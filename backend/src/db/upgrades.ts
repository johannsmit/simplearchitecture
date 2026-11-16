import { definitionsForKeys, isDefinableRelationshipKey } from '@simplearchitecture/shared';
import { insertDefinitions } from '../properties/property-store.js';
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

export const upgradeSteps: ReadonlyMap<string, UpgradeStep> = new Map([
  ['016_relationship_properties', defineRelationshipKeysFromModels],
]);
