/** Response body of `GET /api/health`. */
export interface HealthResponse {
  status: 'ok';
}

/**
 * Response body of `GET /api/about` (Viewer or higher): the code the server runs. `version` comes
 * from the package files; `commit` is the short commit the build came from, or "development" or
 * "unknown" when the build didn't record one.
 */
export interface AboutResponse {
  version: string;
  commit: string;
}

/** Body of every error response from the API. Never contains stack traces or internals. */
export interface ApiError {
  statusCode: number;
  error: string;
  message: string;
}
