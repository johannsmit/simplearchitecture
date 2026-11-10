import type { JgfDocument, ModelAuthor } from '@simplearchitecture/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictError,
  EditingUnavailableError,
  NotFoundError,
  RejectedError,
} from '../src/editing/common.js';
import { ElementService } from '../src/editing/element-service.js';
import { RelationshipService } from '../src/editing/relationship-service.js';
import { validateJgf } from '../src/jgf/validate.js';
import { FileModelStore } from '../src/storage/file-model-store.js';
import { ModelNotStorableError, ModelTooLargeError } from '../src/storage/model-store.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { tempDataDir } from './helpers.js';
import { createTestDb, resetTestDb, type TestDb } from './pglite.js';

const modeller: ModelAuthor = { id: 'oid-made-up-modeller', name: 'Made-up Modeller' };
const other: ModelAuthor = { id: 'oid-made-up-other', name: 'Made-up Colleague' };

// Made up: a farm in which the barn holds the silo; the silo holds the pump.
const farm: JgfDocument = {
  graph: {
    label: 'Made-up farm',
    directed: true,
    nodes: {
      farmer: { label: 'Farmer', metadata: { type: 'Stakeholder' } },
      barn: { label: 'Barn', metadata: { type: 'Infrastructure' } },
      silo: { label: 'Silo', metadata: { type: 'Infrastructure' } },
      pump: { label: 'Pump', metadata: { type: 'Application' } },
      tractor: { label: 'Tractor', metadata: { type: 'Other' } },
    },
    edges: [
      { id: 'r1', source: 'barn', target: 'silo', relation: 'Contains' },
      { id: 'r2', source: 'silo', target: 'pump', relation: 'Contains' },
      {
        id: 'r3',
        source: 'farmer',
        target: 'pump',
        relation: 'Relation',
        metadata: { informationFlow: true },
        label: 'Reads the level',
      },
      { source: 'farmer', target: 'tractor', relation: 'Relation' },
    ],
  },
};

interface AuditRow {
  action: string;
  user_id: string;
  user_name: string;
  element_id: string | null;
  relationship_id: string | null;
  details: { fields: string[] };
}

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetTestDb(db);
});

async function setup(options: { maxModelBytes?: number; model?: JgfDocument } = {}) {
  const { model = farm, ...storeOptions } = options;
  const store = await PostgresModelStore.open(db, {
    log: { warn: () => undefined },
    ...storeOptions,
  });
  const summary = await store.save(model, other);
  return { store, service: new RelationshipService(store), modelId: summary.id };
}

const audit = () =>
  db.query<AuditRow>(
    'select action, user_id, user_name, element_id, relationship_id, details from audit order by id',
  );

async function edgesOf(store: PostgresModelStore, modelId: string) {
  const document = await store.get(modelId);
  if (!document) throw new Error('model gone');
  return document.graph.edges ?? [];
}

async function rejection(promise: Promise<unknown>): Promise<RejectedError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof RejectedError))
    throw new Error(`expected a rejection, got ${String(error)}`);
  return error;
}

