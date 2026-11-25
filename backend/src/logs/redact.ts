/**
 * Defence in depth for stored log entries: the logger already redacts the paths it knows (see
 * app.ts), and this blanks any field named like a credential, at any depth, before an entry is
 * stored and again before it is returned.
 */

export const redacted = '[Redacted]';

/** Field names that may hold a credential: authorization, cookies, passwords, tokens, secrets. */
const secretName =
  /authori[sz]ation|cookie|passw(or)?d|pwd|secret|token|credential|api[-_]?key|private[-_]?key|connection[-_]?string|database[-_]?url|session[-_]?id|^sid$/i;

const maxDepth = 12;

/** NUL and unpaired surrogates: PostgreSQL's jsonb refuses both, and with them the whole batch. */
const unpaired = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function storable(text: string): string {
  return text.replaceAll('\u0000', '').replace(unpaired, '\ufffd');
}

export function isSecretName(name: string): boolean {
  return secretName.test(name);
}

/**
 * A copy of a logged value with every credential-named field replaced by [Redacted], text made
 * storable, and nesting cut at a fixed depth.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return storable(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= maxDepth) return '[Nested too deep]';
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const name = storable(key);
    copy[name] = isSecretName(name) ? redacted : redactSecrets(item, depth + 1);
  }
  return copy;
}
