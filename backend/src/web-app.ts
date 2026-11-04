import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The built web app (frontend/dist), served by the API so the image has one origin. Every file is
 * read into memory once at startup (about 3 MB): nothing is read from disk per request, no request
 * path ever reaches the file system, and the root file system can be read-only.
 */

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const compressible = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.txt', '.svg']);

/** Vite's content-hashed build output: its name changes whenever its content does. */
const hashedPrefix = '/assets/';
export const immutableCache = 'public, max-age=31536000, immutable';
/** Everything else (index.html, sw.js, registerSW.js, the manifest, icons): always revalidate. */
export const revalidateCache = 'no-cache';

interface WebFile {
  type: string;
  cacheControl: string;
  body: Buffer;
  etag: string;
  gzip?: { body: Buffer; etag: string };
}

export class WebAppError extends Error {
  override name = 'WebAppError';
}

function etagOf(body: Buffer): string {
  return `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
}

/**
 * Never served, even if one lands in the build: dotfiles and dot folders (`.env`, `.git/`) and
 * source maps. The image check refuses them too; this is the defence in the code.
 */
function isHidden(name: string): boolean {
  return name.startsWith('.') || name.toLowerCase().endsWith('.map');
}

// Walks the folder itself: a recursive readdir follows symlinked folders, which could serve files
// from outside the build. Links of any kind are skipped.
function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (isHidden(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

/** Reads a built web app. Throws WebAppError when the folder has no index.html. */
export function loadWebApp(dir: string): Map<string, WebFile> {
  if (!existsSync(join(dir, 'index.html'))) {
    throw new WebAppError('The web app is not built (no index.html). Run `npm run build`.');
  }
  const files = new Map<string, WebFile>();
  for (const path of listFiles(dir)) {
    const urlPath = `/${relative(dir, path).split(sep).join('/')}`;
    const extension = extname(path).toLowerCase();
    const body = readFileSync(path);
    const file: WebFile = {
      type: types[extension] ?? 'application/octet-stream',
      cacheControl: urlPath.startsWith(hashedPrefix) ? immutableCache : revalidateCache,
      body,
      etag: etagOf(body),
    };
    if (compressible.has(extension) && body.length > 1024) {
      const gzip = gzipSync(body, { level: 9 });
      if (gzip.length < body.length) file.gzip = { body: gzip, etag: etagOf(gzip) };
    }
    files.set(urlPath, file);
  }
  return files;
}

/** /api, /auth, /oauth and /mcp belong to the API: never answered with the web app. */
function isApiPath(path: string): boolean {
  return /^\/(api|auth|oauth|mcp)(\/|$)/.test(path);
}

/**
 * A path for the app's client-side router: no file extension in its last segment, and no segment
 * that is hidden (`/.git/config`, `/../x`), which no app route has.
 */
function isAppRoute(path: string): boolean {
  if (path.split('/').some(isHidden)) return false;
  return !path.slice(path.lastIndexOf('/') + 1).includes('.');
}

function send(request: FastifyRequest, reply: FastifyReply, file: WebFile): FastifyReply {
  const acceptsGzip = /\bgzip\b/.test(request.headers['accept-encoding'] ?? '');
  const variant = acceptsGzip && file.gzip ? file.gzip : file;
  reply
    .header('content-type', file.type)
    .header('cache-control', file.cacheControl)
    .header('etag', variant.etag);
  if (file.gzip) reply.header('vary', 'Accept-Encoding');
  if (variant !== file) reply.header('content-encoding', 'gzip');
  if (request.headers['if-none-match'] === variant.etag) return reply.code(304).send();
  return reply.send(variant.body);
}

/**
 * GET (and HEAD) for every path the API doesn't own: a file of the build, or index.html for the
 * app's own routes (the client-side router takes over). Missing files are 404, never index.html.
 */
export function webAppRoutes(files: Map<string, WebFile>): FastifyPluginAsync {
  const index = files.get('/index.html');
  if (index === undefined) throw new WebAppError('The web app has no index.html.');
  return async (app) => {
    app.get('/*', { config: { access: 'public' } }, async (request, reply) => {
      const path = request.url.split('?', 1)[0] ?? '/';
      if (isApiPath(path)) {
        reply.callNotFound();
        return reply;
      }
      const file = files.get(path === '/' ? '/index.html' : path);
      if (file) return send(request, reply, file);
      if (isAppRoute(path)) return send(request, reply, index);
      reply.callNotFound();
      return reply;
    });
  };
}
