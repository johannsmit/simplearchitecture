import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoRoot } from '../src/paths.js';

// The image contents check (deploy/check-image-files.sh) and the prune before it, on made-up
// folders. CI runs the same check on the built image's file list.
const check = join(repoRoot, 'deploy', 'check-image-files.sh');
const prune = join(repoRoot, 'deploy', 'prune-app.sh');

let folder: string | undefined;
afterEach(() => {
  if (folder) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

function appFolder(files: string[]): string {
  folder = mkdtempSync(join(tmpdir(), 'sa-image-'));
  for (const file of files) {
    mkdirSync(dirname(join(folder, file)), { recursive: true });
    writeFileSync(join(folder, file), 'made-up');
  }
  return folder;
}

function run(script: string, args: string[], input?: string) {
  const result = spawnSync('sh', [script, ...args], { encoding: 'utf8', input });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const clean = [
  'LICENSE',
  'package.json',
  'backend/package.json',
  'backend/dist/server.js',
  'backend/migrations/001_initial.sql',
  'shared/dist/index.js',
  'frontend/dist/index.html',
  'frontend/dist/assets/index-abc123.js',
  'frontend/dist/third-party-licenses.txt',
  'config/oef-mapping.json',
  // Third-party packages keep their docs, tests and sources, as published.
  'node_modules/made-up-package/README.md',
  'node_modules/made-up-package/LICENSE',
  'node_modules/made-up-package/test/index.js',
  'node_modules/made-up-package/src/index.ts',
];

const forbidden: [string, string][] = [
  ['backend/dist/server.js.map', 'source map'],
  ['shared/dist/index.d.ts', 'type declaration'],
  ['node_modules/made-up-package/index.js.map', 'source map'],
  ['node_modules/made-up-package/index.d.ts', 'type declaration'],
  ['node_modules/made-up-package/.env', 'environment file'],
  ['.env', 'environment file'],
  ['config/.env.production', 'environment file'],
  ['.git/HEAD', 'git'],
  ['graph-export.json', 'model data'],
  ['data/3f9c.json', 'model data'],
  ['samples/sample-insurance.jgf.json', 'sample model'],
  ['backend/src/server.ts', 'TypeScript source'],
  ['backend/test/helpers.js', 'source or tests'],
  ['frontend/dist/app.test.js', 'test'],
  ['docs/notes.txt', 'docs'],
  ['README.md', 'document'],
  ['frontend/dist/made-up-model.xml', 'model export or log'],
  ['backend/tsconfig.tsbuildinfo', 'build cache'],
];

describe('deploy/check-image-files.sh', () => {
  it('passes a folder that holds only what runs', () => {
    const result = run(check, [appFolder(clean)]);
    expect(result.output).toContain('check passed');
    expect(result.status).toBe(0);
  });

  it.each(forbidden)('fails on %s (%s) and names it', (file, reason) => {
    const result = run(check, [appFolder([...clean, file])]);
    expect(result.status).toBe(1);
    expect(result.output).toContain(`${file}  (${reason})`);
    expect(result.output).toContain('check failed');
  });

  it.each(['LICENSE', 'frontend/dist/third-party-licenses.txt'])(
    'fails when %s is missing, in a folder and in a list',
    (required) => {
      const rest = clean.filter((file) => file !== required);
      const result = run(check, [appFolder(rest)]);
      expect(result.status).toBe(1);
      expect(result.output).toContain(`${required}  (required, missing)`);
      expect(run(check, ['--list', '-'], `${rest.join('\n')}\n`).status).toBe(1);
    },
  );

  it('checks a file list too, as CI does for the image (folders end in /)', () => {
    const list = ['app/', ...clean, 'backend/test/', 'backend/dist/app.js.map'].join('\n');
    const result = run(check, ['--list', '-'], `${list}\n`);
    expect(result.status).toBe(1);
    expect(result.output).toContain('backend/test  (source or tests)');
    expect(result.output).toContain('backend/dist/app.js.map  (source map)');
    expect(run(check, ['--list', '-'], `${clean.join('\n')}\n`).status).toBe(0);
  });

  it('fails on an empty list and on wrong usage', () => {
    expect(run(check, ['--list', '-'], '').status).toBe(1);
    expect(run(check, []).status).toBe(2);
    expect(run(check, [join(tmpdir(), 'sa-no-such-folder')]).status).toBe(2);
  });
});

describe('deploy/prune-app.sh', () => {
  it('removes source maps, type declarations and build caches, and keeps the code', () => {
    const dir = appFolder([
      'LICENSE',
      'frontend/dist/third-party-licenses.txt',
      'backend/dist/server.js',
      'backend/dist/server.js.map',
      'shared/dist/index.d.ts',
      'node_modules/made-up-package/index.d.mts',
      'node_modules/made-up-package/index.js',
      'node_modules/made-up-package/index.js.map',
      'backend/tsconfig.tsbuildinfo',
    ]);
    expect(run(prune, [dir]).status).toBe(0);
    expect(existsSync(join(dir, 'backend/dist/server.js'))).toBe(true);
    expect(existsSync(join(dir, 'node_modules/made-up-package/index.js'))).toBe(true);
    expect(run(check, [dir]).status).toBe(0);
  });
});

describe('the image build uses them', () => {
  const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

  it('prunes and checks the assembled app in the Dockerfile, and lets only the two scripts in', () => {
    expect(read('Dockerfile')).toMatch(
      /sh \/tools\/prune-app\.sh \/out[\s\S]*sh \/tools\/check-image-files\.sh \/out/,
    );
    expect(read('Dockerfile')).toContain('COPY --from=app /out ./');
    const ignore = read('.dockerignore');
    expect(ignore).toContain('!deploy/prune-app.sh');
    expect(ignore).toContain('!deploy/check-image-files.sh');
    expect(ignore).not.toMatch(/^!deploy\/?$/m);
  });

  it('copies the licence into the image and labels it', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain('COPY LICENSE LICENSE');
    expect(dockerfile).toContain(
      'LABEL org.opencontainers.image.licenses="LicenseRef-SimpleArchitecture"',
    );
    expect(read('.dockerignore')).toMatch(/^!LICENSE$/m);
  });

  it('builds the backend without source maps', () => {
    expect(read('backend/tsconfig.build.json')).toMatch(/"sourceMap": false/);
  });
});

describe('deploy/merge-sbom.sh', () => {
  const merge = join(repoRoot, 'deploy', 'merge-sbom.sh');
  const hasJq = spawnSync('jq', ['--version']).status === 0;
  const lib = (name: string, version: string, purl = `pkg:npm/${name}@${version}`) => ({
    type: 'library',
    name,
    version,
    purl,
  });

  function mergeOf(image: object[], web: object[]) {
    folder = mkdtempSync(join(tmpdir(), 'sa-sbom-'));
    const paths = ['image.json', 'web.json', 'out.json'].map((name) => join(folder ?? '', name));
    const [imagePath = '', webPath = '', out = ''] = paths;
    writeFileSync(imagePath, JSON.stringify({ bomFormat: 'CycloneDX', components: image }));
    writeFileSync(webPath, JSON.stringify({ components: web }));
    const result = run(merge, [imagePath, webPath, out]);
    return { ...result, out };
  }

  it.runIf(hasJq)("adds the web packages, each once, and keeps the image's", () => {
    const shared = lib('react', '19.3.1');
    const { status, out } = mergeOf(
      [lib('fastify', '5.0.0'), shared],
      [shared, lib('elkjs', '0.12.1')],
    );
    expect(status).toBe(0);
    const { components } = JSON.parse(readFileSync(out, 'utf8')) as {
      components: { name: string; version: string }[];
    };
    expect(components.map((c) => `${c.name} ${c.version}`).sort()).toEqual([
      'elkjs 0.12.1',
      'fastify 5.0.0',
      'react 19.3.1',
    ]);
  });

  it.runIf(hasJq)('fails on an empty web list', () => {
    expect(mergeOf([lib('fastify', '5.0.0')], []).status).toBe(1);
  });
});
