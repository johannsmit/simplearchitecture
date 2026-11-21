import {
  definitionsForKeys,
  elementDefinitionsForKeys,
  newElementKeys,
  newRelationshipKeys,
  sortDefinitions,
  standardNameClash,
  type AddedElementProperty,
  type AddedRelationshipProperty,
  type DefinedPropertyKind,
  type ElementPropertyDefinition,
  type ElementPropertyKind,
  type ModelAuthor,
  type RelationshipPropertyDefinition,
} from '@simplearchitecture/shared';
import type { Queryable } from '../db/db.js';
import { unstorable } from '../storage/stored-model.js';

/**
 * The property definitions in PostgreSQL, for relationships (migration 016) and for elements
 * (migration 020), read and written inside the caller's transaction. The rules are in
 * shared/relationship-properties.ts, shared/element-properties.ts and PropertyService.
 *
 * Locks, so a value never lands under a key that isn't defined:
 * - every change to the definitions of either list (an Admin's, an import's) takes `propertyLock`
 *   first, so they take turns and a name or key is checked against the list as it is;
 * - a relationship or element change share-locks the rows of the defined keys it sets
 *   (`lockDefinitions`, `lockElementDefinitions`), so a key change or a delete waits for it, and a
 *   change after them finds the key gone.
 */

// Definition changes take turns across every API process (any fixed number would do).
const propertyLock = 4_120_003;

interface Row<K extends string> {
  key: string;
  name: string;
  kind: K;
  options: string[] | null;
  from_models: boolean;
  version: number;
}
type DefinitionRow = Row<DefinedPropertyKind>;
export type ElementDefinitionRow = Row<ElementPropertyKind>;

const columns = 'key, name, kind, options, from_models, version';

function ofRow<K extends string>(row: Row<K>) {
  return {
    key: row.key,
    name: row.name,
    kind: row.kind,
    ...(row.kind === 'choice' ? { options: row.options ?? [] } : {}),
    fromModels: row.from_models,
    version: row.version,
  };
}

export function definitionOfRow(row: DefinitionRow): RelationshipPropertyDefinition {
  return ofRow(row);
}

export function elementDefinitionOfRow(row: ElementDefinitionRow): ElementPropertyDefinition {
  return ofRow(row);
}

/**
 * Whether the database has the definitions (migration 016). A store on an older schema (while it
 * is upgraded, and in the migration tests) works without them: 016's upgrade step defines the keys.
 */
export async function hasDefinitions(q: Queryable): Promise<boolean> {
  const [row] = await q.query<{ present: boolean }>(
    "select to_regclass('relationship_properties') is not null as present",
  );
  return row?.present === true;
}

/**
 * Whether the database has the element definitions (migration 020). A store on an older schema
 * works without them: 020's upgrade step defines the keys.
 */
export async function hasElementDefinitions(q: Queryable): Promise<boolean> {
  const [row] = await q.query<{ present: boolean }>(
    "select to_regclass('element_properties') is not null as present",
  );
  return row?.present === true;
}

/** Takes the definitions' lock until the transaction ends. */
export async function lockPropertyChanges(tx: Queryable): Promise<void> {
  await tx.query('select pg_advisory_xact_lock($1::bigint)', [propertyLock]);
}

/**
 * The standard properties that a defined property is named like (ignoring case and runs of
 * spaces), once each: one defined before the standard name existed, as when the two lists of data
 * were named by direction. In a label, the standard property wins.
 */
export async function standardNameClashes(q: Queryable): Promise<string[]> {
  if (!(await hasDefinitions(q))) return [];
  const rows = await q.query<{ name: string }>('select name from relationship_properties');
  const clashes = rows.flatMap((row) => standardNameClash(row.name) ?? []);
  return [...new Set(clashes)].sort();
}

/** Every definition, by name. */
export async function readDefinitions(q: Queryable): Promise<RelationshipPropertyDefinition[]> {
  const rows = await q.query<DefinitionRow>(`select ${columns} from relationship_properties`);
  return sortDefinitions(rows.map(definitionOfRow));
}

/** One definition; `lock` takes its row for a change. */
export async function readDefinition(
  q: Queryable,
  key: string,
  lock = false,
): Promise<RelationshipPropertyDefinition | undefined> {
  const [row] = await q.query<DefinitionRow>(
    `select ${columns} from relationship_properties where key = $1${lock ? ' for update' : ''}`,
    [key],
  );
  return row === undefined ? undefined : definitionOfRow(row);
}

/** Share-locks the rows of these keys (those defined), until the transaction ends. */
export async function lockDefinitions(q: Queryable, keys: readonly string[]): Promise<void> {
  // A key PostgreSQL can't hold is no property's (the change is refused).
  const storable = keys.filter((key) => !unstorable.test(key));
  if (storable.length === 0) return;
  await q.query('select key from relationship_properties where key = any($1::text[]) for share', [
    storable,
  ]);
}

/** Every element definition, by name. */
export async function readElementDefinitions(q: Queryable): Promise<ElementPropertyDefinition[]> {
  const rows = await q.query<ElementDefinitionRow>(`select ${columns} from element_properties`);
  return sortDefinitions(rows.map(elementDefinitionOfRow));
}

