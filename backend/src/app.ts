import { STATUS_CODES } from 'node:http';
import fastifyHelmet from '@fastify/helmet';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import helmet from 'helmet';
import { registerAuth } from './auth/auth.js';
import { OidcClient } from './auth/oidc.js';
import { PostgresSessionStore } from './auth/postgres-sessions.js';
import {
  defaultSessionTimeouts,
  MemorySessionStore,
  type SessionStore,
  type SessionTimeouts,
} from './auth/sessions.js';
import type { Config } from './config.js';
import { DatabaseService } from './db/service.js';
import { errorBody } from './errors.js';
import { loadOefMapping, type OefMapping } from './oef/mapping-config.js';
import { exchangeRoutes } from './routes/exchange.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { brandingRoutes } from './routes/branding.js';
import { databaseRoutes } from './routes/database.js';
import { elementRoutes } from './routes/elements.js';
import { relationshipRoutes } from './routes/relationships.js';
import { modelRoutes } from './routes/models.js';
import { spaceRoutes } from './routes/spaces.js';
import { resolveDataDir } from './storage/data-dir.js';
import { webAppRoutes } from './web-app.js';
import { BrandingService } from './branding/branding-service.js';
import { ElementService } from './editing/element-service.js';
import { RelationshipService } from './editing/relationship-service.js';
import { FileModelStore } from './storage/file-model-store.js';
import type { ModelStore } from './storage/model-store.js';
import { PostgresModelStore } from './storage/postgres-model-store.js';
import { ModelService } from './models/model-service.js';
import { newModelLimit, uploadLimit } from './rate-limit.js';
import { mcpTokenGuard } from './mcp-auth/guard.js';
import { OAuthService } from './mcp-auth/oauth-service.js';
import { McpReadService } from './mcp/read-service.js';
import { mcpRoutes } from './routes/mcp.js';
import { agentRoutes } from './routes/agents.js';
import { oauthRoutes } from './routes/oauth.js';

/** How long one request may take in all, body included. */
export const requestTimeoutMs = 120_000;

export interface AppOptions {
  /** Overrides OIDC_ISSUER, e.g. with a local mock provider in tests. */
  oidcIssuer?: string;
  /** Tests only: allow plain-HTTP calls to a local mock provider. */
  allowInsecureOidcRequests?: boolean;
  sessionTimeouts?: SessionTimeouts;
  /** Clock, for tests of the session timeouts. */
  now?: () => number;
  /** Tests only: routes registered exactly like the app's own, after auth. */
  extraRoutes?: FastifyPluginAsync;
  /** Tests only: told of every route as it registers, so a test can walk them all. */
  onRoute?: (route: { method: string | string[]; url: string }) => void;
  /** The validated OEF mapping. Without it, buildApp loads it (OEF_MAPPING_PATH or the default). */
  oefMapping?: OefMapping;
  /** Where models are stored. Without it: PostgreSQL with a database, otherwise DATA_DIR. */
  modelStore?: ModelStore;
  /**
   * An open, migrated database (tests: PGlite). Without it, buildApp connects with DATABASE_URL
   * when it is set. The caller closes a database it passes in.
   */
  database?: DatabaseService;
  /** The built web app (see web-app.ts), served for every path outside /api and /auth. */
  webApp?: Parameters<typeof webAppRoutes>[0];
}

/**
 * One helmet policy for every response. The CSP suits the web app served from this origin: its
 * scripts are files (no inline script, the service worker registration included), React Flow
 * positions with inline styles, and the only form posts to /auth/logout on this origin, which
 * leaves for the provider through a page of its own (see auth/auth.ts), not a form redirect.
 */
function securityHeaders(config: Config) {
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        // Only where the site is https: on plain-http development it would break every request.
        upgradeInsecureRequests: config.NODE_ENV === 'production' ? [] : null,
      },
    },
    // Not helmet's no-referrer: under it a browser sends `Origin: null` with the sign-out form, and
    // the CSRF check refuses that. This sends nothing to other sites either.
    referrerPolicy: { policy: 'same-origin' as const },
    // Two years, as the HSTS preload list asks. Browsers ignore it on plain http.
    strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true },
  };
}

/**
 * Behind the host's TLS proxy in production: a request that reached the proxy over plain http is
 * sent to the https web origin (GET, HEAD) or refused. Requests straight to the container (the
 * health probe) carry no X-Forwarded-Proto and pass.
 */
