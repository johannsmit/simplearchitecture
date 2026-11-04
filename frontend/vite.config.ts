import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';
import { devServiceWorkerCleanup } from './vite/dev-service-worker.js';
import { thirdPartyLicenses } from './vite/third-party-licenses.js';

/**
 * APP_DOMAIN, FRONTEND_PORT and BACKEND_PORT from the repo root's .env, the same values the API
 * reads (see .env.example). Required for the dev server and preview; the build and the tests
 * don't use them.
 */
function localAddress(
  mode: string,
): { domain: string; frontend: number; backend: number } | undefined {
  if (process.env.VITEST !== undefined) return undefined;
  const env = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), [
    'APP_DOMAIN',
    'FRONTEND_PORT',
    'BACKEND_PORT',
  ]);
  const domain = (env.APP_DOMAIN ?? '').trim().toLowerCase();
  const frontend = Number(env.FRONTEND_PORT);
  const backend = Number(env.BACKEND_PORT);
  const valid = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535;
  if (domain === '' || !valid(frontend) || !valid(backend)) {
    throw new Error('Set APP_DOMAIN, FRONTEND_PORT and BACKEND_PORT in .env (see .env.example).');
  }
  return { domain, frontend, backend };
}

export default defineConfig(({ command, mode }) => {
  const local = command === 'serve' ? localAddress(mode) : undefined;
  // Requests to /api, /auth and the AI agents' /oauth, /mcp and OAuth metadata go to the API, in
  // dev and in preview.
  const apiTarget = `http://localhost:${String(local?.backend ?? 0)}`;
  const server = {
    // The browser uses APP_DOMAIN (localhost is always allowed; another name must point here).
    ...(local === undefined ? {} : { port: local.frontend, allowedHosts: [local.domain] }),
    strictPort: true,
    proxy: {
      '^/api(/|$)': { target: apiTarget },
      '^/auth(/|$)': { target: apiTarget },
      '^/oauth(/|$)': { target: apiTarget },
      '^/mcp(/|$)': { target: apiTarget },
      '^/\\.well-known/oauth-': { target: apiTarget },
    },
  };
  return {
    resolve: { tsconfigPaths: true },
    plugins: [
      react(),
      thirdPartyLicenses(),
      // Dev only: a worker left by a built app on this origin removes itself.
      devServiceWorkerCleanup(),
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: 'auto',
        // globPatterns below already covers everything in public/, including the icons.
        includeManifestIcons: false,
        manifest: {
          name: 'SimpleArchitecture',
          short_name: 'SimpleArch',
          description: 'Model and explore your IT architecture.',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          theme_color: '#1f4e79',
          background_color: '#ffffff',
          icons: [
            { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
            { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
          ],
        },
        workbox: {
          // Precache the app shell (build output) only. No runtimeCaching: API and auth responses are
          // never cached by the service worker.
          globPatterns: ['**/*.{js,css,html,svg,png,txt}'],
          navigateFallback: '/index.html',
          // Navigations to the API or auth endpoints (e.g. the OIDC callback, or an AI agent's
          // authorize page) must reach the server, not be answered with the cached app shell.
          navigateFallbackDenylist: [
            /^\/api(\/|$)/,
            /^\/auth(\/|$)/,
            /^\/oauth(\/|$)/,
            /^\/mcp(\/|$)/,
            /^\/\.well-known\//,
          ],
          cleanupOutdatedCaches: true,
        },
      }),
    ],
    build: {
      // Browsers with native light-dark() (the design tokens). A lower target would make the build
      // rewrite it into a fixed scheme, and the theme switch would stop working.
      cssTarget: ['chrome123', 'edge123', 'firefox120', 'safari17.5'],
    },
    server,
    preview: server,
    test: {
      name: 'frontend',
      environment: 'jsdom',
      include: ['test/**/*.test.{ts,tsx}'],
      setupFiles: ['test/setup.ts'],
      // Above the 5 s wait in test/setup.ts, so a slow wait isn't cut off by the test's own limit.
      testTimeout: 20_000,
    },
  };
});
