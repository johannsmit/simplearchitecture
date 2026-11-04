import type { ApiError } from '@simplearchitecture/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sampleModel } from '../src/jgf/sample.js';
import {
  RateLimiter,
  signInsPerMinute,
  signInBusyPath,
  tooManyUploadsMessage,
  uploadsPerMinute,
} from '../src/rate-limit.js';
import {
  buildTestApp,
  idpOptions,
  signIn,
  startMockIdp,
  webOrigin,
  withClaims,
} from './helpers.js';

describe('RateLimiter', () => {
  it('allows the limit per key in the window, then refuses until the window has passed', () => {
    let time = 0;
    const limiter = new RateLimiter(3, 60_000, () => time);
    expect([1, 2, 3, 4].map(() => limiter.allow('a'))).toEqual([true, true, true, false]);
    expect(limiter.allow('b')).toBe(true);
    time = 59_999;
    expect(limiter.allow('a')).toBe(false);
    time = 60_001;
    expect(limiter.allow('a')).toBe(true);
  });

  it('keeps memory bounded when many different keys arrive at once', () => {
    const limiter = new RateLimiter(1, 60_000, () => 0);
    for (let i = 0; i < 25_000; i += 1) limiter.allow(`key-${i}`);
    expect(limiter.size).toBeLessThanOrEqual(10_001);
  });
});

let idp: OAuth2Server;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  idp = await startMockIdp();
});

afterAll(async () => {
  await idp.stop();
});

afterEach(async () => {
  idp.service.removeAllListeners('beforeTokenSigning');
  await app?.close();
  app = undefined;
});

function expectTooMany(res: LightMyRequestResponse, message: string) {
  expect(res.statusCode).toBe(429);
  expect(res.headers['retry-after']).toBe('60');
  expect(res.json<ApiError>()).toEqual({ statusCode: 429, error: 'Too Many Requests', message });
}

/** Sign-in is a browser navigation: over the limit it goes to a fixed page, never JSON. */
function expectSignInBusy(res: LightMyRequestResponse) {
  expect(res.statusCode).toBe(303);
  expect(res.headers.location).toBe(`${webOrigin}${signInBusyPath}`);
  expect(res.headers['retry-after']).toBe('60');
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.cookies).toEqual([]);
}

describe('sign-in starts (/auth/login)', () => {
  it(`allows ${signInsPerMinute} per minute per client address, then sends to the busy page`, async () => {
    let time = 1_000_000;
    const target = (app = await buildTestApp({}, idpOptions(idp, { now: () => time })));
    const login = (remoteAddress: string) =>
      target.inject({ method: 'GET', url: '/auth/login?returnTo=/viewing/made-up', remoteAddress });

    for (let i = 0; i < signInsPerMinute; i += 1) {
      expect((await login('192.0.2.10')).statusCode).toBe(302);
    }
    // Nothing from the request (here returnTo) goes into the redirect.
    expectSignInBusy(await login('192.0.2.10'));

    // Another address has its own budget; after a minute the first one has again.
    expect((await login('192.0.2.11')).statusCode).toBe(302);
    time += 60_001;
    expect((await login('192.0.2.10')).statusCode).toBe(302);
  });

  it('counts the client address behind the proxy, not the proxy (TRUST_PROXY)', async () => {
    const target = (app = await buildTestApp({ TRUST_PROXY: 1 }, idpOptions(idp)));
    const login = (client: string) =>
      target.inject({
        method: 'GET',
        url: '/auth/login',
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': client },
      });
    for (let i = 0; i < signInsPerMinute; i += 1) await login('198.51.100.7');
    expectSignInBusy(await login('198.51.100.7'));
    expect((await login('198.51.100.8')).statusCode).toBe(302);
  });
});

