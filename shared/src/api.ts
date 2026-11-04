/** Response body of `GET /api/health`. */
export interface HealthResponse {
  status: 'ok';
}

/** Body of every error response from the API. Never contains stack traces or internals. */
export interface ApiError {
  statusCode: number;
  error: string;
  message: string;
}
