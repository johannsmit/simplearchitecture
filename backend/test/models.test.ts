import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  storedModelKey,
  type ApiError,
  type ImportOefModelResult,
  type JgfDocument,
  type ModelListResponse,
  type ModelRejected,
  type SaveModelResult,
} from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { sampleModel } from '../src/jgf/sample.js';
import { maxImportNodes, maxJsonDepth } from '../src/limits.js';
import { jgfBodyLimit } from '../src/routes/body.js';
import { uploadsPerMinute } from '../src/rate-limit.js';
import { invalidModelIdMessage, modelNotFoundMessage } from '../src/routes/models.js';
import { FileModelStore } from '../src/storage/file-model-store.js';
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

const bakery = readFileSync(new URL('./fixtures/bakery-oef.xml', import.meta.url), 'utf8');
const user = { oid: '9f0c4f8e-0000-4000-8000-00000000abcd', name: 'Made-up Modeller Person' };

let idp: OAuth2Server;
let app: FastifyInstance | undefined;
let dataDir: string;

beforeAll(async () => {
  idp = await startMockIdp();
});

afterAll(async () => {
  await idp.stop();
});

beforeEach(() => {
  // A temporary DATA_DIR per test, inside a parent the tests can inspect (never the real data/).
  dataDir = join(tempDataDir(), 'models');
});

afterEach(async () => {
  idp.service.removeAllListeners('beforeTokenSigning');
  await app?.close();
  app = undefined;
  rmSync(dirname(dataDir), { recursive: true, force: true });
});

async function start(
  overrides: Partial<Config> = {},
  options: { maxModels?: number; maxFileBytes?: number } = {},
): Promise<FastifyInstance> {
  const modelStore =
    options.maxModels === undefined && options.maxFileBytes === undefined
      ? undefined
      : await FileModelStore.open(dataDir, { log: { warn: () => undefined }, ...options });
  app = await buildTestApp(
    { DATA_DIR: dataDir, ...overrides },
    idpOptions(idp, modelStore === undefined ? {} : { modelStore }),
  );
  return app;
}

async function signedInAs(
  roles: string[],
  overrides: Partial<Config> = {},
  options: { maxModels?: number; maxFileBytes?: number } = {},
): Promise<{ target: FastifyInstance; cookie: string }> {
  const target = await start(overrides, options);
  withClaims(idp, { roles, ...user });
  const { sessionCookie } = await signIn(target);
  return { target, cookie: sessionCookie };
}

interface Send {
  cookie?: string;
  origin?: string | null;
  contentType?: string;
  payload?: string;
}

function send(target: FastifyInstance, method: 'POST' | 'DELETE', url: string, opts: Send = {}) {
  const origin = opts.origin === undefined ? webOrigin : opts.origin;
  const isOef = url.endsWith('/oef');
  return target.inject({
    method,
    url,
    headers: {
      ...(origin === null ? {} : { origin }),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(method === 'POST'
        ? { 'content-type': opts.contentType ?? (isOef ? 'application/xml' : 'application/json') }
        : {}),
    },
    ...(method === 'POST'
      ? { payload: opts.payload ?? (isOef ? bakery : JSON.stringify(sampleModel)) }
      : {}),
  });
}

function get(target: FastifyInstance, url: string, cookie?: string) {
  return target.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
}

async function saveSample(target: FastifyInstance, cookie: string, payload?: string) {
  const res = await send(target, 'POST', '/api/models', {
    cookie,
    ...(payload ? { payload } : {}),
  });
  expect(res.statusCode).toBe(201);
  return res.json<SaveModelResult>().model;
}

const unknownId = '0b6f8d55-1c1e-4b7e-9a51-6c1c2f4f2d10';

const viewingRoutes = [
  ['GET', '/api/models'],
  ['GET', `/api/models/${unknownId}`],
] as const;
/** Admin routes that change the store: these also need the web origin (CSRF). */
const adminWriteRoutes = [
  ['POST', '/api/models'],
  ['POST', '/api/models/import/oef'],
  ['DELETE', `/api/models/${unknownId}`],
] as const;
const adminRoutes = [['GET', '/api/admin/models/damaged'], ...adminWriteRoutes] as const;

function call(
  target: FastifyInstance,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  cookie?: string,
) {
  return method === 'GET'
    ? get(target, url, cookie)
    : send(target, method, url, cookie ? { cookie } : {});
}

