import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  databaseWorkloadIdentity,
  developmentSettings,
  ignoredSettings,
  loadConfig,
  loadDatabaseConfig,
  oidcClientAuth,
  productionSettings,
  replacedSettings,
} from '../src/config.js';

// The test runner's own mode, where everything can be set (see testSchema).
const required = {
  NODE_ENV: 'test',
  OIDC_ISSUER: 'https://idp.example.test/tenant-a',
  OIDC_CLIENT_ID: '11111111-2222-3333-4444-555555555555',
  OIDC_CLIENT_SECRET: 'config-test-client-secret',
  SESSION_SECRET: 'config-test-session-secret-0123456789',
  WEB_ORIGIN: 'http://localhost:5173',
};

const madeUpDatabaseUrl = 'postgres://app:made-up-db-password@db.example.test:5432/app';

describe('loadConfig', () => {
  it('applies defaults in tests', () => {
    expect(loadConfig(required)).toEqual({
      ...required,
      PORT: 3000,
      HOST: 'localhost',
      TRUST_PROXY: 0,
      LOG_LEVEL: 'info',
      AUTH_REDIRECT_URI: 'http://localhost:3000/auth/callback',
      COOKIE_SECURE: true,
      DATABASE_WAIT_SECONDS: 60,
      DATA_DIR: 'data',
      OIDC_ROLES_CLAIM: 'roles',
      OIDC_ROLE_ADMIN: 'Admin',
      OIDC_ROLE_MODELLER: 'Modeller',
      OIDC_ROLE_VIEWER: 'Viewer',
    });
  });

  it('reads the role values', () => {
    const config = loadConfig({
      ...required,
      OIDC_ROLE_ADMIN: 'EA.Admin',
      OIDC_ROLE_MODELLER: 'EA.Modeller',
      OIDC_ROLE_VIEWER: 'EA.Reader',
    });
    expect(config).toMatchObject({
      OIDC_ROLE_ADMIN: 'EA.Admin',
      OIDC_ROLE_MODELLER: 'EA.Modeller',
      OIDC_ROLE_VIEWER: 'EA.Reader',
    });
  });

  it.each([
    [{ OIDC_ROLE_ADMIN: '   ' }, 'OIDC_ROLE_ADMIN'],
    [{ OIDC_ROLE_MODELLER: 'x'.repeat(251) }, 'OIDC_ROLE_MODELLER'],
    [{ OIDC_ROLE_VIEWER: 'Admin' }, 'must all differ'],
  ])('refuses role values %j', (values, problem) => {
    expect(() => loadConfig({ ...required, ...values })).toThrow(problem);
  });

  it('parses valid values', () => {
    const config = loadConfig({
      ...required,
      PORT: '8080',
      DATABASE_URL: madeUpDatabaseUrl,
      LOG_LEVEL: 'warn',
      WEB_ORIGIN: 'https://app.example.com/',
      AUTH_REDIRECT_URI: 'https://app.example.com/auth/callback',
    });
    expect(config).toMatchObject({
      PORT: 8080,
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      WEB_ORIGIN: 'https://app.example.com',
    });
  });

  it('rejects invalid values with a message naming each field', () => {
    expect(() => loadConfig({ ...required, PORT: 'abc', TRUST_PROXY: 'x' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...required, PORT: 'abc', TRUST_PROXY: 'x' })).toThrow(
      /PORT[\s\S]*TRUST_PROXY/,
    );
  });

  it('refuses an unknown NODE_ENV', () => {
    expect(() => loadConfig({ ...required, NODE_ENV: 'staging' })).toThrow(
      /must be development, test or production[\s\S]*NODE_ENV/,
    );
  });

  it.each(Object.keys(required).filter((name) => name !== 'NODE_ENV'))(
    'refuses to start without %s',
    (name) => {
      const env: Record<string, string> = { ...required };
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete env[name];
      expect(() => loadConfig(env)).toThrow(new RegExp(`is required[\\s\\S]*${name}`));
    },
  );

  it('treats an empty client secret as missing', () => {
    expect(() => loadConfig({ ...required, OIDC_CLIENT_SECRET: '' })).toThrow(
      /is required[\s\S]*OIDC_CLIENT_SECRET/,
    );
  });

  it('keeps OIDC_ISSUER exactly as written, with or without a trailing slash', () => {
    for (const address of [
      'https://idp.example.test',
      'https://idp.example.test/',
      'https://idp.example.test/oauth2/default',
      'https://idp.example.test/oauth2/default/',
    ]) {
      expect(loadConfig({ ...required, OIDC_ISSUER: address }).OIDC_ISSUER).toBe(address);
    }
  });

  it('takes any client id, role values with spaces, and any claim name', () => {
    const config = loadConfig({
      ...required,
      OIDC_CLIENT_ID: '0oa1made-up.apps',
      OIDC_ROLES_CLAIM: 'https://app.example.test/roles',
      OIDC_ROLE_ADMIN: '  App Admins (all)  ',
    });
    expect(config.OIDC_CLIENT_ID).toBe('0oa1made-up.apps');
    expect(config.OIDC_ROLES_CLAIM).toBe('https://app.example.test/roles');
    expect(config.OIDC_ROLE_ADMIN).toBe('App Admins (all)');
  });

  it.each([
    [{ OIDC_ISSUER: 'not-an-address' }, 'OIDC_ISSUER'],
    [{ OIDC_ISSUER: 'ftp://idp.example.test' }, 'OIDC_ISSUER'],
    [{ OIDC_ISSUER: 'https://idp.example.test/?tenant=a' }, 'OIDC_ISSUER'],
    [{ OIDC_ISSUER: 'https://idp.example.test/#a' }, 'OIDC_ISSUER'],
    [{ OIDC_ISSUER: 'https://user:secret@idp.example.test/' }, 'OIDC_ISSUER'],
    [{ OIDC_CLIENT_ID: '   ' }, 'OIDC_CLIENT_ID'],
    [{ OIDC_ROLES_CLAIM: '   ' }, 'OIDC_ROLES_CLAIM'],
    [{ OIDC_ROLES_CLAIM: 'x'.repeat(251) }, 'OIDC_ROLES_CLAIM'],
    [{ OIDC_ROLE_VIEWER: ' Admin ' }, 'must all differ'],
  ])('refuses %j', (values, problem) => {
    expect(() => loadConfig({ ...required, ...values })).toThrow(problem);
  });

  describe('the settings renamed from ENTRA_*', () => {
    const old = {
      ENTRA_TENANT_ID: 'made-up-old-tenant',
      ENTRA_CLIENT_ID: 'made-up-old-client',
      ENTRA_CLIENT_SECRET: 'made-up-old-secret',
      ENTRA_ROLE_ADMIN: 'made-up-old-admin',
      ENTRA_ROLE_MODELLER: 'made-up-old-modeller',
      ENTRA_ROLE_VIEWER: 'made-up-old-viewer',
    };
    const replacements = [
      { setting: 'ENTRA_TENANT_ID', replacement: 'OIDC_ISSUER' },
      { setting: 'ENTRA_CLIENT_ID', replacement: 'OIDC_CLIENT_ID' },
      { setting: 'ENTRA_CLIENT_SECRET', replacement: 'OIDC_CLIENT_SECRET' },
      { setting: 'ENTRA_ROLE_ADMIN', replacement: 'OIDC_ROLE_ADMIN' },
      { setting: 'ENTRA_ROLE_MODELLER', replacement: 'OIDC_ROLE_MODELLER' },
      { setting: 'ENTRA_ROLE_VIEWER', replacement: 'OIDC_ROLE_VIEWER' },
    ];
    const hosted = {
      NODE_ENV: 'production',
      APP_DOMAIN: 'app.example.com',
      DATABASE_URL: madeUpDatabaseUrl,
      OIDC_ISSUER: 'https://idp.example.test/tenant-a',
      OIDC_CLIENT_ID: 'made-up-client',
      OIDC_CLIENT_SECRET: 'made-up-client-secret',
      SESSION_SECRET: required.SESSION_SECRET,
      OIDC_ROLES_CLAIM: 'roles',
      OIDC_ROLE_ADMIN: 'Admin',
      OIDC_ROLE_MODELLER: 'Modeller',
      OIDC_ROLE_VIEWER: 'Viewer',
    };

    it('are ignored, each named with its replacement', () => {
      expect(replacedSettings({ ...hosted, ...old })).toEqual(replacements);
      expect(loadConfig({ ...hosted, ...old })).toEqual(loadConfig(hosted));
      expect(ignoredSettings({ ...hosted, ...old })).toEqual([]);
      expect(replacedSettings(hosted)).toEqual([]);
      expect(replacedSettings({ ...hosted, ...old, NODE_ENV: 'test' })).toEqual([]);
    });

    it.each(['production', 'development'])(
      'are no fallback: with only them, %s refuses to start and says what to set',
      (mode) => {
        const env = {
          NODE_ENV: mode,
          APP_DOMAIN: 'localhost',
          DATABASE_URL: 'postgres://app:made-up-db-password@localhost:5432/app',
          SESSION_SECRET: required.SESSION_SECRET,
          FRONTEND_PORT: '5173',
          BACKEND_PORT: '3000',
          ...old,
        };
        let message = '';
        try {
          loadConfig(env);
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toMatch(/is required[\s\S]*OIDC_ISSUER/);
        expect(message).toContain(
          'ENTRA_TENANT_ID is no longer read: set OIDC_ISSUER to the full address, for Entra ID https://login.microsoftonline.com/<tenant id>/v2.0.',
        );
        for (const { setting, replacement } of replacements.slice(1)) {
          expect(message).toContain(`${setting} is no longer read: set ${replacement}.`);
        }
        for (const value of Object.values(old)) expect(message).not.toContain(value);
      },
    );

    it.each([
      ['http', { OIDC_ISSUER: 'http://idp.example.test/tenant-a' }],
      ['a query', { OIDC_ISSUER: 'https://idp.example.test/tenant-a?x=1' }],
      ['an empty query', { OIDC_ISSUER: 'https://idp.example.test/tenant-a?' }],
      ['a fragment', { OIDC_ISSUER: 'https://idp.example.test/tenant-a#x' }],
      ['an empty fragment', { OIDC_ISSUER: 'https://idp.example.test/tenant-a#' }],
      ['a user name', { OIDC_ISSUER: 'https://user@idp.example.test/tenant-a' }],
      ['an empty user name', { OIDC_ISSUER: 'https://@idp.example.test/tenant-a' }],
    ])('outside tests, OIDC_ISSUER is https only and refuses %s', (_name, values) => {
      expect(() => loadConfig({ ...hosted, ...values })).toThrow(/OIDC_ISSUER/);
      expect(() =>
        loadConfig({
          ...hosted,
          ...values,
          NODE_ENV: 'development',
          APP_DOMAIN: 'localhost',
          FRONTEND_PORT: '5173',
          BACKEND_PORT: '3000',
        }),
      ).toThrow(/OIDC_ISSUER/);
    });

    it('keeps the old rules: the session secret must differ from the client secret', () => {
      expect(() => loadConfig({ ...hosted, OIDC_CLIENT_SECRET: required.SESSION_SECRET })).toThrow(
        /must not be the same as OIDC_CLIENT_SECRET/,
      );
    });
  });

  it('never echoes secret values in the error', () => {
    const shortSecret = 'too-short-secret';
    let message = '';
    try {
      loadConfig({ ...required, SESSION_SECRET: shortSecret, OIDC_ISSUER: 'not-an-address' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/SESSION_SECRET[\s\S]*OIDC_ISSUER|OIDC_ISSUER[\s\S]*SESSION_SECRET/);
    expect(message).not.toContain(shortSecret);
    expect(message).not.toContain(required.OIDC_CLIENT_SECRET);
  });

  it.each([
    ['WEB_ORIGIN with a path', { WEB_ORIGIN: 'http://localhost:5173/app' }, /WEB_ORIGIN/],
    ['WEB_ORIGIN not http(s)', { WEB_ORIGIN: 'javascript:alert(1)' }, /WEB_ORIGIN/],
    [
      'a redirect URI on another path',
      { AUTH_REDIRECT_URI: 'http://localhost:3000/x' },
      /AUTH_REDIRECT_URI/,
    ],
  ])('rejects %s', (_name, overrides, field) => {
    expect(() => loadConfig({ ...required, ...overrides })).toThrow(field);
  });

  describe("in development: exactly the image's nine settings plus two ports, in .env", () => {
    const development = {
      APP_DOMAIN: 'localhost',
      FRONTEND_PORT: '5173',
      BACKEND_PORT: '3000',
      DATABASE_URL: 'postgres://app:made-up-db-password@localhost:5432/app',
      OIDC_ISSUER: required.OIDC_ISSUER,
      OIDC_CLIENT_ID: required.OIDC_CLIENT_ID,
      OIDC_CLIENT_SECRET: required.OIDC_CLIENT_SECRET,
      SESSION_SECRET: required.SESSION_SECRET,
      OIDC_ROLES_CLAIM: 'roles',
      OIDC_ROLE_ADMIN: 'Admin',
      OIDC_ROLE_MODELLER: 'Modeller',
      OIDC_ROLE_VIEWER: 'Viewer',
    };

    it('reads exactly the twelve settings, with NODE_ENV unset or development', () => {
      expect([...developmentSettings].sort()).toEqual(Object.keys(development).sort());
      expect(developmentSettings).toEqual([...productionSettings, 'FRONTEND_PORT', 'BACKEND_PORT']);
      expect(loadConfig({ ...development, NODE_ENV: 'development' })).toEqual(
        loadConfig(development),
      );
    });

    it('runs both on APP_DOMAIN over http, on the two ports, and fixes everything else', () => {
      const { APP_DOMAIN, FRONTEND_PORT, BACKEND_PORT, ...settings } = development;
      expect(loadConfig(development)).toEqual({
        ...settings,
        NODE_ENV: 'development',
        WEB_ORIGIN: `http://${APP_DOMAIN}:${FRONTEND_PORT}`,
        AUTH_REDIRECT_URI: `http://${APP_DOMAIN}:${BACKEND_PORT}/auth/callback`,
        PORT: Number(BACKEND_PORT),
        HOST: 'localhost',
        TRUST_PROXY: 0,
        COOKIE_SECURE: false,
        LOG_LEVEL: 'info',
        DATABASE_WAIT_SECONDS: 60,
        DATA_DIR: 'data',
      });
    });

    it('ignores the other settings, and names them for a warning', () => {
      const env = {
        ...development,
        PORT: '4000',
        WEB_ORIGIN: 'http://localhost:4173',
        LOG_LEVEL: 'debug',
        DATA_DIR: '~/models',
      };
      expect(loadConfig(env)).toEqual(loadConfig(development));
      expect(ignoredSettings(env)).toEqual(['WEB_ORIGIN', 'LOG_LEVEL', 'DATA_DIR', 'PORT']);
      expect(ignoredSettings(development)).toEqual([]);
    });

    it('ignores TRUST_PROXY: development has no proxy in front', () => {
      const env = { ...development, TRUST_PROXY: '2' };
      expect(loadConfig(env).TRUST_PROXY).toBe(0);
      expect(ignoredSettings(env)).toEqual(['TRUST_PROXY']);
    });

    it.each(developmentSettings)('refuses to start without %s, listing the full set', (name) => {
      const env: Record<string, string> = { ...development };
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete env[name];
      expect(() => loadConfig(env)).toThrow(
        new RegExp(`is required[\\s\\S]*${name}[\\s\\S]*Development reads exactly these settings`),
      );
    });

    it.each([
      [{ OIDC_ROLE_ADMIN: '   ' }, 'OIDC_ROLE_ADMIN'],
      [{ OIDC_ROLE_VIEWER: 'Admin' }, 'must all differ'],
      [{ SESSION_SECRET: 'too-short' }, 'at least 32 characters'],
      [{ FRONTEND_PORT: '5173x' }, 'FRONTEND_PORT'],
      [{ BACKEND_PORT: '70000' }, 'BACKEND_PORT'],
      [{ BACKEND_PORT: '0' }, 'BACKEND_PORT'],
      [{ BACKEND_PORT: '5173' }, 'must differ from FRONTEND_PORT'],
      [{ APP_DOMAIN: 'localhost:5173' }, 'must be the domain only'],
      [{ APP_DOMAIN: 'http://localhost' }, 'must be the domain only'],
    ])('refuses %j', (values, problem) => {
      expect(() => loadConfig({ ...development, ...values })).toThrow(problem);
    });

    it('puts the web app and the sign-in callback on the two ports', () => {
      const config = loadConfig({
        ...development,
        APP_DOMAIN: 'sa.localhost',
        FRONTEND_PORT: '5200',
        BACKEND_PORT: '3100',
      });
      expect(config).toMatchObject({
        PORT: 3100,
        WEB_ORIGIN: 'http://sa.localhost:5200',
        AUTH_REDIRECT_URI: 'http://sa.localhost:3100/auth/callback',
      });
    });

    it('leaves port 80 out of the addresses, as browsers do in the Origin header', () => {
      const config = loadConfig({ ...development, FRONTEND_PORT: '80', BACKEND_PORT: '3000' });
      expect(config.WEB_ORIGIN).toBe('http://localhost');
      expect(loadConfig({ ...development, BACKEND_PORT: '80' }).AUTH_REDIRECT_URI).toBe(
        'http://localhost/auth/callback',
      );
    });

    it('allows a simple SESSION_SECRET (only the image checks its variety)', () => {
      const secret = 'ab'.repeat(20);
      expect(loadConfig({ ...development, SESSION_SECRET: secret }).SESSION_SECRET).toBe(secret);
    });
  });

  describe('in production (the image): exactly the fixed settings', () => {
    const production = {
      NODE_ENV: 'production',
      APP_DOMAIN: 'app.example.com',
      DATABASE_URL: madeUpDatabaseUrl,
      OIDC_ISSUER: required.OIDC_ISSUER,
      OIDC_CLIENT_ID: required.OIDC_CLIENT_ID,
      OIDC_CLIENT_SECRET: required.OIDC_CLIENT_SECRET,
      SESSION_SECRET: required.SESSION_SECRET,
      OIDC_ROLES_CLAIM: 'groups',
      OIDC_ROLE_ADMIN: 'EA.Admin',
      OIDC_ROLE_MODELLER: 'EA.Modeller',
      OIDC_ROLE_VIEWER: 'EA.Reader',
    };

    const withoutDomain = (env: Record<string, string>) =>
      Object.fromEntries(Object.entries(env).filter(([name]) => name !== 'APP_DOMAIN'));

    it('reads exactly the ten settings', () => {
      expect([...productionSettings].sort()).toEqual(
        Object.keys(production)
          .filter((name) => name !== 'NODE_ENV')
          .sort(),
      );
    });

    it('fixes everything else: one https origin, port 8080, one proxy, secure cookies', () => {
      const settings = withoutDomain(production);
      expect(loadConfig(production)).toEqual({
        ...settings,
        WEB_ORIGIN: 'https://app.example.com',
        AUTH_REDIRECT_URI: 'https://app.example.com/auth/callback',
        PORT: 8080,
        HOST: '0.0.0.0',
        TRUST_PROXY: 1,
        COOKIE_SECURE: true,
        LOG_LEVEL: 'info',
        DATABASE_WAIT_SECONDS: 60,
        DATA_DIR: 'data',
      });
    });

    it('reads TRUST_PROXY, the number of proxies in front, one by default', () => {
      expect(loadConfig(production).TRUST_PROXY).toBe(1);
      expect(loadConfig({ ...production, TRUST_PROXY: '2' }).TRUST_PROXY).toBe(2);
      expect(ignoredSettings({ ...production, TRUST_PROXY: '2' })).toEqual([]);
      for (const value of ['0', '6', 'x']) {
        expect(() => loadConfig({ ...production, TRUST_PROXY: value }), value).toThrow(
          /number of proxies in front of the API, 1 to 5[\s\S]*TRUST_PROXY/,
        );
      }
    });

    it('without the optional settings, lists a missing client secret in its place and says nothing of them', () => {
      const problems = (env: Record<string, string>) => {
        let message = '';
        try {
          loadConfig(env);
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).not.toMatch(/OIDC_CLIENT_AUTH|DATABASE_AUTH|AZURE_/);
        expect(message).toMatch(/The image reads exactly these settings, all required: [^\n]*\.$/);
        return message.split('\n').filter((line) => line.startsWith('  → at '));
      };
      const without = (env: Record<string, string>, ...names: string[]) =>
        Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name)));
      const withoutSecret = without(production, 'OIDC_CLIENT_SECRET');
      const withoutSecretOrClaim = without(withoutSecret, 'OIDC_ROLES_CLAIM');
      // In the order of the ten, as before the optional settings.
      expect(problems(withoutSecretOrClaim)).toEqual([
        '  → at OIDC_CLIENT_SECRET',
        '  → at OIDC_ROLES_CLAIM',
      ]);
      // A missing setting comes first: the checks across settings wait until all are there.
      expect(
        problems({
          ...withoutSecret,
          SESSION_SECRET: 'ab'.repeat(20),
          OIDC_ROLE_VIEWER: production.OIDC_ROLE_ADMIN,
        }),
      ).toEqual(['  → at OIDC_CLIENT_SECRET']);
    });

    it('mentions the federated credential and Entra sign-in only to a host that uses one', () => {
      const env: Record<string, string> = { ...production, DATABASE_AUTH: 'entra' };
      expect(() => loadConfig(env)).toThrow(
        /With OIDC_CLIENT_AUTH=federated[\s\S]*With DATABASE_AUTH=entra/,
      );
    });

    it('ignores the settings of earlier versions, and names them for a warning', () => {
      const env = {
        ...production,
        WEB_ORIGIN: 'https://evil.example',
        AUTH_REDIRECT_URI: 'https://evil.example/auth/callback',
        AUTH_POST_LOGOUT_REDIRECT_URI: 'https://evil.example/',
        COOKIE_SECURE: 'false',
        LOG_LEVEL: 'silent',
        DATABASE_CA_FILE: 'ca.pem',
        PORT: '80',
      };
      expect(loadConfig(env)).toEqual(loadConfig(production));
      expect(ignoredSettings(env)).toEqual([
        'WEB_ORIGIN',
        'AUTH_REDIRECT_URI',
        'AUTH_POST_LOGOUT_REDIRECT_URI',
        'COOKIE_SECURE',
        'LOG_LEVEL',
        'DATABASE_CA_FILE',
        'PORT',
      ]);
      expect(ignoredSettings({ ...production, FRONTEND_PORT: '5173' })).toEqual(['FRONTEND_PORT']);
      expect(ignoredSettings(production)).toEqual([]);
      // Tests still read them.
      expect(ignoredSettings({ ...required, PORT: '3000', TRUST_PROXY: '1' })).toEqual([]);
    });

    it.each(productionSettings)('refuses to start without %s, listing the full set', (name) => {
      const env: Record<string, string> = { ...production };
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete env[name];
      expect(() => loadConfig(env)).toThrow(
        new RegExp(`is required[\\s\\S]*${name}[\\s\\S]*exactly these settings, all required`),
      );
    });

    it('says APP_DOMAIN replaces WEB_ORIGIN when an older host sets only WEB_ORIGIN', () => {
      const older = withoutDomain(production);
      expect(() => loadConfig({ ...older, WEB_ORIGIN: 'https://app.example.com' })).toThrow(
        /WEB_ORIGIN is no longer read: set APP_DOMAIN to the domain only/,
      );
      expect(() => loadConfig(older)).not.toThrow(/WEB_ORIGIN is no longer read/);
    });

    it.each([
      ['app.example.com', 'https://app.example.com'],
      ['https://app.example.com', 'https://app.example.com'],
      ['HTTPS://App.Example.com/', 'https://app.example.com'],
      [' app.example.com ', 'https://app.example.com'],
      [
        'sa-1a2b3c.westeurope-01.azurewebsites.net',
        'https://sa-1a2b3c.westeurope-01.azurewebsites.net',
      ],
    ])('reads APP_DOMAIN %j as %s', (domain, origin) => {
      const config = loadConfig({ ...production, APP_DOMAIN: domain });
      expect(config.WEB_ORIGIN).toBe(origin);
      expect(config.AUTH_REDIRECT_URI).toBe(`${origin}/auth/callback`);
    });

    it.each([
      'http://app.example.com',
      'app.example.com/app',
      'app.example.com:8443',
      'app..example.com',
      '-app.example.com',
      'app example.com',
      'https://',
      'app.example.com?x=1',
    ])('refuses APP_DOMAIN %j', (domain) => {
      expect(() => loadConfig({ ...production, APP_DOMAIN: domain })).toThrow(
        /must be the domain only[\s\S]*APP_DOMAIN/,
      );
    });

    it.each([
      [{ OIDC_ROLE_ADMIN: '   ' }, 'OIDC_ROLE_ADMIN'],
      [{ OIDC_ROLE_VIEWER: 'EA.Admin' }, 'must all differ'],
      [{ DATABASE_URL: `${madeUpDatabaseUrl}?sslmode=disable` }, 'DATABASE_URL'],
    ])('refuses %j', (values, problem) => {
      expect(() => loadConfig({ ...production, ...values })).toThrow(problem);
    });

    const clientSecret = 'made-up-shared-secret-0123456789-abcdef';
    it.each([
      [
        'a 31-character SESSION_SECRET',
        'Qx7!mZ2#pL9$wR4%tY6^uI8&oP0*aS3',
        /at least 32 characters/,
      ],
      ['a SESSION_SECRET of few different characters', 'ab'.repeat(20), /too weak/],
      ['a SESSION_SECRET equal to the client secret', clientSecret, /OIDC_CLIENT_SECRET/],
    ])('refuses %s, without printing it', (_name, secret, message) => {
      const env = { ...production, OIDC_CLIENT_SECRET: clientSecret, SESSION_SECRET: secret };
      let error: unknown;
      try {
        loadConfig(env);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).toContain('SESSION_SECRET');
      expect((error as Error).message).not.toContain(secret);
    });

    it('accepts a random SESSION_SECRET, hex or base64', () => {
      // Made-up values shaped like `openssl rand -hex 16` and `openssl rand -base64 48`.
      for (const secret of [
        '3f9a0c7be21d48f6a5c3e09b7d1f2a64',
        'k2V9qXb7Lr0Tz+Wm4yHc8Np1Ds6Gf3Ja5Ue0Io/Bh7Ql2Rv9Xt4Mw8Yn1Zs6Ek3Cd5Pa0Fg7Hj2',
      ]) {
        expect(loadConfig({ ...production, SESSION_SECRET: secret }).SESSION_SECRET).toBe(secret);
      }
    });
  });

  it('keeps the default AUTH_REDIRECT_URI on the API port', () => {
    expect(loadConfig(required).AUTH_REDIRECT_URI).toBe('http://localhost:3000/auth/callback');
  });

  it('reads TRUST_PROXY as a number of proxy hops, off by default', () => {
    expect(loadConfig(required).TRUST_PROXY).toBe(0);
    expect(loadConfig({ ...required, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    for (const value of ['true', '-1', '1.5', '6']) {
      expect(() => loadConfig({ ...required, TRUST_PROXY: value }), value).toThrow(/TRUST_PROXY/);
    }
  });

  it.each([
    ['https://app.example.com', 'https://evil.example/auth/callback'],
    ['http://localhost:5173', 'http://evil.example/auth/callback'],
    ['http://localhost:5173', 'http://127.0.0.1:3000/auth/callback'],
  ])(
    'rejects a redirect URI on another host than WEB_ORIGIN (%s, %s)',
    (webOrigin, redirectUri) => {
      expect(() =>
        loadConfig({
          ...required,
          WEB_ORIGIN: webOrigin,
          AUTH_REDIRECT_URI: redirectUri,
        }),
      ).toThrow(/WEB_ORIGIN's host[\s\S]*AUTH_REDIRECT_URI/);
    },
  );

  it('makes cookies Secure unless configured', () => {
    expect(loadConfig(required).COOKIE_SECURE).toBe(true);
    expect(loadConfig({ ...required, COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(false);
  });
});

describe('the client credential: secret or federated', () => {
  const tokenFile = '/var/run/secrets/azure/tokens/azure-identity-token';
  const withoutSecret: Record<string, string> = { ...required };
  delete withoutSecret.OIDC_CLIENT_SECRET;
  const hosted = {
    NODE_ENV: 'production',
    APP_DOMAIN: 'app.example.com',
    DATABASE_URL: madeUpDatabaseUrl,
    OIDC_ISSUER: 'https://idp.example.test/tenant-a',
    OIDC_CLIENT_ID: 'made-up-client',
    SESSION_SECRET: required.SESSION_SECRET,
    OIDC_ROLES_CLAIM: 'roles',
    OIDC_ROLE_ADMIN: 'Admin',
    OIDC_ROLE_MODELLER: 'Modeller',
    OIDC_ROLE_VIEWER: 'Viewer',
    OIDC_CLIENT_AUTH: 'federated',
    AZURE_FEDERATED_TOKEN_FILE: tokenFile,
  };

  it('uses the client secret when OIDC_CLIENT_AUTH is unset or secret', () => {
    const secret = { method: 'secret', secret: required.OIDC_CLIENT_SECRET };
    expect(oidcClientAuth(loadConfig(required))).toEqual(secret);
    expect(oidcClientAuth(loadConfig({ ...required, OIDC_CLIENT_AUTH: 'secret' }))).toEqual(secret);
  });

  it('reads the token file instead of the client secret when federated', () => {
    const config = loadConfig({
      ...withoutSecret,
      OIDC_CLIENT_AUTH: 'federated',
      AZURE_FEDERATED_TOKEN_FILE: tokenFile,
    });
    expect(oidcClientAuth(config)).toEqual({ method: 'federated', tokenFile });
    expect(oidcClientAuth(loadConfig(hosted))).toEqual({ method: 'federated', tokenFile });
  });

  it('needs the token file when federated, listed with the other problems', () => {
    expect(() =>
      loadConfig({ ...required, OIDC_CLIENT_AUTH: 'federated', OIDC_ISSUER: 'not-an-address' }),
    ).toThrow(
      /OIDC_ISSUER[\s\S]*is required when OIDC_CLIENT_AUTH is federated[\s\S]*AZURE_FEDERATED_TOKEN_FILE/,
    );
    expect(() => loadConfig({ ...withoutSecret, OIDC_ISSUER: 'not-an-address' })).toThrow(
      /OIDC_ISSUER[\s\S]*is required[\s\S]*OIDC_CLIENT_SECRET/,
    );
  });

  it('refuses any other method', () => {
    expect(() => loadConfig({ ...required, OIDC_CLIENT_AUTH: 'certificate' })).toThrow(
      /must be secret or federated[\s\S]*OIDC_CLIENT_AUTH/,
    );
  });

  it('in the image, says a client secret left on the host is ignored', () => {
    expect(ignoredSettings(hosted)).toEqual([]);
    const withSecret = { ...hosted, OIDC_CLIENT_SECRET: 'made-up-client-secret' };
    expect(oidcClientAuth(loadConfig(withSecret))).toEqual({ method: 'federated', tokenFile });
    expect(ignoredSettings(withSecret)).toEqual(['OIDC_CLIENT_SECRET']);
  });
});

describe('the database sign-in: password or Entra', () => {
  const entraUrl =
    'postgres://made-up-entra-role@made-up-server.postgres.database.azure.com:5432/simplearchitecture';
  const workload = {
    AZURE_CLIENT_ID: 'made-up-identity',
    AZURE_TENANT_ID: 'made-up-tenant',
    AZURE_FEDERATED_TOKEN_FILE: '/var/run/secrets/azure/tokens/azure-identity-token',
  };
  const hosted = {
    NODE_ENV: 'production',
    APP_DOMAIN: 'app.example.com',
    DATABASE_URL: entraUrl,
    OIDC_ISSUER: 'https://idp.example.test/tenant-a',
    OIDC_CLIENT_ID: 'made-up-client',
    OIDC_CLIENT_SECRET: 'made-up-client-secret',
    SESSION_SECRET: required.SESSION_SECRET,
    OIDC_ROLES_CLAIM: 'roles',
    OIDC_ROLE_ADMIN: 'Admin',
    OIDC_ROLE_MODELLER: 'Modeller',
    OIDC_ROLE_VIEWER: 'Viewer',
    DATABASE_AUTH: 'entra',
    ...workload,
  };

  it('uses the password in DATABASE_URL when DATABASE_AUTH is unset or password', () => {
    expect(databaseWorkloadIdentity(loadConfig(required))).toBeUndefined();
    const withPassword = {
      ...required,
      DATABASE_URL: madeUpDatabaseUrl,
      DATABASE_AUTH: 'password',
    };
    expect(databaseWorkloadIdentity(loadConfig(withPassword))).toBeUndefined();
  });

  it('signs in with the workload identity when entra, through the public cloud by default', () => {
    expect(databaseWorkloadIdentity(loadConfig(hosted))).toEqual({
      authorityHost: 'https://login.microsoftonline.com/',
      tenantId: 'made-up-tenant',
      clientId: 'made-up-identity',
      tokenFile: workload.AZURE_FEDERATED_TOKEN_FILE,
    });
    const sovereign = { ...hosted, AZURE_AUTHORITY_HOST: 'https://login.example.test/' };
    expect(databaseWorkloadIdentity(loadConfig(sovereign))?.authorityHost).toBe(
      'https://login.example.test/',
    );
  });

  it.each(['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_FEDERATED_TOKEN_FILE'])(
    'needs %s when entra',
    (name) => {
      const env: Record<string, string> = { ...hosted };
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete env[name];
      expect(() => loadConfig(env)).toThrow(
        new RegExp(`is required when DATABASE_AUTH is entra[\\s\\S]*${name}`),
      );
    },
  );

  it('refuses a password in DATABASE_URL when entra, without echoing it', () => {
    let message = '';
    try {
      loadConfig({ ...hosted, DATABASE_URL: madeUpDatabaseUrl });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(
      /must not hold a password when DATABASE_AUTH is entra[\s\S]*DATABASE_URL/,
    );
    expect(message).not.toContain('made-up-db-password');
  });

  it('refuses any other method or an authority that is not https', () => {
    expect(() => loadConfig({ ...hosted, DATABASE_AUTH: 'certificate' })).toThrow(
      /must be password or entra[\s\S]*DATABASE_AUTH/,
    );
    expect(() =>
      loadConfig({ ...hosted, AZURE_AUTHORITY_HOST: 'http://login.example.test/' }),
    ).toThrow(/AZURE_AUTHORITY_HOST/);
  });

  it('applies to the db:* commands too', () => {
    const database = { DATABASE_URL: entraUrl, DATABASE_AUTH: 'entra', ...workload };
    expect(databaseWorkloadIdentity(loadDatabaseConfig(database))?.clientId).toBe(
      'made-up-identity',
    );
    expect(() => loadDatabaseConfig({ DATABASE_URL: entraUrl, DATABASE_AUTH: 'entra' })).toThrow(
      /AZURE_CLIENT_ID/,
    );
    expect(databaseWorkloadIdentity(loadDatabaseConfig({ DATABASE_URL: madeUpDatabaseUrl }))).toBe(
      undefined,
    );
  });
});
