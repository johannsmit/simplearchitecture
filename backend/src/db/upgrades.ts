import {
  definitionsForKeys,
  elementDefinitionsForKeys,
  isDefinableElementKey,
  isDefinableRelationshipKey,
  referenceKey,
} from '@simplearchitecture/shared';
import { insertDefinitions, insertElementDefinitions } from '../properties/property-store.js';
import type { Queryable } from './db.js';

/**
 * Upgrade steps written in code, each run right after one migration file, in the same transaction:
 * only when that migration runs, so exactly once per database. For an upgrade whose rules the app
 * keeps in code anyway, so they are written once (a migration file has only SQL). A step that throws
 * rolls back its migration with it. Keyed by the migration's file name without `.sql`.
 */
export type UpgradeStep = (tx: Queryable) => Promise<void>;

/**
 * After 016 (the definitions table): every custom key on relationships in the stored models
 * becomes a text property from models, named after its key by the same rules as an import, so no
 * relationship is left with custom metadata that isn't a property. Standard, reserved and retired
 * keys are left out. Values and models don't change.
 */
export async function defineRelationshipKeysFromModels(tx: Queryable): Promise<void> {
  const rows = await tx.query<{ key: string }>(
    `select distinct jsonb_object_keys(metadata) as key
     from relationships where jsonb_typeof(metadata) = 'object'`,
  );
  const keys = rows
    .map((row) => row.key)
    .filter(isDefinableRelationshipKey)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  await insertDefinitions(tx, definitionsForKeys(keys, []));
}

/**
 * After 020 (the element definitions table): every custom key on elements in the stored models
 * becomes an element property from models, named after its key by the same rules as an import. A
 * key whose every value, in every model, is a Reference (an object whose one key is
 * `simplearchitecture:reference`, holding a list: `isReference`) becomes a Reference property;
 * any other key a text property, its other values then read as "not this kind". The standard
 * properties of every element type and the reserved keys are left out. Values and models don't
 * change.
 */
export async function defineElementKeysFromModels(tx: Queryable): Promise<void> {
  const rows = await tx.query<{ key: string; references: boolean }>(
    `select entry.key,
       -- A case, so the key is only taken out of an object (any order of an "and" is allowed).
       bool_and(case when jsonb_typeof(entry.value) = 'object'
         then entry.value - $1::text = '{}'::jsonb
           and coalesce(jsonb_typeof(entry.value -> $1::text) = 'array', false)
         else false end) as references
     from elements, jsonb_each(elements.metadata) as entry
     where jsonb_typeof(elements.metadata) = 'object'
     group by entry.key`,
    [referenceKey],
  );
  const keys = rows
    .filter((row) => isDefinableElementKey(row.key))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  await insertElementDefinitions(tx, elementDefinitionsForKeys(keys, []));
}

export const upgradeSteps: ReadonlyMap<string, UpgradeStep> = new Map([
  ['016_relationship_properties', defineRelationshipKeysFromModels],
  ['020_element_properties', defineElementKeysFromModels],
]);