describe('model routes: access', () => {
  it.each([...viewingRoutes, ...adminRoutes])(
    '%s %s returns 401 when signed out',
    async (method, url) => {
      const target = await start();
      const res = await call(target, method, url);
      expect(res.statusCode).toBe(401);
      expect(res.json<ApiError>().error).toBe('Unauthorized');
    },
  );

  it.each([[[]], [['Superuser']]])('roles %j get 403 on every model route', async (roles) => {
    const { target, cookie } = await signedInAs(roles);
    for (const [method, url] of [...viewingRoutes, ...adminRoutes]) {
      const res = await call(target, method, url, cookie);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it.each([['Viewer'], ['Modeller']])(
    'a %s lists and reads models, but may not save, import or delete them',
    async (role) => {
      const modeller = await signedInAs(['Admin']);
      const saved = await saveSample(modeller.target, modeller.cookie);
      const { sessionCookie: viewer } = await (async () => {
        idp.service.removeAllListeners('beforeTokenSigning');
        withClaims(idp, { roles: [role], ...user });
        return signIn(modeller.target);
      })();

      const list = await get(modeller.target, '/api/models', viewer);
      expect(list.statusCode).toBe(200);
      expect(list.json<ModelListResponse>().models).toEqual([saved]);
      const read = await get(modeller.target, `/api/models/${saved.id}`, viewer);
      expect(read.statusCode).toBe(200);
      expect(read.json<JgfDocument>().graph.id).toBe(saved.id);

      for (const [method, url] of [
        ...adminRoutes,
        ['DELETE', `/api/models/${saved.id}`] as const,
      ]) {
        const res = await call(modeller.target, method, url, viewer);
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json<ApiError>().message).toBe('You do not have access to this resource');
      }
      expect(
        (await get(modeller.target, '/api/models', viewer)).json<ModelListResponse>().models,
      ).toHaveLength(1);
    },
  );

  it.each([[['Admin']], [['Viewer', 'Admin']], [['Modeller', 'Admin']]])(
    'roles %j may use every model route',
    async (roles) => {
      const { target, cookie } = await signedInAs(roles);
      const saved = await saveSample(target, cookie);
      const imported = await send(target, 'POST', '/api/models/import/oef', { cookie });
      expect(imported.statusCode).toBe(201);
      for (const url of ['/api/models', `/api/models/${saved.id}`]) {
        const res = await get(target, url, cookie);
        expect(res.statusCode, url).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
      }
      const deleted = await send(target, 'DELETE', `/api/models/${saved.id}`, { cookie });
      expect(deleted.statusCode).toBe(204);
    },
  );

  it.each(adminWriteRoutes)(
    '%s %s needs the web origin (CSRF), even for an Admin',
    async (method, url) => {
      const { target, cookie } = await signedInAs(['Admin']);
      for (const origin of [null, 'https://evil.example', 'http://localhost:3001']) {
        const res = await send(target, method, url, { cookie, origin });
        expect(res.statusCode, String(origin)).toBe(403);
        expect(res.json<ApiError>().message).toBe('Request origin not allowed');
      }
      expect(readdirSync(dataDir)).toEqual([]);
    },
  );

  it('refuses a foreign origin on DELETE without deleting anything', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const saved = await saveSample(target, cookie);
    const res = await send(target, 'DELETE', `/api/models/${saved.id}`, {
      cookie,
      origin: 'https://evil.example',
    });
    expect(res.statusCode).toBe(403);
    expect(readdirSync(dataDir)).toEqual([`${saved.id}.json`]);
  });

  it('refuses a Viewer before reading an oversized body', async () => {
    const modeller = await signedInAs(['Viewer']);
    const res = await send(modeller.target, 'POST', '/api/models', {
      cookie: modeller.cookie,
      payload: ' '.repeat(jgfBodyLimit + 1),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('exporting a model', () => {
  it('gives an Admin a file that imports again, with the same content', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const first = await saveSample(target, cookie);

    const exported = await get(target, `/api/models/${first.id}`, cookie);
    expect(exported.statusCode).toBe(200);

    // The bytes the web app saves: the document with two-space indents.
    const file = `${JSON.stringify(exported.json(), null, 2)}\n`;
    const second = await saveSample(target, cookie, file);
    expect(second.id).not.toBe(first.id);
    expect(second.name).toBe(first.name);
    expect(second.nodeCount).toBe(first.nodeCount);
    expect(second.edgeCount).toBe(first.edgeCount);

    const again = await get(target, `/api/models/${second.id}`, cookie);
    const graph = (res: typeof exported) =>
      res.json<{ graph: { nodes: unknown; edges: unknown } }>().graph;
    expect(graph(again).nodes).toEqual(graph(exported).nodes);
    expect(graph(again).edges).toEqual(graph(exported).edges);
  });
});

describe('POST /api/models', () => {
  it('saves a valid model: 201, its metadata and the validation result', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const res = await send(target, 'POST', '/api/models', { cookie });
    expect(res.statusCode).toBe(201);
    const body = res.json<SaveModelResult>();
    expect(body.model).toEqual({
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ) as string,
      name: 'Sample model (made up)',
      createdAt: expect.any(String) as string,
      createdBy: { id: user.oid, name: user.name },
      nodeCount: 6,
      edgeCount: 3,
      sourceId: 'sample-model',
    });
    expect(Date.parse(body.model.createdAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(body.validation).toMatchObject({ valid: true, errorCount: 0, warningCount: 0 });
    expect(res.headers.location).toBe(`/api/models/${body.model.id}`);

    // Stored as one JGF file named by the id; read back with the server data in place.
    expect(readdirSync(dataDir)).toEqual([`${body.model.id}.json`]);
    const stored = (await get(target, `/api/models/${body.model.id}`, cookie)).json<JgfDocument>();
    expect(stored.graph.id).toBe(body.model.id);
    expect(stored.graph.metadata?.[storedModelKey]).toEqual(body.model);
    expect(stored.graph.nodes).toEqual(sampleModel.graph.nodes);
    const list = (await get(target, '/api/models', cookie)).json<ModelListResponse>();
    expect(list.models).toEqual([body.model]);
  });

  it('imports a file saved by Export: a new model with the same elements and relationships', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const original = await saveSample(target, cookie);
    const exported = (await get(target, `/api/models/${original.id}`, cookie)).body;

    // Export saves the document indented; the bytes differ, the model doesn't.
    const file = JSON.stringify(JSON.parse(exported), null, 2);
    const restored = await saveSample(target, cookie, file);
    expect(restored.id).not.toBe(original.id);
    expect(restored).toMatchObject({
      name: original.name,
      nodeCount: original.nodeCount,
      edgeCount: original.edgeCount,
    });

    const again = (await get(target, `/api/models/${restored.id}`, cookie)).json<JgfDocument>();
    const first = JSON.parse(exported) as JgfDocument;
    expect(again.graph.nodes).toEqual(first.graph.nodes);
    expect(again.graph.edges).toEqual(first.graph.edges);
    // The server's own details are its own, whatever the file says.
    const stored = again.graph.metadata?.[storedModelKey] as { id: string };
    expect(stored.id).toBe(restored.id);
  });

  it.each([
    ['not JSON', 'this is not json', 400],
    ['an array', '[]', 422],
    ['an unknown element type', '{"graph":{"nodes":{"a":{"metadata":{"type":"Nonsense"}}}}}', 422],
  ])('refuses a file that is %s, safely and with nothing saved', async (_name, payload, status) => {
    const { target, cookie } = await signedInAs(['Admin']);
    const res = await send(target, 'POST', '/api/models', { cookie, payload });
    expect(res.statusCode).toBe(status);
    expect(res.body).not.toContain('    at ');
    const list = (await get(target, '/api/models', cookie)).json<ModelListResponse>();
    expect(list.models).toEqual([]);
  });

  it('saves a model with warnings and returns them', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const payload = JSON.stringify({
      graph: {
        label: 'With warnings',
        nodes: { a: { metadata: { type: 'Application', supplierHqCountry: 'Holland' } } },
      },
    });
    const res = await send(target, 'POST', '/api/models', { cookie, payload });
    expect(res.statusCode).toBe(201);
    const body = res.json<SaveModelResult>();
    expect(body.validation).toMatchObject({ valid: true, warningCount: 1 });
    expect(body.validation.warnings[0]).toMatchObject({ code: 'non-iso-country', nodeId: 'a' });
  });

  it('refuses a model with validation errors: 422 with every issue, and saves nothing', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const payload = JSON.stringify({
      graph: {
        nodes: { a: { metadata: { type: 'Server' } } },
        edges: [{ id: 'x', source: 'a', target: 'nowhere', relation: 'Relation' }],
      },
    });
    const res = await send(target, 'POST', '/api/models', { cookie, payload });
    expect(res.statusCode).toBe(422);
    const body = res.json<ModelRejected>();
    expect(body).toMatchObject({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'The model is not valid (2 errors). Nothing was saved.',
      validation: { valid: false, errorCount: 2 },
    });
    expect(body.validation.errors.map((e) => e.code)).toEqual([
      'unknown-node-type',
      'unknown-node',
    ]);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it('replaces any id or server data the client sends', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const payload = JSON.stringify({
      graph: {
        ...sampleModel.graph,
        id: '../../etc/passwd',
        metadata: { [storedModelKey]: { id: 'forged', createdBy: { id: 'someone-else' } } },
      },
    });
    const model = await saveSample(target, cookie, payload);
    expect(model.createdBy.id).toBe(user.oid);
    const stored = (await get(target, `/api/models/${model.id}`, cookie)).json<JgfDocument>();
    expect(stored.graph.id).toBe(model.id);
    expect(stored.graph.metadata?.[storedModelKey]).toEqual(model);
  });

  it('round-trips: a stored model posted again is saved as a new model', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const first = await saveSample(target, cookie);
    const stored = (await get(target, `/api/models/${first.id}`, cookie)).body;
    const second = await saveSample(target, cookie, stored);
    expect(second.id).not.toBe(first.id);
    expect(second.nodeCount).toBe(first.nodeCount);
  });

  it.each([
    ['malformed JSON', '{"graph": ', 400, 'Body is not valid JSON'],
    [
      'a reserved key',
      '{"graph":{"nodes":{"__proto__":{"metadata":{"type":"Other"}}}}}',
      400,
      'The key "__proto__" is reserved: it can\'t be a node id, edge id or metadata key.',
    ],
    [
      'JSON nested too deeply',
      `{"graph":{"metadata":{"x":${'['.repeat(5000)}${']'.repeat(5000)}}}}`,
      400,
      `The JSON is nested too deeply (more than ${maxJsonDepth} levels).`,
    ],
    [
      'too many nodes',
      `{"graph":{"nodes":{${Array.from({ length: maxImportNodes + 1 }, (_, i) => `"n${i}":{}`).join(',')}}}}`,
      413,
      `The model has more than ${maxImportNodes} nodes.`,
    ],
  ])('refuses %s, and saves nothing', async (_name, payload, status, message) => {
    const { target, cookie } = await signedInAs(['Admin']);
    const res = await send(target, 'POST', '/api/models', { cookie, payload });
    expect(res.statusCode).toBe(status);
    expect(res.json<ApiError>().message).toBe(message);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it('refuses a body over the JGF limit with 413', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const res = await send(target, 'POST', '/api/models', {
      cookie,
      payload: `{"graph":{"label":"${'x'.repeat(jgfBodyLimit)}"}}`,
    });
    expect(res.statusCode).toBe(413);
  });

  it.each(['text/plain', 'application/xml', 'application/x-www-form-urlencoded'])(
    'answers 415 to %s before reading the body',
    async (contentType) => {
      const { target, cookie } = await signedInAs(['Admin']);
      const res = await send(target, 'POST', '/api/models', {
        cookie,
        contentType,
        payload: 'x'.repeat(jgfBodyLimit + 1),
      });
      expect(res.statusCode).toBe(415);
      expect(res.json<ApiError>().message).toBe('Send the JGF file as application/json');
    },
  );

  it('answers 409 with a clear message when the store is full, and saves nothing', async () => {
    const { target, cookie } = await signedInAs(['Admin'], {}, { maxModels: 2 });
    await saveSample(target, cookie);
    await saveSample(target, cookie);
    const res = await send(target, 'POST', '/api/models', { cookie });
    expect(res.statusCode).toBe(409);
    expect(res.json<ApiError>()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'The model store is full (2 models). Delete a model before saving another.',
    });
    const oef = await send(target, 'POST', '/api/models/import/oef', { cookie });
    expect(oef.statusCode).toBe(409);
    expect(readdirSync(dataDir)).toHaveLength(2);
  });
});

describe('POST /api/models with older relationship types', () => {
  it('stores them converted, with a note in the report', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const older = {
      graph: {
        nodes: {
          a: { label: 'Made-up A', metadata: { type: 'Application' } },
          b: { label: 'Made-up B', metadata: { type: 'Application' } },
        },
        edges: [
          { id: 'f', source: 'a', target: 'b', relation: 'Information flow', directed: false },
          { id: 'i', source: 'b', target: 'a', relation: 'Integration', label: 'API' },
        ],
      },
    };
    const res = await send(target, 'POST', '/api/models', {
      cookie,
      payload: JSON.stringify(older),
    });
    expect(res.statusCode).toBe(201);
    const { model, validation } = res.json<SaveModelResult>();
    expect(validation.warnings.map((issue) => issue.code)).toEqual(['older-relationship-types']);
    const stored = (await get(target, `/api/models/${model.id}`, cookie)).json<JgfDocument>();
    expect(stored.graph.edges).toEqual([
      {
        id: 'f',
        source: 'a',
        target: 'b',
        relation: 'Relation',
        directed: false,
        metadata: { informationFlow: true },
      },
      { id: 'i', source: 'b', target: 'a', relation: 'Relation', label: 'API' },
    ]);
  });
});

describe('POST /api/models/import/oef', () => {
  it('converts and saves the file: 201 with the metadata, the mapping report and the validation', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const res = await send(target, 'POST', '/api/models/import/oef', { cookie });
    expect(res.statusCode).toBe(201);
    const body = res.json<ImportOefModelResult>();
    expect(body.model).toMatchObject({
      name: 'Bakery landscape',
      createdBy: { id: user.oid, name: user.name },
      nodeCount: 12,
      edgeCount: 3,
      // The OEF model identifier.
      sourceId: 'model-bakery',
    });
    expect(res.headers.location).toBe(`/api/models/${body.model.id}`);
    expect(body.report.relationships.mapped).toEqual({
      Relation: 3,
      Contains: 0,
    });
    expect(body.report.relationships.foldedEnds).toEqual({
      count: 1,
      listed: [{ id: 'r-from-function', type: 'Flow', reason: 'source-folded', end: 'source' }],
      truncated: false,
    });
    // Warnings don't stop the save.
    expect(body.validation).toMatchObject({ valid: true, errorCount: 0, warningCount: 1 });

    const stored = (await get(target, `/api/models/${body.model.id}`, cookie)).json<JgfDocument>();
    expect(Object.keys(stored.graph.nodes ?? {})).toHaveLength(12);
    expect(stored.graph.label).toBe('Bakery landscape');
  });

  it('refuses a model with validation errors: 422 with the report, and saves nothing', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    // An architecture state the mapping doesn't translate is kept as is, and is invalid.
    const payload = bakery.replace(/(<value[^>]*>)Target state(<\/value>)/, '$1Someday$2');
    expect(payload).not.toBe(bakery);
    const res = await send(target, 'POST', '/api/models/import/oef', { cookie, payload });
    expect(res.statusCode).toBe(422);
    const body = res.json<ModelRejected>();
    expect(body.message).toBe('The model is not valid (1 error). Nothing was saved.');
    expect(body.validation.errors[0]?.code).toBe('invalid-property-value');
    expect(body.report?.elements.total).toBeGreaterThan(0);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it.each([
    ['malformed XML', '<model><elements></model>', 400],
    ['a DOCTYPE', '<!DOCTYPE m [<!ENTITY x "y">]><model>&x;</model>', 400],
    ['XML that is not an OEF model', '<html/>', 400],
    [
      'too many elements',
      `<model><elements>${'<element/>'.repeat(maxImportNodes + 1)}</elements></model>`,
      413,
    ],
  ])('refuses %s, and saves nothing', async (_name, payload, status) => {
    const { target, cookie } = await signedInAs(['Admin']);
    const res = await send(target, 'POST', '/api/models/import/oef', { cookie, payload });
    expect(res.statusCode).toBe(status);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it('answers 415 to JSON', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const res = await send(target, 'POST', '/api/models/import/oef', {
      cookie,
      contentType: 'application/json',
      payload: '{}',
    });
    expect(res.statusCode).toBe(415);
  });
});

describe('GET and DELETE /api/models/:id', () => {
  it('deletes a model: 204, then it is gone (404)', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const saved = await saveSample(target, cookie);
    const res = await send(target, 'DELETE', `/api/models/${saved.id}`, { cookie });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(readdirSync(dataDir)).toEqual([]);

    for (const again of [
      await get(target, `/api/models/${saved.id}`, cookie),
      await send(target, 'DELETE', `/api/models/${saved.id}`, { cookie }),
    ]) {
      expect(again.statusCode).toBe(404);
      expect(again.json<ApiError>().message).toBe(modelNotFoundMessage);
    }
    expect((await get(target, '/api/models', cookie)).json<ModelListResponse>().models).toEqual([]);
  });

  it('answers 404 to an unknown id', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    expect((await get(target, `/api/models/${unknownId}`, cookie)).statusCode).toBe(404);
    expect((await send(target, 'DELETE', `/api/models/${unknownId}`, { cookie })).statusCode).toBe(
      404,
    );
  });

  // Each attempt points at a file next to DATA_DIR. None may be read or deleted.
  it.each([
    '..%2Foutside.json',
    '..%2Foutside',
    '..%2F..%2F..%2Fetc%2Fpasswd',
    '%2e%2e%2Foutside',
    '.',
    '..%5Coutside',
    'outside',
    `${unknownId}.json`,
    unknownId.toUpperCase(),
    `${unknownId}%00`,
    `${unknownId}%2F..%2F..%2Foutside`,
    `%20${unknownId}`,
    'not-a-uuid',
  ])('refuses the id %s with 400 and never touches the filesystem', async (id) => {
    const { target, cookie } = await signedInAs(['Admin']);
    const outside = join(dirname(dataDir), 'outside.json');
    writeFileSync(outside, JSON.stringify(sampleModel));
    for (const res of [
      await get(target, `/api/models/${id}`, cookie),
      await send(target, 'DELETE', `/api/models/${id}`, { cookie }),
    ]) {
      expect(res.statusCode, id).toBe(400);
      expect(res.json<ApiError>().message).toBe(invalidModelIdMessage);
      expect(res.body).not.toContain('Made up');
    }
    expect(existsSync(outside)).toBe(true);
  });

  it.each(['..', '../outside.json', '%2F..%2Foutside', `${unknownId}/extra`])(
    'gives no access to the paths %s (not a model route)',
    async (path) => {
      const { target, cookie } = await signedInAs(['Admin']);
      const res = await get(target, `/api/models/${path}`, cookie);
      expect([400, 404]).toContain(res.statusCode);
    },
  );

  it('lists the other models when one file is damaged, and answers 500 with a safe message when it is read', async () => {
    const { target, cookie } = await signedInAs(['Admin'], {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
    });
    const lines = captureLogs(target);
    const good = await saveSample(target, cookie);
    const bad = await saveSample(target, cookie);
    writeFileSync(join(dataDir, `${bad.id}.json`), '{"graph": "Made-up secret content');

    const list = await get(target, '/api/models', cookie);
    expect(list.statusCode).toBe(200);
    expect(list.json<ModelListResponse>().models).toEqual([good]);

    const read = await get(target, `/api/models/${bad.id}`, cookie);
    expect(read.statusCode).toBe(500);
    expect(read.json<ApiError>()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'The stored model could not be read. Its file may be damaged; see the API log.',
    });
    expect(read.body).not.toContain('secret');

    const log = lines.join('');
    expect(log).toContain(`"file":"${bad.id}.json"`);
    expect(log).toContain('model file is damaged');
    expect(log).not.toContain('secret');

    // A damaged model can still be deleted.
    expect((await send(target, 'DELETE', `/api/models/${bad.id}`, { cookie })).statusCode).toBe(
      204,
    );
  });
});