describe('RelationshipService: add', () => {
  it('adds a relationship last, with a server id, version 1, counts and one audit row', async () => {
    const { store, service, modelId } = await setup();
    const result = await service.addRelationship(
      modelId,
      { source: 'tractor', target: 'pump', type: 'Relation', description: 'Made-up link' },
      modeller,
    );
    const { relationship } = result;
    expect(relationship.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(relationship.version).toBe(1);
    expect(relationship.edge).toEqual({
      id: relationship.id,
      source: 'tractor',
      target: 'pump',
      relation: 'Relation',
      directed: true,
      metadata: { architectureState: 'Current', description: 'Made-up link' },
    });
    expect(result.nestingChanges).toEqual([]);

    const edges = await edgesOf(store, modelId);
    expect(edges.map((edge) => edge.id)).toEqual(['r1', 'r2', 'r3', undefined, relationship.id]);
    expect((await store.list())[0]?.edgeCount).toBe(5);
    expect(await audit()).toEqual([
      {
        action: 'relationship-added',
        user_id: modeller.id,
        user_name: modeller.name,
        element_id: null,
        relationship_id: relationship.id,
        details: { fields: ['source', 'target', 'type', 'architectureState', 'description'] },
      },
    ]);
    expect(await service.getRelationship(modelId, relationship.id)).toEqual({
      relationship,
      warnings: [],
      nestingChanges: [],
    });
  });

  it('reports the element a new Contains nests, and warns about a second container', async () => {
    const { service, modelId } = await setup();
    const nested = await service.addRelationship(
      modelId,
      { source: 'barn', target: 'tractor', type: 'Contains', architectureState: 'Target' },
      modeller,
    );
    expect(nested.nestingChanges).toEqual([{ elementId: 'tractor', containerId: 'barn' }]);
    expect(nested.relationship.edge.metadata).toEqual({ architectureState: 'Target' });
    expect(nested.warnings).toEqual([]);

    const second = await service.addRelationship(
      modelId,
      { source: 'farmer', target: 'pump', type: 'Contains' },
      modeller,
    );
    expect(second.warnings.map((issue) => issue.code)).toEqual(['multiple-containers']);
  });

  it('refuses self-contains, a cycle and a duplicate, and stores nothing', async () => {
    const { store, service, modelId } = await setup();
    const self = await rejection(
      service.addRelationship(
        modelId,
        { source: 'barn', target: 'barn', type: 'Contains' },
        modeller,
      ),
    );
    expect(self.fields).toEqual([
      { field: 'target', message: "Can't connect an element to itself." },
    ]);
    // Refused for every type in Modelling, not only Contains.
    const selfFlow = await rejection(
      service.addRelationship(
        modelId,
        { source: 'pump', target: 'pump', type: 'Relation' },
        modeller,
      ),
    );
    expect(selfFlow.fields[0]?.message).toBe("Can't connect an element to itself.");

    const cycle = await rejection(
      service.addRelationship(
        modelId,
        { source: 'pump', target: 'barn', type: 'Contains' },
        modeller,
      ),
    );
    expect(cycle.fields[0]?.message).toBe('Not possible: Pump is inside Barn (through Silo).');

    const twin = await rejection(
      service.addRelationship(
        modelId,
        { source: 'barn', target: 'silo', type: 'Contains' },
        modeller,
      ),
    );
    expect(twin.duplicateOf).toBe('r1');
    expect(twin.fields[0]?.message).toBe('Barn already contains Silo.');
    // Several Relations may link the same two elements.
    await service.addRelationship(
      modelId,
      { source: 'farmer', target: 'pump', type: 'Relation' },
      modeller,
    );
    await service.addRelationship(
      modelId,
      { source: 'farmer', target: 'tractor', type: 'Relation' },
      modeller,
    );

    // Another type, or the other direction, is a different relationship.
    await service.addRelationship(
      modelId,
      { source: 'farmer', target: 'pump', type: 'Relation' },
      modeller,
    );
    await service.addRelationship(
      modelId,
      { source: 'pump', target: 'farmer', type: 'Relation' },
      modeller,
    );
    expect(await edgesOf(store, modelId)).toHaveLength(8);
    expect((await audit()).map((row) => row.action)).toEqual(Array(4).fill('relationship-added'));
  });

  it('checks the input and both ends', async () => {
    const { service, modelId } = await setup();
    const bad = await rejection(
      service.addRelationship(
        modelId,
        { source: '', target: 'pump', type: 'Uses', architectureState: 'Someday', label: 'x' },
        modeller,
      ),
    );
    expect(bad.fields.map((issue) => issue.field).sort()).toEqual(
      ['architectureState', 'label', 'source', 'type'].sort(),
    );
    expect((await rejection(service.addRelationship(modelId, [], modeller))).fields).toEqual([
      { field: '', message: 'Send the relationship as a JSON object.' },
    ]);
    const long = await rejection(
      service.addRelationship(
        modelId,
        { source: 'farmer', target: 'pump', type: 'Relation', description: 'x'.repeat(10_001) },
        modeller,
      ),
    );
    expect(long.fields.map((issue) => issue.field)).toEqual(['description']);

    for (const [body, missing] of [
      [{ source: 'nobody', target: 'pump', type: 'Relation' }, 'source'],
      [{ source: 'farmer', target: '__proto__', type: 'Relation' }, 'target'],
    ] as const) {
      const error = await service.addRelationship(modelId, body, modeller).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).what).toBe(missing);
    }
    const unknown = '0b6f8d55-1c1e-4b7e-9a51-6c1c2f4f2d10';
    await expect(
      service.addRelationship(
        unknown,
        { source: 'farmer', target: 'pump', type: 'Relation' },
        modeller,
      ),
    ).rejects.toMatchObject({ what: 'model' });
    expect(await audit()).toEqual([]);
  });

  it('refuses a change that would make the model too large', async () => {
    const { service, modelId } = await setup({ maxModelBytes: 3000 });
    await expect(
      service.addRelationship(
        modelId,
        { source: 'farmer', target: 'barn', type: 'Relation', description: 'x'.repeat(5000) },
        modeller,
      ),
    ).rejects.toThrow(ModelTooLargeError);
    expect(await audit()).toEqual([]);
  });
});

