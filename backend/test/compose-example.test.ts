import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { productionSettings } from '../src/config.js';
import { repoRoot } from '../src/paths.js';

// What the Docker Compose example must keep. Only bringing it up proves it works; this keeps the
// settings, the pins and the guards from being lost in an edit.
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');
const compose = read('deploy/compose/compose.yaml');
const example = read('deploy/compose/example.env');

/** The text of one service: from its key to the next top-level or service key. */
function service(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n(?: {2})?[a-z-]+:/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** The settings in example.env, by name. */
const settings = new Map(
  example
    .split('\n')
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
);

describe('the Docker Compose example', () => {
  it('runs the published image at a version from the settings, never latest', () => {
    expect(service('app')).toContain(
      'image: ghcr.io/johannsmit/simplearchitecture:${SIMPLEARCHITECTURE_VERSION:?',
    );
    expect(compose).not.toMatch(/:latest\b/);
  });

  it('gives the app exactly the settings the image reads, each required from the settings file', () => {
    const app = service('app');
    const block = app.slice(app.indexOf('environment:'), app.indexOf('healthcheck:'));
    const names = [...block.matchAll(/^ {6}([A-Z_]+):/gm)].map((match) => match[1]);
    expect(names.sort()).toEqual([...productionSettings].sort());
    for (const name of productionSettings.filter((name) => name !== 'DATABASE_URL')) {
      expect(block).toContain(`${name}: \${${name}:?Set ${name} in .env}`);
    }
    // The database is reached by its service name, with the password from .env, without TLS: the
    // one plain connection the app allows besides localhost.
    expect(block).toContain(
      'DATABASE_URL: postgres://simplearchitecture:${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}@db:5432/simplearchitecture?sslmode=disable',
    );
  });

  it('has every variable it uses in example.env, as a placeholder with no value', () => {
    const used = new Set([...compose.matchAll(/\$\{([A-Z_]+)/g)].map((match) => match[1]));
    expect([...settings.keys()].sort()).toEqual([...used].sort());
    for (const [name, value] of settings) expect(value, name).toMatch(/^<[^<>]+>$/);
  });

  it('runs PostgreSQL 17 on a named volume, the image the container test and CI use', () => {
    const pinned = /postgres:17\.[\w.-]+@sha256:[0-9a-f]{64}/.exec(compose)?.[0];
    expect(pinned).toBeDefined();
    expect(read('deploy/test-container.sh')).toContain(`pg_image=${pinned ?? ''}`);
    expect(read('.github/workflows/ci.yml')).toContain(`image: ${pinned ?? ''}`);
    expect(service('db')).toContain('- db-data:/var/lib/postgresql/data');
    expect(compose).toMatch(/^volumes:\n {2}db-data:/m);
  });

  it('waits for a healthy database, and checks the app with the health route', () => {
    expect(service('db')).toContain('test: [CMD, pg_isready');
    const app = service('app');
    expect(app).toMatch(/db:\n {8}condition: service_healthy/);
    expect(app).toContain("fetch('http://127.0.0.1:8080/api/health')");
  });

  it("publishes one port, the app's, from the settings, on this machine only", () => {
    expect(compose.match(/^ {4}ports:/gm)).toHaveLength(1);
    expect(service('app')).toContain('- 127.0.0.1:${APP_PORT:?Set APP_PORT in .env}:8080');
  });

  it('runs the app read-only, with no privileges', () => {
    const app = service('app');
    expect(app).toContain('read_only: true');
    expect(app).toContain('cap_drop: [ALL]');
    expect(app).toContain('security_opt: [no-new-privileges:true]');
  });

  it('has just the app and the database, on the network Compose makes for them', () => {
    const services = compose.slice(
      compose.indexOf('\nservices:\n'),
      compose.indexOf('\nvolumes:\n'),
    );
    expect([...services.matchAll(/^ {2}([a-z-]+):$/gm)].map((match) => match[1])).toEqual([
      'db',
      'app',
    ]);
    expect(compose).not.toContain('network_mode');
  });
});
