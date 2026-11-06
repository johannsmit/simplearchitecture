import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { clientProtocol } from '../src/app.js';
import { DatabaseError } from '../src/db/db.js';
import { MigrationError } from '../src/db/migrate.js';
import { waitForDatabase, type DatabaseLogger } from '../src/db/service.js';
import { immutableCache, loadWebApp, revalidateCache, WebAppError } from '../src/web-app.js';
import { buildTestApp } from './helpers.js';

// A made-up build, shaped like Vite's output (frontend/dist).
const indexHtml =
  '<!doctype html><html><head><script src="/theme-init.js"></script>' +
  '<script type="module" src="/assets/index-abc123.js"></script>' +
  '<script id="vite-plugin-pwa:register-sw" src="/registerSW.js"></script></head>' +
  '<body><div id="root"></div></body></html>';
const appScript = `console.log(${JSON.stringify('x'.repeat(4000))});`;
let distDir: string;

beforeAll(() => {
  distDir = mkdtempSync(join(tmpdir(), 'sa-web-'));
  mkdirSync(join(distDir, 'assets'));
  writeFileSync(join(distDir, 'index.html'), indexHtml);
  writeFileSync(join(distDir, 'assets', 'index-abc123.js'), appScript);
  writeFileSync(join(distDir, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  writeFileSync(join(distDir, 'manifest.webmanifest'), '{"name":"Test"}');
});

afterAll(() => {
  rmSync(distDir, { recursive: true, force: true });
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('the built web app, served from the API origin', () => {
  const start = async () => (app = await buildTestApp({}, { webApp: loadWebApp(distDir) }));

  it('serves index.html at / and for the app routes (SPA fallback), revalidated', async () => {
    const web = await start();
    for (const url of ['/', '/viewing/models', '/viewing/models/3f9c?x=1']) {
      const res = await web.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe(revalidateCache);
      expect(res.body).toBe(indexHtml);
    }
  });

  it('caches hashed assets for a year, but never the service worker or the manifest', async () => {
    const web = await start();
    const asset = await web.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(asset.headers['cache-control']).toBe(immutableCache);
    for (const url of ['/sw.js', '/manifest.webmanifest']) {
      const res = await web.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['cache-control'], url).toBe('no-cache');
    }
  });

  it('answers 304 to a matching ETag and gzips for clients that accept it', async () => {
    const web = await start();
    const url = '/assets/index-abc123.js';
    const plain = await web.inject({ method: 'GET', url });
    const again = await web.inject({
      method: 'GET',
      url,
      headers: { 'if-none-match': String(plain.headers.etag) },
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');

    const zipped = await web.inject({
      method: 'GET',
      url,
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(zipped.headers.vary).toBe('Accept-Encoding');
    expect(zipped.headers.etag).not.toBe(plain.headers.etag);
    expect(gunzipSync(zipped.rawPayload).toString()).toBe(appScript);
  });

  it('keeps /api and /auth for the API, and 404s missing files instead of sending index.html', async () => {
    const web = await start();
    for (const url of ['/api/nope', '/api', '/auth/nope', '/assets/gone-123.js', '/favicon.ico']) {
      const res = await web.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).toContain('application/json');
    }
    // Never a file outside the build, whatever the path looks like.
    for (const url of ['/../package.json', '/assets/..%2f..%2fpackage.json', '/%2e%2e/x.json']) {
      const res = await web.inject({ method: 'GET', url });
      expect(res.body, url).not.toContain('"name"');
      expect(res.statusCode, url).not.toBe(200);
    }
    // Only GET and HEAD: other methods on app paths match no route.
    expect((await web.inject({ method: 'POST', url: '/viewing' })).statusCode).toBe(404);
  });

  it('sends a CSP that lets the built app run with no inline script, and HSTS', async () => {
    const web = await start();
    const res = await web.inject({ method: 'GET', url: '/' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // Sign-out posts to this origin and leaves from there by a page of its own, not a redirect.
    expect(csp).toMatch(/form-action 'self'(;|$)/);
    // Plain-http development: upgrading would break every request.
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(res.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
    // The built index.html loads scripts from files only (checked on the real build too).
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });

  it('upgrades insecure requests in production', async () => {
    app = await buildTestApp({ NODE_ENV: 'production' });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['content-security-policy']).toContain('upgrade-insecure-requests');
  });

  it('does not serve a symlink that points outside the build', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'sa-outside-'));
    const dist = mkdtempSync(join(tmpdir(), 'sa-web-link-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'made-up-secret');
      writeFileSync(join(dist, 'index.html'), indexHtml);
      symlinkSync(join(outside, 'secret.txt'), join(dist, 'leak.txt'));
      symlinkSync(outside, join(dist, 'linked'));
      const web = await buildTestApp({}, { webApp: loadWebApp(dist) });
      app = web;
      for (const url of ['/leak.txt', '/linked/secret.txt']) {
        const res = await web.inject({ method: 'GET', url });
        expect(res.body, url).not.toContain('made-up-secret');
        expect(res.statusCode, url).toBe(404);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('refuses to start without an index.html', () => {
    expect(() => loadWebApp(join(distDir, 'assets'))).toThrow(WebAppError);
  });
});

/** A GET with the path sent exactly as given (inject and fetch would normalise `..` first). */
function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('path tricks against the served web app (over a real socket)', () => {
  // Made-up files next to the build and in the app folder: none may ever be served.
  const marker = 'made-up-secret-marker';
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'sa-traversal-'));
    mkdirSync(join(root, 'dist', 'assets'), { recursive: true });
    writeFileSync(join(root, 'dist', 'index.html'), indexHtml);
    writeFileSync(join(root, 'dist', 'assets', 'index-abc123.js'), appScript);
    writeFileSync(join(root, 'secret.txt'), marker);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: marker }));
    writeFileSync(join(root, '.env'), `SESSION_SECRET=${marker}`);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const paths = [
    '/../secret.txt',
    '/../../secret.txt',
    '/assets/../../secret.txt',
    '/./../package.json',
    '/%2e%2e/secret.txt',
    '/%2E%2E/%2E%2E/secret.txt',
    '/%2e%2e%2fsecret.txt',
    '/assets/%2e%2e/%2e%2e/package.json',
    '/assets/..%2f..%2fpackage.json',
    '/..%5csecret.txt',
    '/..\\secret.txt',
    '/%252e%252e/secret.txt',
    '/%c0%ae%c0%ae/secret.txt',
    '/..;/secret.txt',
    '//secret.txt',
    '/secret.txt',
    '/package.json',
    '/.env',
    '/../.env',
    '/%2e%65nv',
    '/index.html%00.txt',
    '/backend/dist/server.js',
    '/node_modules/fastify/package.json',
    '/etc/passwd',
    '/../../../../../../etc/passwd',
    '/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
  ];

  it('answers every trick with the app shell or an error, never a file outside the build', async () => {
    const web = await buildTestApp({}, { webApp: loadWebApp(join(root, 'dist')) });
    app = web;
    await web.listen({ port: 0, host: '127.0.0.1' });
    const { port } = web.server.address() as AddressInfo;
    for (const path of paths) {
      const res = await rawGet(port, path);
      expect(res.body, path).not.toContain(marker);
      expect(res.body, path).not.toMatch(/root:.*:0:0:/);
      // 200 only ever for the app shell itself (the client-side router shows its own not-found).
      if (res.status === 200) expect(res.body, path).toBe(indexHtml);
      else expect([400, 404], path).toContain(res.status);
    }
    // The real files still come through.
    expect((await rawGet(port, '/assets/index-abc123.js')).body).toBe(appScript);
  });
});

describe('behind the host TLS proxy (TRUST_PROXY)', () => {
  const webOrigin = 'https://app.example.com';
  const echo = async (instance: FastifyInstance) => {
    instance.get('/api/test/echo', { config: { access: 'public' } }, async (request) => ({
      ip: request.ip,
      protocol: request.protocol,
    }));
  };
  const production = (trustProxy: number) =>
    buildTestApp(
      {
        NODE_ENV: 'production',
        TRUST_PROXY: trustProxy,
        WEB_ORIGIN: webOrigin,
        AUTH_REDIRECT_URI: `${webOrigin}/auth/callback`,
      },
      { extraRoutes: echo },
    );

  it('trusts one hop of X-Forwarded-For and X-Forwarded-Proto, and no more', async () => {
    app = await production(1);
    const res = await app.inject({
      method: 'GET',
      url: '/api/test/echo',
      headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.7', 'x-forwarded-proto': 'https' },
    });
    expect(res.json()).toEqual({ ip: '198.51.100.7', protocol: 'https' });
  });

  it('ignores the forwarded headers when TRUST_PROXY is 0 (the default)', async () => {
    app = await buildTestApp({}, { extraRoutes: echo });
    const res = await app.inject({
      method: 'GET',
      url: '/api/test/echo',
      headers: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' },
    });
    expect(res.json()).toEqual({ ip: '127.0.0.1', protocol: 'http' });
  });

  it('sends plain-http requests to https in production, and refuses unsafe ones', async () => {
    app = await production(1);
    const get = await app.inject({
      method: 'GET',
      url: '/viewing/models?x=1',
      headers: { 'x-forwarded-proto': 'http', host: 'evil.example' },
    });
    expect(get.statusCode).toBe(301);
    expect(get.headers.location).toBe(`${webOrigin}/viewing/models?x=1`);

    const post = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { 'x-forwarded-proto': 'http', origin: webOrigin },
    });
    expect(post.statusCode).toBe(403);
    expect(post.json()).toMatchObject({ message: 'HTTPS required' });
  });

  it('only ever redirects to WEB_ORIGIN, whatever the path or Host looks like (no open redirect)', async () => {
    app = await production(1);
    for (const url of [
      '//evil.example/x',
      '/\\evil.example',
      '/@evil.example',
      '/%2f%2fevil.example',
    ]) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: {
          'x-forwarded-proto': 'http',
          host: 'evil.example',
          'x-forwarded-host': 'evil.example',
        },
      });
      expect(res.statusCode, url).toBe(301);
      const location = String(res.headers.location);
      expect(location.startsWith(`${webOrigin}/`), url).toBe(true);
      expect(new URL(location).origin, url).toBe(webOrigin);
    }
  });

  it('behind two proxies (a front door, then an ingress over http), reads the client two hops back', async () => {
    app = await production(2);
    const through = await app.inject({
      method: 'GET',
      url: '/api/test/echo',
      headers: {
        'x-forwarded-for': '203.0.113.9, 198.51.100.7',
        'x-forwarded-proto': 'https, http',
      },
    });
    expect(through.statusCode).toBe(200);
    expect(through.json()).toMatchObject({ ip: '203.0.113.9' });

    for (const proto of ['http, http', 'http']) {
      const res = await app.inject({
        method: 'GET',
        url: '/viewing/models',
        headers: { 'x-forwarded-proto': proto },
      });
      expect(res.statusCode, proto).toBe(301);
    }
  });

  it("with one proxy, only that proxy's own (last) value counts", async () => {
    app = await production(1);
    const res = await app.inject({
      method: 'GET',
      url: '/viewing/models',
      headers: { 'x-forwarded-proto': 'https, http' },
    });
    expect(res.statusCode).toBe(301);
  });

  it('lets the health probe (straight to the container, no forwarded headers) through', async () => {
    app = await production(1);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['strict-transport-security']).toBeDefined();
  });
});