describe('RelationshipService: update and reverse', () => {
  it('sets, changes and removes the label, auditing the field name only', async () => {
    const { store, service, modelId } = await setup();
    const set = await service.updateRelationship(
      modelId,
      'r3',
      { version: 1, label: '  Reads nightly  ' },
      modeller,
    );
    expect(set.relationship.version).toBe(2);
    expect(set.relationship.edge.label).toBe('Reads nightly');
    const cleared = await service.updateRelationship(
      modelId,
      'r3',
      { version: 2, label: '   ' },
      modeller,
    );
    expect(cleared.relationship.edge).not.toHaveProperty('label');
    expect((await edgesOf(store, modelId))[2]).not.toHaveProperty('label');
    const added = await service.updateRelationship(
      modelId,
      'r3',
      { version: 3, label: 'Back again' },
      modeller,
    );
    const removed = await service.updateRelationship(
      modelId,
      'r3',
      { version: added.relationship.version, label: null },
      modeller,
    );
    expect(removed.relationship.edge).not.toHaveProperty('label');

    const rows = await audit();
    const row = rows.at(-1);
    expect(row?.action).toBe('relationship-updated');
    expect(row?.details).toEqual({ fields: ['label'] });
    expect(JSON.stringify(rows)).not.toContain('Back again');
    expect(JSON.stringify(rows)).not.toContain('Reads nightly');
  });

  it('stores nothing when the label is the same', async () => {
    const { service, modelId } = await setup();
    const same = await service.updateRelationship(
      modelId,
      'r3',
      { version: 1, label: ' Reads the level ' },
      modeller,
    );
    expect(same.relationship.version).toBe(1);
  });

  it('refuses a label over 200 characters, and a label that isn’t text', async () => {
    const { store, service, modelId } = await setup();
    const long = await rejection(
      service.updateRelationship(modelId, 'r3', { version: 1, label: 'x'.repeat(201) }, modeller),
    );
    expect(long.fields.map((issue) => issue.field)).toEqual(['label']);
    const notText = await rejection(
      service.updateRelationship(modelId, 'r3', { version: 1, label: 5 }, modeller),
    );
    expect(notText.fields.map((issue) => issue.field)).toEqual(['label']);
    expect((await edgesOf(store, modelId))[2]?.label).toBe('Reads the level');
    await expect(
      service.updateRelationship(modelId, 'r3', { version: 1, label: 'x'.repeat(200) }, modeller),
    ).resolves.toBeDefined();
  });

  it('refuses a label change from an older version', async () => {
    const { store, service, modelId } = await setup();
    await service.updateRelationship(modelId, 'r3', { version: 1, label: 'New' }, modeller);
    await expect(
      service.updateRelationship(modelId, 'r3', { version: 1, label: 'Older' }, modeller),
    ).rejects.toThrow(ConflictError);
    expect((await edgesOf(store, modelId))[2]?.label).toBe('New');
  });

  it('changes the type, state and description, bumping the version once per change', async () => {
    const { store, service, modelId } = await setup();
    const changed = await service.updateRelationship(
      modelId,
      'r3',
      { version: 1, type: 'Contains', architectureState: 'Deprecate', description: 'Made-up' },
      modeller,
    );
    expect(changed.relationship.version).toBe(2);
    expect(changed.relationship.edge).toEqual({
      id: 'r3',
      source: 'farmer',
      target: 'pump',
      relation: 'Contains',
      label: 'Reads the level',
      metadata: { architectureState: 'Deprecate', description: 'Made-up' },
    });
    const removed = await service.updateRelationship(
      modelId,
      'r3',
      { version: 2, description: null },
      modeller,
    );
    expect(removed.relationship.edge.metadata).toEqual({ architectureState: 'Deprecate' });
    expect((await edgesOf(store, modelId))[2]).toEqual(removed.relationship.edge);

    // Nothing changes: the same version, and no audit row.
    const same = await service.updateRelationship(
      modelId,
      'r3',
      { version: 3, architectureState: 'Deprecate', reverse: false },
      modeller,
    );
    expect(same.relationship.version).toBe(3);
    expect(
      (await audit()).map((row) => [row.action, row.relationship_id, row.details.fields]),
    ).toEqual([
      ['relationship-updated', 'r3', ['type', 'architectureState', 'description', 'requestData']],
      ['relationship-updated', 'r3', ['description']],
    ]);
  });

  it('reverses a relationship in place, keeping its id, and reports the nesting', async () => {
    const { store, service, modelId } = await setup();
    // barn contains silo; reversed, silo contains barn and the pump stays in the silo.
    const reversed = await service.updateRelationship(
      modelId,
      'r1',
      { version: 1, reverse: true },
      modeller,
    );
    expect(reversed.relationship).toMatchObject({
      id: 'r1',
      version: 2,
      edge: { source: 'silo', target: 'barn', relation: 'Contains' },
    });
    expect(reversed.nestingChanges).toEqual([
      { elementId: 'barn', containerId: 'silo' },
      { elementId: 'silo', containerId: null },
    ]);
    expect((await edgesOf(store, modelId)).map((edge) => edge.id)).toEqual([
      'r1',
      'r2',
      'r3',
      undefined,
    ]);
    const [row] = await audit();
    expect(row).toMatchObject({
      action: 'relationship-reversed',
      relationship_id: 'r1',
      details: { fields: ['source', 'target'] },
    });
  });

  it('re-checks the rules on reverse and type change, and stores nothing when refused', async () => {
    // An imported self-relationship stays readable, but can't become a Contains.
    const loop = {
      id: 'loop',
      source: 'pump',
      target: 'pump',
      relation: 'Relation',
      metadata: { informationFlow: true },
    };
    const model = { graph: { ...farm.graph, edges: [...(farm.graph.edges ?? []), loop] } };
    const { store, service, modelId } = await setup({ model });
    const add = async (source: string, target: string, type: string) =>
      (await service.addRelationship(modelId, { source, target, type }, modeller)).relationship.id;
    const twinId = await add('pump', 'farmer', 'Contains');
    const towardsBarn = await add('pump', 'barn', 'Relation');
    // A second container for the pump: allowed, with a warning.
    const second = await add('barn', 'pump', 'Contains');
    const selfFlow = 'loop';
    const before = await edgesOf(store, modelId);
    const rows = (await audit()).length;

    const twin = await rejection(
      service.updateRelationship(
        modelId,
        'r3',
        { version: 1, type: 'Contains', reverse: true },
        modeller,
      ),
    );
    expect(twin.duplicateOf).toBe(twinId);
    expect(twin.fields[0]?.field).toBe('reverse');

    // pump contains barn contains silo contains pump.
    const byType = await rejection(
      service.updateRelationship(modelId, towardsBarn, { version: 1, type: 'Contains' }, modeller),
    );
    expect(byType.fields).toEqual([
      { field: 'type', message: expect.stringMatching(/^Not possible: /) as string },
    ]);
    const byReverse = await rejection(
      service.updateRelationship(modelId, second, { version: 1, reverse: true }, modeller),
    );
    expect(byReverse.fields).toEqual([
      { field: 'reverse', message: expect.stringMatching(/^Not possible: /) as string },
    ]);

    const self = await rejection(
      service.updateRelationship(modelId, selfFlow, { version: 1, type: 'Contains' }, modeller),
    );
    expect(self.fields).toEqual([
      { field: 'type', message: "Can't connect an element to itself." },
    ]);
    // Reversing a self-relationship changes nothing.
    const unchanged = await service.updateRelationship(
      modelId,
      selfFlow,
      { version: 1, reverse: true },
      modeller,
    );
    expect(unchanged.relationship.version).toBe(1);

    expect(await edgesOf(store, modelId)).toEqual(before);
    expect(await audit()).toHaveLength(rows);
  });

  it('refuses a stale version and an unknown relationship', async () => {
    const { service, modelId } = await setup();
    await service.updateRelationship(
      modelId,
      'r3',
      { version: 1, architectureState: 'Target' },
      modeller,
    );
    const stale = await service
      .updateRelationship(modelId, 'r3', { version: 1, architectureState: 'Current' }, modeller)
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(ConflictError);
    expect((stale as ConflictError).currentVersion).toBe(2);
    expect((stale as ConflictError).message).toMatch(/relationship/);
    // Edges without an id can't be addressed.
    for (const id of ['nope', 'edges[3]', '']) {
      await expect(
        service.updateRelationship(modelId, id, { version: 1, reverse: true }, modeller),
      ).rejects.toMatchObject({ what: 'relationship' });
    }
    const unknownField = await rejection(
      service.updateRelationship(modelId, 'r3', { version: 2, relation: 'Contains' }, modeller),
    );
    expect(unknownField.fields).toEqual([
      { field: 'relation', message: 'Is not a field of a relationship.' },
    ]);
    expect(await audit()).toHaveLength(1);
  });
});

