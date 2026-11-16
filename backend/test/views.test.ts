import {
  editingUnavailableMessage,
  maxViewElements,
  viewConflictMessage,
  type DeletedViewResult,
  type JgfDocument,
  type MovedViewResult,
  type RenamedViewFolderResult,
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
import { viewBodyLimit, viewFolderBodyLimit } from '../src/limits.js';
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

/** Random or machine values (ids, time, host), which may hold any digits or letters. */
const randomFields = new Set(['time', 'pid', 'hostname', 'reqId', 'userId', 'modelId', 'viewId']);
/** A log line's other fields, to check that no position, route or element is logged. */
const loggedFields = (line: string): string =>
  JSON.stringify(
    Object.entries(JSON.parse(line) as Record<string, unknown>).filter(
      ([key]) => !randomFields.has(key),
    ),
  );

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
      expect(loggedFields(audit[0] ?? '')).not.toMatch(/314|256|ledger|clerk/);
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

describe('line routes', () => {
  const route = [
    { x: 200, y: 22 },
    { x: 250, y: 22 },
    { x: 250, y: 90 },
    { x: 320, y: 90 },
  ];

  it('a Modeller saves a line moved by hand with the cards, and it opens again so', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const logs = captureLogs(target);
    const view = await created(target, cookie);
    const url = `${views()}/${view.id}/layout`;
    const cards = [
      { elementId: 'clerk', x: 32, y: 0 },
      { elementId: 'ledger', x: 320, y: 68 },
    ];
    const res = await call(target, 'PUT', url, {
      cookie,
      body: { version: 1, cards, routes: [{ relationshipId: 'h1', points: route }] },
    });
    expect(res.statusCode).toBe(200);
    const { view: laid } = res.json<ViewResult>();
    expect(laid).toMatchObject({
      version: 2,
      layout: cards,
      routes: [{ relationshipId: 'h1', points: route }],
    });
    const opened = await call(target, 'GET', `${views()}/${view.id}`, { cookie });
    expect(opened.json<ViewResult>().view).toEqual(laid);
    // Tidy up: the cards without the route, which goes.
    const tidied = await call(target, 'PUT', url, {
      cookie,
      body: { version: 2, cards, routes: [] },
    });
    expect(tidied.json<ViewResult>().view).toMatchObject({ version: 3, routes: [] });
    const audit = logs.filter((line) => line.includes('"audit":"view-laid-out"'));
    expect(audit).toHaveLength(2);
    expect(audit.map(loggedFields).join('\n')).not.toMatch(/250|h1|clerk/);
  });

  it('gets 422 on routes for a line not in the view, a slanted stretch, or too many points', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const view = await created(target, cookie);
    const url = `${views()}/${view.id}/layout`;
    for (const routes of [
      [{ relationshipId: 'h2', points: route }],
      [
        {
          relationshipId: 'h1',
          points: [
            { x: 0, y: 0 },
            { x: 5, y: 5 },
          ],
        },
      ],
      [{ relationshipId: 'h1', points: Array.from({ length: 40 }, (_, x) => ({ x, y: 0 })) }],
      [
        { relationshipId: 'h1', points: route },
        { relationshipId: 'h1', points: route },
      ],
    ]) {
      const res = await call(target, 'PUT', url, {
        cookie,
        body: { version: 1, cards: [], routes },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json<ViewRejected>().fields.map((issue) => issue.field)).toEqual(['routes']);
    }
    const opened = await call(target, 'GET', `${views()}/${view.id}`, { cookie });
    expect(opened.json<ViewResult>().view).toMatchObject({ version: 1, routes: [] });
  });

  it('a Viewer gets 403 and nothing is stored', async () => {
    const modeller = await signedInAs(['Modeller']);
    const view = await created(modeller.target, modeller.cookie);
    await app?.close();
    const { target, cookie } = await signedInAs(['Viewer']);
    const url = `${views()}/${view.id}`;
    const res = await call(target, 'PUT', `${url}/layout`, {
      cookie,
      body: { version: 1, cards: [], routes: [{ relationshipId: 'h1', points: route }] },
    });
    expect(res.statusCode).toBe(403);
    const opened = await call(target, 'GET', url, { cookie });
    expect(opened.json<ViewResult>().view).toMatchObject({ version: 1, routes: [] });
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

describe('folders', () => {
  const folderOf = (viewId: string) => `${views()}/${viewId}/folder`;
  const folders = () => `/api/models/${modelId}/view-folders`;
  const listed = async (target: FastifyInstance, cookie: string) =>
    Object.fromEntries(
      (await call(target, 'GET', views(), { cookie }))
        .json<ViewListResponse>()
        .views.map((view) => [view.name, view.folder]),
    );

  it('a Modeller or an Admin saves into a folder, moves, takes out and renames, logged by id only', async () => {
    for (const roles of [['Modeller'], ['Admin']]) {
      const { target, cookie } = await signedInAs(roles);
      const logs = captureLogs(target);
      const res = await call(target, 'POST', views(), {
        cookie,
        body: { name: 'Booking', folder: ' Quay office ', elementIds: ['clerk'] },
      });
      expect(res.statusCode).toBe(201);
      const booking = res.json<ViewResult>().view;
      expect(booking).toMatchObject({ folder: 'Quay office', version: 1 });
      const lifting = (
        await call(target, 'POST', views(), {
          cookie,
          body: { name: 'Lifting', elementIds: ['crane'] },
        })
      ).json<ViewResult>().view;
      expect(lifting.folder).toBeNull();

      const moved = await call(target, 'PUT', folderOf(lifting.id), {
        cookie,
        body: { folder: 'quay OFFICE' },
      });
      expect(moved.statusCode).toBe(200);
      expect(moved.json<MovedViewResult>().view).toMatchObject({
        id: lifting.id,
        folder: 'Quay office',
        version: 1,
      });
      const renamed = await call(target, 'PATCH', folders(), {
        cookie,
        body: { from: 'Quay office', to: 'Harbour office' },
      });
      expect(renamed.statusCode).toBe(200);
      const result = renamed.json<RenamedViewFolderResult>();
      expect(result.folder).toBe('Harbour office');
      expect(result.views.map((view) => [view.name, view.folder, view.version])).toEqual([
        ['Booking', 'Harbour office', 1],
        ['Lifting', 'Harbour office', 1],
      ]);
      const out = await call(target, 'PUT', folderOf(lifting.id), {
        cookie,
        body: { folder: null },
      });
      expect(out.json<MovedViewResult>().view.folder).toBeNull();
      expect(await listed(target, cookie)).toEqual({ Booking: 'Harbour office', Lifting: null });
      // Opening a view gives its folder too, still at version 1.
      const opened = await call(target, 'GET', `${views()}/${booking.id}`, { cookie });
      expect(opened.json<ViewResult>().view).toMatchObject({
        folder: 'Harbour office',
        version: 1,
      });
      // One line per view changed, naming no folder.
      const lines = logs.filter((line) => line.includes('"audit":"view-folder-changed"'));
      expect(lines).toHaveLength(4);
      for (const line of lines) expect(loggedFields(line)).not.toMatch(/office|Quay|Harbour/i);
      await app?.close();
      app = undefined;
      await resetTestDb(db);
      const store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
      modelId = (await store.save(harbour, { id: 'oid-seed', name: 'Made-up Seeder' })).id;
    }
  });

  it("doesn't raise the version: a save with the version read before a move still works", async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const view = await created(target, cookie);
    await call(target, 'PUT', folderOf(view.id), { cookie, body: { folder: 'Quay office' } });
    const laid = await call(target, 'PUT', `${views()}/${view.id}/layout`, {
      cookie,
      body: { version: 1, cards: [{ elementId: 'clerk', x: 10, y: 20 }] },
    });
    expect(laid.statusCode).toBe(200);
    expect(laid.json<ViewResult>().view).toMatchObject({ version: 2, folder: 'Quay office' });
  });

  it('gets 422 on folder for a name taken by another folder, in any case: never merged', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const booking = await created(target, cookie);
    await call(target, 'PUT', folderOf(booking.id), { cookie, body: { folder: 'Quay office' } });
    const lifting = (
      await call(target, 'POST', views(), {
        cookie,
        body: { name: 'Lifting', folder: 'Cranes', elementIds: ['crane'] },
      })
    ).json<ViewResult>().view;
    for (const res of [
      // A new folder with an existing name, the view's own folder too.
      await call(target, 'PUT', folderOf(booking.id), {
        cookie,
        body: { folder: ' cranes ', newFolder: true },
      }),
      await call(target, 'PUT', folderOf(booking.id), {
        cookie,
        body: { folder: 'QUAY OFFICE', newFolder: true },
      }),
      // A rename to another folder's name.
      await call(target, 'PATCH', folders(), {
        cookie,
        body: { from: 'Quay office', to: 'CRANES' },
      }),
    ]) {
      expect(res.statusCode).toBe(422);
      const [issue] = res.json<ViewRejected>().fields;
      expect(issue?.field).toBe('folder');
      expect(issue?.message).toMatch(/^There's already a folder called “(Cranes|Quay office)”\.$/);
    }
    expect(await listed(target, cookie)).toEqual({ Booking: 'Quay office', Lifting: 'Cranes' });
    expect(lifting.folder).toBe('Cranes');
  });

  it('gets 422 on folder for a name over 100 characters', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const view = await created(target, cookie);
    const long = 'q'.repeat(101);
    for (const res of [
      await call(target, 'PUT', folderOf(view.id), { cookie, body: { folder: long } }),
      await call(target, 'POST', views(), {
        cookie,
        body: { name: 'Other', folder: long, elementIds: [] },
      }),
    ]) {
      expect(res.statusCode).toBe(422);
      expect(res.json<ViewRejected>().fields).toEqual([
        { field: 'folder', message: 'The folder name has 101 characters. Use 100 or fewer.' },
      ]);
    }
    const fits = await call(target, 'PUT', folderOf(view.id), {
      cookie,
      body: { folder: 'q'.repeat(100) },
    });
    expect(fits.statusCode).toBe(200);
  });

  it('gets 404 saying what is missing, 400 for a bad model id, 415 and 413', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const view = await created(target, cookie);
    const missing = async (res: Awaited<ReturnType<typeof call>>) => {
      expect(res.statusCode).toBe(404);
      return res.json<ViewNotFound>().missing;
    };
    expect(
      await missing(
        await call(target, 'PATCH', folders(), { cookie, body: { from: 'None', to: 'X' } }),
      ),
    ).toBe('folder');
    expect(
      await missing(
        await call(target, 'PUT', folderOf(unknownId), { cookie, body: { folder: 'X' } }),
      ),
    ).toBe('view');
    expect(
      await missing(
        await call(target, 'PUT', `/api/models/${unknownId}/views/${view.id}/folder`, {
          cookie,
          body: { folder: 'X' },
        }),
      ),
    ).toBe('model');
    const bad = await call(target, 'PATCH', '/api/models/not-a-model/view-folders', {
      cookie,
      body: { from: 'A', to: 'B' },
    });
    expect(bad.statusCode).toBe(400);
    const text = await call(target, 'PUT', folderOf(view.id), {
      cookie,
      raw: '{"folder":"X"}',
      contentType: 'text/plain',
    });
    expect(text.statusCode).toBe(415);
    const big = await call(target, 'PUT', folderOf(view.id), {
      cookie,
      raw: JSON.stringify({ folder: 'x'.repeat(viewFolderBodyLimit) }),
    });
    expect(big.statusCode).toBe(413);
  });

  it('a Viewer sees folders but gets 403 on every folder change, and nothing is stored', async () => {
    const modeller = await signedInAs(['Modeller']);
    const view = await created(modeller.target, modeller.cookie);
    await call(modeller.target, 'PUT', folderOf(view.id), {
      cookie: modeller.cookie,
      body: { folder: 'Quay office' },
    });
    await app?.close();
    const { target, cookie } = await signedInAs(['Viewer']);
    expect(await listed(target, cookie)).toEqual({ Booking: 'Quay office' });
    for (const res of [
      await call(target, 'POST', views(), {
        cookie,
        body: { name: 'X', folder: 'Quay office', elementIds: [] },
      }),
      await call(target, 'PUT', folderOf(view.id), { cookie, body: { folder: 'Elsewhere' } }),
      await call(target, 'PUT', folderOf(view.id), { cookie, body: { folder: null } }),
      await call(target, 'PUT', folderOf(view.id), {
        cookie,
        body: { folder: 'New one', newFolder: true },
      }),
      await call(target, 'PATCH', folders(), { cookie, body: { from: 'Quay office', to: 'Y' } }),
    ]) {
      expect(res.statusCode).toBe(403);
    }
    expect(await listed(target, cookie)).toEqual({ Booking: 'Quay office' });
  });
});

describe('the views an element is used in', () => {
  const usedIn = (elementId: string, model = modelId) =>
    `/api/models/${model}/elements/${encodeURIComponent(elementId)}/views`;

  it.each([['Viewer'], ['Modeller'], ['Admin']])(
    'a %s gets the views holding the element, by name',
    async (role) => {
      const modeller = await signedInAs(['Modeller']);
      await created(modeller.target, modeller.cookie);
      for (const [name, elementIds] of [
        ['lifting', ['crane']],
        ['All', ['clerk', 'ledger', 'crane']],
      ] as const) {
        const res = await call(modeller.target, 'POST', views(), {
          cookie: modeller.cookie,
          body: { name, elementIds },
        });
        expect(res.statusCode).toBe(201);
      }
      await app?.close();
      const { target, cookie } = await signedInAs([role]);
      const names = async (elementId: string) => {
        const res = await call(target, 'GET', usedIn(elementId), { cookie });
        expect(res.statusCode).toBe(200);
        return res.json<ViewListResponse>().views.map((view) => view.name);
      };
      expect(await names('crane')).toEqual(['All', 'lifting']);
      expect(await names('ledger')).toEqual(['All', 'Booking']);
      expect(await names('no such element')).toEqual([]);
    },
  );

  it('is current after a Modeller adds the element to a view or takes it out', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const view = await created(target, cookie);
    const names = async () =>
      (await call(target, 'GET', usedIn('crane'), { cookie }))
        .json<ViewListResponse>()
        .views.map((one) => one.name);
    expect(await names()).toEqual([]);
    const contents = `${views()}/${view.id}/contents`;
    const added = await call(target, 'PUT', contents, {
      cookie,
      body: { version: 1, elementIds: ['clerk', 'ledger', 'crane'] },
    });
    expect(added.statusCode).toBe(200);
    expect(await names()).toEqual(['Booking']);
    const removed = await call(target, 'PUT', contents, {
      cookie,
      body: { version: 2, elementIds: ['clerk', 'ledger'] },
    });
    expect(removed.statusCode).toBe(200);
    expect(await names()).toEqual([]);
  });

  it('gets 404 for a model that is gone, 400 for one that cannot be, and 401 signed out', async () => {
    const { target, cookie } = await signedInAs(['Viewer']);
    const gone = await call(target, 'GET', usedIn('crane', unknownId), { cookie });
    expect(gone.statusCode).toBe(404);
    expect(gone.json<ViewNotFound>().missing).toBe('model');
    expect((await call(target, 'GET', usedIn('crane', 'not-a-model'), { cookie })).statusCode).toBe(
      400,
    );
    expect((await call(target, 'GET', usedIn('crane'))).statusCode).toBe(401);
  });

  it('a person without a role gets 403', async () => {
    const { target, cookie } = await signedInAs([]);
    expect((await call(target, 'GET', usedIn('crane'), { cookie })).statusCode).toBe(403);
  });
});

describe('without a database', () => {
  it('answers 501: views need PostgreSQL', async () => {
    const { target, cookie } = await signedInAs(['Admin'], false);
    for (const url of [
      `/api/models/${unknownId}/views`,
      `/api/models/${unknownId}/elements/crane/views`,
    ]) {
      const res = await call(target, 'GET', url, { cookie });
      expect(res.statusCode).toBe(501);
      expect(res.json<{ message: string }>().message).toBe(editingUnavailableMessage);
    }
    for (const res of [
      await call(target, 'PUT', `/api/models/${unknownId}/views/${unknownId}/folder`, {
        cookie,
        body: { folder: 'X' },
      }),
      await call(target, 'PATCH', `/api/models/${unknownId}/view-folders`, {
        cookie,
        body: { from: 'X', to: 'Y' },
      }),
    ]) {
      expect(res.statusCode).toBe(501);
    }
  });
});
