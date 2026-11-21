import {
  buildModelGraph,
  elementDefinitionsForKeys,
  catalogCell,
  catalogTable,
  elementGroupValue,
  elementPropertyValues,
  elementReferences,
  filterFields,
  groupByChoices,
  isReference,
  maxReferences,
  metadataText,
  referenceIds,
  referenceKey,
  referenceMessages,
  referenceProblem,
  referenceValue,
  referencedBy,
  withImportableReferences,
  withoutReferenceTo,
  type JgfDocument,
  type JgfNode,
  type ModelAuthor,
  type SaveModelResult,
} from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/db/service.js';
import { ElementRejectedError, ElementService } from '../src/editing/element-service.js';
import { validateJgf } from '../src/jgf/validate.js';
import { McpReadService } from '../src/mcp/read-service.js';
import { insertElementDefinitions } from '../src/properties/property-store.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import {
  buildTestApp,
  idpOptions,
  signIn,
  startMockIdp,
  webOrigin,
  withClaims,
} from './helpers.js';
import { createTestDb, resetTestDb, testConnection, type TestDb } from './pglite.js';

// References from an element to other elements of the same model: a custom value of the type
// Reference. Made-up data: a small library with a desk, a catalogue, a scanner and a reader.

const ref = (...ids: string[]) => ({ [referenceKey]: ids });
const modeller: ModelAuthor = { id: 'oid-made-up-modeller', name: 'Made-up Modeller' };
const seeder: ModelAuthor = { id: 'oid-made-up-seeder', name: 'Made-up Seeder' };

const library: JgfDocument = {
  graph: {
    label: 'Made-up library',
    nodes: {
      desk: {
        label: 'Lending desk',
        metadata: {
          type: 'Application',
          uses: ref('catalogue', 'scanner'),
          seeAlso: ref('scanner'),
          note: 'Front of house',
        },
      },
      catalogue: { label: 'Catalogue', metadata: { type: 'Application', uses: 'Paper cards' } },
      scanner: { label: 'Scanner', metadata: { type: 'Infrastructure' } },
      reader: { label: 'Reader', metadata: { type: 'Stakeholder', uses: ref('desk') } },
    },
    edges: [{ id: 'r1', source: 'reader', target: 'desk', relation: 'Relation' }],
  },
};

describe('the reference shape', () => {
  it('is an object with the one key, holding a list; nothing else is', () => {
    expect(referenceValue(['a', 'b'])).toEqual({ 'simplearchitecture:reference': ['a', 'b'] });
    expect(isReference(ref('a'))).toBe(true);
    expect(isReference(ref())).toBe(true);
    // Values a model may already hold as custom metadata: never a reference.
    for (const odd of [
      'a',
      ['a'],
      { reference: ['a'] },
      { [referenceKey]: 'a' },
      { [referenceKey]: ['a'], note: 'x' },
      { ids: ['a'] },
      null,
      7,
    ]) {
      expect(isReference(odd)).toBe(false);
      expect(referenceIds(odd)).toBeUndefined();
    }
    expect(referenceIds({ [referenceKey]: ['a', 3, 'b'] })).toEqual(['a', 'b']);
  });

  it('reads an element’s Reference fields from its custom keys only', () => {
    const graph = buildModelGraph({
      graph: {
        nodes: {
          ...library.graph.nodes,
          // A Stakeholder's Kind is a standard property: never a reference, whatever it holds.
          odd: { label: 'Odd', metadata: { type: 'Stakeholder', stakeholderKind: ref('desk') } },
        },
      },
    });
    const desk = graph.elements.get('desk');
    expect(desk && elementReferences(desk)).toEqual([
      { key: 'seeAlso', ids: ['scanner'] },
      { key: 'uses', ids: ['catalogue', 'scanner'] },
    ]);
    const odd = graph.elements.get('odd');
    expect(odd && elementReferences(odd)).toEqual([]);
  });
});

