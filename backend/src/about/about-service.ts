import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AboutResponse } from '@simplearchitecture/shared';
import { repoRoot } from '../paths.js';

/** Shown for a commit the build didn't record (or recorded wrongly), or a version that isn't one. */
export const unknownText = 'unknown';
/** Shown by `npm run dev` when git can't name the working copy's commit. */
export const developmentCommit = 'development';

/**
 * Written next to the compiled code by the backend's build script, from the `SOURCE_COMMIT`
 * build argument (see the Dockerfile). Running from source, as `npm run dev` does, it isn't there.
 */
export const buildInfoFile = new URL('../build-info.json', import.meta.url);

const commitPattern = /^[0-9a-f]{7,40}$/i;
// Semantic versioning, kept short: anything else in a package file shows as "unknown".
const versionPattern =
  /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,40})?(?:\+[0-9A-Za-z.-]{1,40})?$/;

/**
 * A commit as shown: hex only, 7 to 40 characters, cut to the first 7 and lower-cased. Anything
 * else is undefined, so a build argument can't put other text into the page.
 */
export function shortCommit(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const commit = value.trim();
  return commitPattern.test(commit) ? commit.slice(0, 7).toLowerCase() : undefined;
}

/** A package file's version, or "unknown" when it isn't a semantic version. */
export function versionOf(value: unknown): string {
  return typeof value === 'string' && versionPattern.test(value) ? value : unknownText;
}

function readJson(file: string | URL): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

/** The commit a build recorded: undefined without the file (running from source). */
function builtCommit(file: string | URL): string | undefined {
  let info: unknown;
  try {
    info = readJson(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return unknownText;
  }
  const commit =
    typeof info === 'object' && info !== null ? (info as { commit?: unknown }).commit : undefined;
  return shortCommit(commit) ?? unknownText;
}

/** The working copy's commit, asked of git; undefined without git or a repository. */
export function workingCopyCommit(cwd: string = repoRoot): string | undefined {
  try {
    const output = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return shortCommit(output);
  } catch {
    return undefined;
  }
}

export interface LoadAboutOptions {
  nodeEnv: 'development' | 'test' | 'production';
  /** Tests only: where the build's record and the package file are, and how git is asked. */
  buildInfo?: string | URL;
  packageFile?: string | URL;
  git?: () => string | undefined;
}

/**
 * The code version, worked out once at startup. Never throws: whatever is missing shows as
 * "unknown" (or "development" when running from source in development without git).
 */
export function loadAbout(options: LoadAboutOptions): AboutResponse {
  let version = unknownText;
  try {
    version = versionOf(
      (readJson(options.packageFile ?? join(repoRoot, 'package.json')) as { version?: unknown })
        .version,
    );
  } catch {
    // An unreadable package file leaves the version unknown.
  }
  let commit = builtCommit(options.buildInfo ?? buildInfoFile);
  if (commit === undefined) {
    // Running from source: only `npm run dev` asks git, never the tests or a production start.
    commit =
      options.nodeEnv === 'development'
        ? ((options.git ?? workingCopyCommit)() ?? developmentCommit)
        : unknownText;
  }
  return { version, commit };
}

/** What `GET /api/about` serves: the code version the server runs. */
export class AboutService {
  readonly #about: AboutResponse;

  constructor(about: AboutResponse) {
    this.#about = { version: about.version, commit: about.commit };
  }

  about(): AboutResponse {
    return { ...this.#about };
  }
}
