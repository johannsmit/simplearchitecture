import {
  editingUnavailableMessage,
  maxViewElements,
  viewConflictMessage,
  type DeletedViewResult,
  type JgfDocument,
  type RenamedViewResult,
  type ViewConflict,
  type ViewListResponse,
  type ViewNotFound,
  type ViewRejected,
  type ViewResult,
} from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/db/service.js';
import { viewBodyLimit } from '../src/limits.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import {
  buildTestApp,
  captureLogs,
  idpOptions,
  signIn,
  startMockIdp,
  webOrigin,
  withClaims,
} from './helpers.js';
import { createTestDb, resetTestDb, testConnection, type TestDb } from './pglite.js';

// The view routes: access per role, the answers to refusals, and what is logged.

const user = { oid: '9f0c4f8e-0000-4000-8000-00000000f1f1', name: 'Made-up View Maker' };
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const unknownId = '0b6f8d55-1c1e-4b7e-9a51-6c1c2f4f2d10';

const harbour: JgfDocument = {
  graph: {
    label: 'Made-up harbour',
    nodes: {
      clerk: { label: 'Clerk', metadata: { type: 'Stakeholder' } },
      ledger: { label: 'Ledger', metadata: { type: 'Application' } },
      crane: { label: 'Crane', metadata: { type: 'Infrastructure' } },
    },
    edges: [
      { id: 'h1', source: 'clerk', target: 'ledger', relation: 'Relation' },
      { id: 'h2', source: 'ledger', target: 'crane', relation: 'Relation' },
    ],
  },
};

let db: TestDb;
let idp: OAuth2Server;
let app: FastifyInstance | undefined;
let modelId: string;

beforeAll(async () => {
  db = await createTestDb();
  idp = await startMockIdp();
});

afterAll(async () => {
  await idp.stop();
  await db.close();
});

beforeEach(async () => {
  await resetTestDb(db);
  const store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
  modelId = (await store.save(harbour, { id: 'oid-seed', name: 'Made-up Seeder' })).id;
});

afterEach(async () => {
  idp.service.removeAllListeners('beforeTokenSigning');
  await app?.close();
  app = undefined;
});

async function signedInAs(
  roles: string[],
  withDatabase = true,
): Promise<{ target: FastifyInstance; cookie: string }> {
  app = await buildTestApp(
    { LOG_LEVEL: 'trace' },
    idpOptions(
      idp,
      withDatabase ? { database: DatabaseService.using(db, testConnection, silent) } : {},
    ),
  );
  withClaims(idp, { roles, ...user });
  const { sessionCookie } = await signIn(app);
  return { target: app, cookie: sessionCookie };
}

interface Call {
  cookie?: string;
  body?: unknown;
  raw?: string;
  contentType?: string;
}

