import { randomUUID } from 'node:crypto';
import {
  storedModelKey,
  type JgfDocument,
  type ModelAuthor,
  type ModelSummary,
} from '@simplearchitecture/shared';
import type { Db, Queryable } from '../db/db.js';
import { convertOlderTypes } from '../jgf/older-types.js';
import { validateJgf } from '../jgf/validate.js';
import { maxModelFileBytes, maxStoredModels, modelReadConcurrency } from '../limits.js';
import {
  isModelId,
  ModelNotStorableError,
  type AppliedElementChange,
  type EditableModel,
  type ElementStore,
  type PlannedElementChange,
  ModelStoreFullError,
  ModelTooLargeError,
  ModelUnreadableError,
  type DeletedModel,
  type ModelStore,
  type ViewStore,
} from './model-store.js';
import { PostgresViewStore } from './postgres-view-store.js';
import {
  isPlainObject,
  mapLimited,
  newestFirst,
  newSummary,
  recordedSummary,
  storedDocument,
  unstorable,
  type StoreLogger,
} from './stored-model.js';

export interface PostgresModelStoreOptions {
  log: StoreLogger;
  /** Clock for `createdAt` (tests). */
  now?: () => number;
  /** Most models the store holds (tests). Default: maxStoredModels. */
  maxModels?: number;
  /** Largest stored model as JSON, in bytes (tests). Default: maxModelFileBytes, as for files. */
  maxModelBytes?: number;
}

type Json = Record<string, unknown>;

interface ModelRow {
  id: string;
  name: string;
  created_at: string;
  created_by_id: string;
  created_by_name: string;
  node_count: number;
  edge_count: number;
  source_id: string | null;
  version: number;
}

interface FullModelRow extends ModelRow {
  graph: Json;
  metadata: Json;
  has_nodes: boolean;
  has_edges: boolean;
  /** [id, type, label, metadata, extra, version] per element, in order. */
  elements: [string, string | null, string | null, Json | null, Json | null, number][];
  /** [id, source, target, relation, directed, label, metadata, extra, version] per relationship. */
  relationships: [
    string | null,
    string | null,
    string | null,
    string | null,
    boolean | null,
    string | null,
    Json | null,
    Json | null,
    number,
  ][];
}

interface ElementRow {
  id: string;
  ordinal: number;
  type?: string;
  label?: string;
  metadata?: Json;
  extra?: Json;
}

interface RelationshipRow {
  ordinal: number;
  id?: string;
  source?: string;
  target?: string;
  relation?: string;
  directed?: boolean;
  label?: string;
  metadata?: Json;
  extra?: Json;
}

interface ModelRows {
  graph: Json;
  metadata: Json;
  hasNodes: boolean;
  hasEdges: boolean;
  elements: ElementRow[];
  relationships: RelationshipRow[];
}

interface CacheEntry {
  version: number;
  /** Undefined when the model is damaged (already logged). */
  summary: ModelSummary | undefined;
}

type ReadResult =
  { ok: true; document: JgfDocument; summary: ModelSummary } | { ok: false; reason: string };

const summaryColumns =
  'id, name, created_at, created_by_id, created_by_name, node_count, edge_count, source_id, version';

// Saves take turns across every API process (any fixed number would do).
const saveLock = 4_120_002;

const loadModel = `select ${summaryColumns}, graph, metadata, has_nodes, has_edges,
  coalesce((select jsonb_agg(jsonb_build_array(e.id, e.type, e.label, e.metadata, e.extra,
                e.version)
              order by e.ordinal)
            from elements e where e.model_id = m.id), '[]'::jsonb) as elements,
  coalesce((select jsonb_agg(jsonb_build_array(r.id, r.source, r.target, r.relation, r.directed,
                r.label, r.metadata, r.extra, r.version) order by r.ordinal)
            from relationships r where r.model_id = m.id), '[]'::jsonb) as relationships
  from models m where m.id = $1::uuid`;

const insertModel = `insert into models (id, name, created_at, created_by_id, created_by_name,
  node_count, edge_count, source_id, graph, metadata, has_nodes, has_edges)
  values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10::text::jsonb, $11, $12)
  on conflict (id) do nothing returning id`;

