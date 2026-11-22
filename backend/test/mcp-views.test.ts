import type { JgfDocument, ViewSummary } from '@simplearchitecture/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpReadService, ToolError } from '../src/mcp/read-service.js';
import type { ModelStore, ViewRecord } from '../src/storage/model-store.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { ViewService } from '../src/views/view-service.js';
import { createTestDb, resetTestDb, type TestDb } from './pglite.js';

// The view tools' service on its own: a view read while the model changed under it.

const author = { id: 'oid-seed', name: 'Made-up Seeder' };

/** A made-up bakery: an oven that bakes bread, and a baker. */
const bakery: JgfDocument = {
  graph: {
    label: 'Made-up bakery',
    nodes: {
      oven: { label: 'Oven', metadata: { type: 'Infrastructure' } },
      bread: { label: 'Bread', metadata: { type: 'Business', mood: 'Crusty' } },
      baker: { label: 'Baker', metadata: { type: 'Stakeholder', stakeholderKind: 'AI Agent' } },
    },
    edges: [
      { id: 'b1', source: 'oven', target: 'bread', relation: 'Relation' },
      { id: 'b2', source: 'baker', target: 'oven', relation: 'Relation' },
    ],
  },
};

const summary: ViewSummary = {
  id: '6c0a4b1e-0000-4000-8000-00000000a1a1',
  name: 'Made-up morning',
  folder: null,
  version: 3,
  elementCount: 4,
  relationshipCount: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: author,
  updatedAt: '2026-01-02T00:00:00.000Z',
  updatedBy: author,
};

let db: TestDb;
let store: PostgresModelStore;
let modelId: string;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetTestDb(db);
  store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
  modelId = (await store.save(bakery, author)).id;
});

/** The service, with views as a stub store reads them: `record` for every view asked for. */
function serviceWith(record: ViewRecord | 'no-model' | 'no-view'): McpReadService {
  const views = {
    list: async () => (record === 'no-model' ? undefined : [summary]),
    get: async () => record,
  };
  const viewStore = { views } as unknown as ModelStore;
  return new McpReadService(store, undefined, new ViewService(viewStore));
}

describe('get_view against the model as it is now', () => {
  it('leaves out ids the model no longer has, and counts them', async () => {
    const service = serviceWith({
      summary,
      elementIds: ['oven', 'gone', 'bread', 'baker'],
      relationshipIds: ['b1', 'lost', 'b2'],
      layout: [],
      routes: [],
      groupBy: 'mood',
    });
    expect(await service.view(modelId, summary.id)).toEqual({
      id: summary.id,
      name: 'Made-up morning',
      groupBy: { key: 'mood', label: 'mood' },
      version: 3,
      updatedAt: '2026-01-02T00:00:00.000Z',
      elements: [
        { id: 'oven', name: 'Oven', type: 'Infrastructure' },
        { id: 'bread', name: 'Bread', type: 'Business' },
        { id: 'baker', name: 'Baker', type: 'Stakeholder', stakeholderKind: 'AI Agent' },
      ],
      relationships: [
        {
          id: 'b1',
          type: 'Relation',
          architectureState: 'Current',
          source: 'oven',
          target: 'bread',
        },
        {
          id: 'b2',
          type: 'Relation',
          architectureState: 'Current',
          source: 'baker',
          target: 'oven',
        },
      ],
      missing: { elements: 1, relationships: 1 },
    });
  });

  it('says nothing is missing when every id is in the model', async () => {
    const service = serviceWith({
      summary,
      elementIds: ['oven'],
      relationshipIds: [],
      layout: [],
      routes: [],
      groupBy: null,
    });
    const view = await service.view(modelId, summary.id);
    expect(view).not.toHaveProperty('missing');
    expect(view).not.toHaveProperty('groupBy');
    expect(view).not.toHaveProperty('folder');
  });

  it('refuses a view or a model the store no longer has with a tool error', async () => {
    await expect(serviceWith('no-view').view(modelId, summary.id)).rejects.toThrow(
      new ToolError('View not found in this model. Use list_views for the ids.'),
    );
    await expect(serviceWith('no-model').view(modelId, summary.id)).rejects.toThrow(
      new ToolError('Model not found. Use list_models for the ids.'),
    );
    await expect(serviceWith('no-model').listViews(modelId)).rejects.toThrow(
      new ToolError('Model not found. Use list_models for the ids.'),
    );
  });
});
