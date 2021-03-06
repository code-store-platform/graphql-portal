import { MetricsChannels } from '@graphql-portal/types';
import { RequestHandler } from 'express';
import { metricEmitter } from '../metric';
import { prefixLogger } from '@graphql-portal/logger';

const logger = prefixLogger('metrics:log-response');

export const logResponse: RequestHandler = (req, res, next) => {
  const oldWrite = res.write.bind(res);
  const oldEnd = res.end.bind(res);

  const chunks: Buffer[] = [];

  res.write = (...args: any[]): any => {
    chunks.push(args[0]);
    return oldWrite(...args);
  };

  res.end = (...args: any[]): any => {
    if (args[0] instanceof Buffer) chunks.push(args[0]);
    return oldEnd(...args);
  };

  res.on('finish', () => {
    const buffer = Buffer.concat(chunks);
    const contentLength = buffer.byteLength;
    const responseBody = buffer.toString('utf8');
    logger.debug(`req.id ${req.id} [${res.statusCode}]: ${contentLength}`);
    if (res.statusCode >= 400) {
      metricEmitter.emit(MetricsChannels.GOT_ERROR, req.id, responseBody, Date.now());
    } else {
      metricEmitter.emit(MetricsChannels.SENT_RESPONSE, req.id, responseBody, contentLength, Date.now());
    }
    req.context?.tracerSpan?.setTag('http.status', res.statusCode);
    req.context?.tracerSpan?.finish();
  });

  next();
};