// One statement per table, whatever the size: the rows travel as one JSON parameter.
const insertElements = `insert into elements (model_id, id, ordinal, type, label, metadata, extra)
  select $1::uuid, x.id, x.ordinal, x.type, x.label, x.metadata, x.extra
  from jsonb_to_recordset($2::text::jsonb)
    as x(id text, ordinal integer, type text, label text, metadata jsonb, extra jsonb)`;

const insertRelationships = `insert into relationships (model_id, ordinal, id, source, target,
  relation, directed, label, metadata, extra)
  select $1::uuid, x.ordinal, x.id, x.source, x.target, x.relation, x.directed, x.label,
    x.metadata, x.extra
  from jsonb_to_recordset($2::text::jsonb)
    as x(ordinal integer, id text, source text, target text, relation text, directed boolean,
      label text, metadata jsonb, extra jsonb)`;

// Element changes hold the model's row lock, so changes to one model take turns, and a delete of
// the model waits for them. A read shares the lock, so it sees a model and its versions as one.
const lockModelForChange = 'select version from models where id = $1::uuid for update';
const lockModelForRead = 'select version from models where id = $1::uuid for share';

const updateElement = `update elements set type = $3, label = $4, metadata = $5::text::jsonb,
  extra = $6::text::jsonb, version = version + 1
  where model_id = $1::uuid and id = $2 returning version`;

// A new element goes last, so the model's order is kept.
const addElement = `insert into elements (model_id, id, ordinal, type, label, metadata, extra)
  select $1::uuid, $2, coalesce(max(ordinal), -1) + 1, $3, $4, $5::text::jsonb, $6::text::jsonb
  from elements where model_id = $1::uuid returning version`;

const updateRelationship = `update relationships set source = $3, target = $4, relation = $5,
  directed = $6, label = $7, metadata = $8::text::jsonb, extra = $9::text::jsonb,
  version = version + 1
  where model_id = $1::uuid and id = $2 returning version`;

// A new relationship goes last, so the model's order is kept. A relationship's ordinal never
// changes while it exists: views refer to it by its ordinal (migration 010).
const addRelationship = `insert into relationships (model_id, ordinal, id, source, target,
  relation, directed, label, metadata, extra)
  select $1::uuid, coalesce(max(ordinal), -1) + 1, $2, $3, $4, $5, $6, $7, $8::text::jsonb,
    $9::text::jsonb
  from relationships where model_id = $1::uuid returning version`;

const deleteRelationshipsOf = `delete from relationships
  where model_id = $1::uuid and (source = $2 or target = $2) returning ordinal, id`;

const touchModel = `update models set
  node_count = (select count(*)::int from elements where model_id = $1::uuid),
  edge_count = (select count(*)::int from relationships where model_id = $1::uuid),
  has_nodes = has_nodes or $2::boolean, has_edges = has_edges or $3::boolean,
  version = version + 1
  where id = $1::uuid returning ${summaryColumns}`;

const insertAudit = `insert into audit (action, user_id, user_name, model_id, element_id,
  relationship_id, details)
  values ($1, $2, $3, $4::uuid, $5, $6, $7::text::jsonb)`;

const jsonOrNull = (value: Json | undefined): string | null =>
  value === undefined ? null : JSON.stringify(value);

/** False when any key or text in the document can't be stored. Walks without recursion. */
function isStorable(document: unknown): boolean {
  const stack: unknown[] = [document];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') {
      if (unstorable.test(value)) return false;
    } else if (Array.isArray(value)) {
      for (const item of value as unknown[]) stack.push(item);
    } else if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (unstorable.test(key)) return false;
        stack.push(child);
      }
    }
  }
  return true;
}

/** Object entries of `extra`, or none. */
const entriesOf = (extra: Json | null): [string, unknown][] => Object.entries(extra ?? {});

const nonEmpty = (extra: Json): Json | undefined =>
  Object.keys(extra).length > 0 ? extra : undefined;

function elementRow(id: string, node: Json, ordinal: number): ElementRow {
  const { label, metadata, ...extra } = node;
  const row: ElementRow = { id, ordinal };
  if (typeof label === 'string') row.label = label;
  else if (label !== undefined) extra.label = label;
  if (isPlainObject(metadata)) {
    const { type, ...rest } = metadata;
    if (typeof type === 'string') {
      row.type = type;
      row.metadata = rest;
    } else {
      row.metadata = metadata;
    }
  } else if (metadata !== undefined) {
    extra.metadata = metadata;
  }
  const others = nonEmpty(extra);
  if (others) row.extra = others;
  return row;
}