describe('waiting for the database at startup', () => {
  const unreachable = new DatabaseError('unreachable', 'ECONNREFUSED');
  const logged: { details: object; message: string }[] = [];
  const log: DatabaseLogger = {
    info: () => undefined,
    warn: (details, message) => logged.push({ details, message }),
    error: () => undefined,
  };
  const fakeClock = () => {
    let time = 0;
    const slept: number[] = [];
    return {
      slept,
      wait: (totalMs: number) => ({
        totalMs,
        now: () => time,
        sleep: async (ms: number) => {
          slept.push(ms);
          time += ms;
        },
      }),
    };
  };

  afterEach(() => {
    logged.length = 0;
  });

  it('retries an unreachable database with growing pauses until it answers', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await waitForDatabase(
      async () => {
        calls += 1;
        if (calls < 4) throw unreachable;
        return 'migrated';
      },
      log,
      clock.wait(60_000),
    );
    expect(result).toBe('migrated');
    expect(clock.slept).toEqual([1_000, 2_000, 4_000]);
    expect(logged[0]).toEqual({
      details: { failure: 'unreachable', attempt: 1, retryInSeconds: 1 },
      message: 'database not reachable yet, retrying',
    });
  });

  it('gives up after the bounded time with the last error', async () => {
    const clock = fakeClock();
    await expect(
      waitForDatabase(() => Promise.reject(unreachable), log, clock.wait(20_000)),
    ).rejects.toBe(unreachable);
    expect(clock.slept).toEqual([1_000, 2_000, 4_000, 8_000, 5_000]);
  });

  it("doesn't wait when waiting can't help (a refused sign-in, a bad migration)", async () => {
    const clock = fakeClock();
    const refused = new DatabaseError('auth', '28P01');
    await expect(
      waitForDatabase(() => Promise.reject(refused), log, clock.wait(60_000)),
    ).rejects.toBe(refused);
    const bad = new MigrationError('bad');
    await expect(waitForDatabase(() => Promise.reject(bad), log, clock.wait(60_000))).rejects.toBe(
      bad,
    );
    expect(clock.slept).toEqual([]);
  });

  it('waits for Entra ID when it is out of reach, but not when it refuses the identity', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await waitForDatabase(
      async () => {
        calls += 1;
        if (calls === 1) throw new DatabaseError('identity', 'ENTRA_UNREACHABLE');
        if (calls === 2) throw new DatabaseError('identity', 'HTTP_503');
        return 'migrated';
      },
      log,
      clock.wait(60_000),
    );
    expect(result).toBe('migrated');
    const refused = new DatabaseError('identity', 'AADSTS700213');
    await expect(
      waitForDatabase(() => Promise.reject(refused), log, clock.wait(60_000)),
    ).rejects.toBe(refused);
    expect(clock.slept).toEqual([1_000, 2_000]);
  });

  it('retries a server that is still starting up (57P03)', async () => {
    const clock = fakeClock();
    let calls = 0;
    await waitForDatabase(
      async () => {
        calls += 1;
        if (calls === 1) throw new DatabaseError('other', '57P03');
      },
      log,
      clock.wait(60_000),
    );
    expect(calls).toBe(2);
  });
});

describe('clientProtocol', () => {
  it.each([
    ['https', 1, 'https'],
    ['https, http', 1, 'http'],
    ['https, http', 2, 'https'],
    ['HTTPS ,http', 2, 'https'],
    ['http', 2, 'http'],
    [['https', 'http'], 2, 'https'],
    ['https, http', 0, 'http'],
  ] as const)('%j with %d trusted proxies is %s', (header, proxies, expected) => {
    expect(clientProtocol(header as string | string[], proxies)).toBe(expected);
  });
});