describe('a damaged stored model', () => {
  it('is left out of the list, and GET answers 500 with a safe message, never the content', async () => {
    const { target, cookie } = await signedInAs(['Admin'], { LOG_LEVEL: 'info' });
    const lines = captureLogs(target);
    const good = await saveSample(target, cookie);
    const bad = await saveSample(target, cookie);
    const file = join(dataDir, `${bad.id}.json`);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as JgfDocument;
    // Well-formed JSON with the server data intact, but not a model a client can handle.
    writeFileSync(
      file,
      JSON.stringify({ graph: { ...stored.graph, edges: 'Made-up secret content' } }),
    );

    const list = await get(target, '/api/models', cookie);
    expect(list.json<ModelListResponse>().models.map((m) => m.id)).toEqual([good.id]);

    const read = await get(target, `/api/models/${bad.id}`, cookie);
    expect(read.statusCode).toBe(500);
    expect(read.json<ApiError>()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message:
        "The stored model is damaged: it doesn't pass validation, so it can't be shown. See the API log.",
    });
    expect(read.body).not.toContain('secret');
    const log = lines.join('');
    expect(log).toContain('"reason":"invalid-model"');
    expect(log).not.toContain('secret');

    // A valid model still reads.
    expect((await get(target, `/api/models/${good.id}`, cookie)).statusCode).toBe(200);
  });

  it('is listed for Admins by id only, and can be deleted', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const good = await saveSample(target, cookie);
    const bad = await saveSample(target, cookie);
    const unreadable = await saveSample(target, cookie);
    const file = join(dataDir, `${bad.id}.json`);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as JgfDocument;
    writeFileSync(file, JSON.stringify({ graph: { ...stored.graph, edges: 'Made-up secret' } }));
    writeFileSync(join(dataDir, `${unreadable.id}.json`), 'Made-up secret, not JSON');

    const damaged = await get(target, '/api/admin/models/damaged', cookie);
    expect(damaged.statusCode).toBe(200);
    expect(damaged.json()).toEqual({
      models: [{ id: bad.id }, { id: unreadable.id }].sort((a, b) => a.id.localeCompare(b.id)),
    });
    expect(damaged.body).not.toMatch(/secret|Sample|Made-up/i);
    expect(
      (await get(target, '/api/models', cookie)).json<ModelListResponse>().models.map((m) => m.id),
    ).toEqual([good.id]);

    for (const id of [bad.id, unreadable.id]) {
      expect((await send(target, 'DELETE', `/api/models/${id}`, { cookie })).statusCode).toBe(204);
    }
    expect((await get(target, '/api/admin/models/damaged', cookie)).json()).toEqual({
      models: [],
    });
  });
});

