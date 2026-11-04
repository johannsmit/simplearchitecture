import { STATUS_CODES } from 'node:http';
import type { ApiError } from '@simplearchitecture/shared';

/** The standard error body. Never contains stack traces or internals. */
export function errorBody(statusCode: number, message: string): ApiError {
  return { statusCode, error: STATUS_CODES[statusCode] ?? 'Error', message };
}
