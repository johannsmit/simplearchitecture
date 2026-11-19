import { PGlite } from '@electric-sql/pglite';
import {
  buildModelGraph,
  relationshipViewFields,
  type JgfDocument,
  type ModelAuthor,
} from '@simplearchitecture/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import type { RejectedError } from '../src/editing/common.js';
import { RelationshipService } from '../src/editing/relationship-service.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { pgliteDb, type TestDb } from './pglite.js';

// Relation and Contains, and the retired Information flow refused when editing. Made-up data.

const author: ModelAuthor = { id: 'oid-29', name: 'Made-up Modeller' };

const nodes = {
  a: { label: 'A', metadata: { type: 'Application' } },
  b: { label: 'B', metadata: { type: 'Application' } },
  c: { label: 'C', metadata: { type: 'Infrastructure' } },
};

describe('the fields Show Viewpoints offers', () => {
  const withEdge = (relation: string, metadata: Record<string, unknown>) => ({
    graph: { nodes, edges: [{ id: 'e', source: 'a', target: 'b', relation, metadata }] },
  });

  it('is offered whenever the model has a Relation, and only then', () => {
    const fields = (document: JgfDocument) =>
      relationshipViewFields(buildModelGraph(document)).map((field) => field.label);
    const standard = ['Architecture state', 'Data', 'Identity', 'Identity Context'];
    expect(fields(withEdge('Relation', {}))).toEqual(standard);
    expect(fields(withEdge('Contains', {}))).toEqual([]);
    expect(fields(withEdge('Relation', { zone: 'x', sourceToTargetData: 'y' }))).toEqual([
      ...standard,
      'zone',
    ]);
  });
});

describe('RelationshipService: Information flow is gone', () => {
  let db: TestDb;
  const model: JgfDocument = {
    graph: {
      nodes,
      edges: [
        {
          id: 'flow',
          source: 'a',
          target: 'b',
          relation: 'Relation',
          directed: false,
          label: 'Orders',
          metadata: { informationFlow: true, zone: 'x' },
        },
        { id: 'plain', source: 'a', target: 'c', relation: 'Relation' },
        { id: 'holds', source: 'c', target: 'b', relation: 'Contains' },
      ],
    },
  };

  beforeAll(async () => {
    db = pgliteDb(new PGlite());
    await migrate(db, loadMigrations());
  });

  afterAll(async () => {
    await db.close();
  });

  const setup = async () => {
    await db.exec(
      'truncate models, elements, relationships, views, view_elements, view_relationships, audit',
    );
    const store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
    const { id } = await store.save(model, author);
    return { service: new RelationshipService(store), id };
  };
  const refused = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => (error as RejectedError).fields,
    );

  it('adds several Relations between the same two elements', async () => {
    const { service, id } = await setup();
    const ends = { source: 'a', target: 'b', type: 'Relation' };
    await expect(service.addRelationship(id, ends, author)).resolves.toBeDefined();
    await expect(service.addRelationship(id, ends, author)).resolves.toBeDefined();
  });

  it('refuses it as a field, and as a custom key', async () => {
    const { service, id } = await setup();
    const asField = await refused(
      service.addRelationship(
        id,
        { source: 'a', target: 'c', type: 'Relation', informationFlow: true },
        author,
      ),
    );
    expect(asField?.map((issue) => issue.field)).toEqual(['informationFlow']);
    expect(
      (
        await refused(
          service.updateRelationship(id, 'plain', { version: 1, informationFlow: true }, author),
        )
      )?.map((issue) => issue.field),
    ).toEqual(['informationFlow']);
    for (const value of [true, 'yes', null]) {
      expect(
        await refused(
          service.updateRelationship(
            id,
            'plain',
            { version: 1, metadata: { informationFlow: value } },
            author,
          ),
        ),
      ).toEqual([{ field: 'metadata.informationFlow', message: 'This key is reserved.' }]);
    }
  });

  it('reads a stored yes with a label as Source to target data, and a change to Contains removes it', async () => {
    const { service, id } = await setup();
    const read = await service.getRelationship(id, 'flow');
    expect(read.relationship.edge.metadata).toEqual({ zone: 'x', sourceToTargetData: ['Orders'] });
    const result = await service.updateRelationship(
      id,
      'flow',
      { version: 1, type: 'Contains' },
      author,
    );
    expect(result.relationship.edge.metadata).toEqual({ zone: 'x' });
    expect(result.warnings.map((issue) => issue.code)).toEqual(['multiple-containers']);
  });
});
