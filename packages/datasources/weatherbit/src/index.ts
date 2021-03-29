import { GetMeshSourceOptions, YamlConfig } from '@graphql-mesh/types';

// eslint-disable-next-line @typescript-eslint/naming-convention
const OpenAPIHandler = require('@graphql-mesh/openapi');

const OPENAPI_SPECIFICATION = 'https://www.weatherbit.io/static/swagger.json';
const BASE_URL = 'https://api.weatherbit.io/v2.0';

export default class WeatherbitHandler extends OpenAPIHandler {
  public constructor({ name, config, cache }: GetMeshSourceOptions<YamlConfig.OpenapiHandler & { token: string }>) {
    config.source = OPENAPI_SPECIFICATION;
    config.baseUrl = BASE_URL;
    config.qs = { key: config.token };
    super({ name, config, cache });
  }
}