describe('audit log', () => {
  // Made-up content that must never reach the log.
  const secrets = [
    'Made-up secret label',
    'Secret node label',
    'Secret description',
    'secret-node-id',
  ];
  const secretModel = JSON.stringify({
    graph: {
      label: 'Made-up secret label',
      nodes: {
        'secret-node-id': {
          label: 'Secret node label',
          metadata: { type: 'Application', description: 'Secret description' },
        },
        other: { metadata: { type: 'Other' } },
      },
      edges: [{ source: 'secret-node-id', target: 'other', relation: 'Relation' }],
    },
  });

  interface LogLine {
    msg?: string;
    audit?: string;
    userId?: string;
    modelId?: string;
    nodes?: number;
    edges?: number;
  }

  it('logs who saved, imported and deleted which model, with counts only', async () => {
    const { target, cookie } = await signedInAs(['Admin'], { LOG_LEVEL: 'trace' });
    const lines = captureLogs(target);

    const saved = (
      await send(target, 'POST', '/api/models', { cookie, payload: secretModel })
    ).json<SaveModelResult>().model;
    const imported = (
      await send(target, 'POST', '/api/models/import/oef', { cookie })
    ).json<ImportOefModelResult>().model;
    await get(target, '/api/models', cookie);
    await get(target, `/api/models/${saved.id}`, cookie);
    await send(target, 'DELETE', `/api/models/${saved.id}`, { cookie });
    // Refused saves are not audit events.
    await send(target, 'POST', '/api/models', { cookie, payload: '{"graph":{"nodes":{"a":{}}}}' });

    const entries = lines.map((line) => JSON.parse(line) as LogLine);
    const audit = entries.filter((entry) => entry.audit !== undefined);
    expect(
      audit.map(({ audit: event, msg, userId, modelId, nodes, edges }) => ({
        event,
        msg,
        userId,
        modelId,
        nodes,
        edges,
      })),
    ).toEqual([
      {
        event: 'model-saved',
        msg: 'model saved',
        userId: user.oid,
        modelId: saved.id,
        nodes: 2,
        edges: 1,
      },
      {
        event: 'model-imported',
        msg: 'model imported and saved',
        userId: user.oid,
        modelId: imported.id,
        nodes: 12,
        edges: 3,
      },
      {
        event: 'model-deleted',
        msg: 'model deleted',
        userId: user.oid,
        modelId: saved.id,
        nodes: 2,
        edges: 1,
      },
    ]);

    // No names, labels or content anywhere in the log, at any level.
    const log = lines.join('');
    for (const secret of [...secrets, user.name, 'Bakery landscape', 'Web shop']) {
      expect(log).not.toContain(secret);
    }
  });
});

