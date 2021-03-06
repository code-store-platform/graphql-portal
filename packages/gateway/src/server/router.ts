import { diff } from '@graphql-inspector/core';
import { processConfig } from '@graphql-mesh/config';
import { getMesh, MeshInstance } from '@graphql-mesh/runtime';
import { KeyValueCache, MeshPubSub } from '@graphql-mesh/types';
import { config } from '@graphql-portal/config';
import { prefixLogger } from '@graphql-portal/logger';
import { ApiDef, ApiDefStatus, WebhookEvent } from '@graphql-portal/types';
import { Application, Request, RequestHandler, Router } from 'express';
import { GraphQLSchema } from 'graphql';
import { useServer } from 'graphql-ws/lib/use/ws';
import ws from 'ws';
import { subscribeToRequestMetrics } from '../metric';
import { setupWebhooks, webhooks } from '../webhooks';
import { publishApiDefStatusUpdated, enqueuePublishApiDefStatusUpdated } from '../redis/publish-api-def-status-updated';
import { defaultMiddlewares, loadCustomMiddlewares, handleError, prepareRequestContext } from '../middleware';
import { graphqlHandler, playgroundMiddlewareFactory } from './mesh';
import { httpServer } from './index';

interface IMesh {
  schema: GraphQLSchema;
  pubsub: MeshPubSub;
  contextBuilder: (initialContextValue?: any) => Promise<Record<string, any>>;
  cache: KeyValueCache;
}

const logger = prefixLogger('router');

let router: Router;
export const apiSchema: { [apiName: string]: GraphQLSchema } = {};

const apiMesh: { [apiName: string]: IMesh } = {};
export const getApiMesh = (apiName: string): IMesh | undefined => {
  return apiMesh[apiName];
};

export async function setRouter(app: Application, apiDefs: ApiDef[]): Promise<void> {
  await buildRouter(apiDefs);
  app.use((req, res, next) => router(req, res, next));
  app.use(handleError);

  setupWebhooks(apiDefs);
  await publishApiDefStatusUpdated();
}

export async function buildRouter(apiDefs: ApiDef[]): Promise<Router> {
  const nextRouter = Router();

  nextRouter.use(prepareRequestContext);

  if (apiDefs?.length) {
    logger.info('Loaded %s API Definitions, preparing the endpoints for them.', apiDefs.length);
    await Promise.all(apiDefs.map((apiDef) => buildApi(nextRouter, apiDef)));
  } else {
    logger.warn('No APIs were loaded as the configuration is empty.');
  }

  router = nextRouter;
  return router;
}

async function buildApi(toRouter: Router, apiDef: ApiDef, mesh?: IMesh): Promise<void> {
  if (!mesh) {
    const customMiddlewares = await loadCustomMiddlewares();

    // Loading middlewares
    [...defaultMiddlewares, ...customMiddlewares].forEach((mw) => {
      const handler = mw(apiDef);

      function wrap(fn: RequestHandler): RequestHandler {
        return (req, res, next): void => {
          const handleError = (error: Error): void => {
            logger.debug(`Error in buildApi mw wrapper: ${JSON.stringify(error)}`);
            error.handlerName = handler.name;
            return next(error);
          };

          try {
            (fn(req, res, next) as any)?.catch(handleError);
          } catch (error) {
            handleError(error);
          }
        };
      }

      toRouter.use(apiDef.endpoint, wrap(handler));
    });
  }

  // Setting up Mesh for the endpoint
  mesh = await getMeshForApiDef(apiDef, mesh);
  if (!mesh) {
    await enqueuePublishApiDefStatusUpdated(apiDef.name, ApiDefStatus.DECLINED);

    logger.error(`Could not get schema for API, endpoint ${apiDef.endpoint} won't be added to the router`);
    return;
  }
  const { schema, contextBuilder, pubsub } = mesh;
  apiSchema[apiDef.name] = schema;

  if (config.gateway?.enable_metrics_recording) {
    await subscribeToRequestMetrics(pubsub);
  }

  const endpointUrl = `http://${config.gateway.hostname}:${config.gateway.listen_port}${apiDef.endpoint}`;
  logger.info(`Loaded API ${apiDef.name} ➜ ${endpointUrl}`);

  if (apiDef.playground) {
    const playgroundMiddleware = playgroundMiddlewareFactory({
      baseDir: __dirname,
      exampleQuery: '',
      graphqlPath: apiDef.endpoint,
    });
    toRouter.get(apiDef.endpoint, playgroundMiddleware);
  }
  const $mesh: MeshInstance = {
    ...mesh,
    contextBuilder: async (req: Request) => {
      const context = await contextBuilder({
        forwardHeaders: req?.context?.forwardHeaders || {},
        requestId: req?.id,
        tracerSpan: req?.context?.tracerSpan || {},
        resolverSpans: req?.context?.resolverSpans || {},
      });

      return {
        schema,
        context,
        graphiql: apiDef.playground ? { headerEditorEnabled: true } : false,
      };
    },
  } as any;

  toRouter.use(apiDef.endpoint, graphqlHandler($mesh));

  setupWSServer(apiDef.endpoint, $mesh);

  await enqueuePublishApiDefStatusUpdated(apiDef.name, ApiDefStatus.READY);
}

