import type { JgfDocument, RelationshipChangeResult, ViewResult } from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/db/service.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import {
  buildTestApp,
  idpOptions,
  signIn,
  startMockIdp,
  webOrigin,
  withClaims,
} from './helpers.js';

// A view's layout, with a line moved by hand, saved through the real API code (routes, service,
// store and the node-postgres driver) to a real PostgreSQL server, and read back by a new app.
//
// Opt-in: set THROWAWAY_DATABASE_URL to a database made for this test, on this machine (for
// example postgres://postgres@127.0.0.1:55432/postgres). The app runs every migration on it. The
// test adds one made-up model and deletes it again; it changes nothing else. Never point it at a
// database with real models in it.

const url = process.env.THROWAWAY_DATABASE_URL;
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const user = { oid: '9f0c4f8e-0000-4000-8000-0000000014a1', name: 'Made-up Line Mover' };

const quay: JgfDocument = {
  graph: {
    label: 'Made-up quay',
    nodes: {
      skipper: { label: 'Skipper', metadata: { type: 'Stakeholder' } },
      berths: { label: 'Berths', metadata: { type: 'Application' } },
      tide: { label: 'Tide gauge', metadata: { type: 'Infrastructure' } },
    },
    edges: [
      { id: 'q1', source: 'skipper', target: 'berths', relation: 'Relation' },
      { id: 'q2', source: 'berths', target: 'tide', relation: 'Relation' },
    ],
  },
};

describe.skipIf(url === undefined)('a moved line, on a real PostgreSQL server', () => {
  let idp: OAuth2Server;
  let seed: DatabaseService | undefined;
  let modelId: string | undefined;

  beforeAll(async () => {
    idp = await startMockIdp();
    const config = { DATABASE_URL: url, DATABASE_WAIT_SECONDS: 5 };
    seed = await DatabaseService.connect(config, silent);
    const store = await PostgresModelStore.open(seed.db as NonNullable<DatabaseService['db']>, {
      log: { warn: () => undefined },
    });
    modelId = (await store.save(quay, { id: 'oid-seed', name: 'Made-up Seeder' })).id;
  });

  afterAll(async () => {
    if (modelId !== undefined) {
      await seed?.db?.query('delete from models where id = $1::uuid', [modelId]);
    }
    await seed?.close();
    await idp.stop();
  });

  async function app(): Promise<{ target: FastifyInstance; cookie: string }> {
    const target = await buildTestApp(
      { DATABASE_URL: url, DATABASE_WAIT_SECONDS: 5 },
      idpOptions(idp),
    );
    withClaims(idp, { roles: ['Modeller'], ...user });
    const { sessionCookie } = await signIn(target);
    idp.service.removeAllListeners('beforeTokenSigning');
    return { target, cookie: sessionCookie };
  }

  const send = (
    target: FastifyInstance,
    cookie: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    path: string,
    body?: unknown,
  ) =>
    target.inject({
      method,
      url: path,
      headers: {
        origin: webOrigin,
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  it('saves cards and a route in one save, reads them back exactly, and drops the route on a reverse', async () => {
    const first = await app();
    const views = `/api/models/${modelId}/views`;
    const created = await send(first.target, first.cookie, 'POST', views, {
      name: 'Mooring',
      elementIds: ['skipper', 'berths', 'tide'],
      relationshipIds: ['q1', 'q2'],
    });
    expect(created.statusCode).toBe(201);
    const { view } = created.json<ViewResult>();
    const cards = [
      { elementId: 'skipper', x: 0, y: 0 },
      { elementId: 'berths', x: 400.5, y: 200, width: 240 },
      { elementId: 'tide', x: -120.3, y: 480 },
    ];
    const route = [
      { x: 168, y: 22 },
      { x: 290.1, y: 22 },
      { x: 290.1, y: 222 },
      { x: 400.5, y: 222 },
    ];
    const saved = await send(first.target, first.cookie, 'PUT', `${views}/${view.id}/layout`, {
      version: 1,
      cards,
      routes: [{ relationshipId: 'q1', points: route }],
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<ViewResult>().view).toMatchObject({
      version: 2,
      layout: cards,
      routes: [{ relationshipId: 'q1', points: route }],
    });
    await first.target.close();

    // A new app, with its own connections: the same layout and route.
    const second = await app();
    const opened = await send(second.target, second.cookie, 'GET', `${views}/${view.id}`);
    expect(opened.statusCode).toBe(200);
    expect(opened.json<ViewResult>().view).toMatchObject({
      version: 2,
      layout: cards,
      routes: [{ relationshipId: 'q1', points: route }],
    });

    // Reversed: the route ran the other way, so it goes, with a new version of the view.
    const reversed = await send(
      second.target,
      second.cookie,
      'PATCH',
      `/api/models/${modelId}/relationships/q1`,
      { version: 1, reverse: true },
    );
    expect(reversed.statusCode).toBe(200);
    expect(reversed.json<RelationshipChangeResult>().viewsChanged).toEqual([
      { id: view.id, version: 3 },
    ]);
    const after = await send(second.target, second.cookie, 'GET', `${views}/${view.id}`);
    expect(after.json<ViewResult>().view).toMatchObject({ version: 3, layout: cards, routes: [] });
    await second.target.close();
  });
});
