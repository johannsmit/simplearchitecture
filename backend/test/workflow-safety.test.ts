import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../src/paths.js';

// The rules every workflow keeps. They hold whatever a tag or branch is called, and only a run on
// GitHub proves that a workflow works.
const folder = join(repoRoot, '.github', 'workflows');
const workflows = readdirSync(folder)
  .filter((name) => name.endsWith('.yml'))
  .map((name) => [name, readFileSync(join(folder, name), 'utf8')] as const);

/** The shell text of every `run:` step: its own line, or the indented block under it. */
function runBlocks(workflow: string): string[] {
  const lines = workflow.split('\n');
  const blocks: string[] = [];
  lines.forEach((line, index) => {
    const match = /^( *)(?:- )?run: ?(.*)$/.exec(line);
    if (match === null) return;
    const block = [match[2] ?? ''];
    const indent = (match[1] ?? '').length;
    for (const next of lines.slice(index + 1)) {
      if (next.trim() !== '' && next.search(/\S/) <= indent) break;
      block.push(next);
    }
    blocks.push(block.join('\n'));
  });
  return blocks;
}

describe('runBlocks', () => {
  it('finds one-line and multi-line steps, and stops where the block ends', () => {
    const blocks = runBlocks(
      [
        '      - run: one',
        '      - name: two',
        '        run: |',
        '          two',
        '      - x',
      ].join('\n'),
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe('one');
    expect(blocks[1]).toContain('two');
    expect(blocks[1]).not.toContain('- x');
  });
});

describe.each(workflows)('the workflow %s', (_name, workflow) => {
  it('puts no expression in a shell step: a tag or branch name reaches it only through env', () => {
    const blocks = runBlocks(workflow);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(block).not.toContain('${{');
  });

  it('pins every action to a full commit, and every image to a digest', () => {
    const uses = [...workflow.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((match) => match[1] ?? '');
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/@[0-9a-f]{40}$/);
    for (const [, image] of workflow.matchAll(/^ {2}[A-Z_]+_IMAGE: (\S+)/gm)) {
      expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it('is read-only unless a job asks for more, and never trusts a pull request target', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).not.toContain('write-all');
  });

  it('keeps no credential after a checkout', () => {
    const checkouts = workflow.split(/\n(?= *- )/).filter((step) => step.includes('/checkout@'));
    for (const step of checkouts) expect(step).toContain('persist-credentials: false');
  });

  it('uses the only credential there is, its own token', () => {
    const secrets = [...workflow.matchAll(/secrets\.([A-Za-z_]+)/g)].map((match) => match[1]);
    for (const secret of secrets) expect(secret).toBe('GITHUB_TOKEN');
  });

  it('lower-cases the image name first in every job that uses it', () => {
    const jobs = workflow.slice(workflow.indexOf('\njobs:\n')).split(/\n(?= {2}[a-z-]+:\n)/);
    for (const job of jobs) {
      const first = job.search(/\$IMAGE|env\.IMAGE/);
      if (first === -1) continue;
      const lowered = job.indexOf('${IMAGE,,}');
      expect(lowered).toBeGreaterThan(-1);
      expect(lowered).toBeLessThanOrEqual(first);
    }
  });
});
