import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@krypton/logger';
import { KryptonApiError } from '@krypton/shared-types';

const logger = createLogger({ serviceName: 'krypton-api' });

@Catch()
export class KryptonExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId = (request.headers['x-request-id'] as string) || uuidv4();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_SERVER_ERROR';
    let message = 'An internal server error occurred.';
    let retryable = false;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const obj = res as Record<string, any>;
        message = obj.message || message;
        code = obj.code || `HTTP_${status}`;
        retryable = obj.retryable || false;
      }
    } else if (exception instanceof Error) {
      logger.error({
        requestId,
        url: request.url,
        method: request.method,
        err: exception.message,
        stack: exception.stack,
      }, 'Unhandled server exception');
    }

    // Never leak stack traces to clients in production (Section 38)
    const errorResponse: KryptonApiError = {
      code,
      message,
      requestId,
      retryable,
    };

    response.status(status).json(errorResponse);
  }
}
