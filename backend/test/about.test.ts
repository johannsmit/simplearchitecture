import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AboutResponse } from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AboutService,
  loadAbout,
  shortCommit,
  versionOf,
  workingCopyCommit,
} from '../src/about/about-service.js';
import { repoRoot } from '../src/paths.js';
import {
  buildTestApp,
  idpOptions,
  signIn,
  startMockIdp,
  webOrigin,
  withClaims,
} from './helpers.js';

const madeUpCommit = '0123456789abcdef0123456789abcdef01234567';
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

describe('shortCommit', () => {
  it.each([
    [madeUpCommit, '0123456'],
    ['ABCDEF0', 'abcdef0'],
    [`  ${madeUpCommit}\n`, '0123456'],
    ['a1b2c3d', 'a1b2c3d'],
  ])('shows %j as %j', (value, shown) => {
    expect(shortCommit(value)).toBe(shown);
  });

  it.each<[unknown, string]>([
    ['', 'empty'],
    ['a1b2c3', 'six characters'],
    [`${madeUpCommit}0`, 'forty-one characters'],
    ['a1b2c3g', 'not hex'],
    ['<script>alert(1)</script>', 'markup'],
    ['a1b2c3d e4f5a6b', 'two values'],
    ['a1b2c3d\nsigned off', 'a second line'],
    [null, 'null'],
    [1234567, 'a number'],
  ])('refuses %j (%s)', (value) => {
    expect(shortCommit(value)).toBeUndefined();
  });
});

describe('versionOf', () => {
  it.each(['0.10.0', '1.2.3-rc.1', '2.0.0+build.5'])('keeps %s', (version) => {
    expect(versionOf(version)).toBe(version);
  });

  it.each(['', 'latest', '1.2', '<b>1.2.3</b>', undefined, 3])('shows %j as unknown', (value) => {
    expect(versionOf(value)).toBe('unknown');
  });
});

describe('loadAbout', () => {
  let folder: string;
  const packageFile = () => join(folder, 'package.json');
  const buildInfo = () => join(folder, 'build-info.json');

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'sa-about-'));
  });
  afterEach(() => {
    rmSync(buildInfo(), { force: true });
  });
  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  const load = (
    nodeEnv: 'development' | 'test' | 'production',
    git = vi.fn((): string | undefined => 'fedcba9'),
  ) => ({
    about: loadAbout({ nodeEnv, packageFile: packageFile(), buildInfo: buildInfo(), git }),
    git,
  });

  it('takes the version from the package file and the commit from the build', () => {
    writeFileSync(packageFile(), JSON.stringify({ version: '3.4.5' }));
    writeFileSync(buildInfo(), JSON.stringify({ commit: madeUpCommit }));
    for (const nodeEnv of ['production', 'development'] as const) {
      const { about, git } = load(nodeEnv);
      expect(about).toEqual({ version: '3.4.5', commit: '0123456' });
      expect(git).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['no commit passed', JSON.stringify({ commit: '' })],
    ['text that is not a commit', JSON.stringify({ commit: '<img src=x onerror=alert(1)>' })],
    ['an unreadable file', '{ not json'],
    ['no object', JSON.stringify('a1b2c3d')],
  ])('shows unknown for a build with %s', (_case, content) => {
    writeFileSync(packageFile(), JSON.stringify({ version: '3.4.5' }));
    writeFileSync(buildInfo(), content);
    expect(load('production').about.commit).toBe('unknown');
  });

  it("asks git when running from source in development, or says so when git can't tell", () => {
    expect(load('development').about.commit).toBe('fedcba9');
    expect(
      load(
        'development',
        vi.fn(() => undefined),
      ).about.commit,
    ).toBe('development');
  });

  it('never asks git outside development', () => {
    for (const nodeEnv of ['production', 'test'] as const) {
      const { about, git } = load(nodeEnv);
      expect(about.commit).toBe('unknown');
      expect(git).not.toHaveBeenCalled();
    }
  });

  it('shows an unknown version rather than failing without a usable package file', () => {
    rmSync(packageFile(), { force: true });
    expect(load('production').about).toEqual({ version: 'unknown', commit: 'unknown' });
    writeFileSync(packageFile(), JSON.stringify({ version: 'next' }));
    expect(load('production').about.version).toBe('unknown');
  });

  it("reads the repository's own version by default", () => {
    const { version } = JSON.parse(read('package.json')) as { version: string };
    expect(loadAbout({ nodeEnv: 'test' }).version).toBe(version);
  });

  it("names the working copy's commit as git does, and nothing outside a repository", () => {
    const git = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (git.status === 0) expect(workingCopyCommit()).toBe(git.stdout.trim().slice(0, 7));
    expect(workingCopyCommit(folder)).toBeUndefined();
  });
});

