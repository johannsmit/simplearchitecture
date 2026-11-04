import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo root. Every module that uses this is one level below src/ (or dist/). */
export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * A configured path. A relative path is resolved against the repo root, not the working
 * directory (which differs between `npm run dev`, `npm start` and tests).
 */
export function resolveFromRepoRoot(path: string): string {
  return resolve(repoRoot, path);
}
