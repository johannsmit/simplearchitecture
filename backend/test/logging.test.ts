import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, captureLogs } from './helpers.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const credentials = {
  authorization: 'Bearer test-access-token-123',
  cookie: 'sid=test-session-cookie-456',
};

describe('log redaction', () => {
  it('keeps credentials out of the default request and response logs', async () => {
    app = await buildTestApp({ LOG_LEVEL: 'trace' });
    const lines = captureLogs(app);

    await app.inject({ method: 'GET', url: '/api/health', headers: credentials });
    await app.inject({ method: 'GET', url: '/api/nope', headers: credentials });

    const output = lines.join('');
    expect(output).toContain('request completed');
    expect(output).not.toContain('test-access-token-123');
    expect(output).not.toContain('test-session-cookie-456');
  });

  it('redacts authorization and cookie when request headers are logged', async () => {
    app = await buildTestApp({ LOG_LEVEL: 'info' });
    const lines = captureLogs(app);
    app.get('/log-headers', { config: { access: 'public' } }, (request) => {
      request.log.info({ headers: request.headers }, 'headers');
      return 'ok';
    });

    await app.inject({ method: 'GET', url: '/log-headers', headers: credentials });

    const entry = lines
      .map((line) => JSON.parse(line) as { msg?: string; headers?: Record<string, string> })
      .find((e) => e.msg === 'headers');
    expect(entry?.headers).toMatchObject({ authorization: '[Redacted]', cookie: '[Redacted]' });
    expect(lines.join('')).not.toMatch(/test-access-token-123|test-session-cookie-456/);
  });

  // Set-cookie was only redacted under `res.headers`.
  it('redacts set-cookie when response headers are logged', async () => {
    app = await buildTestApp({ LOG_LEVEL: 'info' });
    const lines = captureLogs(app);
    app.get('/log-reply-headers', { config: { access: 'public' } }, (request, reply) => {
      reply.header('set-cookie', 'sid=test-session-cookie-789; HttpOnly');
      request.log.info({ headers: reply.getHeaders() }, 'reply headers');
      return 'ok';
    });

    await app.inject({ method: 'GET', url: '/log-reply-headers' });

    expect(lines.join('')).not.toContain('test-session-cookie-789');
  });
});
