import { GetMeshSourceOptions, YamlConfig } from '@graphql-mesh/types';

// eslint-disable-next-line @typescript-eslint/naming-convention
const OpenAPIHandler = require('@graphql-mesh/openapi');

const BASE_URL = 'https://api.stripe.com/';

export default class StripeHandler extends OpenAPIHandler {
  public constructor({ name, config, cache }: GetMeshSourceOptions<YamlConfig.OpenapiHandler & { token: string }>) {
    config.source = require.resolve('@graphql-portal/stripe/src/source.json');
    config.baseUrl = BASE_URL;
    config.operationHeaders = config.schemaHeaders = {
      Authorization: `Bearer ${config.token}`,
    };

    super({ name, config, cache });
  }
}
