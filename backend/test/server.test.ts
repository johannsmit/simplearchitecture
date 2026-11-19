import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Runs the real entry point (src/server.ts via tsx) as a child process.
// The environment is passed explicitly and no --env-file is used, so a local .env never leaks in.
const backendDir = fileURLToPath(new URL('..', import.meta.url));

interface RunningApi {
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
  kill: (signal: NodeJS.Signals) => void;
}

function startApi(env: Record<string, string>): RunningApi {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: backendDir,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    exited,
    kill: (signal) => child.kill(signal),
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * The health answer, once the API listens. No time limit: starting a process takes longer the
 * busier the machine is, so the wait ends when the API answers, or fails when it exits.
 */
async function waitForHealth(url: string, api: RunningApi): Promise<Response> {
  const stopped = api.exited.then(() => 'exited' as const);
  for (;;) {
    try {
      return await fetch(url);
    } catch {
      const retry = new Promise<'retry'>((resolve) => {
        setTimeout(() => {
          resolve('retry');
        }, 100);
      });
      if ((await Promise.race([stopped, retry])) === 'exited') {
        throw new Error(`API did not start:\n${api.stderr()}`);
      }
    }
  }
}

// Placeholder values for the variables the API requires. No real tenant is contacted. The test
// mode lets these tests pick the port and the mapping.
const authEnv = {
  NODE_ENV: 'test',
  OIDC_ISSUER: 'https://idp.example.test/tenant-a',
  OIDC_CLIENT_ID: '11111111-2222-3333-4444-555555555555',
  OIDC_CLIENT_SECRET: 'spawned-client-secret',
  SESSION_SECRET: 'spawned-session-secret-0123456789abcdef',
  WEB_ORIGIN: 'http://localhost:5173',
};

// Each test starts the API as a process and waits for it to exit or answer, however long the
// machine takes: no time limit, as a busy machine is no failure. The API's own waits are bounded.
describe.concurrent('API process', { timeout: 0 }, () => {
  it('refuses to start with invalid config: exit code 1, every problem named, no secret, no stack trace', async () => {
    const api = startApi({
      ...authEnv,
      PORT: 'abc',
      TRUST_PROXY: 'x',
      OIDC_CLIENT_SECRET: '',
      LOG_LEVEL: 'info',
    });

    expect(await api.exited).toBe(1);
    expect(api.stderr()).toContain('API not started. Invalid configuration');
    expect(api.stderr()).toMatch(/PORT[\s\S]*TRUST_PROXY/);
    expect(api.stderr()).toMatch(/is required[\s\S]*OIDC_CLIENT_SECRET/);
    expect(api.stderr()).not.toContain(authEnv.SESSION_SECRET);
    expect(api.stderr()).not.toMatch(/\n\s+at /); // no stack trace
    expect(api.stdout()).not.toContain('Server listening');
  });

  it('refuses to start when the database is unreachable, with a safe message', async () => {
    const port = await freePort();
    const api = startApi({
      ...authEnv,
      DATABASE_URL: `postgres://app:made-up-db-password@127.0.0.1:${port}/app`,
      DATABASE_WAIT_SECONDS: '2',
      LOG_LEVEL: 'info',
    });

    expect(await api.exited).toBe(1);
    // It waited (a bounded time, retrying) before giving up.
    expect(api.stdout()).toContain('database not reachable yet, retrying');
    expect(api.stderr()).toContain(
      "API not started. The database can't be used. Can't reach the database server.",
    );
    expect(api.stderr()).toContain('Gave up after waiting 2 seconds.');
    expect(`${api.stderr()}${api.stdout()}`).not.toContain('made-up-db-password');
    expect(api.stderr()).not.toMatch(/\n\s+at /);
  });

  it('refuses to start without a database', async () => {
    const api = startApi({ ...authEnv, LOG_LEVEL: 'info' });

    expect(await api.exited).toBe(1);
    expect(api.stderr()).toContain('API not started. DATABASE_URL is not set or not valid.');
    expect(api.stdout()).not.toContain('Server listening');
  });

  // Opt-in, like views-real-postgres.test.ts (CI's check job sets it): a database made for tests,
  // never one with real models. The API runs every migration on it and adds nothing else.
  const throwaway = process.env.THROWAWAY_DATABASE_URL;
  it.skipIf(throwaway === undefined)(
    'starts on a real PostgreSQL server, serves health, logs no credentials, and shuts down cleanly',
    async () => {
      const port = await freePort();
      const api = startApi({
        ...authEnv,
        DATABASE_URL: throwaway ?? '',
        // Production requires https URLs; nothing here is fetched from them.
        WEB_ORIGIN: 'https://localhost:5173',
        AUTH_REDIRECT_URI: 'https://localhost:3000/auth/callback',
        PORT: String(port),
        HOST: '127.0.0.1',
        // Relative to the repo root, although the API starts in backend/ (it wouldn't resolve from there).
        OEF_MAPPING_PATH: 'backend/test/fixtures/oef-mapping-agreed.json',
        LOG_LEVEL: 'info',
      });

      try {
        const res = await waitForHealth(`http://127.0.0.1:${port}/api/health`, api);
        expect(res.status).toBe(200);
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');

        await fetch(`http://127.0.0.1:${port}/api/health`, {
          headers: { authorization: 'Bearer spawned-token-123', cookie: 'sid=spawned-cookie-456' },
        });
      } finally {
        api.kill('SIGTERM');
      }

      expect(await api.exited).toBe(0);
      const lines = api.stdout().trim().split('\n');
      // Structured logging: every line is JSON.
      for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
      expect(api.stdout()).toContain('shutting down');
      expect(api.stdout()).not.toMatch(/spawned-token-123|spawned-cookie-456/);
      expect(api.stdout()).not.toMatch(/spawned-client-secret|spawned-session-secret/);
    },
  );
});
