import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoRoot } from '../src/paths.js';

// What the workflows must promise. Only a run on GitHub proves they work; this keeps the order and
// the guards from being lost in an edit.
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');
const hasJq = spawnSync('jq', ['--version']).status === 0;
const ci = read('.github/workflows/ci.yml');
const weekly = read('.github/workflows/weekly-scan.yml');

/** The text of one job: from its key to the next job's key. */
function job(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const publicRepository = "github.repository == 'johannsmit/simplearchitecture'";

describe('the release workflow', () => {
  const publish = job(ci, 'publish');

  it('publishes only from the public repository, on a version tag', () => {
    const condition = /^ {4}if: (.*)$/m.exec(publish)?.[1];
    expect(condition).toContain(publicRepository);
    expect(condition).toContain("startsWith(github.ref, 'refs/tags/v')");
  });

  it('runs after the checks, and the release after publishing', () => {
    expect(publish).toContain('needs: [check, image]');
    expect(job(ci, 'release')).toContain('needs: [publish]');
  });

  it('adds the version tags last, after every check of the pushed digest', () => {
    const order = [
      'push-by-digest=true',
      'deploy/check-finished-image.sh "$PUSHED"',
      'deploy/test-container.sh "$PUSHED"',
      'deploy/scan-image.sh "$AMD64"',
      'deploy/scan-image.sh "$ARM64"',
      'cosign sign',
      'deploy/merge-sbom.sh',
      'cosign attest',
      'actions/attest-build-provenance',
      'actions/attest-sbom',
      'actions/upload-artifact',
      'deploy/add-version-tags.sh',
    ];
    const places = order.map((text) => publish.indexOf(text));
    expect(places).not.toContain(-1);
    expect(places).toEqual([...places].sort((a, b) => a - b));
    expect(publish.slice(places.at(-1))).not.toMatch(/- name:|- uses:/);
  });

  it('pushes with no tag and never a latest one', () => {
    expect(publish).toContain('latest=false');
    expect(publish).not.toMatch(/^\s+push: true/m);
    const build = publish.slice(publish.indexOf('Push the image by digest'));
    expect(build.slice(0, build.indexOf('cache-from'))).not.toMatch(/^\s+tags:/m);
  });

  it('keeps the condition that skips GitHub attestations on a private repository', () => {
    expect(publish.match(/if: vars\.SKIP_ATTESTATIONS != 'true'/g)).toHaveLength(2);
  });

  it('marks a pre-release, so it never becomes the latest release', () => {
    expect(job(ci, 'release')).toContain('--prerelease');
  });

  it.each([
    ['publish', ci],
    ['release', ci],
    ['scan', weekly],
  ])('lower-cases the image name first in the %s job', (name, workflow) => {
    const steps = job(workflow, name);
    const lowered = steps.indexOf('IMAGE=${IMAGE,,}');
    expect(lowered).toBeGreaterThan(-1);
    const firstUse = steps.search(/\$IMAGE[^=]|env\.IMAGE/);
    expect(firstUse).toBeGreaterThan(lowered);
  });

  it('uses the image name in no other job', () => {
    for (const name of ['check', 'image']) {
      expect(job(ci, name)).not.toMatch(/\$IMAGE|env\.IMAGE/);
    }
  });
});

describe('the weekly scan', () => {
  it('runs weekly, only in the public repository', () => {
    expect(weekly).toMatch(/cron: '\d+ \d+ \* \* \d'/);
    expect(job(weekly, 'scan')).toContain(`if: ${publicRepository}`);
  });

  it('scans both platforms and keeps to one issue per release', () => {
    const scan = job(weekly, 'scan');
    expect(scan).toContain('for arch in amd64 arm64');
    expect(scan).toContain('deploy/scan-image.sh');
    expect(scan).toContain('An open issue already reports');
    expect(scan).toContain('gh issue create');
  });
});

describe('the scan and the SBOM', () => {
  it("cover the web app, which Trivy can't see in the image", () => {
    expect(read('deploy/scan-image.sh')).toContain('sbom /out/web-packages.cdx.json');
    expect(job(ci, 'publish')).toContain('deploy/merge-sbom.sh');
    expect(job(ci, 'image')).toContain('deploy/scan-image.sh simplearchitecture:ci');
  });
});

// Made-up stand-ins for the tools, on the PATH of a real run of the shell code.
const folders: string[] = [];
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempFolder(): string {
  const path = mkdtempSync(join(tmpdir(), 'sa-release-'));
  folders.push(path);
  return path;
}

function stub(folder: string, name: string, body: string): void {
  const path = join(folder, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

describe('finding the latest release in the weekly scan', () => {
  const step = job(weekly, 'scan');
  const start = step.indexOf('        run: |', step.indexOf('name: Find the latest release'));
  const end = step.indexOf('      - if:', start);
  const shell = step.slice(start, end).split('\n').slice(1).join('\n');

  function find(gh: string) {
    const bin = tempFolder();
    const temp = tempFolder();
    stub(bin, 'gh', gh);
    const output = join(temp, 'output');
    writeFileSync(output, '');
    const run = spawnSync('bash', ['-e', '-c', shell], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        RUNNER_TEMP: temp,
        GITHUB_OUTPUT: output,
        IMAGE: 'ghcr.io/made-up/app',
      },
    });
    return { status: run.status, stderr: run.stderr, output: readFileSync(output, 'utf8') };
  }

  it('finds the tag and the image', () => {
    const found = find('echo v1.2.3');
    expect(found.status).toBe(0);
    expect(found.output).toBe('tag=v1.2.3\nimage=ghcr.io/made-up/app:1.2.3\n');
  });

  it('treats only "release not found" as no release, which skips the scan', () => {
    const found = find('echo "release not found" >&2; exit 1');
    expect(found.status).toBe(0);
    expect(found.output).toBe('');
  });

  it.each([
    ['a network failure', 'echo "dial tcp: i/o timeout" >&2; exit 1'],
    ['a bad token', 'echo "HTTP 401: Bad credentials" >&2; exit 1'],
    ['a message that only mentions it', 'echo "error: release not found, retry" >&2; exit 1'],
    ['no message at all', 'exit 1'],
    ['an empty answer', 'exit 0'],
  ])('fails the run on %s', (_name, gh) => {
    const found = find(gh);
    expect(found.status).toBe(1);
    expect(found.output).toBe('');
  });
});

describe('deploy/add-version-tags.sh', () => {
  const script = join(repoRoot, 'deploy', 'add-version-tags.sh');
  const sha256 = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
  const manifest = '{"made":"up"}';
  const tags = 'ghcr.io/made-up/app:1.2.3\nghcr.io/made-up/app:1.2\n';

  function addTags(
    options: { manifest?: string; planned?: string; tagged?: string; createFails?: boolean } = {},
  ) {
    const shown = options.manifest ?? manifest;
    const digest = sha256(shown);
    const bin = tempFolder();
    const writes = join(bin, 'writes');
    stub(
      bin,
      'docker',
      `
      if [ "$3" = create ] && [ "$4" = --dry-run ]; then
        printf '%s\\n' '${options.planned ?? shown}'
      elif [ "$3" = create ]; then
        echo "$*" >> '${writes}'
        ${options.createFails === true ? 'exit 1' : ''}
      elif [ "$3" = inspect ]; then
        case "$4" in
          *:1.2) printf '"%s"\\n' '${options.tagged ?? digest}' ;;
          *) printf '"%s"\\n' '${digest}' ;;
        esac
      fi`,
    );
    const run = spawnSync('bash', [script, 'ghcr.io/made-up/app', digest, tags], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    return { status: run.status, output: `${run.stdout}${run.stderr}`, wrote: existsSync(writes) };
  }

  it('writes the tags when the plan and the result match the digest', () => {
    const result = addTags();
    expect(result.status).toBe(0);
    expect(result.wrote).toBe(true);
  });

  it('hashes an indented manifest with only the last newline dropped', () => {
    const indented = '{\n   "schemaVersion": 2,\n   "made": "up"\n}';
    expect(addTags({ manifest: indented }).status).toBe(0);
    // A manifest that itself ends in a newline keeps it.
    expect(addTags({ manifest: `${indented}\n` }).status).toBe(0);
  });

  it('writes no tag when they would point at another digest', () => {
    const result = addTags({ planned: '{"made":"different"}' });
    expect(result.status).toBe(1);
    expect(result.wrote).toBe(false);
    expect(result.output).toContain('No tag was written');
  });

  it('fails and names a tag that ended up on another digest', () => {
    const result = addTags({ tagged: 'sha256:0000' });
    expect(result.status).toBe(1);
    expect(result.output).toContain('ghcr.io/made-up/app:1.2 points at sha256:0000');
    expect(result.output).not.toContain(`ghcr.io/made-up/app:1.2.3 points at`);
  });

  it('fails when writing the tags fails, and still reports where they point', () => {
    const result = addTags({ createFails: true });
    expect(result.status).toBe(1);
    expect(result.output).toContain('After a failed release run');
  });

  it('refuses a run with no tags', () => {
    const run = spawnSync('bash', [script, 'ghcr.io/made-up/app', sha256(manifest), ''], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
  });

  it('is what the release workflow calls', () => {
    expect(job(ci, 'publish')).toContain(
      'bash deploy/add-version-tags.sh "$IMAGE" "$DIGEST" "$TAGS"',
    );
  });
});

describe.skipIf(!hasJq)('deploy/scan-image.sh and packages', () => {
  const script = join(repoRoot, 'deploy', 'scan-image.sh');
  const withPackages = JSON.stringify({ Results: [{ Packages: [{ Name: 'made-up' }] }] });
  const noPackages = JSON.stringify({ Results: [{ Target: 'made-up' }] });
  const noResults = JSON.stringify({ SchemaVersion: 2 });

  function scan(image: string, web: string, ...args: string[]) {
    const bin = tempFolder();
    const out = tempFolder();
    stub(
      bin,
      'docker',
      `
      case "$1" in
        image) echo linux/amd64 ;;
        create) echo made-up-id ;;
        cp) echo '{}' > "$3" ;;
        run)
          while [ $# -gt 0 ]; do
            if [ "$1" = --output ] && [ "$2" = /out/scan.json ]; then
              echo '${image}' > '${out}/scan.json'
            elif [ "$1" = --output ] && [ "$2" = /out/web-scan.json ]; then
              echo '${web}' > '${out}/web-scan.json'
            fi
            shift
          done ;;
      esac`,
    );
    const run = spawnSync('bash', [script, 'made-up:1', out, ...args], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, TRIVY_IMAGE: 'made-up-trivy' },
    });
    return {
      status: run.status,
      output: `${run.stdout}${run.stderr}`,
      counted: existsSync(join(out, 'count')),
    };
  }

  it('passes when both scans list packages, with no findings', () => {
    const result = scan(withPackages, withPackages, '--fail');
    expect(result.status).toBe(0);
    expect(result.counted).toBe(true);
  });

  it.each([
    ['the image, with an empty result', noPackages, withPackages, 'the image'],
    ['the image, with no results', noResults, withPackages, 'the image'],
    ['the web app, with an empty result', withPackages, noPackages, "the web app's packages"],
    ['the web app, with no results', withPackages, noResults, "the web app's packages"],
  ])('fails on no packages in %s, with or without --fail', (_name, image, web, where) => {
    for (const args of [['--fail'], []]) {
      const result = scan(image, web, ...args);
      expect(result.status).toBe(1);
      expect(result.output).toContain(`no packages in ${where}`);
      expect(result.counted).toBe(false);
    }
  });

  it('asks Trivy to list packages in both reports', () => {
    const text = read('deploy/scan-image.sh');
    expect(text.match(/--format json --list-all-pkgs/g)).toHaveLength(2);
  });
});