describe('referenceProblem', () => {
  const inModel = (id: string) => ['desk', 'catalogue', 'scanner'].includes(id);
  const cases: [string, unknown, string | undefined][] = [
    ['a list of other elements', ref('catalogue', 'scanner'), undefined],
    ['another shape', { [referenceKey]: 'catalogue' }, referenceMessages.shape],
    ['a marked value with more keys', { ...ref('catalogue'), note: 'x' }, referenceMessages.shape],
    ['ids that aren’t text', { [referenceKey]: ['catalogue', 7] }, referenceMessages.ids],
    ['no element', ref(), referenceMessages.empty],
    ['the same element twice', ref('scanner', 'scanner'), referenceMessages.repeated],
    ['the element itself', ref('desk'), referenceMessages.itself],
    ['an element not in the model', ref('catalogue', 'attic'), referenceMessages.missing],
    [
      `more than ${maxReferences} elements`,
      ref(...Array.from({ length: maxReferences + 1 }, (_, i) => `e${i}`)),
      referenceMessages.tooMany,
    ],
  ];
  it.each(cases)('%s', (_name, value, problem) => {
    expect(referenceProblem(value, 'desk', inModel)).toBe(problem);
  });

  it('takes exactly the most a field may hold', () => {
    const ids = Array.from({ length: maxReferences }, (_, i) => `e${i}`);
    expect(referenceProblem(ref(...ids), undefined, () => true)).toBeUndefined();
  });
});

describe('Referenced by', () => {
  it('lists who refers to an element, under which field, by name', () => {
    const graph = buildModelGraph(library);
    const names = (id: string) =>
      referencedBy(graph, id).map((entry) => [entry.element.id, entry.key]);
    expect(names('scanner')).toEqual([
      ['desk', 'seeAlso'],
      ['desk', 'uses'],
    ]);
    expect(names('catalogue')).toEqual([['desk', 'uses']]);
    expect(names('desk')).toEqual([['reader', 'uses']]);
    expect(names('reader')).toEqual([]);
    // Worked out once per graph.
    expect(referencedBy(graph, 'scanner')).toBe(referencedBy(graph, 'scanner'));
  });
});

describe('a reference where custom metadata shows', () => {
  const graph = buildModelGraph(library);

  it('reads as the elements’ current names, joined with ", "', () => {
    const renamed = buildModelGraph({
      graph: {
        nodes: {
          ...library.graph.nodes,
          scanner: { label: 'Barcode scanner', metadata: { type: 'Infrastructure' } },
          catalogue: { label: '  ', metadata: { type: 'Application' } },
        },
      },
    });
    const value = ref('catalogue', 'scanner');
    expect(metadataText(value, graph.elements)).toBe('Catalogue, Scanner');
    // Renamed: the new name. No name: the id.
    expect(metadataText(value, renamed.elements)).toBe('catalogue, Barcode scanner');
    // Without the model: the ids, never JSON or [object Object].
    expect(metadataText(value)).toBe('catalogue, scanner');
  });

  it('shows names in a catalog cell, never JSON', () => {
    // A catalog column is a standard property; a Reference only reaches one through its text.
    const element = {
      id: 'x',
      name: 'X',
      type: 'Business' as const,
      metadata: { type: 'Business', owningTeam: ref('desk', 'scanner') },
    };
    expect(catalogCell(element, 'owningTeam', graph.elements).text).toBe('Lending desk, Scanner');
    const table = catalogTable([element], 'Business', undefined, graph.elements);
    expect(table.rows[0]?.cells.map((cell) => cell.text)).toEqual([
      'X',
      '',
      'Lending desk, Scanner',
    ]);
  });

  it('is never a filter, Group by or suggested value; the key’s text values still are', () => {
    const fields = filterFields(graph);
    expect(fields.find((field) => field.key === 'seeAlso')).toBeUndefined();
    // `uses` is a Reference on the desk and the reader, and text on the catalogue.
    expect(fields.find((field) => field.key === 'uses')).toMatchObject({
      values: [{ value: 'Paper cards', count: 1 }],
      notSetCount: 3,
    });
    const choices = groupByChoices(graph).map((choice) => choice.key);
    expect(choices).not.toContain('seeAlso');
    const desk = graph.elements.get('desk');
    expect(desk && elementGroupValue(desk, 'uses')).toBeUndefined();
    expect(elementPropertyValues(graph).get('uses')).toEqual(['Paper cards']);
    expect(elementPropertyValues(graph).has('seeAlso')).toBe(false);
  });
});

describe('withoutReferenceTo', () => {
  it('leaves the id out of every field, removes a field left empty, and keeps the rest', () => {
    const desk = library.graph.nodes?.desk as JgfNode;
    const result = withoutReferenceTo(desk, 'scanner');
    expect(result?.keys).toEqual(['uses', 'seeAlso']);
    expect(result?.node).toEqual({
      label: 'Lending desk',
      metadata: { type: 'Application', uses: ref('catalogue'), note: 'Front of house' },
    });
    expect(withoutReferenceTo(desk, 'reader')).toBeUndefined();
    // The input isn't changed.
    expect(desk.metadata?.seeAlso).toEqual(ref('scanner'));
  });
});