function relationshipRow(edge: Json, ordinal: number): RelationshipRow {
  const { id, source, target, relation, directed, label, metadata, ...extra } = edge;
  const row: RelationshipRow = { ordinal };
  const text = { id, source, target, relation, label };
  for (const [key, value] of Object.entries(text)) {
    if (typeof value === 'string') row[key as keyof typeof text] = value;
    else if (value !== undefined) extra[key] = value;
  }
  if (typeof directed === 'boolean') row.directed = directed;
  else if (directed !== undefined) extra.directed = directed;
  if (isPlainObject(metadata)) row.metadata = metadata;
  else if (metadata !== undefined) extra.metadata = metadata;
  const others = nonEmpty(extra);
  if (others) row.extra = others;
  return row;
}

/**
 * Splits a stored document into rows. Nodes and edges that aren't JGF-shaped (a damaged model)
 * stay in the graph's own JSON as they are, so nothing is lost.
 */
function toRows(stored: JgfDocument): ModelRows {
  const graph: Json = { ...stored.graph };
  const { nodes, edges, metadata } = graph;
  delete graph.id;
  delete graph.nodes;
  delete graph.edges;
  delete graph.metadata;
  const hasNodes = isPlainObject(nodes) && Object.values(nodes).every(isPlainObject);
  const hasEdges = Array.isArray(edges) && edges.every(isPlainObject);
  if (!hasNodes && nodes !== undefined) graph.nodes = nodes;
  if (!hasEdges && edges !== undefined) graph.edges = edges;
  const clientMetadata = Object.fromEntries(
    Object.entries(isPlainObject(metadata) ? metadata : {}).filter(
      ([key]) => key !== storedModelKey,
    ),
  );
  return {
    graph,
    metadata: clientMetadata,
    hasNodes,
    hasEdges,
    elements: hasNodes
      ? Object.entries(nodes as Record<string, Json>).map(([key, node], index) =>
          elementRow(key, node, index),
        )
      : [],
    relationships: hasEdges
      ? (edges as Json[]).map((edge, index) => relationshipRow(edge, index))
      : [],
  };
}

function summaryOf(row: ModelRow): ModelSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    createdBy: { id: row.created_by_id, name: row.created_by_name },
    nodeCount: row.node_count,
    edgeCount: row.edge_count,
    ...(row.source_id === null ? {} : { sourceId: row.source_id }),
  };
}

/** Rebuilds the stored JGF document from its rows. */
function documentOf(row: FullModelRow, summary: ModelSummary): JgfDocument {
  const own = Object.entries(row.graph).filter(([key]) => key !== 'id' && key !== 'metadata');
  const parts: [string, unknown][] = [['id', row.id], ...own];
  if (row.has_nodes) {
    const nodes = row.elements.map(([id, type, label, metadata, extra]): [string, unknown] => {
      const node: [string, unknown][] = [];
      if (label !== null) node.push(['label', label]);
      if (type !== null) node.push(['metadata', { type, ...metadata }]);
      else if (metadata !== null) node.push(['metadata', metadata]);
      return [id, Object.fromEntries([...node, ...entriesOf(extra)])];
    });
    parts.push(['nodes', Object.fromEntries(nodes)]);
  }
  if (row.has_edges) {
    const names = ['id', 'source', 'target', 'relation', 'directed', 'label', 'metadata'];
    const edges = row.relationships.map((values) => {
      const extra = values[7];
      const fields = names.flatMap((name, index): [string, unknown][] =>
        values[index] === null ? [] : [[name, values[index]]],
      );
      return Object.fromEntries([...fields, ...entriesOf(extra)]);
    });
    parts.push(['edges', edges]);
  }
  parts.push([
    'metadata',
    Object.fromEntries([[storedModelKey, summary], ...entriesOf(row.metadata)]),
  ]);
  // Migrations 006, 009 and 012 converted the older edge types and properties. One still written by
  // an older API running during an upgrade reads converted too: its type isn't damage. Labels stay
  // as stored: 012 converted the older ones, and a `{Data}` typed since is an unknown name.
  return convertOlderTypes({ graph: Object.fromEntries(parts) }, { labels: false })
    .document as JgfDocument;
}

