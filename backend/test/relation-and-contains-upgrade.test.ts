import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { JgfDocument, ModelAuthor } from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/db/service.js';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { RelationshipService } from '../src/editing/relationship-service.js';
import { convertOlderTypes } from '../src/jgf/older-types.js';
import { validateJgf } from '../src/jgf/validate.js';
import { convertOef } from '../src/oef/mapper.js';
import { loadOefMapping } from '../src/oef/mapping-config.js';
import { ModelTooLargeError } from '../src/storage/model-store.js';
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
import { createTestDb, pgliteDb, resetTestDb, testConnection, type TestDb } from './pglite.js';

// The upgrade to Relation and Contains: what can't be undone, tried from the outside. Made-up data only.

const author: ModelAuthor = { id: 'oid-made-up', name: 'Made-up author' };
// Up to the migration under test: a later one has its own tests.
const all = loadMigrations().filter((migration) => migration.version <= '006');
const before = all.filter((migration) => migration.version < '006');
const nodes = {
  a: { label: 'A', metadata: { type: 'Application' } },
  b: { label: 'B', metadata: { type: 'Application' } },
  c: { label: 'C', metadata: { type: 'Infrastructure' } },
};
const model = (edges: unknown[]): JgfDocument =>
  ({ graph: { label: 'Made-up', nodes, edges } }) as unknown as JgfDocument;
const quiet = { log: { warn: () => undefined } };

/** A database at migration 005 holding `document`, as an older API stored it. */
async function olderDatabase(document: JgfDocument) {
  const db = pgliteDb(new PGlite());
  await migrate(db, before);
  const store = await PostgresModelStore.open(db, quiet);
  const { id } = await store.save(document, author);
  return { db, id };
}

const rowsOf = (db: TestDb, id: string) =>
  db.query<{ id: string; relation: string; metadata: Record<string, unknown> | null }>(
    'select id, relation, metadata from relationships where model_id = $1::uuid order by ordinal',
    [id],
  );