describe('withImportableReferences', () => {
  it('keeps references within the graph and lists what it left out, per field', () => {
    const many = Array.from({ length: maxReferences + 2 }, (_, i) => `n${i}`);
    const nodes: Record<string, JgfNode> = {
      a: {
        label: 'A',
        metadata: {
          type: 'Other',
          uses: { [referenceKey]: ['b', 'gone', 'a', 'b', 4, 'c'] },
          only: ref('a'),
          empty: ref(),
          text: 'kept',
          near: { [referenceKey]: ['gone'], note: 'not a reference' },
        },
      },
      b: { label: 'B', metadata: { type: 'Other', uses: ref('a') } },
      c: { label: 'C', metadata: { type: 'Other', lots: ref(...many) } },
      ...Object.fromEntries(many.map((id) => [id, { metadata: { type: 'Other' } }])),
    };
    const { nodes: result, changes } = withImportableReferences(nodes);
    expect(result.a?.metadata).toEqual({
      type: 'Other',
      uses: ref('b', 'c'),
      text: 'kept',
      near: { [referenceKey]: ['gone'], note: 'not a reference' },
    });
    expect(result.b).toBe(nodes.b);
    expect(referenceIds(result.c?.metadata?.lots)).toHaveLength(maxReferences);
    const zero = { notInModel: 0, itself: 0, repeated: 0, overLimit: 0, removed: 0 };
    expect(changes).toEqual([
      { ...zero, key: 'empty', elements: 1, removed: 1 },
      { ...zero, key: 'lots', elements: 1, overLimit: 2 },
      { ...zero, key: 'only', elements: 1, itself: 1, removed: 1 },
      { ...zero, key: 'uses', elements: 1, notInModel: 2, itself: 1, repeated: 1 },
    ]);
    expect(Object.keys(result)).toEqual(Object.keys(nodes));
  });

  it('changes nothing in a model without references', () => {
    const nodes = { a: { label: 'A', metadata: { type: 'Other', list: ['x'], obj: { y: 1 } } } };
    const result = withImportableReferences(nodes);
    expect(result.changes).toEqual([]);
    expect(result.nodes.a).toBe(nodes.a);
  });
});

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function setup() {
  await resetTestDb(db);
  const store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
  const summary = await store.save(library, seeder);
  // Reference properties an Admin defined, which the tests set (the save defined the model's).
  const keys = ['feeds', 'usedBy', 'more', 'holds', 'constructor', 'toString'];
  await insertElementDefinitions(
    db,
    elementDefinitionsForKeys(
      keys.map((key) => ({ key, references: true })),
      [],
    ),
  );
  return { store, service: new ElementService(store), modelId: summary.id };
}

async function fields(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof ElementRejectedError)) throw new Error(`not rejected: ${String(error)}`);
  return error.fields;
}

/** The element audit rows (not the property rows the save wrote). */
const audit = () =>
  db.query<{ action: string; element_id: string; details: unknown }>(
    `select action, element_id, details from audit where action not like '%property%'
     order by id`,
  );

