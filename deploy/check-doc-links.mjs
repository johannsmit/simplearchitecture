// Checks that every relative link and #anchor in the documents resolves: README.md, SECURITY.md,
// guide/**/*.md and metamodel/*.md. Anchors follow GitHub's rules for headings. Folder links are
// fine; outside addresses (https:, mailto: …) and links shown as code aren't checked. Prints each
// broken link and exits with 1. Plain Node with no dependencies. Run by `npm run check:links` and
// in CI; not part of the tests, so a copy of the app with its own documents still passes them.
//
//   node deploy/check-doc-links.mjs [repository folder]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fence = /^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm;

/** The documents checked, relative to the root. */
function documents(root) {
  const found = ['README.md', 'SECURITY.md'].filter((path) => existsSync(join(root, path)));
  const walk = (folder, deep) => {
    if (!existsSync(join(root, folder))) return;
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory() && deep) walk(path, deep);
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(path);
    }
  };
  walk('guide', true);
  walk('metamodel', false);
  return found;
}

/** GitHub's anchor for a heading: lower case, punctuation removed, spaces as hyphens. */
function anchorOf(heading) {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // a link or image: its text
    .replace(/<[^>]+>/g, '') // HTML tags
    .replace(/`/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** Every anchor a document has: one per heading (repeats get -1, -2 …), and explicit ids. */
function anchorsOf(text) {
  const anchors = new Set();
  const seen = new Map();
  const prose = text.replace(fence, '');
  for (const [, heading] of prose.matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) {
    const base = anchorOf(heading);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  for (const [, id] of prose.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) anchors.add(id);
  return anchors;
}

/** The link targets in a document: inline links and images, reference definitions, HTML links. */
function targetsOf(text) {
  const prose = text.replace(fence, '').replace(/`[^`\n]*`/g, '');
  return [
    ...[...prose.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]),
    ...[...prose.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/gm)].map((m) => m[1]),
    ...[...prose.matchAll(/<(?:a|img)\s[^>]*?(?:href|src)="([^"]+)"/g)].map((m) => m[1]),
  ];
}

/** A link part with its % escapes decoded, or undefined when one is malformed. */
function decoded(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/** The links that don't resolve, as "file: target (why)". */
function brokenLinks(root) {
  const broken = [];
  const anchors = new Map();
  const anchorsIn = (path) => {
    if (!anchors.has(path)) anchors.set(path, anchorsOf(readFileSync(path, 'utf8')));
    return anchors.get(path);
  };
  for (const document of documents(root)) {
    const from = join(root, document);
    for (const target of targetsOf(readFileSync(from, 'utf8'))) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
      const [rawPath = '', rawFragment] = target.split('#', 2);
      const path = decoded(rawPath);
      const fragment = rawFragment === undefined ? '' : decoded(rawFragment);
      if (path === undefined || fragment === undefined) {
        broken.push(`${document}: ${target} (a malformed % escape)`);
        continue;
      }
      const to = path === '' ? from : resolve(dirname(from), path);
      if (relative(root, to).startsWith('..')) {
        broken.push(`${document}: ${target} (outside the repository)`);
      } else if (!existsSync(to)) {
        broken.push(`${document}: ${target} (no such file)`);
      } else if (fragment === '') {
        continue;
      } else if (statSync(to).isDirectory() || !to.endsWith('.md')) {
        broken.push(`${document}: ${target} (an anchor on something that isn't a document)`);
      } else if (!anchorsIn(to).has(fragment)) {
        broken.push(`${document}: ${target} (no such heading)`);
      }
    }
  }
  return broken;
}

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const broken = brokenLinks(root);
if (broken.length > 0) {
  console.error(`${broken.length} broken link(s) in the documents:`);
  for (const line of broken) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`Links checked in ${documents(root).length} documents: all resolve.`);
