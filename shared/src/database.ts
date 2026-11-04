/**
 * Response body of `GET /api/admin/database` (Admin only). The connection details come from
 * `DATABASE_URL`; the password and the URL itself are never part of any response.
 */
export interface DatabaseStatus {
  /** False when `DATABASE_URL` isn't set: models are stored as files in `DATA_DIR`. */
  configured: boolean;
  /** The API could run a query just now. */
  connected: boolean;
  host: string | null;
  port: number | null;
  database: string | null;
  user: string | null;
  /** The connection uses TLS. */
  tls: boolean;
  /** The server's certificate and host name are verified (always, when TLS is on). */
  tlsVerified: boolean;
  /** For example `16.4`. Null when not connected. */
  serverVersion: string | null;
  /** `applied` is null when it can't be read (not connected). */
  migrations: { applied: number | null; total: number };
}

/** Response body of `POST /api/admin/database/test`. The message is one of a few fixed texts. */
export interface DatabaseTestResult {
  ok: boolean;
  message: string;
}
