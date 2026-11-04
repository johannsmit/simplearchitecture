import type { Plugin } from 'vite';

/**
 * Under `npm run dev` only: answers `/sw.js` with a service worker that removes itself. A built
 * app that once ran on the same origin (e.g. `vite preview` on :5173) leaves its worker behind,
 * and that worker keeps serving the old build even under the dev server. The browser checks the
 * worker script on every navigation, finds this one, installs it, and it then unregisters, clears
 * the caches and reloads the open pages, so dev shows the dev build again. The build is untouched:
 * it still gets vite-plugin-pwa's real worker.
 */

/** The worker's path: vite-plugin-pwa's default, so it replaces the built app's worker. */
export const serviceWorkerPath = '/sw.js';

/** The same steps as vite-plugin-pwa's `selfDestroying` worker. */
export const selfDestroyingWorker = `// Development only: removes a service worker left by a built app (see vite/dev-service-worker.ts).
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.registration.unregister();
      const names = await self.caches.keys();
      await Promise.all(names.map((name) => self.caches.delete(name)));
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) client.navigate(client.url);
    })(),
  );
});
`;

export function devServiceWorkerCleanup(): Plugin {
  return {
    name: 'simplearchitecture:dev-service-worker-cleanup',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== serviceWorkerPath) {
          next();
          return;
        }
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(selfDestroyingWorker);
      });
    },
  };
}
