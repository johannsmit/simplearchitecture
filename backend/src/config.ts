import { z } from 'zod';
import { parseDatabaseUrl } from './db/connection.js';

// Says "is required" for a missing variable; other problems keep their specific message.
const required = {
  error: (issue: { input?: unknown }) => (issue.input === undefined ? 'is required' : undefined),
};
const httpUrl = z.url({ protocol: /^https?$/, ...required });
// A role value as the provider puts it in the ID token. It may hold spaces (a group name, say).
const roleMessage = 'must be one role value of 1 to 250 characters';
const roleValue = z.string().trim().min(1, roleMessage).max(250, roleMessage);
/** In production, SESSION_SECRET needs this many different characters (it rules out "aaaa…"). */
export const minSessionSecretCharacters = 10;

// The rules (TLS for any host but this machine, no weakening sslmode) are in db/connection.ts.
// Its messages never contain the URL, which holds the password.
function checkDatabaseUrl(value: string, context: z.RefinementCtx): void {
  const parsed = parseDatabaseUrl(value);
  if (!parsed.ok) context.addIssue({ code: 'custom', message: parsed.message });
}
const databaseUrl = z.string().superRefine(checkDatabaseUrl);

// One value giving two roles would quietly hand out the higher one.
function rolesDiffer(config: {
  OIDC_ROLE_ADMIN: string;
  OIDC_ROLE_MODELLER: string;
  OIDC_ROLE_VIEWER: string;
}): boolean {
  return (
    new Set([config.OIDC_ROLE_ADMIN, config.OIDC_ROLE_MODELLER, config.OIDC_ROLE_VIEWER]).size === 3
  );
}
const rolesDifferIssue = {
  message: 'OIDC_ROLE_ADMIN, OIDC_ROLE_MODELLER and OIDC_ROLE_VIEWER must all differ',
  path: ['OIDC_ROLE_VIEWER'],
};

