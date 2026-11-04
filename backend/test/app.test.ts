import type { ApiError, HealthResponse } from '@simplearchitecture/shared';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { permissionsPolicy } from '../src/app.js';
import { buildTestApp } from './helpers.js';

let app: FastifyInstance | undefined;

/**
 * A route that throws, registered by buildApp exactly like the app's own routes (in a plugin,
 * after auth). Adding it to the app after buildApp would miss the routes buildApp registers.
 */
function throwingRoute(message: string): FastifyPluginAsync {
  return async (plugin) => {
    plugin.get('/api/boom', { config: { access: 'public' } }, () => {
      throw new Error(message);
    });
  };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /api/health', () => {
  it('returns 200 with the status only: no version, server or stack details', async () => {
    app = await buildTestApp({ NODE_ENV: 'production' });
    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json<HealthResponse>()).toEqual({ status: 'ok' });
    expect(res.body).not.toMatch(/\d+\.\d+\.\d+|node|fastify|stack/i);
    expect(res.headers.server).toBeUndefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets security headers', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('unknown routes', () => {
  it('return 404 with a generic body', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });

    expect(res.statusCode).toBe(404);
    expect(res.json<ApiError>()).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Not Found',
    });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('security headers on every response', () => {
  function expectSecurityHeaders(headers: Record<string, unknown>) {
    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(headers['referrer-policy']).toBe('same-origin');
    // On every answer, errors raised before routing included.
    expect(headers['permissions-policy']).toBe(permissionsPolicy);
    expect(headers['x-powered-by']).toBeUndefined();
  }

  it.each([
    { name: '404 unknown route', method: 'GET', url: '/api/does-not-exist', status: 404, body: '' },
    { name: '404 wrong method', method: 'POST', url: '/api/health', status: 404, body: '' },
    { name: '400 malformed JSON body', method: 'POST', url: '/api/x', status: 400, body: '{bad' },
  ] as const)('are set on $name', async ({ method, url, status, body }) => {
    app = await buildTestApp();
    const res = await app.inject(
      body
        ? { method, url, payload: body, headers: { 'content-type': 'application/json' } }
        : { method, url },
    );

    expect(res.statusCode).toBe(status);
    expectSecurityHeaders(res.headers);
  });

  it('are set on 500 errors', async () => {
    app = await buildTestApp({ NODE_ENV: 'production' }, { extraRoutes: throwingRoute('boom') });
    const res = await app.inject({ method: 'GET', url: '/api/boom' });

    expect(res.statusCode).toBe(500);
    expectSecurityHeaders(res.headers);
  });

  // Fastify answers a malformed URL before any hook runs.
  it('are set on 400 malformed URL, with the standard error body', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/%zz' });

    expect(res.statusCode).toBe(400);
    expectSecurityHeaders(res.headers);
    expect(res.json<ApiError>()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: expect.any(String) as string,
    });
  });
});

describe('error handler', () => {
  it('hides internal error details and stack traces outside development', async () => {
    app = await buildTestApp(
      { NODE_ENV: 'production' },
      { extraRoutes: throwingRoute('secret internal detail') },
    );
    const res = await app.inject({ method: 'GET', url: '/api/boom' });

    expect(res.statusCode).toBe(500);
    expect(res.json<ApiError>()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
    expect(res.body).not.toContain('secret internal detail');
    expect(res.body).not.toContain('at ');
  });

  // Routes registered inside buildApp kept Fastify's default
  // error handler, because setErrorHandler ran after them. A 5xx there would reveal its message.
  it('also handles errors on the routes buildApp registers', async () => {
    app = await buildTestApp({ NODE_ENV: 'production' });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      payload: '{not json',
    });

    expect(res.statusCode).toBe(400);
    // The app's own body has exactly these fields; Fastify's default adds `code`.
    expect(Object.keys(res.json<ApiError>()).sort()).toEqual(['error', 'message', 'statusCode']);
  });
});
