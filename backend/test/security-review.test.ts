// Pins what a security review of the app found: its fixes, and behaviour it confirmed is safe.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadWebApp } from '../src/web-app.js';
import {
  buildTestApp,
  captureLogs,
  idpOptions,
  signIn,
  startMockIdp,
  webOrigin,
  withClaims,
} from './helpers.js';

let idp: OAuth2Server;
let app: FastifyInstance | undefined;
let distDir: string;

beforeAll(async () => {
  idp = await startMockIdp();
  // A made-up build with files that must never be served, should they ever land in it.
  distDir = mkdtempSync(join(tmpdir(), 'sa-web-review-'));
  mkdirSync(join(distDir, 'assets'));
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(distDir, 'assets', 'index-abc123.js'), 'console.log(1);');
  writeFileSync(join(distDir, 'assets', 'index-abc123.js.map'), '{"sources":["src/main.tsx"]}');
  writeFileSync(join(distDir, '.env'), 'MADE_UP_SECRET=not-a-real-value');
  mkdirSync(join(distDir, '.git'));
  writeFileSync(join(distDir, '.git', 'config'), '[core]');
});

afterAll(async () => {
  await idp.stop();
  rmSync(distDir, { recursive: true, force: true });
});

afterEach(async () => {
  idp.service.removeAllListeners('beforeTokenSigning');
  await app?.close();
  app = undefined;
});

/** Sends one raw HTTP/1.1 request (for request targets `inject` can't send) and returns the head. */
function rawRequest(target: FastifyInstance, request: string): Promise<string> {
  const address = target.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    socket.on('data', (chunk: Buffer) => (data += chunk.toString('latin1')));
    socket.on('end', () => {
      resolve(data.split('\r\n\r\n', 1)[0] ?? '');
    });
    socket.on('error', reject);
  });
}

describe('error responses and logs never carry request content', () => {
  it('a broken JSON body or an odd Content-Type is not echoed, and the body is not logged', async () => {
    app = await buildTestApp({ LOG_LEVEL: 'trace' }, idpOptions(idp));
    const logs = captureLogs(app);
    withClaims(idp, { roles: ['Admin'], name: 'Sam Example' });
    const { sessionCookie } = await signIn(app);
    const headers = { origin: webOrigin, cookie: sessionCookie };
    const marker = 'MadeUpModelContent42';
    const modelId = '3f9c2b1e-0000-4000-8000-000000000001';

    const responses = [
      await app.inject({
        method: 'PATCH',
        url: `/api/models/${modelId}/elements/e1`,
        headers: { ...headers, 'content-type': 'application/json' },
        payload: `{"name": "${marker}" broken`,
      }),
      await app.inject({
        method: 'PUT',
        url: '/api/admin/branding',
        headers: { ...headers, 'content-type': 'application/json' },
        payload: `{"primary": "${marker}"`,
      }),
      await app.inject({
        method: 'POST',
        url: '/api/admin/database/test',
        headers: { ...headers, 'content-type': `text/${marker}` },
        payload: marker,
      }),
      await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { origin: webOrigin, 'content-type': `text/${marker}` },
        payload: marker,
      }),
    ];
    for (const res of responses) {
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.body).not.toContain(marker);
    }
    expect(logs.join('')).not.toContain(marker);
  });
});

describe('the built web app', () => {
  it('never serves dotfiles or source maps, even when the build folder holds them', async () => {
    app = await buildTestApp({}, { webApp: loadWebApp(distDir) });
    for (const url of ['/.env', '/.git/config', '/assets/index-abc123.js.map']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain('MADE_UP_SECRET');
      expect(res.body, url).not.toContain('sources');
    }
    // The app itself is still served.
    const asset = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(asset.statusCode).toBe(200);
  });
});

describe('behind the TLS proxy in production', () => {
  const origin = 'https://app.example.com';
  const production = () =>
    buildTestApp(
      {
        NODE_ENV: 'production',
        TRUST_PROXY: 1,
        WEB_ORIGIN: origin,
        AUTH_REDIRECT_URI: `${origin}/auth/callback`,
      },
      idpOptions(idp),
    );

  it('an absolute-form or asterisk request target never becomes a malformed redirect', async () => {
    app = await production();
    await app.listen({ port: 0, host: '127.0.0.1' });
    for (const target of ['https://a.evil.example/x', 'http://a.evil.example/x', '*']) {
      const head = await rawRequest(
        app,
        `GET ${target} HTTP/1.1\r\nHost: app.example.com\r\nX-Forwarded-Proto: http\r\nConnection: close\r\n\r\n`,
      );
      const location = /\r\nlocation: ([^\r\n]*)/i.exec(head)?.[1];
      // Either refused outright, or sent to a path on WEB_ORIGIN itself.
      if (location !== undefined) {
        expect(new URL(location).origin, target).toBe(origin);
        expect(location.startsWith(`${origin}/`), target).toBe(true);
      } else {
        expect(head.split('\r\n')[0], target).toMatch(/^HTTP\/1\.1 4\d\d /);
      }
    }
  });
});

describe('server limits', () => {
  it('a request that is sent slowly is timed out (Fastify requestTimeout is set)', async () => {
    app = await buildTestApp({}, idpOptions(idp));
    // 0 means no limit: Fastify's default, which also switches off Node's own 300 s default.
    expect(app.server.requestTimeout).toBeGreaterThan(0);
  });
});

describe('security headers', () => {
  it('a Permissions-Policy turns off browser features the app never uses', async () => {
    app = await buildTestApp({}, idpOptions(idp));
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    const policy = String(res.headers['permissions-policy'] ?? '');
    for (const feature of ['camera=()', 'microphone=()', 'geolocation=()']) {
      expect(policy).toContain(feature);
    }
  });
});
