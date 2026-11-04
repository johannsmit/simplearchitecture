import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../src/oef/mapping-config.js';

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

async function waitForHealth(url: string, api: RunningApi): Promise<Response> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return await fetch(url);
    } catch {
      if (Date.now() > deadline) throw new Error(`API did not start:\n${api.stderr()}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

// Placeholder values for the variables the API requires. No real tenant is contacted. The test
// mode lets these tests pick the port, the folder and the mapping, and run without a database.
const authEnv = {
  NODE_ENV: 'test',
  OIDC_ISSUER: 'https://idp.example.test/tenant-a',
  OIDC_CLIENT_ID: '11111111-2222-3333-4444-555555555555',
  OIDC_CLIENT_SECRET: 'spawned-client-secret',
  SESSION_SECRET: 'spawned-session-secret-0123456789abcdef',
  WEB_ORIGIN: 'http://localhost:5173',
};

describe('API process', () => {
  it('refuses to start with invalid config: exit code 1 and a clear message', async () => {
    const api = startApi({ ...authEnv, PORT: 'abc', TRUST_PROXY: 'x', LOG_LEVEL: 'info' });

    expect(await api.exited).toBe(1);
    expect(api.stderr()).toContain('API not started. Invalid configuration');
    expect(api.stderr()).toMatch(/PORT[\s\S]*TRUST_PROXY/);
    expect(api.stderr()).not.toMatch(/\n\s+at /); // no stack trace
    expect(api.stdout()).not.toContain('Server listening');
  }, 20_000);

  it('refuses to start without the client secret, naming it but printing no secret', async () => {
    const api = startApi({ ...authEnv, OIDC_CLIENT_SECRET: '', LOG_LEVEL: 'info' });

    expect(await api.exited).toBe(1);
    expect(api.stderr()).toContain('API not started. Invalid configuration');
    expect(api.stderr()).toMatch(/is required[\s\S]*OIDC_CLIENT_SECRET/);
    expect(api.stderr()).not.toContain(authEnv.SESSION_SECRET);
    expect(api.stderr()).not.toMatch(/\n\s+at /);
  }, 20_000);

  it('refuses to start in development without the settings in .env, listing them all', async () => {
    // NODE_ENV unset, as with npm run dev; only the sign-in values of an older .env.
    const api = startApi({ ...authEnv, NODE_ENV: '', PORT: '4000' });

    expect(await api.exited).toBe(1);
    const stderr = api.stderr();
    for (const name of ['APP_DOMAIN', 'DATABASE_URL', 'OIDC_ROLE_VIEWER', 'BACKEND_PORT']) {
      expect(stderr).toMatch(new RegExp(`is required[\\s\\S]*${name}`));
    }
    expect(stderr).toContain(
      'Development reads exactly these settings from .env, all required: APP_DOMAIN, DATABASE_URL,',
    );
    expect(stderr).not.toContain(authEnv.OIDC_CLIENT_SECRET);
    expect(stderr).not.toContain(authEnv.SESSION_SECRET);
  }, 20_000);

  it('refuses to start in production without the fixed settings, listing them all', async () => {
    // An older host's settings: WEB_ORIGIN instead of APP_DOMAIN, no database, no role values.
    const api = startApi({
      ...authEnv,
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://app.example.test',
      AUTH_REDIRECT_URI: 'https://app.example.test/auth/callback',
    });

    expect(await api.exited).toBe(1);
    const stderr = api.stderr();
    expect(stderr).toContain('API not started. Invalid configuration');
    for (const name of ['APP_DOMAIN', 'DATABASE_URL', 'OIDC_ROLE_ADMIN']) {
      expect(stderr).toMatch(new RegExp(`is required[\\s\\S]*${name}`));
    }
    expect(stderr).toContain('WEB_ORIGIN is no longer read: set APP_DOMAIN');
    expect(stderr).toContain(
      'The image reads exactly these settings, all required: APP_DOMAIN, DATABASE_URL,',
    );
    expect(stderr).not.toContain(authEnv.OIDC_CLIENT_SECRET);
    expect(stderr).not.toContain(authEnv.SESSION_SECRET);
  }, 20_000);

  it('refuses a DATABASE_URL without TLS to another host, never printing the password', async () => {
    const api = startApi({
      ...authEnv,
      DATABASE_URL: 'postgres://app:made-up-db-password@db.example.test/app?sslmode=disable',
    });

    expect(await api.exited).toBe(1);
    expect(api.stderr()).toMatch(/verified certificate[\s\S]*DATABASE_URL/);
    expect(api.stderr()).not.toContain('made-up-db-password');
    expect(api.stderr()).not.toContain('db.example.test');
  }, 20_000);

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
  }, 20_000);

  it('refuses to start with an invalid OEF mapping config, naming the bad entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oef-mapping-server-'));
    try {
      const file = join(dir, 'mapping.json');
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          elements: { Goal: 'Strategy' },
          functionFolding: { rules: [] },
          relationships: { rules: [] },
          properties: { documentation: 'description', mappings: [], defaults: [] },
        }),
      );
      const api = startApi({ ...authEnv, OEF_MAPPING_PATH: file, LOG_LEVEL: 'info' });

      expect(await api.exited).toBe(1);
      expect(api.stderr()).toContain('API not started. Invalid OEF mapping config');
      expect(api.stderr()).toMatch(/elements\.Goal/);
      expect(api.stderr()).not.toMatch(/\n\s+at /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('refuses to start when OEF_MAPPING_PATH points to a missing file', async () => {
    const api = startApi({
      ...authEnv,
      OEF_MAPPING_PATH: 'does-not-exist.json',
      LOG_LEVEL: 'info',
    });

    expect(await api.exited).toBe(1);
    expect(api.stderr()).toContain(
      `API not started. Cannot read OEF mapping config ${join(repoRoot, 'does-not-exist.json')} (ENOENT)`,
    );
  }, 20_000);

  it.each([
    ['.', /is not allowed: it is the repo root or a folder that contains it/],
    // The home directory usually contains the repo, so either reason may apply.
    ['~', /is not allowed: it is (the repo root or a folder that contains it|your home directory)/],
    ['~nobody/models', /is not supported: only a leading ~\//],
  ])(
    'refuses to start with DATA_DIR=%s, changing nothing',
    async (value, message) => {
      const before = statSync(repoRoot).mode;
      const api = startApi({ ...authEnv, DATA_DIR: value, LOG_LEVEL: 'info' });

      expect(await api.exited).toBe(1);
      expect(api.stderr()).toContain('API not started. DATA_DIR ');
      expect(api.stderr()).toMatch(message);
      expect(api.stderr()).not.toMatch(/\n\s+at /);
      expect(statSync(repoRoot).mode).toBe(before);
    },
    20_000,
  );

  it('refuses to start when DATA_DIR is not a writable directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'data-dir-server-'));
    try {
      const file = join(dir, 'a-file');
      writeFileSync(file, '');
      const api = startApi({ ...authEnv, DATA_DIR: file, LOG_LEVEL: 'info' });

      expect(await api.exited).toBe(1);
      expect(api.stderr()).toContain(
        `API not started. DATA_DIR ${file} is not a writable directory`,
      );
      expect(api.stderr()).not.toMatch(/\n\s+at /);
      expect(api.stdout()).not.toContain('Server listening');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  // The API starts in backend/, but a relative DATA_DIR means the repo root.
  it('resolves a relative DATA_DIR against the repo root, not the folder the API starts in', async () => {
    const port = await freePort();
    const dataParent = mkdtempSync(join(tmpdir(), 'data-dir-relative-'));
    const dataDir = join(dataParent, 'models');
    const relativeDir = relative(repoRoot, dataDir);
    const api = startApi({
      ...authEnv,
      DATA_DIR: relativeDir,
      PORT: String(port),
      HOST: '127.0.0.1',
    });
    try {
      await waitForHealth(`http://127.0.0.1:${port}/api/health`, api);
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
      // The wrong place (resolved against backend/) must not exist. Checked only when it is a
      // different folder: on macOS, a repo under /private/tmp makes it /private/var/…, which is
      // the same folder as the temporary /var/… one.
      const wrongPlace = join(backendDir, relativeDir);
      if (!existsSync(wrongPlace) || statSync(wrongPlace).ino !== statSync(dataDir).ino) {
        expect(existsSync(wrongPlace)).toBe(false);
      }
    } finally {
      api.kill('SIGTERM');
      await api.exited;
      rmSync(dataParent, { recursive: true, force: true });
    }
  }, 20_000);

  it('starts with valid config, serves health, logs no credentials, and shuts down cleanly', async () => {
    const port = await freePort();
    // Never the real data/: a new folder in a temporary directory, created owner-only at startup.
    const dataParent = mkdtempSync(join(tmpdir(), 'data-dir-server-'));
    const dataDir = join(dataParent, 'models');
    const api = startApi({
      DATA_DIR: dataDir,
      ...authEnv,
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
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    } finally {
      api.kill('SIGTERM');
    }

    expect(await api.exited).toBe(0);
    rmSync(dataParent, { recursive: true, force: true });
    const lines = api.stdout().trim().split('\n');
    // Structured logging: every line is JSON.
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
    expect(api.stdout()).toContain('shutting down');
    expect(api.stdout()).not.toMatch(/spawned-token-123|spawned-cookie-456/);
    expect(api.stdout()).not.toMatch(/spawned-client-secret|spawned-session-secret/);
  }, 20_000);
});
