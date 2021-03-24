import { GetMeshSourceOptions, YamlConfig } from '@graphql-mesh/types';
// eslint-disable-next-line @typescript-eslint/naming-convention
const OpenAPIHandler = require('@graphql-mesh/openapi');

const BASE_URL = 'https://slack.com/api';

export default class SlackHandler extends OpenAPIHandler {
  public constructor({ name, config, cache }: GetMeshSourceOptions<YamlConfig.OpenapiHandler & { token: string }>) {
    config.source = require.resolve('@graphql-portal/slack/src/definitions.json');
    config.baseUrl = BASE_URL;
    config.operationHeaders = {
      authorization: `Bearer ${config.token}`,
    };

    super({ name, config, cache });
  }
}
