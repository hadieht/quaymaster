import type { ErrorCode } from '@quaymaster/shared';

/** Error with a stable machine-readable code that maps onto the uniform error envelope. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError(400, 'validation', message, details);
export const unauthorized = (message = 'Authentication required'): AppError =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Not permitted'): AppError => new AppError(403, 'forbidden', message);
export const notFound = (what: string): AppError => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: ErrorCode, message: string, details?: unknown): AppError =>
  new AppError(409, code, message, details);