// HEAD, more id shapes, spoofing another user's model, and races through
// the routes. Everything here is made up.
describe('model routes under attack', () => {
  function head(target: FastifyInstance, url: string, cookie?: string) {
    return target.inject({ method: 'HEAD', url, headers: cookie ? { cookie } : {} });
  }

  it('HEAD follows the GET rules: 401 signed out, 403 without a role, 200 for a Viewer', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const saved = await saveSample(target, cookie);
    expect((await head(target, `/api/models/${saved.id}`)).statusCode).toBe(401);
    expect((await head(target, '/api/models')).statusCode).toBe(401);

    idp.service.removeAllListeners('beforeTokenSigning');
    withClaims(idp, { roles: [], oid: 'b0000000-0000-4000-8000-000000000001', name: 'Made-up' });
    const noRole = (await signIn(target)).sessionCookie;
    expect((await head(target, `/api/models/${saved.id}`, noRole)).statusCode).toBe(403);

    idp.service.removeAllListeners('beforeTokenSigning');
    withClaims(idp, { roles: ['Viewer'], oid: 'b0000000-0000-4000-8000-000000000002', name: 'V' });
    const viewer = (await signIn(target)).sessionCookie;
    const res = await head(target, `/api/models/${saved.id}`, viewer);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  const unknown = '0b6f8d55-1c1e-4b7e-9a51-6c1c2f4f2d10';
  it.each([
    ['double-encoded ../', '..%252F..%252Foutside.json'],
    ['double-encoded dots and slash', '%252e%252e%252foutside'],
    ['overlong UTF-8 dots', '%C0%AE%C0%AE%2Foutside'],
    ['one-dot leaders', '%E2%80%A4%E2%80%A4%2Foutside'],
    ['fullwidth dots and slash', '%EF%BC%8E%EF%BC%8E%EF%BC%8Foutside'],
    ['a trailing dot', `${unknown}.`],
    ['a trailing encoded slash', `${unknown}%2F`],
    ['a fullwidth digit', `%EF%BC%90${unknown.slice(1)}`],
    ['a non-breaking hyphen', unknown.replace('-', '%E2%80%91')],
    ['a version 1 UUID', unknown.replace(/^(.{14})4/, '$11')],
    ['the nil UUID', '00000000-0000-0000-0000-000000000000'],
    ['braces', `%7B${unknown}%7D`],
  ])('refuses an id with %s on GET, HEAD and DELETE (400)', async (_name, id) => {
    const { target, cookie } = await signedInAs(['Admin']);
    const outside = join(dirname(dataDir), 'outside.json');
    writeFileSync(outside, JSON.stringify(sampleModel));
    for (const method of ['GET', 'HEAD', 'DELETE'] as const) {
      const res = await target.inject({
        method,
        url: `/api/models/${id}`,
        headers: { cookie, origin: webOrigin },
      });
      expect(res.statusCode, `${method} ${id}`).toBe(400);
    }
    expect(existsSync(outside)).toBe(true);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it('answers an id longer than the router allows with 414, not a file lookup', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const res = await get(target, `/api/models/${'a'.repeat(101)}`, cookie);
    expect(res.statusCode).toBe(414);
  });

  it("can't make a stored model claim another model's id, creator, date or counts", async () => {
    const { target, cookie: owner } = await signedInAs(['Admin']);
    const victim = await saveSample(target, owner);
    const victimFile = readFileSync(join(dataDir, `${victim.id}.json`), 'utf8');

    idp.service.removeAllListeners('beforeTokenSigning');
    const attacker = { oid: 'c0000000-0000-4000-8000-00000000000a', name: 'Made-up Attacker' };
    withClaims(idp, { roles: ['Admin'], ...attacker });
    const cookie = (await signIn(target)).sessionCookie;
    const forged = {
      ...victim,
      createdAt: '2000-01-01T00:00:00.000Z',
      nodeCount: 999,
      edgeCount: 999,
    };
    // The key is written as an escape and repeated: JSON.parse decodes it and keeps the last one.
    const payload =
      `{"graph":{"id":"${victim.id}","label":"Made-up forged","metadata":` +
      `{"simplearchitecture\\u003astored":{},"${storedModelKey}":${JSON.stringify(forged)}},` +
      `"nodes":{"a":{"metadata":{"type":"Other"}}}}}`;
    const saved = await saveSample(target, cookie, payload);

    expect(saved.id).not.toBe(victim.id);
    expect(saved.createdBy).toEqual({ id: attacker.oid, name: attacker.name });
    expect(saved.createdAt).not.toBe(forged.createdAt);
    expect([saved.nodeCount, saved.edgeCount]).toEqual([1, 0]);
    const stored = (await get(target, `/api/models/${saved.id}`, cookie)).json<JgfDocument>();
    expect(stored.graph.id).toBe(saved.id);
    expect(stored.graph.metadata).toEqual({ [storedModelKey]: saved });
    // The other user's model is untouched.
    expect(readFileSync(join(dataDir, `${victim.id}.json`), 'utf8')).toBe(victimFile);
    expect(readdirSync(dataDir)).toHaveLength(2);
  });

  it('never stores more than the cap when saves race through the routes', async () => {
    const { target, cookie } = await signedInAs(['Admin'], {}, { maxModels: 3 });
    // As many as one user may upload in a minute (the rate limit), all at once.
    const results = await Promise.all(
      Array.from({ length: uploadsPerMinute }, (_, i) =>
        // Two thirds JGF saves, one third OEF imports.
        send(target, 'POST', i % 3 ? '/api/models' : '/api/models/import/oef', { cookie }),
      ),
    );
    const codes = results.map((res) => res.statusCode).sort();
    expect(codes.filter((code) => code === 201)).toHaveLength(3);
    expect(codes.filter((code) => code === 409)).toHaveLength(uploadsPerMinute - 3);
    expect(readdirSync(dataDir).filter((name) => name.endsWith('.json'))).toHaveLength(3);
    expect(readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('deletes a model once when deletes, reads and lists race through the routes', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const saved = await saveSample(target, cookie);
    const url = `/api/models/${saved.id}`;
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => send(target, 'DELETE', url, { cookie })),
      ...Array.from({ length: 5 }, () => get(target, url, cookie)),
      ...Array.from({ length: 5 }, () => get(target, '/api/models', cookie)),
    ]);
    const deletes = results.slice(0, 5).map((res) => res.statusCode);
    expect(deletes.filter((code) => code === 204)).toHaveLength(1);
    expect(deletes.filter((code) => code === 404)).toHaveLength(4);
    for (const res of results.slice(5, 10)) expect([200, 404]).toContain(res.statusCode);
    for (const res of results.slice(10)) expect(res.statusCode).toBe(200);
    expect(readdirSync(dataDir)).toEqual([]);
    expect((await get(target, '/api/models', cookie)).json<ModelListResponse>().models).toEqual([]);
  });
});

describe('entries that are not model files, and the file size limit', () => {
  it('DELETE removes a FIFO named like a model (204), and the list never hangs on it', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const saved = await saveSample(target, cookie);
    const id = crypto.randomUUID();
    const fifo = join(dataDir, `${id}.json`);
    execFileSync('mkfifo', [fifo]);
    try {
      const list = await get(target, '/api/models', cookie);
      expect(list.json<ModelListResponse>().models).toEqual([saved]);
      expect((await get(target, `/api/models/${id}`, cookie)).statusCode).toBe(500);
      expect((await send(target, 'DELETE', `/api/models/${id}`, { cookie })).statusCode).toBe(204);
      expect(existsSync(fifo)).toBe(false);
    } finally {
      try {
        closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
      } catch {
        // Gone, or no reader waiting.
      }
    }
  });

  it('DELETE of a folder that is not empty gets 409 with a clear message, not a 500', async () => {
    const { target, cookie } = await signedInAs(['Admin'], { NODE_ENV: 'production' });
    const id = crypto.randomUUID();
    mkdirSync(join(dataDir, `${id}.json`));
    writeFileSync(join(dataDir, `${id}.json`, 'inside.txt'), 'kept');
    const res = await send(target, 'DELETE', `/api/models/${id}`, { cookie });
    expect(res.statusCode).toBe(409);
    expect(res.json<ApiError>().message).toBe(
      'This entry in the model store is not a model file and could not be deleted. Remove it on the server.',
    );
    expect(res.body).not.toContain(dataDir);
  });

  it('refuses to save a model whose file would be over the size limit, with 413', async () => {
    const { target, cookie } = await signedInAs(['Admin'], {}, { maxFileBytes: 1000 });
    const res = await send(target, 'POST', '/api/models', { cookie });
    expect(res.statusCode).toBe(413);
    expect(res.json<ApiError>().message).toBe(
      'The model is too large to store (more than 1000 bytes).',
    );
    expect(readdirSync(dataDir)).toEqual([]);
  });
});
