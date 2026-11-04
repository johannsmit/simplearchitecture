import type { FileModelStore } from './file-model-store.js';
import type { PostgresModelStore } from './postgres-model-store.js';

/** What a move of the files did: counts only, never names or content. */
export interface FileImportCounts {
  /** Models in DATA_DIR, damaged ones included. */
  found: number;
  imported: number;
  /** Already in the database (from an earlier run): left as they are. */
  skipped: number;
  /** Damaged files: they fail validation, so they aren't moved. */
  damaged: number;
  /** Valid models that couldn't be stored (e.g. the database is full). */
  failed: number;
  /** Elements and relationships of the models imported in this run. */
  elements: number;
  relationships: number;
}

/**
 * Copies every valid model from the file store into PostgreSQL, keeping its id and stored data
 * (name, created at and by, counts, sourceId). Running it again imports nothing new. The files
 * are left in place as a backup.
 */
export async function importFileModels(
  files: FileModelStore,
  database: PostgresModelStore,
): Promise<FileImportCounts> {
  const models = await files.list();
  const damaged = (await files.listDamaged()).length;
  const counts: FileImportCounts = {
    found: models.length + damaged,
    imported: 0,
    skipped: 0,
    damaged,
    failed: 0,
    elements: 0,
    relationships: 0,
  };
  for (const summary of models) {
    try {
      const document = await files.get(summary.id);
      if (document === undefined) {
        counts.failed += 1;
        continue;
      }
      if ((await database.importStored(document)) === 'exists') {
        counts.skipped += 1;
        continue;
      }
      counts.imported += 1;
      counts.elements += summary.nodeCount;
      counts.relationships += summary.edgeCount;
    } catch {
      counts.failed += 1;
    }
  }
  return counts;
}