describe('migration 006, tried from the outside', () => {
  it('rolls back completely when 006 itself fails on the last row, and runs clean afterwards', async () => {
    const edges = [
      { id: 'f', source: 'a', target: 'b', relation: 'Information flow', metadata: { x: 'y' } },
      { id: 'i', source: 'a', target: 'c', relation: 'Integration' },
      { id: 'poison', source: 'b', target: 'c', relation: 'Integration' },
    ];
    const { db, id } = await olderDatabase(model(edges));
    const was = await rowsOf(db, id);
    await db.exec(`
      create function refuse_poison() returns trigger language plpgsql as $$
      begin
        if new.id = 'poison' then raise exception 'made-up failure'; end if;
        return new;
      end $$;
      create trigger refuse_poison before update on relationships
        for each row execute function refuse_poison();`);
    await expect(migrate(db, all)).rejects.toThrow();
    expect(await rowsOf(db, id)).toEqual(was);
    const versions = await db.query<{ version: string }>('select version from schema_migrations');
    expect(versions.map((row) => row.version)).not.toContain('006');
    await db.exec('drop trigger refuse_poison on relationships');
    expect(await migrate(db, all)).toBe(1);
    expect((await rowsOf(db, id)).map((row) => row.relation)).toEqual([
      'Relation',
      'Relation',
      'Relation',
    ]);
    await db.close();
  });

  it('refuses to start when its text was changed after it ran', async () => {
    const { db } = await olderDatabase(model([]));
    await migrate(db, all);
    const changed = all.map((migration) =>
      migration.version === '006' ? { ...migration, checksum: 'made-up' } : migration,
    );
    await expect(migrate(db, changed)).rejects.toThrow(/changed after it was applied/);
    await db.close();
  });

  it('keeps every shape a valid model can hold, and opens with none damaged', async () => {
    const edges = [
      // Parallel, the same way, opposite way, two-way, self, and with no id.
      { id: 'p1', source: 'a', target: 'b', relation: 'Information flow' },
      { id: 'p2', source: 'a', target: 'b', relation: 'Information flow' },
      { id: 'p3', source: 'a', target: 'b', relation: 'Integration', label: 'x' },
      { id: 'p4', source: 'a', target: 'b', relation: 'Integration' },
      { id: 'p5', source: 'b', target: 'a', relation: 'Integration', directed: false },
      { id: 'self', source: 'a', target: 'a', relation: 'Information flow' },
      { source: 'a', target: 'c', relation: 'Integration', metadata: {} },
      // Contains that break the Modelling rules but are valid when stored.
      { id: 'c1', source: 'a', target: 'c', relation: 'Contains', directed: false },
      { id: 'c2', source: 'a', target: 'c', relation: 'Contains' },
      { id: 'c3', source: 'c', target: 'a', relation: 'Contains' },
      {
        id: 'cflow',
        source: 'b',
        target: 'c',
        relation: 'Contains',
        metadata: { informationFlow: 1 },
      },
      // Bad standard values are warnings before and after.
      {
        id: 'bad',
        source: 'b',
        target: 'a',
        relation: 'Information flow',
        metadata: { architectureState: 'made-up', description: 7 },
      },
    ];
    const document = model(edges);
    const { db, id } = await olderDatabase(document);
    await migrate(db, all);
    const store = await PostgresModelStore.open(db, quiet);
    expect(await store.listDamaged()).toEqual([]);
    const read = await store.get(id);
    if (read === undefined) throw new Error('gone');
    expect(validateJgf(read).valid).toBe(true);
    // As the import converts it; an old flow without metadata got an object from 006, now empty.
    const metadataOrNone = (edges: JgfDocument['graph']['edges']) =>
      (edges ?? []).map((edge) => ({ ...edge, metadata: edge.metadata ?? {} }));
    expect(metadataOrNone(read.graph.edges)).toEqual(
      metadataOrNone((convertOlderTypes(document).document as JgfDocument).graph.edges),
    );
    await db.close();
  });

  it('holds what a host can check before and after, as plain read-only SQL', async () => {
    const edges = [
      {
        id: 'text-flow',
        source: 'a',
        target: 'b',
        relation: 'Information flow',
        metadata: { informationFlow: 'Made-up' },
      },
      {
        id: 'yes-int',
        source: 'a',
        target: 'c',
        relation: 'Integration',
        metadata: { informationFlow: true },
      },
      {
        id: 'text-int',
        source: 'b',
        target: 'c',
        relation: 'Integration',
        metadata: { informationFlow: 'Made-up' },
      },
      { id: 'plain', source: 'b', target: 'a', relation: 'Integration' },
      { id: 'flow', source: 'c', target: 'a', relation: 'Information flow' },
    ];
    const { db } = await olderDatabase(model(edges));
    const check = await db.query<{ relation: string; value_type: string; n: number }>(`
      select relation, jsonb_typeof(metadata -> 'informationFlow') as value_type, count(*)::int as n
      from relationships where metadata ? 'informationFlow'
      group by 1, 2 order by 1, 2`);
    expect(check).toEqual([
      { relation: 'Information flow', value_type: 'string', n: 1 },
      { relation: 'Integration', value_type: 'boolean', n: 1 },
      { relation: 'Integration', value_type: 'string', n: 1 },
    ]);
    const counts = () =>
      db.query<{ relation: string; flows: number; n: number }>(`
        select relation, count(*) filter (where metadata -> 'informationFlow' = 'true'::jsonb)::int as flows,
               count(*)::int as n
        from relationships group by 1 order by 1`);
    await migrate(db, all);
    // Old flows (2) plus the Integration that already held true.
    expect(await counts()).toEqual([{ relation: 'Relation', flows: 3, n: 5 }]);
    await db.close();
  });

  it('keeps custom values if they are renamed first, as an OEF import now names them', async () => {
    const edges = [
      {
        id: 'f',
        source: 'a',
        target: 'b',
        relation: 'Information flow',
        metadata: { informationFlow: 'Made-up', x: 1 },
      },
      {
        id: 'i',
        source: 'a',
        target: 'c',
        relation: 'Integration',
        metadata: { informationFlow: 'Made-up' },
      },
      {
        id: 'yes',
        source: 'b',
        target: 'c',
        relation: 'Integration',
        metadata: { informationFlow: true },
      },
      { id: 'c', source: 'c', target: 'a', relation: 'Contains', metadata: { informationFlow: 7 } },
      { id: 'plain', source: 'b', target: 'a', relation: 'Information flow' },
    ];
    const { db, id } = await olderDatabase(model(edges));
    await db.exec(`
      update relationships
      set metadata = (metadata - 'informationFlow')
        || jsonb_build_object('oefInformationFlow', metadata -> 'informationFlow')
      where jsonb_typeof(metadata -> 'informationFlow') is distinct from 'boolean'
        and metadata ? 'informationFlow';`);
    await migrate(db, all);
    expect((await rowsOf(db, id)).map((row) => row.metadata)).toEqual([
      { informationFlow: true, oefInformationFlow: 'Made-up', x: 1 },
      { oefInformationFlow: 'Made-up' },
      { informationFlow: true },
      { oefInformationFlow: 7 },
      { informationFlow: true },
    ]);
    const store = await PostgresModelStore.open(db, quiet);
    expect(await store.listDamaged()).toEqual([]);
    await db.close();
  });

  // A known limit, so expected to fail: a custom value under this name on an old flow is lost for
  // good, while an OEF import now keeps the same value as `oefInformationFlow`. Migration 006 has
  // run on real databases, and the API refuses to start if an applied migration changes, so it
  // can't be fixed there.
  it.fails('keeps a custom text value held under informationFlow on an old flow', async () => {
    const { db, id } = await olderDatabase(
      model([
        {
          id: 'f',
          source: 'a',
          target: 'b',
          relation: 'Information flow',
          metadata: { informationFlow: 'Made-up value' },
        },
      ]),
    );
    await migrate(db, all);
    expect(JSON.stringify(await rowsOf(db, id))).toContain('Made-up value');
    await db.close();
  });

  it('leaves a model over the size limit readable, and refuses only the edit', async () => {
    const edges = Array.from({ length: 40 }, (_, index) => ({
      id: `f${index}`,
      source: 'a',
      target: 'b',
      relation: 'Information flow',
    }));
    const document = model(edges);
    const { db, id } = await olderDatabase(document);
    const size = async () => {
      const store = await PostgresModelStore.open(db, quiet);
      return JSON.stringify(await store.get(id)).length;
    };
    await migrate(db, all);
    const grown = await size();
    // Just below what it has grown to, as a model right at the limit before the migration would be.
    const store = await PostgresModelStore.open(db, { ...quiet, maxModelBytes: grown - 1 });
    expect(await store.listDamaged()).toEqual([]);
    expect(await store.get(id)).toBeDefined();
    await expect(
      new RelationshipService(store).updateRelationship(
        id,
        'f0',
        { version: 1, label: 'Made-up' },
        author,
      ),
    ).rejects.toBeInstanceOf(ModelTooLargeError);
    await db.close();
  });

  it('turns an old row into a plain Relation when it is edited, without Information flow', async () => {
    const { db, id } = await olderDatabase(
      model([{ id: 'f', source: 'a', target: 'b', relation: 'Information flow' }]),
    );
    await migrate(db, all);
    // As an older API still running would write it.
    await db.query(`update relationships set relation = 'Information flow', metadata = null`);
    const store = await PostgresModelStore.open(db, quiet);
    const saved = await new RelationshipService(store).updateRelationship(
      id,
      'f',
      { version: 1, label: 'Made-up' },
      author,
    );
    expect(saved.relationship.edge.relation).toBe('Relation');
    expect(saved.relationship.edge.metadata ?? {}).toEqual({});
    const [row] = await rowsOf(db, id);
    expect(row?.relation).toBe('Relation');
    expect(row?.metadata ?? {}).toEqual({});
    await db.close();
  });

  // Information flow is no longer a property: every model reads without the key, as after 009.
  it('drops a custom informationFlow text on a Contains, as every model is read now', async () => {
    const { db, id } = await olderDatabase(
      model([
        {
          id: 'c',
          source: 'a',
          target: 'b',
          relation: 'Contains',
          metadata: { informationFlow: 'Made-up' },
        },
      ]),
    );
    await migrate(db, all);
    const store = await PostgresModelStore.open(db, quiet);
    const saved = await new RelationshipService(store).updateRelationship(
      id,
      'c',
      { version: 1, label: 'Made-up label' },
      author,
    );
    expect(saved.relationship.edge.metadata).toEqual({});
    await db.close();
  });
});