export async function getMeshForApiDef(
  apiDef: ApiDef,
  mesh?: IMesh,
  retry = 5,
  errorHandler?: (error: Error) => any
): Promise<IMesh | undefined> {
  if (mesh) {
    return mesh;
  }
  try {
    const meshConfig = await processConfig({ sources: apiDef.sources, ...apiDef.mesh });
    mesh = await getMesh(meshConfig);
  } catch (error) {
    if (errorHandler) {
      errorHandler(error);
    } else {
      logger.error(error.stack);
    }
    if (retry) {
      logger.warn('Failed to load schema, retrying after 5 seconds...');
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return getMeshForApiDef(apiDef, mesh, retry - 1);
    }
  }
  if (mesh) {
    apiMesh[apiDef.name] = mesh;
  }
  return mesh;
}

/**
 * Rebuilds the Mesh for a give apiDef and updates the endpoint in the router
 * to point to a new Mesh instance.
 *
 * @param apiDef API Definition which should be updated
 */
export async function updateApi(apiDef: ApiDef): Promise<void> {
  logger.debug(`Updating API ${apiDef.name}: ${apiDef.endpoint}`);
  const mesh = await getMeshForApiDef(apiDef);
  if (!mesh) {
    logger.error(`Could not get schema for API, endpoint ${apiDef.endpoint} won't be updated in the router`);
    return;
  }
  if (apiSchema[apiDef.name] && !diff(mesh.schema, apiSchema[apiDef.name]!).length) {
    logger.debug(`API ${apiDef.name} schema was not changed`);
    return;
  }
  logger.info(`API ${apiDef.name} schema changed, updating the endpoint: ${apiDef.endpoint}`);

  const routerWithNewApi = Router();
  await buildApi(routerWithNewApi, apiDef, mesh);

  const oldLayerIndex = router.stack.findIndex(
    (layer) => layer.name === 'graphqlMiddleware' && layer.regexp.test(apiDef.endpoint)
  );
  router.stack.splice(oldLayerIndex, 1, routerWithNewApi.stack[0]);

  webhooks.triggerForApi(apiDef.name, WebhookEvent.SCHEMA_CHANGED);
}

function setupWSServer(endpoint: string, mesh: MeshInstance): ws.Server {
  const wsServer = new ws.Server({
    path: endpoint,
    server: httpServer,
  });

  useServer(
    {
      schema: () => mesh.schema,
      execute: (args: any) => mesh.execute(args.document, args.variableValues, args.contextValue, args.rootValue),
      subscribe: (args: any) => mesh.subscribe(args.document, args.variableValues, args.contextValue, args.rootValue),
      context: async (ctx) => mesh.contextBuilder(ctx.extra.request),
    },
    wsServer
  );

  return wsServer;
}
