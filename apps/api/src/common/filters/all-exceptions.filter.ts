/**
 * Turns every uncaught error into a consistent JSON body and one log line.
 *
 * Deliberately does not leak internals: a caller-facing 500 says "internal
 * error" and the detail goes to the log, correlated by request id, so a stack
 * trace never reaches an API consumer.
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // Validation failures are the client's problem and safe to describe.
    if (exception instanceof ZodError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        message: 'Request validation failed',
        details: exception.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
        path: request.url,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response
        .status(status)
        .json(
          typeof body === 'string'
            ? { statusCode: status, message: body, path: request.url }
            : { ...(body as object), path: request.url },
        );
      return;
    }

    const message = exception instanceof Error ? exception.message : String(exception);
    this.logger.error(
      `Unhandled error on ${request.method} ${request.url}: ${message}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: 'An unexpected error occurred.',
      path: request.url,
    });
  }
}