describe('RelationshipService: new ends', () => {
  it('changes the target, the source or both, keeping the id, with the field names audited', async () => {
    const { store, service, modelId } = await setup();
    // farmer relates to pump; then to the tractor.
    const target = await service.updateRelationship(
      modelId,
      'r3',
      { version: 1, target: 'tractor' },
      modeller,
    );
    expect(target.relationship).toMatchObject({
      id: 'r3',
      version: 2,
      edge: { source: 'farmer', target: 'tractor', relation: 'Relation', label: 'Reads the level' },
    });
    expect(target.nestingChanges).toEqual([]);
    const both = await service.updateRelationship(
      modelId,
      'r3',
      { version: 2, source: 'tractor', target: 'barn', description: 'Made-up' },
      modeller,
    );
    expect(both.relationship.edge).toMatchObject({ source: 'tractor', target: 'barn' });
    // An end sent as it is changes nothing.
    const same = await service.updateRelationship(
      modelId,
      'r3',
      { version: 3, source: 'tractor', target: 'barn' },
      modeller,
    );
    expect(same.relationship.version).toBe(3);
    expect((await edgesOf(store, modelId)).map((edge) => edge.id)).toEqual([
      'r1',
      'r2',
      'r3',
      undefined,
    ]);
    expect(
      (await audit()).map((row) => [row.action, row.relationship_id, row.details.fields]),
    ).toEqual([
      ['relationship-updated', 'r3', ['target']],
      ['relationship-updated', 'r3', ['source', 'target', 'description']],
    ]);
  });

  it('refuses reverse with a new end, an end not in the model, and a stale version', async () => {
    const { store, service, modelId } = await setup();
    const before = await edgesOf(store, modelId);
    for (const change of [
      { version: 1, reverse: true, target: 'tractor' },
      { version: 1, reverse: true, source: 'tractor' },
    ]) {
      const refused = await rejection(service.updateRelationship(modelId, 'r3', change, modeller));
      expect(refused.fields).toEqual([
        {
          field: 'reverse',
          message:
            "Reverse can't be sent with a new source or target: send the new source and target instead.",
        },
      ]);
    }
    // reverse: false is no reverse.
    const kept = await service.updateRelationship(
      modelId,
      'r3',
      { version: 1, reverse: false, target: 'tractor' },
      modeller,
    );
    expect(kept.relationship.edge).toMatchObject({ source: 'farmer', target: 'tractor' });
    for (const [change, what] of [
      [{ version: 2, target: 'ghost' }, 'target'],
      [{ version: 2, source: 'toString' }, 'source'],
    ] as const) {
      const missing = await service.updateRelationship(modelId, 'r3', change, modeller).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(missing).toBeInstanceOf(NotFoundError);
      expect((missing as NotFoundError).what).toBe(what);
    }
    for (const bad of [
      { version: 2, target: '' },
      { version: 2, source: 7 },
    ]) {
      const refused = await rejection(service.updateRelationship(modelId, 'r3', bad, modeller));
      expect(refused.fields.map((issue) => issue.field)).toEqual([Object.keys(bad)[1]]);
    }
    await expect(
      service.updateRelationship(modelId, 'r3', { version: 1, target: 'barn' }, modeller),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await edgesOf(store, modelId))[2]).toEqual({ ...before[2], target: 'tractor' });
    expect((await audit()).length).toBe(1);
  });

  it('applies the rules for a new relationship: no self, no cycle, no Contains twice', async () => {
    const { store, service, modelId } = await setup();
    const before = await edgesOf(store, modelId);
    const self = await rejection(
      service.updateRelationship(modelId, 'r3', { version: 1, target: 'farmer' }, modeller),
    );
    expect(self.fields).toEqual([
      { field: 'target', message: "Can't connect an element to itself." },
    ]);
    const selfBySource = await rejection(
      service.updateRelationship(modelId, 'r3', { version: 1, source: 'pump' }, modeller),
    );
    expect(selfBySource.fields[0]?.field).toBe('source');
    // silo contains pump; with the barn as its target, the barn would contain the silo that
    // contains it.
    const cycle = await rejection(
      service.updateRelationship(modelId, 'r2', { version: 1, target: 'barn' }, modeller),
    );
    expect(cycle.fields[0]).toEqual({
      field: 'target',
      message: 'Not possible: Barn contains Silo.',
    });
    const twin = await rejection(
      service.updateRelationship(
        modelId,
        'r2',
        { version: 1, source: 'barn', target: 'silo' },
        modeller,
      ),
    );
    expect(twin.duplicateOf).toBe('r1');
    // A Relation may repeat: two Relations from the farmer to the pump are fine.
    await service.addRelationship(
      modelId,
      { source: 'farmer', target: 'tractor', type: 'Relation' },
      modeller,
    );
    const repeated = await service.updateRelationship(
      modelId,
      'r3',
      { version: 1, target: 'tractor' },
      modeller,
    );
    expect(repeated.relationship.edge.target).toBe('tractor');
    expect((await edgesOf(store, modelId)).slice(0, 2)).toEqual(before.slice(0, 2));
  });

  it('moves the nesting with a Contains end, and warns about a second container', async () => {
    const { service, modelId } = await setup();
    // silo contains pump; with the barn as its source, the pump is nested in the barn.
    const moved = await service.updateRelationship(
      modelId,
      'r2',
      { version: 1, source: 'barn' },
      modeller,
    );
    expect(moved.nestingChanges).toEqual([{ elementId: 'pump', containerId: 'barn' }]);
    expect(moved.warnings).toEqual([]);
    // barn contains silo; with the tractor as its target the silo is no longer nested, and the
    // tractor is.
    const retargeted = await service.updateRelationship(
      modelId,
      'r1',
      { version: 1, target: 'tractor' },
      modeller,
    );
    expect(retargeted.nestingChanges).toEqual([
      { elementId: 'silo', containerId: null },
      { elementId: 'tractor', containerId: 'barn' },
    ]);
    // The silo contains the tractor too: a second container is allowed, with a warning, and the
    // first Contains in the model's order still holds it. The pump, left by r2, is no longer
    // nested.
    const second = await service.updateRelationship(
      modelId,
      'r2',
      { version: 2, source: 'silo', target: 'tractor' },
      modeller,
    );
    expect(second.nestingChanges).toEqual([{ elementId: 'pump', containerId: null }]);
    expect(second.warnings.map((issue) => issue.code)).toEqual(['multiple-containers']);
  });
});

