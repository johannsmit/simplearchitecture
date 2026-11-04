import type { IncomingMessage, ServerResponse } from 'node:http';
import { Script } from 'node:vm';
import type { ViteDevServer } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import {
  devServiceWorkerCleanup,
  selfDestroyingWorker,
  serviceWorkerPath,
} from '../vite/dev-service-worker';

type Middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => void;

function middleware(): Middleware {
  const plugin = devServiceWorkerCleanup();
  let registered: Middleware | undefined;
  const server = {
    middlewares: {
      use: (handler: Middleware) => {
        registered = handler;
      },
    },
  } as unknown as ViteDevServer;
  (plugin.configureServer as (server: ViteDevServer) => void)(server);
  if (!registered) throw new Error('no middleware');
  return registered;
}

describe('dev service worker cleanup', () => {
  it('runs under the dev server only, never in the build', () => {
    expect(devServiceWorkerCleanup().apply).toBe('serve');
  });

  it('answers /sw.js with a worker that unregisters itself, clears caches and reloads pages', () => {
    const response = { setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();
    middleware()(
      { url: `${serviceWorkerPath}?v=1` } as IncomingMessage,
      response as unknown as ServerResponse,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/javascript; charset=utf-8',
    );
    expect(response.end).toHaveBeenCalledWith(selfDestroyingWorker);
    expect(selfDestroyingWorker).toContain('self.skipWaiting()');
    expect(selfDestroyingWorker).toContain('self.registration.unregister()');
    expect(selfDestroyingWorker).toContain('caches.delete');
    expect(selfDestroyingWorker).toContain('client.navigate(client.url)');
    // It is valid JavaScript (compiled, not run).
    expect(() => new Script(selfDestroyingWorker)).not.toThrow();
  });

  it('leaves every other request to Vite', () => {
    const next = vi.fn();
    const response = { setHeader: vi.fn(), end: vi.fn() };
    for (const url of ['/', '/viewing', '/sw.js.map', '/src/main.tsx', '/api/models']) {
      middleware()({ url } as IncomingMessage, response as unknown as ServerResponse, next);
    }
    expect(next).toHaveBeenCalledTimes(5);
    expect(response.end).not.toHaveBeenCalled();
  });
});
