import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative, sep } from 'node:path';
import { repoRoot, resolveFromRepoRoot } from '../paths.js';
import { ModelStoreError } from './model-store.js';

/**
 * Where DATA_DIR points. A leading `~/` means the home directory; `~user` isn't supported. Any
 * other relative path is resolved against the repo root.
 */
export function resolveDataDir(value: string, home: string = homedir()): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  if (value.startsWith('~')) {
    throw new ModelStoreError(
      `DATA_DIR ${value} is not supported: only a leading ~/ (your home directory) is expanded. Use an absolute path.`,
    );
  }
  return resolveFromRepoRoot(value);
}

/** True when `dir` is `other` or one of its parents. */
function containsOrIs(dir: string, other: string): boolean {
  const path = relative(dir, other);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

/**
 * Refuses a DATA_DIR that would make the store change permissions on, or clean up, a folder that
 * holds other things: the file-system root, the home directory itself, the repo root or a parent
 * of it. Throws ModelStoreError. `dir` must be absolute.
 */
export function checkDataDirLocation(
  dir: string,
  places: { home: string; repoRoot: string } = { home: homedir(), repoRoot },
): void {
  const reason =
    dir === parse(dir).root
      ? 'the file-system root'
      : containsOrIs(dir, places.repoRoot)
        ? 'the repo root or a folder that contains it'
        : relative(places.home, dir) === ''
          ? 'your home directory'
          : undefined;
  if (reason !== undefined) {
    throw new ModelStoreError(
      `DATA_DIR ${dir} is not allowed: it is ${reason}. Use a folder of its own, such as data/ in the repo.`,
    );
  }
}

/** The home directory and the repo root with symlinks resolved (each as is if that fails). */
export async function realPlaces(): Promise<{ home: string; repoRoot: string }> {
  const real = (path: string) => realpath(path).catch(() => path);
  return { home: await real(homedir()), repoRoot: await real(repoRoot) };
}