describe('RelationshipService: delete', () => {
  it('deletes one relationship, un-nesting its target, with one audit row', async () => {
    const { store, service, modelId } = await setup();
    const result = await service.deleteRelationship(modelId, 'r2', { version: '1' }, modeller);
    expect(result).toEqual({
      id: 'r2',
      nestingChanges: [{ elementId: 'pump', containerId: null }],
    });
    expect((await edgesOf(store, modelId)).map((edge) => edge.id)).toEqual(['r1', 'r3', undefined]);
    expect((await store.list())[0]?.edgeCount).toBe(3);
    expect(await audit()).toMatchObject([
      { action: 'relationship-deleted', relationship_id: 'r2', details: { fields: [] } },
    ]);
    // A new relationship still goes last, after the gap.
    const added = await service.addRelationship(
      modelId,
      { source: 'farmer', target: 'barn', type: 'Relation' },
      modeller,
    );
    expect((await edgesOf(store, modelId)).at(-1)?.id).toBe(added.relationship.id);
  });

  it('refuses a stale or missing version and stores nothing', async () => {
    const { store, service, modelId } = await setup();
    await expect(
      service.deleteRelationship(modelId, 'r2', { version: 2 }, modeller),
    ).rejects.toThrow(ConflictError);
    await rejection(service.deleteRelationship(modelId, 'r2', {}, modeller));
    expect(await edgesOf(store, modelId)).toHaveLength(4);
    expect(await audit()).toEqual([]);
  });
});