function call(
  target: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  opts: Call = {},
) {
  const payload = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  return target.inject({
    method,
    url,
    headers: {
      origin: webOrigin,
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(payload === undefined ? {} : { 'content-type': opts.contentType ?? 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload }),
  });
}

const views = () => `/api/models/${modelId}/views`;

async function created(target: FastifyInstance, cookie: string) {
  const res = await call(target, 'POST', views(), {
    cookie,
    body: { name: 'Booking', elementIds: ['clerk', 'ledger'], relationshipIds: ['h1'] },
  });
  expect(res.statusCode).toBe(201);
  return res.json<ViewResult>().view;
}

describe('a Modeller', () => {
  it('creates, lists, opens, renames, changes and deletes a view', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const logs = captureLogs(target);
    const res = await call(target, 'POST', views(), {
      cookie,
      body: { name: 'Booking', elementIds: ['ledger', 'clerk'], relationshipIds: ['h1'] },
    });
    expect(res.statusCode).toBe(201);
    const { view } = res.json<ViewResult>();
    expect(res.headers.location).toBe(`${views()}/${view.id}`);
    expect(view).toMatchObject({
      name: 'Booking',
      version: 1,
      elementIds: ['clerk', 'ledger'],
      relationshipIds: ['h1'],
      createdBy: { id: user.oid, name: user.name },
    });

    const list = await call(target, 'GET', views(), { cookie });
    expect(list.statusCode).toBe(200);
    expect(list.json<ViewListResponse>().views).toEqual([
      expect.objectContaining({ id: view.id, name: 'Booking', version: 1, elementCount: 2 }),
    ]);
    const opened = await call(target, 'GET', `${views()}/${view.id}`, { cookie });
    expect(opened.json<ViewResult>()).toEqual({ view });

    const renamed = await call(target, 'PATCH', `${views()}/${view.id}`, {
      cookie,
      body: { version: 1, name: 'Loading' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<RenamedViewResult>().view).toMatchObject({ name: 'Loading', version: 2 });

    const changed = await call(target, 'PUT', `${views()}/${view.id}/contents`, {
      cookie,
      body: { version: 2, elementIds: ['clerk', 'ledger', 'crane'], relationshipIds: ['h1', 'h2'] },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json<ViewResult>().view).toMatchObject({
      version: 3,
      elementIds: ['clerk', 'ledger', 'crane'],
      relationshipIds: ['h1', 'h2'],
    });

    const deleted = await call(target, 'DELETE', `${views()}/${view.id}?version=3`, { cookie });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json<DeletedViewResult>()).toEqual({ id: view.id });
    expect((await call(target, 'GET', views(), { cookie })).json<ViewListResponse>().views).toEqual(
      [],
    );

    // Ids and the action only: never the view's name.
    const audit = logs.filter((line) => line.includes('"audit":"view-'));
    expect(audit.map((line) => (JSON.parse(line) as { audit: string }).audit)).toEqual([
      'view-added',
      'view-renamed',
      'view-changed',
      'view-deleted',
    ]);
    for (const line of audit) {
      expect(line).toContain(view.id);
      expect(line).not.toMatch(/Booking|Loading/);
    }
  });

  it('gets 422 on the field name for a bad name', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    for (const name of ['', '   ', 'x'.repeat(201)]) {
      const res = await call(target, 'POST', views(), { cookie, body: { name, elementIds: [] } });
      expect(res.statusCode).toBe(422);
      const body = res.json<ViewRejected>();
      expect(body).toMatchObject({ statusCode: 422, error: 'Unprocessable Entity' });
      expect(body.fields.map((issue) => issue.field)).toEqual(['name']);
    }
    const view = await created(target, cookie);
    const res = await call(target, 'PATCH', `${views()}/${view.id}`, {
      cookie,
      body: { version: 1, name: ' ' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<ViewRejected>().fields[0]?.field).toBe('name');
  });

  it('gets 422 on the field name for a name another view has, in any case', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    await created(target, cookie);
    const res = await call(target, 'POST', views(), {
      cookie,
      body: { name: 'BOOKING', elementIds: [] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<ViewRejected>().fields).toEqual([
      {
        field: 'name',
        message: 'This model already has a view called \u201cBooking\u201d. Choose another name.',
      },
    ]);
  });

  it('gets 422 for a relationship without both of its elements, and for unknown ids', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await call(target, 'POST', views(), {
      cookie,
      body: { name: 'X', elementIds: ['clerk', 'ghost'], relationshipIds: ['h2'] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<ViewRejected>().fields.map((issue) => issue.field)).toEqual([
      'elementIds',
      'relationshipIds',
    ]);
  });

  it('gets 409 with the current version on a stale one, for every change', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const view = await created(target, cookie);
    const url = `${views()}/${view.id}`;
    await call(target, 'PATCH', url, { cookie, body: { version: 1, name: 'Newer' } });
    for (const res of [
      await call(target, 'PATCH', url, { cookie, body: { version: 1, name: 'Older' } }),
      await call(target, 'PUT', `${url}/contents`, {
        cookie,
        body: { version: 1, elementIds: [] },
      }),
      await call(target, 'PUT', `${url}/layout`, { cookie, body: { version: 1, cards: [] } }),
      await call(target, 'DELETE', `${url}?version=1`, { cookie }),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(res.json<ViewConflict>()).toMatchObject({
        statusCode: 409,
        message: viewConflictMessage,
        currentVersion: 2,
      });
    }
  });

  it('gets 404 saying what is missing when the view or the model is gone', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const view = await created(target, cookie);
    await call(target, 'DELETE', `${views()}/${view.id}?version=1`, { cookie });
    const url = `${views()}/${view.id}`;
    for (const res of [
      await call(target, 'GET', url, { cookie }),
      await call(target, 'PATCH', url, { cookie, body: { version: 1, name: 'X' } }),
      await call(target, 'PUT', `${url}/contents`, {
        cookie,
        body: { version: 1, elementIds: [] },
      }),
      await call(target, 'PUT', `${url}/layout`, { cookie, body: { version: 1, cards: [] } }),
      await call(target, 'DELETE', `${url}?version=1`, { cookie }),
      await call(target, 'GET', `${views()}/not-a-view-id`, { cookie }),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json<ViewNotFound>()).toMatchObject({
        message: 'View not found',
        missing: 'view',
      });
    }
    const gone = await call(target, 'GET', `/api/models/${unknownId}/views`, { cookie });
    expect(gone.statusCode).toBe(404);
    expect(gone.json<ViewNotFound>().missing).toBe('model');
    const created404 = await call(target, 'POST', `/api/models/${unknownId}/views`, {
      cookie,
      body: { name: 'X', elementIds: [] },
    });
    expect(created404.json<ViewNotFound>().missing).toBe('model');
  });

  it('gets 400 for a model id that cannot be one', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    for (const res of [
      await call(target, 'GET', '/api/models/not-a-model/views', { cookie }),
      await call(target, 'POST', '/api/models/not-a-model/views', {
        cookie,
        body: { name: 'X', elementIds: [] },
      }),
    ]) {
      expect(res.statusCode).toBe(400);
    }
  });

  it('gets 415 for another media type, 400 for bad JSON and 413 for a body over the limit', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const wrongType = await call(target, 'POST', views(), {
      cookie,
      raw: 'name=X',
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(wrongType.statusCode).toBe(415);
    const badJson = await call(target, 'POST', views(), { cookie, raw: '{"name":' });
    expect(badJson.statusCode).toBe(400);
    const proto = await call(target, 'POST', views(), {
      cookie,
      raw: '{"name":"X","elementIds":[],"__proto__":{"admin":true}}',
    });
    expect(proto.statusCode).toBe(400);
    const tooLarge = await call(target, 'POST', views(), {
      cookie,
      body: { name: 'X', elementIds: ['x'.repeat(viewBodyLimit)] },
    });
    expect(tooLarge.statusCode).toBe(413);
  });

  it('gets 422 for more elements than a view holds', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await call(target, 'POST', views(), {
      cookie,
      body: { name: 'X', elementIds: Array.from({ length: maxViewElements + 1 }, () => 'clerk') },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<ViewRejected>().fields).toEqual([
      { field: 'elementIds', message: `A view can hold at most ${maxViewElements} elements.` },
    ]);
  });
});

describe('layouts', () => {
  it('a Modeller or an Admin saves where the cards are, logged without positions', async () => {
    for (const roles of [['Modeller'], ['Admin']]) {
      const { target, cookie } = await signedInAs(roles);
      const logs = captureLogs(target);
      const view = await created(target, cookie);
      const url = `${views()}/${view.id}/layout`;
      const res = await call(target, 'PUT', url, {
        cookie,
        body: {
          version: 1,
          cards: [
            { elementId: 'ledger', x: 314.5, y: -27 },
            { elementId: 'clerk', x: 8, y: 9, width: 256 },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const { view: laid } = res.json<ViewResult>();
      expect(laid).toMatchObject({
        version: 2,
        layout: [
          { elementId: 'clerk', x: 8, y: 9, width: 256 },
          { elementId: 'ledger', x: 314.5, y: -27 },
        ],
      });
      const opened = await call(target, 'GET', `${views()}/${view.id}`, { cookie });
      expect(opened.json<ViewResult>().view).toEqual(laid);
      // The same again: nothing changes, nothing is logged.
      const same = await call(target, 'PUT', url, {
        cookie,
        body: { version: 2, cards: laid.layout },
      });
      expect(same.json<ViewResult>().view.version).toBe(2);
      const audit = logs.filter((line) => line.includes('"audit":"view-laid-out"'));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toContain(view.id);
      expect(audit[0]).not.toMatch(/314|256|ledger|clerk/);
      await app?.close();
      app = undefined;
      await resetTestDb(db);
      const store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
      modelId = (await store.save(harbour, { id: 'oid-seed', name: 'Made-up Seeder' })).id;
    }
  });

  it('gets 422 on cards for a card not in the view and for a position out of bounds', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const view = await created(target, cookie);
    const url = `${views()}/${view.id}/layout`;
    for (const cards of [
      [{ elementId: 'crane', x: 0, y: 0 }],
      [{ elementId: 'clerk', x: 2_000_000, y: 0 }],
      [{ elementId: 'clerk', x: 0, y: 0, width: 999 }],
      [{ elementId: 'clerk', x: 0, y: '0' }],
    ]) {
      const res = await call(target, 'PUT', url, { cookie, body: { version: 1, cards } });
      expect(res.statusCode).toBe(422);
      expect(res.json<ViewRejected>().fields.map((issue) => issue.field)).toEqual(['cards']);
    }
    const wrongType = await call(target, 'PUT', url, {
      cookie,
      raw: 'version=1',
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(wrongType.statusCode).toBe(415);
    const tooLarge = await call(target, 'PUT', url, {
      cookie,
      body: { version: 1, cards: [{ elementId: 'x'.repeat(viewBodyLimit), x: 0, y: 0 }] },
    });
    expect(tooLarge.statusCode).toBe(413);
    const bad = await call(target, 'PUT', `/api/models/not-a-model/views/${view.id}/layout`, {
      cookie,
      body: { version: 1, cards: [] },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('a Viewer', () => {
  it('lists and opens views, and can change none', async () => {
    const modeller = await signedInAs(['Modeller']);
    const view = await created(modeller.target, modeller.cookie);
    await app?.close();
    const { target, cookie } = await signedInAs(['Viewer']);
    expect((await call(target, 'GET', views(), { cookie })).statusCode).toBe(200);
    const opened = await call(target, 'GET', `${views()}/${view.id}`, { cookie });
    expect(opened.statusCode).toBe(200);
    expect(opened.json<ViewResult>().view.elementIds).toEqual(['clerk', 'ledger']);
    const url = `${views()}/${view.id}`;
    for (const res of [
      await call(target, 'POST', views(), { cookie, body: { name: 'X', elementIds: [] } }),
      await call(target, 'PATCH', url, { cookie, body: { version: 1, name: 'X' } }),
      await call(target, 'PUT', `${url}/contents`, {
        cookie,
        body: { version: 1, elementIds: [] },
      }),
      await call(target, 'PUT', `${url}/layout`, {
        cookie,
        body: { version: 1, cards: [{ elementId: 'clerk', x: 10, y: 20 }] },
      }),
      await call(target, 'DELETE', `${url}?version=1`, { cookie }),
    ]) {
      expect(res.statusCode).toBe(403);
    }
    expect((await call(target, 'GET', url, { cookie })).json<ViewResult>().view.layout).toEqual([]);
    expect((await call(target, 'GET', url, { cookie })).json<ViewResult>().view.version).toBe(1);
  });
});

describe('without a database', () => {
  it('answers 501: views need PostgreSQL', async () => {
    const { target, cookie } = await signedInAs(['Admin'], false);
    const res = await call(target, 'GET', `/api/models/${unknownId}/views`, { cookie });
    expect(res.statusCode).toBe(501);
    expect(res.json<{ message: string }>().message).toBe(editingUnavailableMessage);
  });
});