describe('ElementService: Reference fields', () => {
  it('stores a reference on a new element and on a change, and audits the field name only', async () => {
    const { store, service, modelId } = await setup();
    const added = await service.addElement(
      modelId,
      { type: 'Other', name: 'Returns box', metadata: { feeds: ref('desk', 'catalogue') } },
      modeller,
    );
    expect(added.element.node.metadata?.feeds).toEqual(ref('desk', 'catalogue'));
    await service.updateElement(
      modelId,
      'scanner',
      { version: 1, metadata: { usedBy: ref('desk') } },
      modeller,
    );
    const document = await store.get(modelId);
    expect(document?.graph.nodes?.scanner?.metadata?.usedBy).toEqual(ref('desk'));
    expect(validateJgf(document).valid).toBe(true);
    const rows = await audit();
    expect(rows.map((row) => row.details)).toEqual([
      { fields: ['name', 'type', 'metadata.feeds'] },
      { fields: ['metadata.usedBy'] },
    ]);
    expect(JSON.stringify(rows)).not.toContain('desk');
  });

  it('keeps a Reference under a Text property (a key used both ways), and refuses a new one there', async () => {
    const { store, service, modelId } = await setup();
    // `uses` holds text and References in the model: the save made it a Text property.
    await service.updateElement(
      modelId,
      'scanner',
      { version: 1, metadata: { uses: 'Batteries' } },
      modeller,
    );
    const nodes = (await store.get(modelId))?.graph.nodes;
    expect(nodes?.scanner?.metadata?.uses).toBe('Batteries');
    expect(nodes?.desk?.metadata?.uses).toEqual(ref('catalogue', 'scanner'));
    // Sent back unchanged, the Reference stays; a new one under the Text property is refused.
    await service.updateElement(
      modelId,
      'desk',
      { version: 1, name: 'Desk', metadata: { uses: ref('catalogue', 'scanner') } },
      modeller,
    );
    expect(
      await fields(
        service.updateElement(
          modelId,
          'scanner',
          { version: 2, metadata: { uses: ref('catalogue') } },
          modeller,
        ),
      ),
    ).toEqual([{ field: 'metadata.uses', message: 'Must be text.' }]);
  });

  const refusals: [string, unknown, string][] = [
    ['another shape', { [referenceKey]: 'scanner' }, referenceMessages.shape],
    ['ids that aren’t text', { [referenceKey]: [1] }, referenceMessages.ids],
    ['no element', ref(), referenceMessages.empty],
    ['the same element twice', ref('scanner', 'scanner'), referenceMessages.repeated],
    ['the element itself', ref('desk'), referenceMessages.itself],
    ['an element not in the model', ref('attic'), referenceMessages.missing],
    [
      'too many elements',
      ref(...Array.from({ length: maxReferences + 1 }, () => 'scanner')),
      referenceMessages.tooMany,
    ],
  ];
  it.each(refusals)(
    'refuses %s at its field, and stores nothing',
    async (_name, value, message) => {
      const { store, service, modelId } = await setup();
      const before = await store.get(modelId);
      expect(
        await fields(
          service.updateElement(
            modelId,
            'desk',
            { version: 1, metadata: { more: value } },
            modeller,
          ),
        ),
      ).toEqual([{ field: 'metadata.more', message }]);
      expect(await store.get(modelId)).toEqual(before);
      expect(await audit()).toEqual([]);
    },
  );

  it('refuses a new element’s reference to an element not in the model', async () => {
    const { service, modelId } = await setup();
    expect(
      await fields(
        service.addElement(
          modelId,
          { type: 'Other', name: 'Shelf', metadata: { holds: ref('catalogue', 'attic') } },
          modeller,
        ),
      ),
    ).toEqual([{ field: 'metadata.holds', message: referenceMessages.missing }]);
    expect(
      await fields(
        service.addElement(
          modelId,
          { type: 'Other', name: 'Shelf', metadata: { holds: ref('scanner', 'scanner') } },
          modeller,
        ),
      ),
    ).toEqual([{ field: 'metadata.holds', message: referenceMessages.repeated }]);
  });

  it('refuses a reference to an element of another model', async () => {
    const { store, service, modelId } = await setup();
    await store.save(
      {
        graph: {
          label: 'Made-up archive',
          nodes: { attic: { label: 'Attic', metadata: { type: 'Infrastructure' } } },
        },
      },
      seeder,
    );
    const before = await store.get(modelId);
    expect(
      await fields(
        service.updateElement(
          modelId,
          'desk',
          { version: 1, metadata: { more: ref('attic') } },
          modeller,
        ),
      ),
    ).toEqual([{ field: 'metadata.more', message: referenceMessages.missing }]);
    expect(
      await fields(
        service.addElement(
          modelId,
          { type: 'Other', name: 'Shelf', metadata: { holds: ref('attic') } },
          modeller,
        ),
      ),
    ).toEqual([{ field: 'metadata.holds', message: referenceMessages.missing }]);
    expect(await store.get(modelId)).toEqual(before);
  });

  it('keeps a Reference under a key named like an object’s own members, and cleans it on delete', async () => {
    const { store, service, modelId } = await setup();
    await service.updateElement(
      modelId,
      'scanner',
      { version: 1, metadata: { constructor: ref('desk'), toString: ref('desk', 'catalogue') } },
      modeller,
    );
    const graph = buildModelGraph((await store.get(modelId)) as JgfDocument);
    // The reader refers to the desk too; then the scanner, under both odd keys.
    expect(referencedBy(graph, 'desk').map((entry) => entry.key)).toEqual([
      'uses',
      'constructor',
      'toString',
    ]);
    await service.deleteElement(modelId, 'desk', { version: 1 }, modeller);
    const scanner = (await store.get(modelId))?.graph.nodes?.scanner?.metadata;
    // The field left with no element is gone; the other keeps the catalogue.
    expect(Object.entries(scanner ?? {})).toEqual([
      ['type', 'Infrastructure'],
      ['toString', ref('catalogue')],
    ]);
  });

  it('never stores a reference under a standard property', async () => {
    const { service, modelId } = await setup();
    expect(
      await fields(
        service.updateElement(
          modelId,
          'desk',
          { version: 1, metadata: { owningTeam: ref('scanner') } },
          modeller,
        ),
      ),
    ).toEqual([
      { field: 'metadata.owningTeam', message: 'Must be text, or a list of text for Functions.' },
    ]);
  });

  it('refuses a type change that would turn a Reference into a standard property', async () => {
    const { service, modelId } = await setup();
    // A model may hold one under another type's standard key (no one can set it there now).
    await db.query(
      `update elements set metadata = $2::jsonb where model_id = $1::uuid and id = 'scanner'`,
      [modelId, JSON.stringify({ stakeholderKind: ref('desk') })],
    );
    const refused = await fields(
      service.updateElement(modelId, 'scanner', { version: 1, type: 'Stakeholder' }, modeller),
    );
    expect(refused.map((issue) => issue.field)).toEqual(['type']);
    // Removing the field in the same change lets it through.
    await service.updateElement(
      modelId,
      'scanner',
      { version: 1, type: 'Stakeholder', metadata: { stakeholderKind: null } },
      modeller,
    );
  });

  it('takes an unchanged reference back as it is', async () => {
    const { service, modelId } = await setup();
    const result = await service.updateElement(
      modelId,
      'desk',
      { version: 1, metadata: { uses: ref('catalogue', 'scanner') } },
      modeller,
    );
    expect(result.element.version).toBe(1);
    expect(await audit()).toEqual([]);
  });
});

