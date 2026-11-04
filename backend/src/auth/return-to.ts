/**
 * Where the browser may go back to after signing in: a path in the web app, never another site.
 * Only same-origin relative paths under the app's spaces and its agents pages (Connected apps and
 * the consent page an AI agent's sign-in goes through) are accepted (with their query, without a
 * fragment); anything else, including `//host`, backslashes, schemes, control characters and dot
 * segments that leave a space, becomes `/`.
 */
const allowedRoots = ['viewing', 'admin', 'modelling', 'agents'] as const;
const maxLength = 1024;
const base = 'http://return-to.invalid';

export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return '/';
  // One leading slash only; no backslashes (browsers treat them as slashes) or control characters.
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  // eslint-disable-next-line no-control-regex -- control characters are what this rejects
  if (/[\\\u0000-\u001f\u007f\s]/.test(value)) return '/';
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return '/';
  }
  if (url.origin !== base) return '/';
  const root = url.pathname.split('/')[1];
  if (!(allowedRoots as readonly (string | undefined)[]).includes(root)) return '/';
  return `${url.pathname}${url.search}`;
}
