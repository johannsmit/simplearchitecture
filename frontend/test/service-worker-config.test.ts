import { matchesGlob } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workboxOptions } from '../vite/pwa';

/** Whether the service worker precaches a file of the build output (a path under dist/). */
function precached(file: string): boolean {
  return (
    workboxOptions.globPatterns.some((pattern) => matchesGlob(file, pattern)) &&
    !workboxOptions.globIgnores.some((pattern) => matchesGlob(file, pattern))
  );
}

/** Whether a request (a full URL) is answered from the runtime cache. */
function cachedAtRuntime(url: string): boolean {
  const parsed = new URL(url);
  const sameOrigin = parsed.origin === 'https://app.example.test';
  return workboxOptions.runtimeCaching.some(({ urlPattern }) =>
    urlPattern({ url: parsed, sameOrigin }),
  );
}

describe('the service worker', () => {
  it('precaches the app shell and the pages that load on first use', () => {
    for (const file of [
      'index.html',
      'theme-init.js',
      'assets/index-Ab12_-cd.js',
      'assets/index-Ab12_-cd.css',
      'assets/react-Ab12_-cd.js',
      'assets/canvas-Ab12_-cd.js',
      'assets/ExplorerPage-Ab12_-cd.js',
      'assets/BrandingPage-Ab12_-cd.js',
      'assets/ViewingHelp-Ab12_-cd.js',
    ]) {
      expect(precached(file), file).toBe(true);
    }
  });

  it("leaves the layout engine's worker out of the precache", () => {
    expect(precached('assets/elk-worker.min-J_vVZCZ4.js')).toBe(false);
  });

  it('caches the worker when a canvas first loads it, first from the cache after that', () => {
    expect(cachedAtRuntime('https://app.example.test/assets/elk-worker.min-J_vVZCZ4.js')).toBe(
      true,
    );
    const [rule] = workboxOptions.runtimeCaching;
    expect(rule?.handler).toBe('CacheFirst');
    expect(rule?.options.expiration.maxEntries).toBeGreaterThan(0);
  });

  it('caches nothing else at runtime: no API, auth or other app requests', () => {
    expect(workboxOptions.runtimeCaching).toHaveLength(1);
    for (const url of [
      'https://app.example.test/api/models',
      'https://app.example.test/api/elk-worker.min-J_vVZCZ4.js',
      'https://app.example.test/api/assets/elk-worker.min-J_vVZCZ4.js',
      'https://app.example.test/assets/elk-worker.min-J_vVZCZ4.js.map',
      'https://app.example.test/auth/callback',
      'https://app.example.test/oauth/authorize',
      'https://app.example.test/mcp',
      'https://app.example.test/manifest.webmanifest',
      'https://app.example.test/assets/index-Ab12_-cd.js',
      'https://cdn.example.test/assets/elk-worker.min-J_vVZCZ4.js',
    ]) {
      expect(cachedAtRuntime(url), url).toBe(false);
    }
  });
});