// The provider's issuer, kept exactly as written: a trailing slash matters to some providers, and
// the discovered issuer must equal it (auth/oidc.ts). No query, fragment or credentials (OIDC
// Discovery). Plain http only for the tests' local mock provider.
function issuerSetting(protocol: RegExp) {
  return z.url({ protocol, ...required }).refine((value) => {
    if (!URL.canParse(value)) return true; // z.url has said so.
    const url = new URL(value);
    // On the text too: the parsed address hides an empty query, fragment or user name.
    if (/[?#]|^[^/]*\/\/[^/]*@/.test(value)) return false;
    return url.search === '' && url.hash === '' && url.username === '' && url.password === '';
  }, "must be the provider's issuer address, with no query, fragment or user name");
}

// One top-level claim, by its exact name. A long name is fine: Auth0's custom claims are addresses.
const rolesClaimMessage = 'must be the name of one claim, 1 to 250 characters';
const rolesClaim = z.string(required).trim().min(1, rolesClaimMessage).max(250, rolesClaimMessage);
// Any provider's own form: not only Entra's GUIDs.
const clientIdSetting = z.string(required).trim().min(1, 'must not be empty');

/**
 * Tests only (NODE_ENV=test): everything can be set, so the suite can run the real server on a
 * free port, with file storage and without a database. Development and the image read a fixed set.
 */
const testSchema = z
  .object({
    // Always test here; the other modes are the type's, for the schemas below.
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    // 'localhost' makes Fastify listen on both 127.0.0.1 and ::1. In a container: 0.0.0.0.
    HOST: z.string().min(1).default('localhost'),
    // How many reverse proxies (e.g. the host's TLS front end) sit in front of the API. Their
    // X-Forwarded-* headers are trusted for that many hops only. 0: none, the headers are ignored.
    TRUST_PROXY: z.coerce
      .number({ error: 'must be the number of proxies in front of the API (0 for none)' })
      .int()
      .min(0)
      .max(5)
      .default(0),
    // Without it, models are files in DATA_DIR and sessions are in memory.
    DATABASE_URL: databaseUrl.optional(),
    // How long startup waits for an unreachable database (e.g. one still starting) before giving up.
    DATABASE_WAIT_SECONDS: z.coerce.number().int().min(0).max(600).default(60),
    // Where models are stored, one JSON file each. Relative to the repo root.
    DATA_DIR: z.string().default('data'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // The OIDC provider.
    OIDC_ISSUER: issuerSetting(/^https?$/),
    OIDC_CLIENT_ID: clientIdSetting,
    OIDC_CLIENT_SECRET: z.string(required).min(1),
    // Derives the key that encrypts the short-lived login-state cookie.
    SESSION_SECRET: z.string(required).min(32, 'must be at least 32 characters'),
    // The ID token claim holding the roles, and the values in it that give each role. Organisations
    // name them their own way. Matched exactly (case-sensitive).
    OIDC_ROLES_CLAIM: rolesClaim.default('roles'),
    OIDC_ROLE_ADMIN: roleValue.default('Admin'),
    OIDC_ROLE_MODELLER: roleValue.default('Modeller'),
    OIDC_ROLE_VIEWER: roleValue.default('Viewer'),

    // The web app's origin. After sign-in the API only ever redirects here.
    WEB_ORIGIN: httpUrl.refine(
      (value) => new URL(value).origin === value.replace(/\/$/, ''),
      'must be an origin only, like http://localhost:5173 (no path, query or fragment)',
    ),
    // Default: the API's own address (http://localhost:3000/auth/callback), where the web app
    // runs on its own port.
    AUTH_REDIRECT_URI: httpUrl
      .refine(
        (value) => new URL(value).pathname === '/auth/callback',
        'path must be /auth/callback',
      )
      .optional(),
    COOKIE_SECURE: z.stringbool().default(true),
    // Optional: another OEF mapping config (relative to the repo root). Default:
    // config/oef-mapping.json at the repo root.
    OEF_MAPPING_PATH: z.string().optional(),
  })
  .transform(({ WEB_ORIGIN, AUTH_REDIRECT_URI, ...rest }) => ({
    ...rest,
    WEB_ORIGIN: new URL(WEB_ORIGIN).origin,
    AUTH_REDIRECT_URI: AUTH_REDIRECT_URI ?? 'http://localhost:3000/auth/callback',
  }))
  .refine(rolesDiffer, rolesDifferIssue)
  // The callback sets the host-only session cookie, which the browser must then send to the web
  // app. So the callback must be on WEB_ORIGIN's host (the port may differ, as in development).
  .refine(
    (config) => new URL(config.AUTH_REDIRECT_URI).hostname === new URL(config.WEB_ORIGIN).hostname,
    { message: "must be on WEB_ORIGIN's host", path: ['AUTH_REDIRECT_URI'] },
  );

export type Config = z.infer<typeof testSchema>;

/**
 * The settings the hosted image reads (it sets NODE_ENV=production): exactly these, all required.
 * Everything else is fixed, so a host has nothing else to get right.
 */
export const productionSettings = [
  'APP_DOMAIN',
  'DATABASE_URL',
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'SESSION_SECRET',
  'OIDC_ROLES_CLAIM',
  'OIDC_ROLE_ADMIN',
  'OIDC_ROLE_MODELLER',
  'OIDC_ROLE_VIEWER',
] as const;

/**
 * The settings development reads from .env: the image's, plus the two local ports. Exactly these,
 * all required. The web app proxies /api and /auth to the API.
 */
export const developmentSettings = [
  ...productionSettings,
  'FRONTEND_PORT',
  'BACKEND_PORT',
] as const;

/** Settings that earlier versions read. Outside tests they are ignored, with a warning. */
const retiredSettings = [
  'WEB_ORIGIN',
  'AUTH_REDIRECT_URI',
  'AUTH_POST_LOGOUT_REDIRECT_URI',
  'TRUST_PROXY',
  'COOKIE_SECURE',
  'LOG_LEVEL',
  'DATABASE_WAIT_SECONDS',
  'DATABASE_CA_FILE',
  'DATA_DIR',
  'OEF_MAPPING_PATH',
  'PORT',
  'HOST',
];

/** Settings renamed from ENTRA_*, with no fallback. Outside tests they are ignored, with a warning. */
const renamedSettings: Record<string, string> = {
  ENTRA_TENANT_ID: 'OIDC_ISSUER',
  ENTRA_CLIENT_ID: 'OIDC_CLIENT_ID',
  ENTRA_CLIENT_SECRET: 'OIDC_CLIENT_SECRET',
  ENTRA_ROLE_ADMIN: 'OIDC_ROLE_ADMIN',
  ENTRA_ROLE_MODELLER: 'OIDC_ROLE_MODELLER',
  ENTRA_ROLE_VIEWER: 'OIDC_ROLE_VIEWER',
};

const roleSetting = z.string(required).trim().min(1, roleMessage).max(250, roleMessage);

const domainLabel = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const domainPattern = new RegExp(`^${domainLabel}(?:\\.${domainLabel})*$`);

// The settings development and the image both read, all required.
const sharedSettings = {
  // The domain only, e.g. architecture.example.com. A pasted https:// or trailing / is removed.
  APP_DOMAIN: z
    .string(required)
    .transform((value) =>
      value
        .trim()
        .replace(/^https:\/\//i, '')
        .replace(/\/$/, '')
        .toLowerCase(),
    )
    .refine(
      (value) => value.length <= 253 && domainPattern.test(value),
      'must be the domain only, like architecture.example.com (no http://, path or port)',
    ),
  DATABASE_URL: z.string(required).superRefine(checkDatabaseUrl),
  OIDC_ISSUER: issuerSetting(/^https$/),
  OIDC_CLIENT_ID: clientIdSetting,
  OIDC_CLIENT_SECRET: z.string(required).min(1),
  SESSION_SECRET: z.string(required).min(32, 'must be at least 32 characters'),
  OIDC_ROLES_CLAIM: rolesClaim,
  OIDC_ROLE_ADMIN: roleSetting,
  OIDC_ROLE_MODELLER: roleSetting,
  OIDC_ROLE_VIEWER: roleSetting,
};

// Fixed in development and in the image.
const fixed = { LOG_LEVEL: 'info', DATABASE_WAIT_SECONDS: 60, DATA_DIR: 'data' } as const;

const portSetting = z
  .string(required)
  .regex(/^\d{1,5}$/, 'must be a port number, like 3000')
  .transform(Number)
  .refine((port) => port >= 1 && port <= 65535, 'must be a port number from 1 to 65535');

const developmentSchema = z
  .object({ FRONTEND_PORT: portSetting, BACKEND_PORT: portSetting, ...sharedSettings })
  .refine(rolesDiffer, rolesDifferIssue)
  .refine((settings) => settings.FRONTEND_PORT !== settings.BACKEND_PORT, {
    message: 'must differ from FRONTEND_PORT',
    path: ['BACKEND_PORT'],
  })
  .transform(({ APP_DOMAIN, FRONTEND_PORT, BACKEND_PORT, ...settings }): Config => ({
    ...settings,
    ...fixed,
    NODE_ENV: 'development',
    // The web app on Vite; the sign-in callback on the API, which sets the session cookie for
    // APP_DOMAIN (cookies ignore the port). Plain http: providers allow it for localhost only.
    // Normalised as browsers send them: port 80 is left out of the Origin header.
    WEB_ORIGIN: new URL(`http://${APP_DOMAIN}:${FRONTEND_PORT}`).origin,
    AUTH_REDIRECT_URI: new URL(`http://${APP_DOMAIN}:${BACKEND_PORT}/auth/callback`).href,
    PORT: BACKEND_PORT,
    HOST: 'localhost',
    TRUST_PROXY: 0,
    // Plain http: every browser accepts these only without Secure.
    COOKIE_SECURE: false,
  }));

const productionSchema = z
  .object(sharedSettings)
  .refine(rolesDiffer, rolesDifferIssue)
  // Not obviously guessable. A random secret (`openssl rand -base64 48`, or even hex) has far
  // more different characters than this.
  .refine((config) => new Set(config.SESSION_SECRET).size >= minSessionSecretCharacters, {
    message: `is too weak: use a random value (at least ${minSessionSecretCharacters} different characters)`,
    path: ['SESSION_SECRET'],
  })
  .refine((config) => config.SESSION_SECRET !== config.OIDC_CLIENT_SECRET, {
    message: 'must not be the same as OIDC_CLIENT_SECRET',
    path: ['SESSION_SECRET'],
  })
  .transform(({ APP_DOMAIN, ...settings }): Config => {
    const origin = `https://${APP_DOMAIN}`;
    return {
      ...settings,
      ...fixed,
      NODE_ENV: 'production',
      WEB_ORIGIN: origin,
      AUTH_REDIRECT_URI: `${origin}/auth/callback`,
      // The image's port, behind one https proxy (App Service, Container Apps, Caddy, ...).
      PORT: 8080,
      HOST: '0.0.0.0',
      TRUST_PROXY: 1,
      COOKIE_SECURE: true,
    };
  });

export class ConfigError extends Error {
  override name = 'ConfigError';
}

// Treat empty strings as unset (e.g. `DATABASE_URL=` in a .env file).
function withoutEmpty(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== ''),
  );
}

function parseEnv<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv, hint = ''): z.infer<T> {
  const result = schema.safeParse(withoutEmpty(env));
  if (!result.success) {
    // prettifyError names the field and the rule, never the received value, so secrets stay out.
    throw new ConfigError(`Invalid configuration:\n${z.prettifyError(result.error)}${hint}`);
  }
  return result.data;
}

const modes = ['development', 'test', 'production'] as const;
type Mode = (typeof modes)[number];

// Unset means development (npm run dev); the image sets production and the test runner test.
function modeOf(env: NodeJS.ProcessEnv): Mode {
  const mode = env.NODE_ENV === undefined || env.NODE_ENV === '' ? 'development' : env.NODE_ENV;
  if (!(modes as readonly string[]).includes(mode)) {
    throw new ConfigError(
      'Invalid configuration:\n✖ must be development, test or production\n  → at NODE_ENV',
    );
  }
  return mode as Mode;
}

/** Each old setting that is still set and its replacement. Names only, never values. */
export function replacedSettings(
  env: NodeJS.ProcessEnv = process.env,
): { setting: string; replacement: string }[] {
  if (modeOf(env) === 'test') return [];
  const set = withoutEmpty(env);
  return Object.entries(renamedSettings)
    .filter(([setting]) => setting in set)
    .map(([setting, replacement]) => ({ setting, replacement }));
}

// A host still on the old names sees exactly what to change, next to the "is required" problems.
function renameHint(env: NodeJS.ProcessEnv): string {
  return replacedSettings(env)
    .map(({ setting, replacement }) =>
      setting === 'ENTRA_TENANT_ID'
        ? `\n${setting} is no longer read: set ${replacement} to the full address, for Entra ID https://login.microsoftonline.com/<tenant id>/v2.0.`
        : `\n${setting} is no longer read: set ${replacement}.`,
    )
    .join('');
}

/** Validates configuration from environment variables. Throws a ConfigError listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = modeOf(env);
  if (mode === 'test') return parseEnv(testSchema, env);
  if (mode === 'development') {
    return parseEnv(
      developmentSchema,
      env,
      `${renameHint(env)}\nDevelopment reads exactly these settings from .env, all required: ${developmentSettings.join(', ')}.`,
    );
  }
  const moved =
    env.APP_DOMAIN === undefined && env.WEB_ORIGIN !== undefined
      ? '\nWEB_ORIGIN is no longer read: set APP_DOMAIN to the domain only, like architecture.example.com.'
      : '';
  return parseEnv(
    productionSchema,
    env,
    `${moved}${renameHint(env)}\nThe image reads exactly these settings, all required: ${productionSettings.join(', ')}.`,
  );
}

/** Outside tests: the settings that are set but not read, so startup can say they are ignored. */
export function ignoredSettings(env: NodeJS.ProcessEnv = process.env): string[] {
  const mode = modeOf(env);
  if (mode === 'test') return [];
  const read: readonly string[] = mode === 'production' ? productionSettings : developmentSettings;
  const set = withoutEmpty(env);
  return [...developmentSettings, ...retiredSettings].filter(
    (name) => name in set && !read.includes(name),
  );
}

export type DatabaseConfig = Pick<Config, 'DATABASE_URL' | 'DATABASE_WAIT_SECONDS'>;

/** The database setting only, for the `db:*` commands. Throws a ConfigError. */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  return parseEnv(
    z.object({ DATABASE_URL: sharedSettings.DATABASE_URL }).transform((settings) => ({
      ...settings,
      DATABASE_WAIT_SECONDS: fixed.DATABASE_WAIT_SECONDS,
    })),
    env,
  );
}