describe('the build records the commit', () => {
  const buildScript = (JSON.parse(read('backend/package.json')) as { scripts: { build: string } })
    .scripts.build;
  let folder: string;

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'sa-build-info-'));
    mkdirSync(join(folder, 'dist'));
  });
  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  /** Runs the build script's last step, which writes dist/build-info.json, as the build does. */
  function recordWith(commit: string | undefined): AboutResponse {
    const step = buildScript.split(' && ').at(-1) ?? '';
    expect(step).toContain('build-info.json');
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
    if (commit !== undefined) env.SOURCE_COMMIT = commit;
    const run = spawnSync('sh', ['-c', step], { cwd: folder, env, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    return loadAbout({
      nodeEnv: 'production',
      buildInfo: join(folder, 'dist', 'build-info.json'),
    });
  }

  it('from the SOURCE_COMMIT build argument, as unknown without it', () => {
    expect(recordWith(madeUpCommit).commit).toBe('0123456');
    expect(recordWith(undefined).commit).toBe('unknown');
    expect(recordWith('"; echo injected').commit).toBe('unknown');
  });

  it('takes the argument in the build stage of the Dockerfile, optional', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toMatch(/^ARG SOURCE_COMMIT=""\nRUN npm run build$/m);
  });

  it('gets the commit from every image build in CI, the same in each so they share a cache', () => {
    const ci = read('.github/workflows/ci.yml');
    const builds = ci.split('uses: docker/build-push-action@').slice(1);
    expect(builds).toHaveLength(3);
    for (const build of builds) {
      const step = build.split(/\n {6}- /)[0] ?? '';
      expect(step).toMatch(/build-args: \|\n\s+SOURCE_COMMIT=\$\{\{ github\.sha \}\}\n/);
    }
  });
});

describe('GET /api/about', () => {
  let idp: OAuth2Server;
  let app: FastifyInstance;
  const about: AboutResponse = { version: '9.8.7', commit: 'a1b2c3d' };

  const sessionFor = async (roles: string[]) => {
    idp.service.removeAllListeners('beforeTokenSigning');
    withClaims(idp, { roles, oid: `made-up-${roles.join('-') || 'none'}`, name: 'Made-up person' });
    return (await signIn(app)).sessionCookie;
  };
  const get = (url: string, cookie?: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: { origin: webOrigin, ...(cookie === undefined ? {} : { cookie }) },
    });

  beforeAll(async () => {
    idp = await startMockIdp();
    app = await buildTestApp({}, idpOptions(idp, { about }));
  });
  afterAll(async () => {
    await app.close();
    await idp.stop();
  });

  it('gives a Viewer, a Modeller and an Admin the version and commit', async () => {
    for (const role of ['Viewer', 'Modeller', 'Admin']) {
      const res = await get('/api/about', await sessionFor([role]));
      expect(res.statusCode, role).toBe(200);
      expect(res.json()).toEqual(about);
    }
  });

  it('tells nobody before sign-in, nor anyone signed in without a role', async () => {
    const visitor = await get('/api/about');
    expect(visitor.statusCode).toBe(401);
    expect(visitor.body).not.toContain('9.8.7');
    const noRole = await get('/api/about', await sessionFor([]));
    expect(noRole.statusCode).toBe(403);
    expect(noRole.body).not.toContain('a1b2c3d');
  });

  it('leaves the health check naming no version', async () => {
    const res = await get('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.body).not.toContain('9.8.7');
    expect(res.body).not.toContain('a1b2c3d');
  });

  it('serves a copy, so a caller cannot change what the next one gets', () => {
    const service = new AboutService(about);
    const first = service.about();
    first.commit = 'changed';
    expect(service.about()).toEqual(about);
  });
});