describe('ElementService: deleting a referenced element', () => {
  it('leaves it out of every reference in the same change, with versions and audit rows', async () => {
    const { store, service, modelId } = await setup();
    const result = await service.deleteElement(modelId, 'scanner', { version: 1 }, modeller);
    expect(result.referencesRemovedFrom).toEqual(['desk']);
    const document = await store.get(modelId);
    expect(document?.graph.nodes?.desk?.metadata).toEqual({
      type: 'Application',
      uses: ref('catalogue'),
      note: 'Front of house',
    });
    expect(validateJgf(document).valid).toBe(true);
    const desk = await service.getElement(modelId, 'desk');
    expect(desk.element.version).toBe(2);
    expect(await audit()).toEqual([
      {
        action: 'element-deleted',
        element_id: 'scanner',
        details: { fields: [], deletedRelationships: 0 },
      },
      {
        action: 'element-updated',
        element_id: 'desk',
        details: { fields: ['metadata.uses', 'metadata.seeAlso'] },
      },
    ]);
    // Referenced by follows: no one refers to the scanner, and the desk still to the catalogue.
    const graph = buildModelGraph(document as JgfDocument);
    expect(referencedBy(graph, 'catalogue').map((entry) => entry.element.id)).toEqual(['desk']);
  });

  it('removes the reference field the deleted element was the last in', async () => {
    const { store, service, modelId } = await setup();
    const result = await service.deleteElement(modelId, 'desk', { version: 1 }, modeller);
    expect(result).toMatchObject({
      referencesRemovedFrom: ['reader'],
      deletedRelationshipCount: 1,
    });
    expect((await store.get(modelId))?.graph.nodes?.reader?.metadata).toEqual({
      type: 'Stakeholder',
    });
  });

  it('changes nothing else when no one refers to it', async () => {
    const { service, modelId } = await setup();
    const result = await service.deleteElement(modelId, 'reader', { version: 1 }, modeller);
    expect(result.referencesRemovedFrom).toEqual([]);
    expect((await audit()).map((row) => row.action)).toEqual(['element-deleted']);
  });
});