describe('the shipped OEF mapping', () => {
  const mapping = loadOefMapping();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" identifier="m">
  <name xml:lang="en">Made-up</name>
  <elements>
    <element identifier="a" xsi:type="ApplicationComponent"><name xml:lang="en">A</name></element>
    <element identifier="b" xsi:type="ApplicationComponent"><name xml:lang="en">B</name></element>
  </elements>
  <propertyDefinitions><propertyDefinition identifier="p" type="string"><name>Information flow</name></propertyDefinition></propertyDefinitions>
  <relationships>
    <relationship identifier="r1" source="a" target="b" xsi:type="Flow"><properties><property propertyDefinitionRef="p"><value xml:lang="en">Made-up</value></property></properties></relationship>
    <relationship identifier="r2" source="b" target="a" xsi:type="Serving"><properties><property propertyDefinitionRef="p"><value xml:lang="en">Made-up</value></property></properties></relationship>
    <relationship identifier="r3" source="a" target="b" xsi:type="Association" isDirected="false"/>
    <relationship identifier="r4" source="a" target="b" xsi:type="Realization"/>
  </relationships>
</model>`;

  it('maps Flow to a Relation, keeps a property named Information flow apart, and stays valid', () => {
    const { jgf } = convertOef(xml, mapping);
    expect(validateJgf(jgf).valid).toBe(true);
    const edges = jgf.graph.edges ?? [];
    expect(edges.map((edge) => edge.relation)).toEqual([
      'Relation',
      'Relation',
      'Relation',
      'Contains',
    ]);
    expect(edges[0]?.metadata).toMatchObject({ oefInformationFlow: 'Made-up' });
    expect(edges[1]?.metadata).toMatchObject({ oefInformationFlow: 'Made-up' });
    for (const edge of edges) expect(edge.metadata).not.toHaveProperty('informationFlow');
    // No names in the file, so no Data either.
    for (const edge of edges) expect(edge.metadata).not.toHaveProperty('data');
    expect(edges[2]?.directed).toBe(false);
  });

  it('has only the two types in the file itself', () => {
    const text = readFileSync(new URL('../../config/oef-mapping.json', import.meta.url), 'utf8');
    expect(text).not.toMatch(/"relation": "(Information flow|Integration)"/);
    expect(text).not.toMatch(/"(Information flow|Integration)"/);
  });
});

describe('through the routes', () => {
  const user = { oid: '9f0c4f8e-0000-4000-8000-00000000e2e9', name: 'Made-up Editor' };
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  let db: TestDb;
  let idp: OAuth2Server;
  let app: FastifyInstance | undefined;

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
  });
  afterEach(async () => {
    idp.service.removeAllListeners('beforeTokenSigning');
    await app?.close();
    app = undefined;
  });

  const signedIn = async (roles: string[]) => {
    app = await buildTestApp(
      { LOG_LEVEL: 'trace' },
      idpOptions(idp, { database: DatabaseService.using(db, testConnection, silent) }),
    );
    withClaims(idp, { roles, ...user });
    const { sessionCookie } = await signIn(app);
    return { target: app, cookie: sessionCookie };
  };
  const call = (
    target: FastifyInstance,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    cookie: string | undefined,
    body?: unknown,
  ) =>
    target.inject({
      method,
      url,
      headers: {
        origin: webOrigin,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  const everything = {
    graph: {
      label: 'Made-up round trip',
      directed: true,
      type: 'made-up',
      metadata: { owner: 'Made-up', deep: { list: [1, { x: 2 }] } },
      nodes: {
        ...nodes,
        d: { label: 'D', metadata: { type: 'Other', informationFlow: 'on an element' } },
      },
      edges: [
        {
          id: 'yes',
          source: 'a',
          target: 'b',
          relation: 'Relation',
          label: 'Orders',
          metadata: { data: 'Orders', identity: 'made-up-client', protocol: 'REST' },
        },
        {
          id: 'context',
          source: 'a',
          target: 'b',
          relation: 'Relation',
          metadata: { identityContext: 'The made-up caller' },
        },
        {
          id: 'bad',
          source: 'a',
          target: 'b',
          relation: 'Relation',
          metadata: { data: 7 },
        },
        {
          id: 'two',
          source: 'b',
          target: 'c',
          relation: 'Relation',
          directed: false,
          metadata: { architectureState: 'Target', n: 0, on: false, list: ['x'], o: { a: null } },
        },
        { source: 'c', target: 'a', relation: 'Relation', directed: true },
        {
          id: 'holds',
          source: 'a',
          target: 'd',
          relation: 'Contains',
          metadata: { data: 'Kept on a Contains' },
        },
      ],
    },
  };
  const graphPart = (document: { graph: Record<string, unknown> }) => {
    const rest = { ...document.graph };
    Reflect.deleteProperty(rest, 'id');
    const own = { ...((rest.metadata ?? {}) as Record<string, unknown>) };
    Reflect.deleteProperty(own, 'simplearchitecture:stored');
    return { ...rest, metadata: own };
  };

  it('an export and re-import keeps everything, twice over', async () => {
    const { target, cookie } = await signedIn(['Admin']);
    const first = await call(target, 'POST', '/api/models', cookie, everything);
    expect(first.statusCode).toBeLessThan(300);
    const id = first.json<{ model: { id: string } }>().model.id;
    const exported = await call(target, 'GET', `/api/models/${id}`, cookie);
    expect(exported.statusCode).toBe(200);
    const once = exported.json<{ graph: Record<string, unknown> }>();
    expect(graphPart(once)).toEqual(graphPart(everything));

    const again = await call(target, 'POST', '/api/models', cookie, once);
    expect(again.statusCode, again.body).toBeLessThan(300);
    const secondId = again.json<{ model: { id: string } }>().model.id;
    expect(secondId).not.toBe(id);
    const twice = (await call(target, 'GET', `/api/models/${secondId}`, cookie)).json<{
      graph: Record<string, unknown>;
    }>();
    expect(graphPart(twice)).toEqual(graphPart(everything));
  });

  it('an older file imports converted, with a note, on both import routes', async () => {
    const { target, cookie } = await signedIn(['Admin']);
    const older = model([
      {
        id: 'f',
        source: 'a',
        target: 'b',
        relation: 'Information flow',
        directed: false,
        label: 'L',
      },
      {
        id: 'i',
        source: 'a',
        target: 'c',
        relation: 'Integration',
        metadata: { protocol: 'REST' },
      },
      { id: 'c', source: 'a', target: 'b', relation: 'Contains' },
    ]);
    const checked = await call(target, 'POST', '/api/import/jgf', cookie, older);
    expect(checked.statusCode).toBe(200);
    const report = checked.json<{ valid: boolean; warnings: { code: string }[] }>();
    expect(report.valid).toBe(true);
    expect(report.warnings.map((issue) => issue.code)).toContain('older-relationship-types');

    const saved = await call(target, 'POST', '/api/models', cookie, older);
    expect(saved.statusCode).toBeLessThan(300);
    const body = saved.json<{
      model: { id: string };
      validation: { warnings: { code: string }[] };
    }>();
    expect(body.validation.warnings.map((issue) => issue.code)).toContain(
      'older-relationship-types',
    );
    const rows = await db.query<{ relation: string; metadata: unknown; directed: boolean | null }>(
      'select relation, metadata, directed from relationships where model_id = $1::uuid order by ordinal',
      [body.model.id],
    );
    expect(rows).toEqual([
      { relation: 'Relation', metadata: { data: 'L' }, directed: false },
      { relation: 'Relation', metadata: { protocol: 'REST' }, directed: null },
      { relation: 'Contains', metadata: null, directed: null },
    ]);
  });

  it('Data is Modeller-only, text-only, and audited by name; Information flow is refused', async () => {
    const seeded = await PostgresModelStore.open(db, quiet);
    const { id } = await seeded.save(
      model([
        { id: 'r', source: 'a', target: 'b', relation: 'Relation' },
        { id: 'c', source: 'a', target: 'c', relation: 'Contains' },
      ]),
      author,
    );
    const patch = `/api/models/${id}/relationships/r`;
    const post = `/api/models/${id}/relationships`;
    const relation = { source: 'b', target: 'c', type: 'Relation' };

    app = await buildTestApp(
      {},
      idpOptions(idp, { database: DatabaseService.using(db, testConnection, silent) }),
    );
    expect((await call(app, 'PATCH', patch, undefined, { version: 1, data: 'x' })).statusCode).toBe(
      401,
    );
    expect((await call(app, 'POST', post, undefined, relation)).statusCode).toBe(401);
    await app.close();

    const viewer = await signedIn(['Viewer']);
    expect(
      (await call(viewer.target, 'PATCH', patch, viewer.cookie, { version: 1, data: 'x' }))
        .statusCode,
    ).toBe(403);
    expect((await call(viewer.target, 'POST', post, viewer.cookie, relation)).statusCode).toBe(403);
    await viewer.target.close();

    const { target, cookie } = await signedIn(['Modeller']);
    const logs = captureLogs(target);
    for (const value of [true, 1, [], {}]) {
      const refused = await call(target, 'PATCH', patch, cookie, { version: 1, data: value });
      expect(refused.statusCode, JSON.stringify(value)).toBe(422);
      expect(refused.json<{ fields: { field: string }[] }>().fields[0]?.field).toBe('data');
    }
    for (const body of [
      { version: 1, informationFlow: true },
      { version: 1, metadata: { informationFlow: true } },
      { version: 1, metadata: { data: 'x' } },
    ]) {
      expect((await call(target, 'PATCH', patch, cookie, body)).statusCode).toBe(422);
    }
    const onPost = await call(target, 'POST', post, cookie, { ...relation, informationFlow: true });
    expect(onPost.statusCode).toBe(422);
    const onContains = await call(target, 'PATCH', `/api/models/${id}/relationships/c`, cookie, {
      version: 1,
      data: 'x',
    });
    expect(onContains.statusCode).toBe(422);

    // Two Relations alike are fine; two Contains alike, a cycle and a self-link are not.
    const alike = { source: 'a', target: 'b', type: 'Relation' };
    expect((await call(target, 'POST', post, cookie, alike)).statusCode).toBe(201);
    expect((await call(target, 'POST', post, cookie, alike)).statusCode).toBe(201);
    const contains = { source: 'a', target: 'c', type: 'Contains' };
    const twin = await call(target, 'POST', post, cookie, contains);
    expect(twin.statusCode).toBe(422);
    expect(twin.json<{ duplicateOf?: string }>().duplicateOf).toBe('c');
    expect(
      (await call(target, 'POST', post, cookie, { source: 'c', target: 'a', type: 'Contains' }))
        .statusCode,
    ).toBe(422);
    expect(
      (await call(target, 'POST', post, cookie, { source: 'a', target: 'a', type: 'Relation' }))
        .statusCode,
    ).toBe(422);

    const saved = await call(target, 'PATCH', patch, cookie, {
      version: 1,
      data: 'made-up-data',
      metadata: { secretish: 'made-up-value' },
    });
    expect(saved.statusCode).toBe(200);
    const [audit] = await db.query<{ details: { fields: string[] } }>(
      `select details from audit where relationship_id = 'r' order by id desc limit 1`,
    );
    expect(audit?.details.fields.sort()).toEqual(['data', 'metadata.secretish']);
    expect(JSON.stringify(audit)).not.toContain('made-up-value');
    expect(JSON.stringify(audit)).not.toContain('made-up-data');
    expect(logs.join('\n')).not.toContain('made-up-value');
    expect(logs.join('\n')).not.toContain('made-up-data');
  });
});
