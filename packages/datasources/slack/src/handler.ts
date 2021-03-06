import OpenAPIHandler from '@graphql-mesh/openapi';
import { GetMeshSourceOptions, YamlConfig } from '@graphql-mesh/types';

const BASE_URL = 'https://slack.com/api';

export default class SlackHandler extends OpenAPIHandler {
  public constructor({
    name,
    config,
    cache,
    pubsub,
  }: GetMeshSourceOptions<YamlConfig.OpenapiHandler & { token: string }>) {
    config.source = require.resolve('@graphql-portal/slack/src/source.json');
    config.baseUrl = BASE_URL;
    config.operationHeaders = {
      authorization: `Bearer ${config.token}`,
    };

    super({ name, config, cache, pubsub });
  }
}