describe('sign-in callbacks (/auth/callback)', () => {
  it(`allows ${signInsPerMinute} per minute per client address, counted apart from the starts`, async () => {
    const target = (app = await buildTestApp({}, idpOptions(idp)));
    const send = (url: string) =>
      target.inject({ method: 'GET', url, remoteAddress: '192.0.2.20' });
    // Without a login cookie each one fails (to the sign-in failed page), but still counts.
    for (let i = 0; i < signInsPerMinute; i += 1) {
      expect((await send('/auth/callback?code=made-up&state=made-up')).statusCode).toBe(302);
    }
    expectSignInBusy(await send('/auth/callback?code=made-up&state=made-up'));
    // A sign-in start from the same address has its own count.
    expect((await send('/auth/login')).statusCode).toBe(302);
  });
});

describe('uploads', () => {
  const jgf = JSON.stringify(sampleModel);
  const upload = (
    target: FastifyInstance,
    cookie: string,
    url: string,
    contentType = 'application/json',
    payload = jgf,
  ) =>
    target.inject({
      method: url.includes('/logo') ? 'PUT' : 'POST',
      url,
      headers: { origin: webOrigin, cookie, 'content-type': contentType },
      payload,
    });

  async function signedIn(target: FastifyInstance, oid: string, roles: string[]): Promise<string> {
    idp.service.removeAllListeners('beforeTokenSigning');
    withClaims(idp, { oid, roles });
    return (await signIn(target)).sessionCookie;
  }

  it(`allows ${uploadsPerMinute} per minute per user across the upload routes, then answers 429`, async () => {
    let time = 1_000_000;
    const target = (app = await buildTestApp({}, idpOptions(idp, { now: () => time })));
    const admin = await signedIn(target, 'made-up-admin', ['Admin']);
    const other = await signedIn(target, 'made-up-modeller', ['Modeller']);

    // One budget for all of them: checks, saves and the logo.
    for (let i = 0; i < uploadsPerMinute; i += 1) {
      const url = i % 2 === 0 ? '/api/import/jgf' : '/api/models';
      expect((await upload(target, admin, url)).statusCode, url).not.toBe(429);
    }
    expectTooMany(await upload(target, admin, '/api/import/jgf'), tooManyUploadsMessage);
    expectTooMany(await upload(target, admin, '/api/models'), tooManyUploadsMessage);
    expectTooMany(
      await upload(target, admin, '/api/models/import/oef', 'application/xml', '<model/>'),
      tooManyUploadsMessage,
    );
    expectTooMany(
      await upload(target, admin, '/api/import/oef', 'application/xml', '<model/>'),
      tooManyUploadsMessage,
    );
    expectTooMany(
      await upload(target, admin, '/api/admin/branding/logo?version=0', 'image/png', 'x'),
      tooManyUploadsMessage,
    );

    // Another user has their own budget; after a minute the first has again.
    expect((await upload(target, other, '/api/import/jgf')).statusCode).toBe(200);
    time += 60_001;
    expect((await upload(target, admin, '/api/import/jgf')).statusCode).toBe(200);
  });

  it('never counts requests the access guard refuses', async () => {
    const target = (app = await buildTestApp({}, idpOptions(idp)));
    const viewer = await signedIn(target, 'made-up-viewer', ['Viewer']);
    for (let i = 0; i < uploadsPerMinute + 2; i += 1) {
      expect((await upload(target, viewer, '/api/import/jgf')).statusCode).toBe(403);
      expect((await upload(target, '', '/api/import/jgf')).statusCode).toBe(401);
    }
  });

  it('leaves the other routes alone', async () => {
    const target = (app = await buildTestApp({}, idpOptions(idp)));
    const admin = await signedIn(target, 'made-up-admin', ['Admin']);
    for (let i = 0; i < uploadsPerMinute + 2; i += 1) {
      const res = await target.inject({
        method: 'GET',
        url: '/api/models',
        headers: { cookie: admin },
      });
      expect(res.statusCode).toBe(200);
    }
  });
});
