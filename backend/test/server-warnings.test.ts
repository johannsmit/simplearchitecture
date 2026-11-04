import { afterEach, describe, expect, it, vi } from 'vitest';

// The entry point's own wiring, without a database: buildApp is replaced, the real config is read.
const warn = vi.fn();
vi.mock('../src/app.js', () => ({
  buildApp: () =>
    Promise.resolve({
      log: { info: vi.fn(), warn, fatal: vi.fn() },
      listen: () => Promise.resolve(),
      close: () => Promise.resolve(),
    }),
}));

const current = {
  NODE_ENV: 'development',
  APP_DOMAIN: 'localhost',
  FRONTEND_PORT: '5173',
  BACKEND_PORT: '3000',
  DATABASE_URL: 'postgres://made-up:made-up-password@localhost:5432/made-up',
  OIDC_ISSUER: 'https://idp.example.test/tenant-a',
  OIDC_CLIENT_ID: 'made-up-client',
  OIDC_CLIENT_SECRET: 'made-up-client-secret',
  SESSION_SECRET: 'made-up-session-secret-that-is-long-enough',
  OIDC_ROLES_CLAIM: 'roles',
  OIDC_ROLE_ADMIN: 'Admin',
  OIDC_ROLE_MODELLER: 'Modeller',
  OIDC_ROLE_VIEWER: 'Viewer',
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('server.ts on an old setting left next to the new ones', () => {
  it('starts, and warns with the name and its replacement, never the value', async () => {
    for (const [name, value] of Object.entries(current)) vi.stubEnv(name, value);
    vi.stubEnv('ENTRA_CLIENT_SECRET', 'made-up-old-secret');
    vi.stubEnv('ENTRA_TENANT_ID', 'made-up-old-tenant');
    vi.spyOn(process, 'once').mockReturnThis();

    await import('../src/server.js');

    const calls = warn.mock.calls.filter(
      ([, message]) => message === 'setting no longer read: ignored, set its replacement',
    );
    expect(calls.map(([fields]: unknown[]) => fields)).toEqual([
      { setting: 'ENTRA_TENANT_ID', replacement: 'OIDC_ISSUER' },
      { setting: 'ENTRA_CLIENT_SECRET', replacement: 'OIDC_CLIENT_SECRET' },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('made-up-old');
  });
});