/**
 * Models in PostgreSQL: one row per model, plus one per element and per relationship. The
 * server-owned data are columns; everything else the JGF document holds is kept, so a model
 * reads back exactly as it was stored (objects compare equal; key order inside an object isn't
 * kept, the order of nodes and edges is).
 *
 * - A save is one transaction: a model is stored whole or not at all. Saves take turns (an
 *   advisory lock), so the cap holds across API processes too.
 * - A model is fully validated whenever it is read. One that fails is left out of the list
 *   and listed as damaged for Admins, never deleted or changed.
 * - The list keeps each model's validation result in memory, by model id and version, so each
 *   model is checked once per process.
 */
export class PostgresModelStore implements ModelStore {
  readonly #db: Db;
  readonly #log: StoreLogger;
  readonly #now: () => number;
  readonly #maxModels: number;
  readonly #maxBytes: number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly elements: ElementStore = {
    read: (modelId) => this.#readEditable(modelId),
    change: (modelId, plan) => this.#change(modelId, plan),
  };
  readonly views: ViewStore;

  private constructor(db: Db, options: PostgresModelStoreOptions) {
    this.#db = db;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
    this.#maxModels = options.maxModels ?? maxStoredModels;
    this.#maxBytes = options.maxModelBytes ?? maxModelFileBytes;
    this.views = new PostgresViewStore(db, this.#now);
  }

  /** Opens the store on a migrated database and checks every model once. */
  static async open(db: Db, options: PostgresModelStoreOptions): Promise<PostgresModelStore> {
    const store = new PostgresModelStore(db, options);
    await store.list();
    return store;
  }

  async list(): Promise<ModelSummary[]> {
    const entries = await this.#entries();
    return entries.flatMap((entry) => (entry.summary ? [entry.summary] : [])).sort(newestFirst);
  }

  async listDamaged(): Promise<string[]> {
    const entries = await this.#entries();
    return entries.flatMap((entry) => (entry.summary ? [] : [entry.id])).sort();
  }

  async get(id: string): Promise<JgfDocument | undefined> {
    if (!isModelId(id)) return undefined;
    const result = await this.#read(id);
    if (result === undefined) return undefined;
    if (!result.ok) throw new ModelUnreadableError(id, result.reason === 'invalid-model');
    return result.document;
  }

  async save(document: JgfDocument, createdBy: ModelAuthor): Promise<ModelSummary> {
    const summary = newSummary(randomUUID(), document, createdBy, this.#now());
    const stored = storedDocument(document, summary);
    // The same limit as a model file, so a model fits whichever store holds it.
    if (Buffer.byteLength(JSON.stringify(stored), 'utf8') > this.#maxBytes) {
      throw new ModelTooLargeError(this.#maxBytes);
    }
    if (!isStorable(stored)) throw new ModelNotStorableError();
    await this.#db.transaction(async (tx) => {
      await tx.query('select pg_advisory_xact_lock($1::bigint)', [saveLock]);
      await this.#checkRoom(tx);
      await this.#insert(tx, summary, toRows(stored));
    });
    this.#cache.set(summary.id, { version: 1, summary });
    return summary;
  }

  /**
   * Moves a model from the file store: keeps its id and stored data. Skips a model that is
   * already here. Throws as `save` does.
   */
  async importStored(document: JgfDocument): Promise<'imported' | 'exists'> {
    const id = document.graph.id ?? '';
    const summary = isModelId(id) ? recordedSummary(document, id) : undefined;
    if (summary === undefined) throw new Error('not a stored model');
    const stored = storedDocument(document, summary);
    if (Buffer.byteLength(JSON.stringify(stored), 'utf8') > this.#maxBytes) {
      throw new ModelTooLargeError(this.#maxBytes);
    }
    if (!isStorable(stored)) throw new ModelNotStorableError();
    return this.#db.transaction(async (tx) => {
      await tx.query('select pg_advisory_xact_lock($1::bigint)', [saveLock]);
      const [present] = await tx.query('select 1 from models where id = $1::uuid', [id]);
      if (present) return 'exists';
      await this.#checkRoom(tx);
      await this.#insert(tx, summary, toRows(stored));
      return 'imported';
    });
  }

  async delete(id: string): Promise<DeletedModel | undefined> {
    if (!isModelId(id)) return undefined;
    const [row] = await this.#db.query<ModelRow>(
      `select ${summaryColumns} from models where id = $1::uuid`,
      [id],
    );
    if (!row) return undefined;
    const entry = await this.#entry(row);
    // Elements and relationships go with it (on delete cascade).
    const deleted = await this.#db.query('delete from models where id = $1::uuid returning id', [
      id,
    ]);
    this.#cache.delete(id);
    if (deleted.length === 0) return undefined;
    return { id, summary: entry.summary };
  }

  async #readEditable(modelId: string): Promise<EditableModel | undefined> {
    if (!isModelId(modelId)) return undefined;
    return this.#db.transaction((tx) => this.#loadEditable(tx, modelId, lockModelForRead));
  }

  /**
   * One element or relationship change and its audit row, in one transaction (see
   * ElementStore.change).
   */
  async #change(
    modelId: string,
    plan: (model: EditableModel) => PlannedElementChange,
  ): Promise<AppliedElementChange | undefined> {
    if (!isModelId(modelId)) return undefined;
    const outcome = await this.#db.transaction(async (tx) => {
      const model = await this.#loadEditable(tx, modelId, lockModelForChange);
      if (model === undefined) return undefined;
      const { write, document, audit } = plan(model);
      if (Buffer.byteLength(JSON.stringify(document), 'utf8') > this.#maxBytes) {
        throw new ModelTooLargeError(this.#maxBytes);
      }
      let version: number | undefined;
      let deleted: { id: string | null }[] = [];
      if (write.kind === 'put-relationship') {
        if (!isStorable(write.relationshipId) || !isStorable(write.edge)) {
          throw new ModelNotStorableError();
        }
        const row = relationshipRow({ ...write.edge, id: write.relationshipId }, 0);
        const exists = model.relationshipVersionOf(write.relationshipId) !== undefined;
        const [written] = await tx.query<{ version: number }>(
          exists ? updateRelationship : addRelationship,
          [
            modelId,
            write.relationshipId,
            row.source ?? null,
            row.target ?? null,
            row.relation ?? null,
            row.directed ?? null,
            row.label ?? null,
            jsonOrNull(row.metadata),
            jsonOrNull(row.extra),
          ],
        );
        version = written?.version;
      } else if (write.kind === 'delete-relationship') {
        await tx.query('delete from relationships where model_id = $1::uuid and id = $2', [
          modelId,
          write.relationshipId,
        ]);
      } else if (write.kind === 'put') {
        if (!isStorable(write.elementId) || !isStorable(write.node)) {
          throw new ModelNotStorableError();
        }
        const row = elementRow(write.elementId, { ...write.node }, 0);
        const exists = model.versionOf(write.elementId) !== undefined;
        const [written] = await tx.query<{ version: number }>(exists ? updateElement : addElement, [
          modelId,
          write.elementId,
          row.type ?? null,
          row.label ?? null,
          jsonOrNull(row.metadata),
          jsonOrNull(row.extra),
        ]);
        version = written?.version;
      } else {
        const removed = await tx.query<{ ordinal: number; id: string | null }>(
          deleteRelationshipsOf,
          [modelId, write.elementId],
        );
        deleted = removed.sort((a, b) => a.ordinal - b.ordinal).map((edge) => ({ id: edge.id }));
        await tx.query('delete from elements where model_id = $1::uuid and id = $2', [
          modelId,
          write.elementId,
        ]);
      }
      const [updated] = await tx.query<ModelRow>(touchModel, [
        modelId,
        write.kind === 'put',
        write.kind === 'put-relationship',
      ]);
      const details =
        write.kind === 'delete'
          ? { fields: audit.fields, deletedRelationships: deleted.length }
          : { fields: audit.fields };
      await tx.query(insertAudit, [
        audit.action,
        audit.actor.id,
        audit.actor.name,
        modelId,
        'elementId' in write ? write.elementId : null,
        'relationshipId' in write ? write.relationshipId : null,
        JSON.stringify(details),
      ]);
      return { applied: { version, deletedRelationships: deleted }, updated };
    });
    if (outcome === undefined) return undefined;
    // The plan validated the model as it now is, so the list needn't check it again.
    if (outcome.updated) {
      this.#cache.set(modelId, {
        version: outcome.updated.version,
        summary: summaryOf(outcome.updated),
      });
    }
    return outcome.applied;
  }

  /** The model under `lock`, fully validated. Throws ModelUnreadableError when it is damaged. */
  async #loadEditable(tx: Queryable, id: string, lock: string): Promise<EditableModel | undefined> {
    const [locked] = await tx.query(lock, [id]);
    if (!locked) return undefined;
    const [row] = await tx.query<FullModelRow>(loadModel, [id]);
    if (!row) return undefined;
    let document: JgfDocument;
    try {
      document = documentOf(row, summaryOf(row));
    } catch {
      this.#log.warn({ modelId: id, reason: 'unreadable' }, 'stored model is damaged');
      throw new ModelUnreadableError(id);
    }
    const validation = validateJgf(document);
    if (!validation.valid) {
      this.#log.warn(
        { modelId: id, reason: 'invalid-model', errors: validation.errorCount },
        'stored model is damaged',
      );
      throw new ModelUnreadableError(id, true);
    }
    const versions = new Map(row.elements.map((element) => [element[0], element[5]]));
    // Edge ids are unique in a valid model; edges without one can't be edited.
    const relationshipVersions = new Map(
      row.relationships.flatMap((edge): [string, number][] =>
        typeof edge[0] === 'string' && edge[0] !== '' ? [[edge[0], edge[8]]] : [],
      ),
    );
    return {
      document,
      validation,
      versionOf: (elementId) => versions.get(elementId),
      relationshipVersionOf: (relationshipId) => relationshipVersions.get(relationshipId),
    };
  }

  async #checkRoom(tx: Queryable): Promise<void> {
    const [counted] = await tx.query<{ count: number }>(
      'select count(*)::int as count from models',
    );
    if ((counted?.count ?? 0) >= this.#maxModels) throw new ModelStoreFullError(this.#maxModels);
  }

  async #insert(tx: Queryable, summary: ModelSummary, rows: ModelRows): Promise<void> {
    await tx.query(insertModel, [
      summary.id,
      summary.name,
      summary.createdAt,
      summary.createdBy.id,
      summary.createdBy.name,
      summary.nodeCount,
      summary.edgeCount,
      summary.sourceId ?? null,
      JSON.stringify(rows.graph),
      JSON.stringify(rows.metadata),
      rows.hasNodes,
      rows.hasEdges,
    ]);
    if (rows.elements.length > 0) {
      await tx.query(insertElements, [summary.id, JSON.stringify(rows.elements)]);
    }
    if (rows.relationships.length > 0) {
      await tx.query(insertRelationships, [summary.id, JSON.stringify(rows.relationships)]);
    }
  }

  /** Every model's cache entry, checking new or changed models a few at a time. */
  async #entries(): Promise<(CacheEntry & { id: string })[]> {
    const rows = await this.#db.query<ModelRow>(`select ${summaryColumns} from models`);
    const present = new Set(rows.map((row) => row.id));
    for (const id of this.#cache.keys()) if (!present.has(id)) this.#cache.delete(id);
    const entries = await mapLimited(rows, modelReadConcurrency, (row) => this.#entry(row));
    return entries.map((entry, index) => ({ ...entry, id: rows[index]?.id ?? '' }));
  }

  async #entry(row: ModelRow): Promise<CacheEntry> {
    const cached = this.#cache.get(row.id);
    if (cached?.version === row.version) return cached;
    const result = await this.#read(row.id);
    const entry = { version: row.version, summary: result?.ok ? result.summary : undefined };
    this.#cache.set(row.id, entry);
    return entry;
  }

  /** Reads and fully validates one model. Undefined if there is none; problems are logged. */
  async #read(id: string): Promise<ReadResult | undefined> {
    const [row] = await this.#db.query<FullModelRow>(loadModel, [id]);
    if (!row) return undefined;
    const summary = summaryOf(row);
    let document: JgfDocument;
    try {
      document = documentOf(row, summary);
    } catch {
      this.#log.warn({ modelId: id, reason: 'unreadable' }, 'stored model is damaged');
      return { ok: false, reason: 'unreadable' };
    }
    const validation = validateJgf(document);
    if (!validation.valid) {
      this.#log.warn(
        { modelId: id, reason: 'invalid-model', errors: validation.errorCount },
        'stored model is damaged',
      );
      return { ok: false, reason: 'invalid-model' };
    }
    return { ok: true, document, summary };
  }
}
