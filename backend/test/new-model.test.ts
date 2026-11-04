import { readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  maxModelNameLength,
  type ApiError,
  type ElementChangeResult,
  type ElementRejected,
  type JgfDocument,
  type ModelListResponse,
  type ModelSummary,
  type NewModelResult,
} from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/db/service.js';
import { RejectedError } from '../src/editing/common.js';
import { validateJgf } from '../src/jgf/validate.js';
import { newModelBodyLimit } from '../src/limits.js';
import { emptyModel, ModelService } from '../src/models/model-service.js';
import { newModelsPerMinute, tooManyNewModelsMessage } from '../src/rate-limit.js';
import { FileModelStore } from '../src/storage/file-model-store.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import {
  buildTestApp,
  captureLogs,
  idpOptions,
  signIn,
  startMockIdp,
  tempDataDir,
  webOrigin,
  withClaims,
} from './helpers.js';
import { createTestDb, resetTestDb, testConnection, type TestDb } from './pglite.js';

// Creating a new, empty model. Made-up data only.

const user = { oid: '9f0c4f8e-0000-4000-8000-00000000b0b0', name: 'Made-up Admin Person' };
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const url = '/api/models/new';

let idp: OAuth2Server;
let db: TestDb;
let app: FastifyInstance | undefined;
let dataDir: string;

beforeAll(async () => {
  idp = await startMockIdp();
  db = await createTestDb();
});

afterAll(async () => {
  await idp.stop();
  await db.close();
});

beforeEach(async () => {
  dataDir = join(tempDataDir(), 'models');
  await resetTestDb(db);
});

afterEach(async () => {
  idp.service.removeAllListeners('beforeTokenSigning');
  await app?.close();
  app = undefined;
  rmSync(dirname(dataDir), { recursive: true, force: true });
});

interface Start {
  roles?: string[];
  database?: boolean;
  maxModels?: number;
  logs?: boolean;
}

/** The app on the file store (default) or PGlite, signed in with `roles` unless undefined. */
async function start(options: Start = {}): Promise<{ target: FastifyInstance; cookie: string }> {
  const modelStore =
    options.maxModels === undefined
      ? undefined
      : await FileModelStore.open(dataDir, {
          log: { warn: () => undefined },
          maxModels: options.maxModels,
        });
  app = await buildTestApp(
    { DATA_DIR: dataDir, ...(options.logs ? { LOG_LEVEL: 'trace' as const } : {}) },
    idpOptions(idp, {
      ...(modelStore === undefined ? {} : { modelStore }),
      ...(options.database ? { database: DatabaseService.using(db, testConnection, silent) } : {}),
    }),
  );
  if (options.roles === undefined) return { target: app, cookie: '' };
  withClaims(idp, { roles: options.roles, ...user });
  const { sessionCookie } = await signIn(app);
  return { target: app, cookie: sessionCookie };
}

interface Post {
  cookie?: string;
  origin?: string | null;
  contentType?: string;
  /** Sent as is when a string, else as JSON. */
  body?: unknown;
}

