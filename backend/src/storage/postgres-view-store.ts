import type { ViewSummary } from '@simplearchitecture/shared';
import type { Db, Queryable } from '../db/db.js';
import {
  isModelId,
  type PlannedViewChange,
  type RelationshipEnds,
  type ViewChangeState,
  type ViewLookup,
  type ViewRecord,
  type ViewStore,
} from './model-store.js';

/**
 * Views in PostgreSQL (migration 010): one row per view, plus one per element and per relationship
 * in it. The foreign keys keep views consistent with the model: deleting an element, a
 * relationship or the model removes it from every view in the same transaction. Ids travel as one
 * JSON parameter, whatever their number.
 */

interface ViewRow {
  id: string;
  name: string;
  version: number;
  created_at: Date | string;
  created_by_id: string;
  created_by_name: string;
  updated_at: Date | string;
  updated_by_id: string;
  updated_by_name: string;
  element_count: number;
  relationship_count: number;
}

interface FullViewRow extends ViewRow {
  element_ids: string[];
  relationship_ids: string[];
}

/** A row of the model joined with its views: without a view, every view column is null. */
type Joined<Row extends ViewRow> = Omit<Row, 'id'> & { id: string | null };

const present = <Row extends ViewRow>(row: Joined<Row>): row is Row => row.id !== null;

const viewColumns = `v.id, v.name, v.version, v.created_at, v.created_by_id, v.created_by_name,
  v.updated_at, v.updated_by_id, v.updated_by_name,
  (select count(*)::int from view_elements ve where ve.view_id = v.id) as element_count,
  (select count(*)::int from view_relationships vr where vr.view_id = v.id) as relationship_count`;

// Contents in the model's order.
const contentColumns = `
  coalesce((select jsonb_agg(ve.element_id order by e.ordinal)
            from view_elements ve
            join elements e on e.model_id = ve.model_id and e.id = ve.element_id
            where ve.view_id = v.id), '[]'::jsonb) as element_ids,
  coalesce((select jsonb_agg(r.id order by r.ordinal)
            from view_relationships vr
            join relationships r on r.model_id = vr.model_id and r.ordinal = vr.relationship_ordinal
            where vr.view_id = v.id and r.id is not null), '[]'::jsonb) as relationship_ids`;

// One statement, so the view and its contents are read as one. No row: no model; a row without a
// view id: no such view in the model.
const loadView = `select m.id as model_id, ${viewColumns}, ${contentColumns}
  from models m left join views v on v.model_id = m.id and v.id = $2::uuid
  where m.id = $1::uuid`;

const listViews = `select m.id as model_id, ${viewColumns}
  from models m left join views v on v.model_id = m.id
  where m.id = $1::uuid`;

// View changes hold the model's row lock, as element changes do: they take turns with each other
// and with element and relationship changes, and a delete of the model waits for them.
const lockModel = 'select version from models where id = $1::uuid for update';

const viewNames = 'select id, name from views where model_id = $1::uuid';

const findElements = `select e.id from elements e
  where e.model_id = $1::uuid and e.id in (select jsonb_array_elements_text($2::text::jsonb))`;

const findRelationships = `select r.id, r.source, r.target from relationships r
  where r.model_id = $1::uuid and r.id in (select jsonb_array_elements_text($2::text::jsonb))
  order by r.ordinal`;

const insertView = `insert into views (id, model_id, name, created_at, created_by_id,
  created_by_name, updated_at, updated_by_id, updated_by_name)
  values ($1::uuid, $2::uuid, $3, $4, $5, $6, $4, $5, $6)`;

// New contents are written as a difference, so adding or removing one card costs little: rows no
// longer wanted go, and only rows not there yet are added.
const insertElements = `insert into view_elements (view_id, model_id, element_id)
  select $1::uuid, $2::uuid, x.id from jsonb_array_elements_text($3::text::jsonb) as x(id)
  on conflict do nothing`;

const deleteOtherElements = `delete from view_elements
  where view_id = $1::uuid
    and element_id not in (select jsonb_array_elements_text($2::text::jsonb))`;

// By the relationship's ordinal. Edge ids are unique in a valid model; should a damaged one repeat
// an id, the first relationship with it counts, as in the check.
const insertRelationships = `insert into view_relationships (view_id, model_id,
  relationship_ordinal)
  select $1::uuid, $2::uuid, min(r.ordinal) from relationships r
  where r.model_id = $2::uuid and r.id in (select jsonb_array_elements_text($3::text::jsonb))
  group by r.id
  on conflict do nothing`;

const deleteOtherRelationships = `delete from view_relationships vr
  where vr.view_id = $1::uuid
    and not exists (select 1 from relationships r
      where r.model_id = vr.model_id and r.ordinal = vr.relationship_ordinal
        and r.id in (select jsonb_array_elements_text($2::text::jsonb)))`;

const touchView = `update views set version = version + 1, updated_at = $3, updated_by_id = $4,
  updated_by_name = $5 where id = $1::uuid and model_id = $2::uuid`;

const insertAudit = `insert into audit (action, user_id, user_name, model_id, view_id, details)
  values ($1, $2, $3, $4::uuid, $5::uuid, $6::text::jsonb)`;

