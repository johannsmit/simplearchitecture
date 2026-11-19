import { readFileSync } from 'node:fs';
import { definitionsForKeys, type JgfDocument, type ModelAuthor } from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/db/service.js';
import { insertDefinitions } from '../src/properties/property-store.js';
import { validateJgf } from '../src/jgf/validate.js';
import { convertOef } from '../src/oef/mapper.js';
import { loadOefMapping } from '../src/oef/mapping-config.js';
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

// Relation and Contains in the shipped OEF mapping and through the routes. Made-up data only.

const author: ModelAuthor = { id: 'oid-made-up', name: 'Made-up author' };
const nodes = {
  a: { label: 'A', metadata: { type: 'Application' } },
  b: { label: 'B', metadata: { type: 'Application' } },
  c: { label: 'C', metadata: { type: 'Infrastructure' } },
};
const model = (edges: unknown[]): JgfDocument =>
  ({ graph: { label: 'Made-up', nodes, edges } }) as unknown as JgfDocument;
const quiet = { log: { warn: () => undefined } };

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
          metadata: {
            sourceToTargetData: ['Orders', 'Customer ids'],
            targetToSourceData: ['Order ids'],
            identity: 'made-up-client',
            protocol: 'REST',
          },
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
          metadata: { sourceToTargetData: 7 },
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
          metadata: { sourceToTargetData: ['Kept on a Contains'] },
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
    // The edge without an id got one on import; it keeps it from then on.
    const edges = once.graph.edges as { id?: string }[];
    const given = edges[4]?.id;
    expect(given).toMatch(/^[0-9a-f-]{36}$/);
    const withId = structuredClone(everything);
    Object.assign(withId.graph.edges[4] as object, { id: given });
    expect(graphPart(once)).toEqual(graphPart(withId));

    const again = await call(target, 'POST', '/api/models', cookie, once);
    expect(again.statusCode, again.body).toBeLessThan(300);
    const secondId = again.json<{ model: { id: string } }>().model.id;
    expect(secondId).not.toBe(id);
    const twice = (await call(target, 'GET', `/api/models/${secondId}`, cookie)).json<{
      graph: Record<string, unknown>;
    }>();
    expect(graphPart(twice)).toEqual(graphPart(withId));
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
      { relation: 'Relation', metadata: { sourceToTargetData: ['L'] }, directed: false },
      { relation: 'Relation', metadata: { protocol: 'REST' }, directed: null },
      { relation: 'Contains', metadata: null, directed: null },
    ]);
  });

  it('Source to target data is Modeller-only, a list of texts only, and audited by name; Information flow and Data are refused', async () => {
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
    expect(
      (await call(app, 'PATCH', patch, undefined, { version: 1, sourceToTargetData: 'x' }))
        .statusCode,
    ).toBe(401);
    expect((await call(app, 'POST', post, undefined, relation)).statusCode).toBe(401);
    await app.close();

    const viewer = await signedIn(['Viewer']);
    expect(
      (
        await call(viewer.target, 'PATCH', patch, viewer.cookie, {
          version: 1,
          sourceToTargetData: 'x',
        })
      ).statusCode,
    ).toBe(403);
    expect((await call(viewer.target, 'POST', post, viewer.cookie, relation)).statusCode).toBe(403);
    await viewer.target.close();

    const { target, cookie } = await signedIn(['Modeller']);
    const logs = captureLogs(target);
    for (const value of [true, 1, 'x', {}, [''], [1], ['x', 'X']]) {
      const refused = await call(target, 'PATCH', patch, cookie, {
        version: 1,
        sourceToTargetData: value,
      });
      expect(refused.statusCode, JSON.stringify(value)).toBe(422);
      expect(refused.json<{ fields: { field: string }[] }>().fields[0]?.field).toBe(
        'sourceToTargetData',
      );
    }
    for (const body of [
      { version: 1, informationFlow: true },
      { version: 1, metadata: { informationFlow: true } },
      { version: 1, metadata: { data: 'x' } },
      { version: 1, data: 'x' },
      { version: 1, requestData: ['x'] },
      { version: 1, metadata: { responseData: ['x'] } },
    ]) {
      expect((await call(target, 'PATCH', patch, cookie, body)).statusCode).toBe(422);
    }
    const onPost = await call(target, 'POST', post, cookie, { ...relation, informationFlow: true });
    expect(onPost.statusCode).toBe(422);
    const onContains = await call(target, 'PATCH', `/api/models/${id}/relationships/c`, cookie, {
      version: 1,
      targetToSourceData: ['x'],
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

    await insertDefinitions(db, definitionsForKeys(['secretish'], []));
    const saved = await call(target, 'PATCH', patch, cookie, {
      version: 1,
      sourceToTargetData: ['made-up-data'],
      metadata: { secretish: 'made-up-value' },
    });
    expect(saved.statusCode).toBe(200);
    const [audit] = await db.query<{ details: { fields: string[] } }>(
      `select details from audit where relationship_id = 'r' order by id desc limit 1`,
    );
    expect(audit?.details.fields.sort()).toEqual(['metadata.secretish', 'sourceToTargetData']);
    expect(JSON.stringify(audit)).not.toContain('made-up-value');
    expect(JSON.stringify(audit)).not.toContain('made-up-data');
    expect(logs.join('\n')).not.toContain('made-up-value');
    expect(logs.join('\n')).not.toContain('made-up-data');
  });
});