describe('MCP read tools: references', () => {
  it('return each reference with id and current name, beside the stored ids, and who refers', async () => {
    const { store, service, modelId } = await setup();
    await service.updateElement(
      modelId,
      'scanner',
      { version: 1, name: 'Barcode scanner' },
      modeller,
    );
    const read = new McpReadService(store);
    const desk = await read.element(modelId, 'desk');
    expect(desk.properties).toMatchObject({ uses: ref('catalogue', 'scanner') });
    expect(desk.references).toEqual({
      seeAlso: [{ id: 'scanner', name: 'Barcode scanner' }],
      uses: [
        { id: 'catalogue', name: 'Catalogue' },
        { id: 'scanner', name: 'Barcode scanner' },
      ],
    });
    expect(desk.referencedBy).toEqual([
      {
        id: 'reader',
        name: 'Reader',
        type: 'Stakeholder',
        stakeholderKind: 'Human',
        field: 'uses',
      },
    ]);
    const scanner = await read.element(modelId, 'scanner');
    expect(scanner).not.toHaveProperty('references');
    expect(scanner.referencedBy?.map((entry) => entry.field)).toEqual(['seeAlso', 'uses']);
    const found = await read.searchElements(modelId, { query: 'desk' });
    expect(found.elements[0]?.references?.uses?.map((entry) => entry.name)).toEqual([
      'Catalogue',
      'Barcode scanner',
    ]);
    const catalogue = (await read.searchElements(modelId, { query: 'catalogue' })).elements[0];
    expect(catalogue).not.toHaveProperty('references');
  });
});

describe('references through the API', () => {
  const user = { oid: '9f0c4f8e-0000-4000-8000-00000000a6a6', name: 'Made-up Librarian' };
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  let idp: OAuth2Server;
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    idp = await startMockIdp();
  });

  afterAll(async () => {
    await idp.stop();
  });

  afterEach(async () => {
    idp.service.removeAllListeners('beforeTokenSigning');
    await app?.close();
    app = undefined;
  });

  beforeEach(async () => {
    await resetTestDb(db);
  });

  async function signedInAs(roles: string[]) {
    app = await buildTestApp(
      { LOG_LEVEL: 'silent' },
      idpOptions(idp, { database: DatabaseService.using(db, testConnection, silent) }),
    );
    withClaims(idp, { roles, ...user });
    const { sessionCookie } = await signIn(app);
    const target = app;
    return (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) =>
      target.inject({
        method,
        url,
        headers: {
          origin: webOrigin,
          cookie: sessionCookie,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
  }

  it('imports references within the model, lists what it left out, and exports them as stored', async () => {
    const call = await signedInAs(['Admin']);
    const file = structuredClone(library);
    const nodes = file.graph.nodes as Record<string, JgfNode>;
    (nodes.desk as JgfNode).metadata = {
      ...nodes.desk?.metadata,
      uses: ref('catalogue', 'attic', 'desk', 'scanner'),
    };
    const saved = await call('POST', '/api/models', file);
    expect(saved.statusCode).toBe(201);
    const body = saved.json<SaveModelResult>();
    expect(body.leftOutReferences).toEqual([
      { key: 'uses', elements: 1, notInModel: 1, itself: 1, repeated: 0, overLimit: 0, removed: 0 },
    ]);
    const exported = await call('GET', `/api/models/${body.model.id}`);
    const desk = exported.json<JgfDocument>().graph.nodes?.desk;
    expect(desk?.metadata?.uses).toEqual(ref('catalogue', 'scanner'));
    expect(desk?.metadata?.seeAlso).toEqual(ref('scanner'));

    // A model with nothing to leave out says nothing about it.
    const clean = await call('POST', '/api/models', library);
    expect(clean.json<SaveModelResult>()).not.toHaveProperty('leftOutReferences');
  });

  it('refuses a bad reference with its field, and a delete answers who referred', async () => {
    const store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
    const modelId = (await store.save(library, seeder)).id;
    const call = await signedInAs(['Modeller']);
    const url = (id: string) => `/api/models/${modelId}/elements/${id}`;
    const refused = await call('PATCH', url('desk'), {
      version: 1,
      metadata: { seeAlso: ref('desk') },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ fields: unknown }>().fields).toEqual([
      { field: 'metadata.seeAlso', message: referenceMessages.itself },
    ]);
    const deleted = await call('DELETE', `${url('catalogue')}?version=1`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json<{ referencesRemovedFrom: string[] }>().referencesRemovedFrom).toEqual([
      'desk',
    ]);
  });
});
