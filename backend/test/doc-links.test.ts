import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoRoot } from '../src/paths.js';

// The link checker (deploy/check-doc-links.mjs), on made-up documents only. The repository's own
// documents are checked by `npm run check:links` and in CI, not here, so a copy of the app with
// documents of its own still passes the tests.
const script = join(repoRoot, 'deploy', 'check-doc-links.mjs');
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sa-links-'));
  folders.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function check(root: string) {
  const run = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  const broken = run.stderr
    .split('\n')
    .filter((line) => line.startsWith('  '))
    .map((line) => line.trim());
  return { status: run.status, broken, output: `${run.stdout}${run.stderr}` };
}

describe('deploy/check-doc-links.mjs', () => {
  it.each([
    ['Run with Docker Compose', 'run-with-docker-compose'],
    ['1. Create the role and the database', '1-create-the-role-and-the-database'],
    ['Forms (Modelling)', 'forms-modelling'],
    ['`DATABASE_URL` and TLS', 'database_url-and-tls'],
    ['Tidy up & Tidy relations', 'tidy-up--tidy-relations'],
    ['What’s new: the [canvas](canvas.md)', 'whats-new-the-canvas'],
  ])('finds the heading "%s" as #%s, as GitHub does', (heading, anchor) => {
    const root = repository({
      'README.md': `[a](guide/a.md#${anchor})\n`,
      'guide/a.md': `# Page\n\n## ${heading}\n`,
      'guide/canvas.md': '# Canvas\n',
    });
    expect(check(root)).toMatchObject({ status: 0, broken: [] });
  });

  const guide = '# Guide\n\n## Run it\n\n## Run it\n\nText.\n';

  it('passes files, folders, anchors, repeated headings and outside addresses', () => {
    const root = repository({
      'README.md':
        '[a](guide/a.md) [b](guide/a.md#run-it) [c](guide/a.md#run-it-1) [d](guide/releases/) ' +
        '[e](https://example.test/missing) [f](mailto:someone@example.test) [g](#readme) ' +
        '![h](guide/images/one.png "Title")\n\n# Readme\n\n[ref]: guide/a.md#guide\n',
      'guide/a.md': guide,
      'guide/releases/v1.md': '# v1\n',
      'guide/images/one.png': '',
      'SECURITY.md': '[back](README.md)\n',
    });
    const result = check(root);
    expect(result).toMatchObject({ status: 0, broken: [] });
    expect(result.output).toContain('Links checked in 4 documents');
  });

  it('fails on a missing file, a missing anchor and a wrong reference, naming each', () => {
    const root = repository({
      'README.md': '[a](guide/missing.md) [b](guide/a.md#no-such-heading) [c](#nowhere)\n',
      'guide/a.md': `${guide}\n[d](../metamodel/gone.md)\n\n[e]: releases/\n`,
      'metamodel/m.md': '[f](../guide/a.md#Run-It) [g](../../outside.md)\n',
    });
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.broken).toEqual([
      'README.md: guide/missing.md (no such file)',
      'README.md: guide/a.md#no-such-heading (no such heading)',
      'README.md: #nowhere (no such heading)',
      'guide/a.md: ../metamodel/gone.md (no such file)',
      'guide/a.md: releases/ (no such file)',
      'metamodel/m.md: ../guide/a.md#Run-It (no such heading)',
      'metamodel/m.md: ../../outside.md (outside the repository)',
    ]);
  });

  it('reports a link with a malformed % escape as broken, and goes on', () => {
    const root = repository({
      'README.md': '[a](guide/a%zz.md) [b](guide/a.md#run-%E0%A4%A) [c](guide/missing.md)\n',
      'guide/a.md': guide,
    });
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.broken).toEqual([
      'README.md: guide/a%zz.md (a malformed % escape)',
      'README.md: guide/a.md#run-%E0%A4%A (a malformed % escape)',
      'README.md: guide/missing.md (no such file)',
    ]);
  });

  it('ignores links shown as code', () => {
    const root = repository({
      'README.md': 'Write `[x](missing.md)` like this:\n\n```md\n[y](missing.md)\n```\n',
    });
    expect(check(root)).toMatchObject({ status: 0, broken: [] });
  });

  it('runs in CI, in the check job, and as npm run check:links', () => {
    const ci = readText('.github/workflows/ci.yml');
    const checkJob = ci.slice(ci.indexOf('\n  check:\n'), ci.indexOf('\n  image:\n'));
    expect(checkJob).toContain('npm run check:links');
    const pkg = JSON.parse(readText('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['check:links']).toBe('node deploy/check-doc-links.mjs');
  });
});

function readText(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}
