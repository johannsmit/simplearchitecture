// Checks a release tag against the version in the package files, before anything is published: the
// tag must be exactly "v" and the version (v1.2.3), and the root package.json, each workspace's
// package.json and package-lock.json must all name that version. Prints why and exits with 1
// otherwise. Plain Node with no dependencies, so it runs on the runner's own Node.
//
//   node deploy/check-release-tag.mjs <tag> [repository folder]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [tag, root = fileURLToPath(new URL('..', import.meta.url))] = process.argv.slice(2);
const stop = 'Nothing was published.';

function fail(message) {
  console.error(`::error::${message} ${stop}`);
  process.exit(1);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(join(root, path), 'utf8'));
  } catch {
    return fail(`${path} can't be read.`);
  }
}

if (tag === undefined || tag === '') {
  fail('Usage: node deploy/check-release-tag.mjs <tag> [repository folder]');
}

// A release version only: no pre-release or build part, no leading zeros.
const release = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
if (!release.test(tag)) {
  fail(
    `The tag "${tag}" isn't a release tag: it must be v and the version in the package files, like v1.2.3.`,
  );
}

const rootPackage = readJson('package.json');
const lockfile = readJson('package-lock.json');
const workspaces = Array.isArray(rootPackage.workspaces) ? rootPackage.workspaces : [];

/** Each place that names the version, with what it says. */
const versions = [
  ['package.json', rootPackage.version],
  ...workspaces.map((name) => [`${name}/package.json`, readJson(`${name}/package.json`).version]),
  ['package-lock.json', lockfile.version],
  ['package-lock.json (root package)', lockfile.packages?.['']?.version],
  ...workspaces.map((name) => [`package-lock.json (${name})`, lockfile.packages?.[name]?.version]),
];

const found = new Set(versions.map(([, version]) => version));
if (found.size !== 1 || typeof versions[0][1] !== 'string') {
  const list = versions.map(([place, version]) => `${place}: ${version ?? 'no version'}`);
  fail(
    `The package files don't agree on the version (${list.join('; ')}). Set it in all of them with npm version.`,
  );
}

const version = versions[0][1];
if (tag !== `v${version}`) {
  fail(`The tag ${tag} doesn't match the version in the package files, ${version}.`);
}
console.log(`The tag ${tag} matches the version ${version} in the package files.`);