describe('RelationshipService: with elements and stores', () => {
  it('keeps relationship versions apart from element versions and survives element deletes', async () => {
    const { store, service, modelId } = await setup();
    const elements = new ElementService(store);
    await elements.updateElement(modelId, 'pump', { version: 1, name: 'Water pump' }, modeller);
    expect((await service.getRelationship(modelId, 'r2')).relationship.version).toBe(1);
    await elements.deleteElement(modelId, 'pump', { version: 2 }, modeller);
    await expect(service.getRelationship(modelId, 'r2')).rejects.toMatchObject({
      what: 'relationship',
    });
    const document = await store.get(modelId);
    expect(validateJgf(document).valid).toBe(true);
  });

  it('adds the first relationship to a model without an edges list', async () => {
    const { store, service, modelId } = await setup({
      model: {
        graph: {
          nodes: {
            a: { label: 'A', metadata: { type: 'Other' } },
            b: { label: 'B', metadata: { type: 'Other' } },
          },
        },
      },
    });
    await service.addRelationship(
      modelId,
      { source: 'a', target: 'b', type: 'Contains' },
      modeller,
    );
    expect(await edgesOf(store, modelId)).toHaveLength(1);
  });

  it('is unavailable without a database', async () => {
    const files = await FileModelStore.open(tempDataDir(), { log: { warn: () => undefined } });
    const service = new RelationshipService(files);
    await expect(service.getRelationship('x', 'y')).rejects.toThrow(EditingUnavailableError);
    await expect(service.addRelationship('x', {}, modeller)).rejects.toThrow(
      EditingUnavailableError,
    );
  });
});