function requireHttps(config: Config) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers['x-forwarded-proto'] === undefined || request.protocol === 'https') return;
    // Only an origin-form target (a path) can follow WEB_ORIGIN; absolute-form or `*` can't.
    if (!request.url.startsWith('/')) return reply.code(400).send(errorBody(400, 'Bad Request'));
    if (request.method === 'GET' || request.method === 'HEAD') {
      return reply.redirect(`${config.WEB_ORIGIN}${request.url}`, 301);
    }
    return reply.code(403).send(errorBody(403, 'HTTPS required'));
  };
}

/** Browser features the app never uses, switched off for it and anything it might load. */
export const permissionsPolicy = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

/**
 * Never log the query of /auth, /oauth and /agents URLs, nor the id in /api/agents/requests/:id:
 * the callback carries the authorization code, an agent's authorize request its state, and the
 * consent page the id of the request it shows.
 */
function loggedUrl(url: string): string {
  if (url.startsWith('/api/agents/requests/')) return '/api/agents/requests/[Redacted]';
  const queryStart = url.indexOf('?');
  if (queryStart === -1 || !/^\/(o?auth|agents)\//.test(url)) return url;
  return `${url.slice(0, queryStart)}?[Redacted]`;
}

/**
 * Builds the Fastify app without listening, so tests can use `app.inject()`.
 * Plugin order matters: security headers first, then auth, then routes.
 */
export async function buildApp(config: Config, options: AppOptions = {}): Promise<FastifyInstance> {
  const isDevelopment = config.NODE_ENV === 'development';
  const now = options.now ?? Date.now;
  const oefMapping = options.oefMapping ?? loadOefMapping(config.OEF_MAPPING_PATH);
  const helmetOptions = securityHeaders(config);
  const applySecurityHeaders = helmet(helmetOptions);

  const app = Fastify({
    // X-Forwarded-* only from the configured number of proxies, so request.ip and
    // request.protocol are the client's, not the proxy's.
    // (Fastify's own number form isn't in its types; this is the same rule.)
    trustProxy: config.TRUST_PROXY === 0 ? false : (_address, hop) => hop < config.TRUST_PROXY,
    // A request (an upload sent very slowly, say) may take this long in all. 0, Fastify's
    // default, would also switch off Node's own limit. Enough for a 10 MB OEF upload.
    requestTimeout: requestTimeoutMs,
    logger: {
      level: config.LOG_LEVEL,
      serializers: {
        req: (request: FastifyRequest) => ({
          method: request.method,
          url: loggedUrl(request.url),
          host: request.host,
          remoteAddress: request.ip,
          ...(request.socket.remotePort === undefined
            ? {}
            : { remotePort: request.socket.remotePort }),
        }),
      },
      // Defence in depth: the default serializers don't log headers, but never let credentials
      // into logs, wherever a headers object is logged (top level or one level down).
      redact: {
        paths: [
          'headers.authorization',
          'headers.cookie',
          'headers["set-cookie"]',
          '*.headers.authorization',
          '*.headers.cookie',
          '*.headers["set-cookie"]',
          // The database URL holds its password: never log either.
          'DATABASE_URL',
          '*.DATABASE_URL',
          'password',
          '*.password',
          'connectionString',
          '*.connectionString',
        ],
        censor: '[Redacted]',
      },
    },
    // Errors Fastify raises before routing (e.g. a malformed URL) skip every hook, so add the
    // security headers here and answer with the standard error body (no echo of the URL).
    frameworkErrors: (error, request, reply) => {
      applySecurityHeaders(request.raw, reply.raw, () => undefined);
      reply.raw.setHeader('permissions-policy', permissionsPolicy);
      const statusCode =
        error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500
          ? error.statusCode
          : 400;
      request.log.info({ code: error.code }, 'request rejected before routing');
      // The handler is generic over the route's types; this one has none.
      void (reply as FastifyReply)
        .code(statusCode)
        .send(errorBody(statusCode, STATUS_CODES[statusCode] ?? 'Error'));
    },
  });

  // 1. Security headers.
  await app.register(fastifyHelmet, helmetOptions);
  // Set first, so every answer has it: routes, errors and not-found alike.
  app.addHook('onRequest', async (_request, reply) => {
    void reply.header('permissions-policy', permissionsPolicy);
  });
  if (config.NODE_ENV === 'production' && config.TRUST_PROXY > 0) {
    app.addHook('onRequest', requireHttps(config));
  }

  // 2. Error and not-found handlers. They must be set before any plugin registers routes:
  //    a route keeps the error handler that was in place when its plugin loaded.
  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send(errorBody(404, 'Not Found'));
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode =
      error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.info({ err: error }, 'request rejected');
    }

    // Client errors (validation, bad JSON) carry safe, Fastify-generated messages.
    // Server errors only reveal their message in development. Stack traces never leave the server.
    const message = statusCode < 500 || isDevelopment ? error.message : 'Internal Server Error';
    return reply.code(statusCode).send(errorBody(statusCode, message));
  });

  // With DATABASE_URL: PostgreSQL for models and sessions, migrated before the API listens.
  // Throws DatabaseStartError or MigrationError, so the API doesn't start.
  const database =
    options.database ??
    (config.DATABASE_URL === undefined
      ? DatabaseService.notConfigured()
      : await DatabaseService.connect(config, app.log));
  if (options.database === undefined) app.addHook('onClose', () => database.close());
  const db = database.db;
  app.log.info({ storage: db === undefined ? 'files' : 'postgres' }, 'model storage');

  // Throws ModelStoreError when DATA_DIR can't be used, so the API doesn't start.
  const modelStore =
    options.modelStore ??
    (db === undefined
      ? await FileModelStore.open(resolveDataDir(config.DATA_DIR), { log: app.log })
      : await PostgresModelStore.open(db, { log: app.log }));

  if (options.onRoute) {
    const { onRoute } = options;
    app.addHook('onRoute', (route) => {
      onRoute({ method: route.method, url: route.url });
    });
  }

  // AI agents (MCP) connect through the app's own OAuth server, which needs PostgreSQL.
  const oauth =
    db === undefined
      ? undefined
      : new OAuthService({ db, webOrigin: config.WEB_ORIGIN, now, log: app.log });
  if (oauth !== undefined) {
    oauth.startSweeping();
    app.addHook('onClose', () => {
      oauth.close();
    });
  }

  // 3. Auth: sessions, the CSRF check and the access guard on every route, and /auth/*.
  const oidc = new OidcClient({
    issuer: options.oidcIssuer ?? config.OIDC_ISSUER,
    clientId: config.OIDC_CLIENT_ID,
    clientSecret: config.OIDC_CLIENT_SECRET,
    redirectUri: config.AUTH_REDIRECT_URI,
    allowInsecureRequests: options.allowInsecureOidcRequests ?? false,
  });
  const timeouts = options.sessionTimeouts ?? defaultSessionTimeouts;
  let sessions: SessionStore;
  if (db === undefined) {
    sessions = new MemorySessionStore(timeouts, now);
  } else {
    const stored = new PostgresSessionStore(db, { timeouts, now, log: app.log });
    stored.startSweeping();
    sessions = stored;
  }
  app.addHook('onClose', () => sessions.close());
  await registerAuth(app, {
    config,
    oidc,
    sessions,
    now,
    ...(oauth === undefined ? {} : { mcpGuard: mcpTokenGuard(oauth, now) }),
  });

  // 4. Routes. Each declares its access rule (see auth/access.ts).
  await app.register(healthRoutes);
  await app.register(meRoutes);
  await app.register(spaceRoutes);
  // One upload budget per user across all upload routes (see rate-limit.ts).
  const uploads = uploadLimit(now);
  await app.register(exchangeRoutes(oefMapping, uploads));
  await app.register(
    modelRoutes({
      store: modelStore,
      service: new ModelService(modelStore),
      mapping: oefMapping,
      uploadLimit: uploads,
      newModelLimit: newModelLimit(now),
    }),
  );
  await app.register(elementRoutes(new ElementService(modelStore)));
  await app.register(relationshipRoutes(new RelationshipService(modelStore)));
  await app.register(databaseRoutes(database, now));
  await app.register(brandingRoutes(new BrandingService(db), uploads));
  if (oauth !== undefined) {
    await app.register(
      oauthRoutes({
        service: oauth,
        webOrigin: config.WEB_ORIGIN,
        now,
      }),
    );
    await app.register(agentRoutes(oauth));
    await app.register(
      mcpRoutes({
        service: new McpReadService(modelStore),
        resource: oauth.addresses.resource,
        now,
      }),
    );
  }
  if (options.extraRoutes) await app.register(options.extraRoutes);
  // Last: the web app answers only what no API route does.
  if (options.webApp) await app.register(webAppRoutes(options.webApp));

  return app;
}