/** One element definition; `lock` takes its row for a change. */
export async function readElementDefinition(
  q: Queryable,
  key: string,
  lock = false,
): Promise<ElementPropertyDefinition | undefined> {
  const [row] = await q.query<ElementDefinitionRow>(
    `select ${columns} from element_properties where key = $1${lock ? ' for update' : ''}`,
    [key],
  );
  return row === undefined ? undefined : elementDefinitionOfRow(row);
}

/** Share-locks the rows of these element keys (those defined), until the transaction ends. */
export async function lockElementDefinitions(q: Queryable, keys: readonly string[]): Promise<void> {
  const storable = keys.filter((key) => !unstorable.test(key));
  if (storable.length === 0) return;
  await q.query('select key from element_properties where key = any($1::text[]) for share', [
    storable,
  ]);
}

type NewDefinition = Omit<RelationshipPropertyDefinition | ElementPropertyDefinition, 'version'>;

/** Adds definitions (each new) to one of the two tables (never a name from input). */
async function insertInto(
  q: Queryable,
  table: 'relationship_properties' | 'element_properties',
  definitions: readonly NewDefinition[],
): Promise<void> {
  if (definitions.length === 0) return;
  const rows = definitions.map((definition) => ({
    key: definition.key,
    name: definition.name,
    kind: definition.kind,
    options: definition.kind === 'choice' ? (definition.options ?? []) : null,
    from_models: definition.fromModels,
  }));
  await q.query(
    `insert into ${table} (key, name, kind, options, from_models)
     select x.key, x.name, x.kind, x.options, x.from_models
     from jsonb_to_recordset($1::text::jsonb)
       as x(key text, name text, kind text, options jsonb, from_models boolean)`,
    [JSON.stringify(rows)],
  );
}

/** Adds relationship definitions (each new). */
export async function insertDefinitions(
  q: Queryable,
  definitions: readonly Omit<RelationshipPropertyDefinition, 'version'>[],
): Promise<void> {
  await insertInto(q, 'relationship_properties', definitions);
}

/** Adds element definitions (each new). */
export async function insertElementDefinitions(
  q: Queryable,
  definitions: readonly Omit<ElementPropertyDefinition, 'version'>[],
): Promise<void> {
  await insertInto(q, 'element_properties', definitions);
}

const insertAudit = `insert into audit (action, user_id, user_name, model_id, details)
  values ($1, $2, $3, $4::uuid, $5::text::jsonb)`;

/** One audit row: the action, who, and details with keys, field names and counts only. */
export async function auditProperty(
  q: Queryable,
  action: string,
  actor: ModelAuthor | undefined,
  details: Record<string, unknown>,
  modelId: string | null = null,
): Promise<void> {
  await q.query(insertAudit, [
    action,
    actor?.id ?? null,
    actor?.name ?? null,
    modelId,
    JSON.stringify(details),
  ]);
}

/**
 * Defines every custom key on these relationships (JGF edges) that isn't defined yet, as a text
 * property from models named after its key, and says which, with the number of values each has
 * here. For a model being stored (an import), in its transaction. Each gets an audit row naming
 * the actor.
 */
export async function defineKeysOf(
  tx: Queryable,
  edges: readonly { metadata?: unknown }[],
  actor: ModelAuthor,
): Promise<AddedRelationshipProperty[]> {
  // Nothing to look at: no lock taken.
  if (newRelationshipKeys(edges, () => false).length === 0) return [];
  if (!(await hasDefinitions(tx))) return [];
  await lockPropertyChanges(tx);
  const existing = await readDefinitions(tx);
  const known = new Set(existing.map((definition) => definition.key));
  const found = newRelationshipKeys(edges, (key) => known.has(key));
  const added = definitionsForKeys(
    found.map((entry) => entry.key),
    existing,
  );
  await insertDefinitions(tx, added);
  for (const definition of added) {
    await auditProperty(tx, 'property-added', actor, {
      key: definition.key,
      fields: ['name', 'key', 'kind'],
      fromModels: true,
    });
  }
  return added.map((definition, index) => ({
    key: definition.key,
    name: definition.name,
    values: found[index]?.values ?? 0,
  }));
}

/**
 * Defines every custom key on these elements (JGF nodes) that isn't defined yet, as an element
 * property from models named after its key (a Reference property when every value here is a
 * Reference, text otherwise), and says which, with the number of values each has here. For a model
 * being stored (an import), in its transaction. Each gets an audit row naming the actor.
 */
export async function defineElementKeysOf(
  tx: Queryable,
  nodes: readonly { metadata?: unknown }[],
  actor: ModelAuthor,
): Promise<AddedElementProperty[]> {
  if (newElementKeys(nodes, () => false).length === 0) return [];
  if (!(await hasElementDefinitions(tx))) return [];
  await lockPropertyChanges(tx);
  const existing = await readElementDefinitions(tx);
  const known = new Set(existing.map((definition) => definition.key));
  const found = newElementKeys(nodes, (key) => known.has(key));
  const added = elementDefinitionsForKeys(found, existing);
  await insertElementDefinitions(tx, added);
  for (const definition of added) {
    await auditProperty(tx, 'element-property-added', actor, {
      key: definition.key,
      fields: ['name', 'key', 'kind'],
      fromModels: true,
    });
  }
  return added.map((definition, index) => ({
    key: definition.key,
    name: definition.name,
    kind: definition.kind,
    values: found[index]?.values ?? 0,
  }));
}