function post(target: FastifyInstance, opts: Post = {}) {
  const origin = opts.origin === undefined ? webOrigin : opts.origin;
  const body = opts.body === undefined ? { name: 'Made-up landscape' } : opts.body;
  return target.inject({
    method: 'POST',
    url,
    headers: {
      ...(origin === null ? {} : { origin }),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      'content-type': opts.contentType ?? 'application/json',
    },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function list(target: FastifyInstance, cookie: string): Promise<ModelListResponse> {
  const res = await target.inject({ method: 'GET', url: '/api/models', headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json<ModelListResponse>();
}

const storedFiles = () => readdirSync(dataDir).filter((name) => name.endsWith('.json'));

describe('POST /api/models/new', () => {
  it('creates an empty, valid model for an Admin: 201, listed at once', async () => {
    const { target, cookie } = await start({ roles: ['Admin'] });
    const res = await post(target, { cookie, body: { name: '  Made-up landscape  ' } });
    expect(res.statusCode).toBe(201);
    const { model } = res.json<NewModelResult>();
    expect(model).toMatchObject({
      name: 'Made-up landscape',
      createdBy: { id: user.oid, name: user.name },
      nodeCount: 0,
      edgeCount: 0,
    });
    expect(model).not.toHaveProperty('sourceId');
    expect(res.headers.location).toBe(`/api/models/${model.id}`);

    const listed = await list(target, cookie);
    expect(listed.models).toEqual([model]);
    // The file store can't edit, as for every other model.
    expect(listed.editable).toBe(false);

    const read = await target.inject({
      method: 'GET',
      url: `/api/models/${model.id}`,
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);
    const document = read.json<JgfDocument>();
    expect(document.graph).toMatchObject({
      id: model.id,
      label: 'Made-up landscape',
      nodes: {},
      edges: [],
    });
    const validation = validateJgf(document);
    expect(validation.valid).toBe(true);
    expect(validation.warningCount).toBe(0);
  });

  it('allows the same name twice: each model has its own id', async () => {
    const { target, cookie } = await start({ roles: ['Admin'] });
    const first = (await post(target, { cookie })).json<NewModelResult>().model;
    const second = (await post(target, { cookie })).json<NewModelResult>().model;
    expect(second.id).not.toBe(first.id);
    expect((await list(target, cookie)).models).toHaveLength(2);
  });

  it('accepts a name of exactly the maximum length', async () => {
    const { target, cookie } = await start({ roles: ['Admin'] });
    const name = 'n'.repeat(maxModelNameLength);
    const res = await post(target, { cookie, body: { name } });
    expect(res.statusCode).toBe(201);
    expect(res.json<NewModelResult>().model.name).toBe(name);
  });

  it('gives 401 when signed out, and stores nothing', async () => {
    const { target } = await start();
    const res = await post(target);
    expect(res.statusCode).toBe(401);
    expect(storedFiles()).toEqual([]);
  });

  it.each([[['Viewer']], [['Modeller']], [['Viewer', 'Modeller']], [[]]])(
    'gives roles %j 403, and stores nothing',
    async (roles) => {
      const { target, cookie } = await start({ roles });
      const res = await post(target, { cookie });
      expect(res.statusCode).toBe(403);
      expect(res.json<ApiError>().message).toBe('You do not have access to this resource');
      expect(storedFiles()).toEqual([]);
    },
  );

  it.each([
    ['empty', { name: '' }, 'name', 'Enter a name.'],
    ['whitespace only', { name: ' \t\n ' }, 'name', 'Enter a name.'],
    [
      'too long',
      { name: 'n'.repeat(maxModelNameLength + 1) },
      'name',
      `Must be at most ${maxModelNameLength} characters.`,
    ],
    [
      'too long once trimmed',
      { name: ` ${'n'.repeat(maxModelNameLength + 1)} ` },
      'name',
      `Must be at most ${maxModelNameLength} characters.`,
    ],
    ['a number', { name: 42 }, 'name', 'Enter a name.'],
    ['null', { name: null }, 'name', 'Enter a name.'],
    ['a list', { name: ['Made-up'] }, 'name', 'Enter a name.'],
    ['missing', {}, 'name', 'Enter a name.'],
    [
      'with another field',
      { name: 'Made-up', description: 'x' },
      'description',
      'Is not a field of a model.',
    ],
    ['not an object', ['Made-up'], '', 'Send the model as a JSON object.'],
    ['a JSON string', '"Made-up"', '', 'Send the model as a JSON object.'],
  ])(
    'refuses a name that is %s: 422 with the field, and stores nothing',
    async (_case, body, field, message) => {
      const { target, cookie } = await start({ roles: ['Admin'] });
      const res = await post(target, { cookie, body });
      expect(res.statusCode).toBe(422);
      const rejected = res.json<ElementRejected>();
      expect(rejected.message).toBe('The change is not valid. Nothing was saved.');
      expect(rejected.fields).toEqual([{ field, message }]);
      expect(storedFiles()).toEqual([]);
    },
  );

  it('never echoes the name in a refusal', async () => {
    const { target, cookie } = await start({ roles: ['Admin'] });
    const name = `Made-up secret ${'x'.repeat(maxModelNameLength)}`;
    const res = await post(target, { cookie, body: { name } });
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain('Made-up secret');
  });

  it('needs the web origin (CSRF), even for an Admin', async () => {
    const { target, cookie } = await start({ roles: ['Admin'] });
    for (const origin of [null, 'https://evil.example', 'http://localhost:3001']) {
      const res = await post(target, { cookie, origin });
      expect(res.statusCode, String(origin)).toBe(403);
      expect(res.json<ApiError>().message).toBe('Request origin not allowed');
    }
    expect(storedFiles()).toEqual([]);
  });

  it('takes JSON only: 415 for other media types, 400 for broken JSON, 413 over the body limit', async () => {
    const { target, cookie } = await start({ roles: ['Admin'] });
    for (const contentType of [
      'text/plain',
      'application/xml',
      'application/x-www-form-urlencoded',
    ]) {
      const res = await post(target, { cookie, contentType, body: 'name=Made-up' });
      expect(res.statusCode, contentType).toBe(415);
      expect(res.json<ApiError>().message).toBe('Send the new model as application/json');
    }
    expect((await post(target, { cookie, body: '{"name":' })).statusCode).toBe(400);
    expect((await post(target, { cookie, body: '{"__proto__":{"name":"x"}}' })).statusCode).toBe(
      400,
    );
    const large = JSON.stringify({ name: 'n'.repeat(newModelBodyLimit) });
    expect((await post(target, { cookie, body: large })).statusCode).toBe(413);
    expect(storedFiles()).toEqual([]);
  });

  it('answers 409 when the store is full', async () => {
    const { target, cookie } = await start({ roles: ['Admin'], maxModels: 1 });
    expect((await post(target, { cookie })).statusCode).toBe(201);
    const res = await post(target, { cookie });
    expect(res.statusCode).toBe(409);
    expect(storedFiles()).toHaveLength(1);
  });

  it('has its own rate limit, apart from the upload budget', async () => {
    const { target, cookie } = await start({ roles: ['Admin'] });
    for (let i = 0; i < newModelsPerMinute; i += 1) {
      expect((await post(target, { cookie })).statusCode).toBe(201);
    }
    const refused = await post(target, { cookie });
    expect(refused.statusCode).toBe(429);
    expect(refused.json<ApiError>().message).toBe(tooManyNewModelsMessage);
    expect(refused.headers['retry-after']).toBe('60');
    expect(storedFiles()).toHaveLength(newModelsPerMinute);
    // The upload budget is untouched.
    const upload = await target.inject({
      method: 'POST',
      url: '/api/models',
      headers: { origin: webOrigin, cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(emptyModel('Made-up upload')),
    });
    expect(upload.statusCode).toBe(201);
  });

  it('writes one audit line with ids only, never the name', async () => {
    const { target, cookie } = await start({ roles: ['Admin'], logs: true });
    const lines = captureLogs(target);
    const model = (
      await post(target, { cookie, body: { name: 'Made-up secret model name' } })
    ).json<NewModelResult>().model;
    // A refused request is not an audit event.
    await post(target, { cookie, body: { name: '' } });

    const audit = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.audit !== undefined);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      audit: 'model-created',
      msg: 'model created',
      userId: user.oid,
      modelId: model.id,
    });
    const log = lines.join('');
    expect(log).not.toContain('Made-up secret model name');
    expect(log).not.toContain(user.name);
  });
});

describe('a new model with PostgreSQL', () => {
  it('is stored, listed as editable, and takes its first element', async () => {
    const { target, cookie } = await start({ roles: ['Admin'], database: true });
    const res = await post(target, { cookie });
    expect(res.statusCode).toBe(201);
    const { model } = res.json<NewModelResult>();

    const listed = await list(target, cookie);
    expect(listed.editable).toBe(true);
    expect(listed.models).toEqual([model]);

    const read = await target.inject({
      method: 'GET',
      url: `/api/models/${model.id}`,
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);
    const document = read.json<JgfDocument>();
    expect(Object.keys(document.graph.nodes ?? {})).toEqual([]);
    expect(document.graph.edges ?? []).toEqual([]);
    expect(validateJgf(document).valid).toBe(true);

    const added = await target.inject({
      method: 'POST',
      url: `/api/models/${model.id}/elements`,
      headers: { origin: webOrigin, cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 'Application', name: 'Made-up first app' }),
    });
    expect(added.statusCode).toBe(201);
    const element = added.json<ElementChangeResult>().element;
    const after = (
      await target.inject({ method: 'GET', url: `/api/models/${model.id}`, headers: { cookie } })
    ).json<JgfDocument>();
    expect(Object.keys(after.graph.nodes ?? {})).toEqual([element.id]);
  });
});

describe('ModelService (for the routes and a future MCP server)', () => {
  const actor = { id: 'oid-made-up', name: 'Made-up Actor' };

  it('makes a valid, empty JGF document', () => {
    const document = emptyModel('Made-up');
    expect(document).toEqual({ graph: { label: 'Made-up', directed: true, nodes: {}, edges: [] } });
    expect(validateJgf(document)).toMatchObject({ valid: true, errorCount: 0, warningCount: 0 });
  });

  it('stores the trimmed name through the store, and refuses a bad request before it', async () => {
    const store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
    const service = new ModelService(store);
    const model: ModelSummary = await service.createModel({ name: ' Made-up ' }, actor);
    expect(model).toMatchObject({ name: 'Made-up', nodeCount: 0, edgeCount: 0, createdBy: actor });
    expect(await store.list()).toEqual([model]);

    await expect(service.createModel({ name: ' ' }, actor)).rejects.toBeInstanceOf(RejectedError);
    await expect(service.createModel(undefined, actor)).rejects.toBeInstanceOf(RejectedError);
    expect(await store.list()).toHaveLength(1);
  });
});