const isoOf = (value: Date | string): string => new Date(value).toISOString();

function summaryOf(row: ViewRow): ViewSummary {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    elementCount: row.element_count,
    relationshipCount: row.relationship_count,
    createdAt: isoOf(row.created_at),
    createdBy: { id: row.created_by_id, name: row.created_by_name },
    updatedAt: isoOf(row.updated_at),
    updatedBy: { id: row.updated_by_id, name: row.updated_by_name },
  };
}

function recordOf(row: FullViewRow): ViewRecord {
  return {
    summary: summaryOf(row),
    elementIds: row.element_ids,
    relationshipIds: row.relationship_ids,
  };
}

/** The view, or which of the two is missing. */
async function readView(
  db: Queryable,
  modelId: string,
  viewId: string,
): Promise<ViewRecord | 'no-model' | 'no-view'> {
  const [row] = await db.query<Joined<FullViewRow>>(loadView, [modelId, viewId]);
  if (!row) return 'no-model';
  return present(row) ? recordOf(row) : 'no-view';
}

export class PostgresViewStore implements ViewStore {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number) {
    this.#db = db;
    this.#now = now;
  }

  async list(modelId: string): Promise<ViewSummary[] | undefined> {
    if (!isModelId(modelId)) return undefined;
    const rows = await this.#db.query<Joined<ViewRow>>(listViews, [modelId]);
    if (rows.length === 0) return undefined;
    return rows.filter(present).map(summaryOf);
  }

  async get(modelId: string, viewId: string): Promise<ViewRecord | 'no-model' | 'no-view'> {
    if (!isModelId(modelId)) return 'no-model';
    if (!isModelId(viewId)) return 'no-view';
    return readView(this.#db, modelId, viewId);
  }

  async change(
    modelId: string,
    lookup: ViewLookup,
    plan: (state: ViewChangeState) => PlannedViewChange,
  ): Promise<{ view: ViewRecord | undefined } | undefined> {
    if (!isModelId(modelId)) return undefined;
    return this.#db.transaction(async (tx) => {
      const [locked] = await tx.query(lockModel, [modelId]);
      if (!locked) return undefined;
      let view: ViewRecord | undefined;
      if (lookup.viewId !== undefined && isModelId(lookup.viewId)) {
        const found = await readView(tx, modelId, lookup.viewId);
        if (typeof found !== 'string') view = found;
      }
      const names = await tx.query<{ id: string; name: string }>(viewNames, [modelId]);
      const elements = await tx.query<{ id: string }>(findElements, [
        modelId,
        JSON.stringify(lookup.elementIds),
      ]);
      const relationshipIds = [
        ...new Set([...lookup.relationshipIds, ...(view?.relationshipIds ?? [])]),
      ];
      const relationships = new Map<string, RelationshipEnds>();
      const edges = await tx.query<RelationshipEnds & { id: string }>(findRelationships, [
        modelId,
        JSON.stringify(relationshipIds),
      ]);
      for (const edge of edges) {
        if (!relationships.has(edge.id)) {
          relationships.set(edge.id, { source: edge.source, target: edge.target });
        }
      }
      const { write, audit } = plan({
        view,
        views: names,
        elements: new Set(elements.map((element) => element.id)),
        relationships,
      });

      const at = new Date(this.#now());
      const { actor } = audit;
      let details: object = { fields: audit.fields };
      if (write.kind === 'create') {
        await tx.query(insertView, [write.viewId, modelId, write.name, at, actor.id, actor.name]);
      } else if (write.kind === 'rename') {
        await tx.query('update views set name = $3 where id = $1::uuid and model_id = $2::uuid', [
          write.viewId,
          modelId,
          write.name,
        ]);
        await tx.query(touchView, [write.viewId, modelId, at, actor.id, actor.name]);
      } else if (write.kind === 'replace') {
        await tx.query(deleteOtherElements, [write.viewId, JSON.stringify(write.elementIds)]);
        await tx.query(deleteOtherRelationships, [
          write.viewId,
          JSON.stringify(write.relationshipIds),
        ]);
        await tx.query(touchView, [write.viewId, modelId, at, actor.id, actor.name]);
      } else {
        await tx.query('delete from views where id = $1::uuid and model_id = $2::uuid', [
          write.viewId,
          modelId,
        ]);
      }
      if (write.kind === 'create' || write.kind === 'replace') {
        if (write.elementIds.length > 0) {
          await tx.query(insertElements, [write.viewId, modelId, JSON.stringify(write.elementIds)]);
        }
        if (write.relationshipIds.length > 0) {
          await tx.query(insertRelationships, [
            write.viewId,
            modelId,
            JSON.stringify(write.relationshipIds),
          ]);
        }
        details = {
          ...details,
          elements: write.elementIds.length,
          relationships: write.relationshipIds.length,
        };
      }
      await tx.query(insertAudit, [
        audit.action,
        actor.id,
        actor.name,
        modelId,
        write.viewId,
        JSON.stringify(details),
      ]);
      if (write.kind === 'delete') return { view: undefined };
      const after = await readView(tx, modelId, write.viewId);
      if (typeof after === 'string') throw new Error('view not written');
      return { view: after };
    });
  }
}