describe('a label on a stored model', () => {
  const longLabel = 'y'.repeat(250);
  const withLong = (): JgfDocument => ({
    graph: {
      ...farm.graph,
      edges: (farm.graph.edges ?? []).map((edge) =>
        edge.id === 'r3' ? { ...edge, label: longLabel } : edge,
      ),
    },
  });

  it('keeps an imported label over 200 characters until it is changed', async () => {
    const { store, service, modelId } = await setup({ model: withLong() });
    // Another field changes: the label stays and nothing is refused.
    const other_ = await service.updateRelationship(
      modelId,
      'r3',
      { version: 1, architectureState: 'Target' },
      modeller,
    );
    expect(other_.relationship.edge.label).toBe(longLabel);
    // The same text sent back is no change either.
    const same = await service.updateRelationship(
      modelId,
      'r3',
      { version: other_.relationship.version, label: longLabel },
      modeller,
    );
    expect(same.relationship.version).toBe(other_.relationship.version);
    // Another long text is refused, and the stored label stays.
    const refused = await rejection(
      service.updateRelationship(
        modelId,
        'r3',
        { version: same.relationship.version, label: `${longLabel}z` },
        modeller,
      ),
    );
    expect(refused.fields.map((issue) => issue.field)).toEqual(['label']);
    expect((await edgesOf(store, modelId))[2]?.label).toBe(longLabel);
    const shorter = await service.updateRelationship(
      modelId,
      'r3',
      { version: same.relationship.version, label: 'Short' },
      modeller,
    );
    expect(shorter.relationship.edge.label).toBe('Short');
  });

  it('leaves a model that still validates after setting and removing a label', async () => {
    const { store, service, modelId } = await setup();
    const unusual = '<b>"quoted"</b> \n tab\t ünï 🚜';
    const set = await service.updateRelationship(
      modelId,
      'r3',
      { version: 1, label: unusual },
      modeller,
    );
    let stored = await store.get(modelId);
    expect(validateJgf(stored).errors).toEqual([]);
    await service.updateRelationship(
      modelId,
      'r3',
      { version: set.relationship.version, label: '  ' },
      modeller,
    );
    stored = await store.get(modelId);
    expect(validateJgf(stored).errors).toEqual([]);
    expect(stored?.graph.edges?.find((edge) => edge.id === 'r3')).not.toHaveProperty('label');
  });

  it('refuses a NUL character in a label, without touching the model', async () => {
    const { store, service, modelId } = await setup();
    await expect(
      service.updateRelationship(modelId, 'r3', { version: 1, label: 'a\u0000b' }, modeller),
    ).rejects.toThrow(/can't be stored/);
    expect((await edgesOf(store, modelId))[2]?.label).toBe('Reads the level');
    expect((await audit()).filter((row) => row.action === 'relationship-updated')).toEqual([]);
  });
});

describe('RelationshipService: custom metadata', () => {
  it('adds, changes and removes values, and audits the field names, never the values', async () => {
    const { service, modelId } = await setup();
    const added = await service.updateRelationship(
      modelId,
      'r3',
      { version: 1, metadata: { protocol: 'REST', auth: 'OAuth' } },
      modeller,
    );
    expect(added.relationship.version).toBe(2);
    expect(added.relationship.edge.metadata).toEqual({
      // Read from the stored Information flow and label, as every model is read now.
      requestData: ['Reads the level'],
      protocol: 'REST',
      auth: 'OAuth',
    });

    const changed = await service.updateRelationship(
      modelId,
      'r3',
      { version: 2, metadata: { protocol: 'gRPC', auth: null } },
      modeller,
    );
    expect(changed.relationship.edge.metadata).toEqual({
      requestData: ['Reads the level'],
      protocol: 'gRPC',
    });

    const rows = (await audit()).filter((row) => row.relationship_id === 'r3');
    expect(rows.map((row) => row.details.fields)).toEqual([
      ['metadata.protocol', 'metadata.auth'],
      ['metadata.protocol', 'metadata.auth'],
    ]);
    expect(JSON.stringify(rows)).not.toContain('REST');
    expect(JSON.stringify(rows)).not.toContain('gRPC');
  });

  it('refuses keys with their own field, reserved keys and values that are not text', async () => {
    const { service, modelId } = await setup();
    const refusal = async (metadata: unknown) =>
      (
        await rejection(
          service.updateRelationship(modelId, 'r3', { version: 1, metadata }, modeller),
        )
      ).fields;
    expect(await refusal({ architectureState: 'Target' })).toEqual([
      expect.objectContaining({ field: 'metadata.architectureState' }),
    ]);
    expect(await refusal({ description: 'Made-up' })).toEqual([
      expect.objectContaining({ field: 'metadata.description' }),
    ]);
    expect(await refusal({ type: 'Made-up' })).toEqual([
      expect.objectContaining({ message: expect.stringContaining('reserved') as string }),
    ]);
    expect(await refusal({ 'simplearchitecture:stored': 'x' })).toHaveLength(1);
    expect(await refusal(JSON.parse('{"__proto__": "x"}'))).toHaveLength(1);
    expect(await refusal({ ' ': 'x' })).toHaveLength(1);
    expect(await refusal({ protocol: 5 })).toEqual([
      { field: 'metadata.protocol', message: 'Must be text.' },
    ]);
    expect(await refusal({ protocol: 'x'.repeat(2001) })).toEqual([
      expect.objectContaining({ field: 'metadata.protocol' }),
    ]);
    expect(
      await refusal(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, 'x']))),
    ).toHaveLength(1);
  });

  it('lets a stored list go back unchanged, keeps other keys, and gives the usual conflict', async () => {
    const edges = (farm.graph.edges ?? []).map((edge) =>
      edge.id === 'r3'
        ? { ...edge, metadata: { protocols: ['REST', 'gRPC'], owner: 'Made-up' } }
        : edge,
    );
    const { service, modelId } = await setup({ model: { graph: { ...farm.graph, edges } } });
    const same = await service.updateRelationship(
      modelId,
      'r3',
      { version: 1, metadata: { protocols: ['REST', 'gRPC'], auth: 'OAuth' } },
      modeller,
    );
    expect(same.relationship.edge.metadata).toEqual({
      protocols: ['REST', 'gRPC'],
      owner: 'Made-up',
      auth: 'OAuth',
    });
    await expect(
      service.updateRelationship(modelId, 'r3', { version: 1, metadata: { auth: 'x' } }, modeller),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('custom metadata at the edges of the rules', () => {
  it('stores odd keys as plain data, touching no prototype', async () => {
    const { service, store, modelId } = await setup();
    const metadata = {
      constructor: 'a',
      toString: 'b',
      hasOwnProperty: 'c',
      prototype: 'd',
      'a.b': 'e',
    };
    const { relationship } = await service.updateRelationship(
      modelId,
      'r3',
      { version: 1, metadata },
      modeller,
    );
    expect(relationship.edge.metadata).toEqual({ requestData: ['Reads the level'], ...metadata });
    const edge = (await edgesOf(store, modelId)).find((e) => e.id === 'r3');
    expect(edge?.metadata).toEqual({ requestData: ['Reads the level'], ...metadata });
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(typeof {}.toString).toBe('function');
    // A second change finds the odd key as its own value, not as an inherited member.
    const again = await service.updateRelationship(
      modelId,
      'r3',
      { version: 2, metadata: { constructor: 'a' } },
      modeller,
    );
    expect(again.relationship.version).toBe(2);
    const removed = await service.updateRelationship(
      modelId,
      'r3',
      { version: 2, metadata: { valueOf: null } },
      modeller,
    );
    expect(removed.relationship.version).toBe(2);
  });

  it('refuses __proto__ at any level, and values that are not text, with nothing stored', async () => {
    const { service, store, modelId } = await setup();
    const before = await edgesOf(store, modelId);
    const refused = async (json: string) =>
      (
        await rejection(
          service.updateRelationship(
            modelId,
            'r3',
            { version: 1, metadata: JSON.parse(json) as unknown },
            modeller,
          ),
        )
      ).fields;
    expect(await refused('{"__proto__": {"polluted": true}}')).toEqual([
      { field: 'metadata.__proto__', message: 'This property name is reserved.' },
    ]);
    expect(await refused('{"a": {"__proto__": {"polluted": true}}}')).toEqual([
      { field: 'metadata.a', message: 'Must be text.' },
    ]);
    for (const value of ['true', '1', '["x"]', '{"x":"y"}']) {
      expect(await refused(`{"a": ${value}}`)).toEqual([
        { field: 'metadata.a', message: 'Must be text.' },
      ]);
    }
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(await edgesOf(store, modelId)).toEqual(before);
    expect(await audit()).toEqual([]);
  });

  it('holds the limits exactly, and refuses reserved keys for removal as well', async () => {
    const { service, modelId } = await setup();
    const key = 'k'.repeat(100);
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, 'x']));
    const ok = await service
      .updateRelationship(
        modelId,
        'r3',
        { version: 1, metadata: { ...many, [key]: 'x'.repeat(2000) } },
        modeller,
      )
      .catch((error: unknown) => error);
    // 101 entries: the cap applies to the whole change.
    expect(ok).toBeInstanceOf(RejectedError);
    const fine = await service.updateRelationship(
      modelId,
      'r3',
      { version: 1, metadata: { [key]: 'x'.repeat(2000) } },
      modeller,
    );
    expect(fine.relationship.version).toBe(2);
    const hundred = await service.updateRelationship(
      modelId,
      'r3',
      { version: 2, metadata: many },
      modeller,
    );
    expect(hundred.relationship.version).toBe(3);
    for (const metadata of [
      { [`${key}k`]: 'x' },
      { type: null },
      { description: null },
      { architectureState: null },
      { 'simplearchitecture:stored': null },
    ]) {
      await expect(
        service.updateRelationship(modelId, 'r3', { version: 3, metadata }, modeller),
      ).rejects.toBeInstanceOf(RejectedError);
    }
  });

  it('takes a key with spaces around it as a key of its own, so it overwrites nothing', async () => {
    const edges = (farm.graph.edges ?? []).map((edge) =>
      edge.id === 'r3' ? { ...edge, metadata: { description: 'Made-up' } } : edge,
    );
    const { service, modelId } = await setup({ model: { graph: { ...farm.graph, edges } } });
    const { relationship } = await service.updateRelationship(
      modelId,
      'r3',
      { version: 1, metadata: { ' description ': 'x' } },
      modeller,
    );
    expect(relationship.edge.metadata).toEqual({ description: 'Made-up', ' description ': 'x' });
  });

  it('refuses a NUL or half a character in a value or a key, without touching the model', async () => {
    const { service, store, modelId } = await setup();
    const before = await edgesOf(store, modelId);
    for (const metadata of [{ a: 'x\u0000y' }, { 'x\u0000y': 'a' }, { a: 'x\ud83dy' }]) {
      await expect(
        service.updateRelationship(modelId, 'r3', { version: 1, metadata }, modeller),
      ).rejects.toBeInstanceOf(ModelNotStorableError);
    }
    expect(await edgesOf(store, modelId)).toEqual(before);
    expect(await audit()).toEqual([]);
  });

  it('checks the version before anything else, and an unchanged value makes no version or row', async () => {
    const { service, modelId } = await setup();
    await service.updateRelationship(modelId, 'r3', { version: 1, metadata: { a: 'x' } }, modeller);
    const rows = (await audit()).length;
    await expect(
      service.updateRelationship(modelId, 'r3', { version: 1, metadata: { a: 5 } }, modeller),
    ).rejects.toBeInstanceOf(ConflictError);
    const same = await service.updateRelationship(
      modelId,
      'r3',
      { version: 2, metadata: { a: 'x', gone: null } },
      modeller,
    );
    expect(same.relationship.version).toBe(2);
    expect(await audit()).toHaveLength(rows);
  });

  it('leaves a stored number, boolean and label alone when other keys change', async () => {
    const edges = (farm.graph.edges ?? []).map((edge) =>
      edge.id === 'r3'
        ? { ...edge, label: 'Made-up', metadata: { count: 3, on: false, nothing: null } }
        : edge,
    );
    const { service, modelId } = await setup({ model: { graph: { ...farm.graph, edges } } });
    const { relationship } = await service.updateRelationship(
      modelId,
      'r3',
      { version: 1, metadata: { count: 3, on: false, extra: 'x' } },
      modeller,
    );
    expect(relationship.edge.label).toBe('Made-up');
    expect(relationship.edge.metadata).toEqual({
      count: 3,
      on: false,
      nothing: null,
      extra: 'x',
    });
  });
});
