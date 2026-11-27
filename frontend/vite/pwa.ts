import type { VitePWAOptions } from 'vite-plugin-pwa';

/**
 * The service worker's options. It precaches the app shell (the build output), less the ELK
 * worker: at about 1.6 MB, it is most of the build, and only a canvas needs it. The worker is
 * cached the first time a canvas lays out (CacheFirst: its name changes with its content), so a
 * canvas opened once works offline too. That is the only runtime cache: API and auth responses
 * (the branding, its images and the manifest included) are never cached by the service worker.
 */
export const workboxOptions = {
  globPatterns: ['**/*.{js,css,html,svg,png,txt}'],
  globIgnores: ['**/elk-worker*.js'],
  runtimeCaching: [
    {
      // The layout engine's worker as the build emits it: hashed, under /assets/, on this origin.
      // The build copies this function into the service worker, so it uses nothing from outside.
      urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
        sameOrigin && /^\/assets\/elk-worker\.min-[\w-]+\.js$/.test(url.pathname),
      handler: 'CacheFirst',
      options: {
        cacheName: 'layout-engine',
        // The current worker, and the one before it while a new version takes over.
        expiration: { maxEntries: 2 },
        cacheableResponse: { statuses: [200] },
      },
    },
  ],
  navigateFallback: '/index.html',
  // Navigations to the API or auth endpoints (e.g. the OIDC callback, or an AI agent's
  // authorize page) must reach the server, not be answered with the cached app shell.
  navigateFallbackDenylist: [
    /^\/api(\/|$)/,
    /^\/auth(\/|$)/,
    /^\/oauth(\/|$)/,
    /^\/mcp(\/|$)/,
    /^\/\.well-known\//,
    /^\/manifest\.webmanifest$/,
  ],
  cleanupOutdatedCaches: true,
} satisfies VitePWAOptions['workbox'];
