import { resolveDataDir } from '../storage/data-dir.js';
import { FileModelStore } from '../storage/file-model-store.js';
import { importFileModels } from '../storage/import-files.js';
import { PostgresModelStore } from '../storage/postgres-model-store.js';
import { runDatabaseCommand } from './cli.js';

// npm run db:import-files -w backend [-- <folder>]: copies the model files in <folder> (default
// data/, relative to the repo root) into PostgreSQL. Prints counts only. The files stay where they are.
const folder = process.argv[2] ?? 'data';
await runDatabaseCommand(async (database) => {
  if (database.db === undefined) return 1;
  // Damaged files are counted below; their names aren't printed.
  const files = await FileModelStore.open(resolveDataDir(folder), {
    log: { warn: () => undefined },
  });
  const store = await PostgresModelStore.open(database.db, { log: { warn: () => undefined } });
  const counts = await importFileModels(files, store);
  console.log(
    [
      `Models in the folder: ${counts.found}`,
      `Imported: ${counts.imported} (${counts.elements} elements, ${counts.relationships} relationships)`,
      `Already in the database: ${counts.skipped}`,
      `Damaged, not imported: ${counts.damaged}`,
      `Failed: ${counts.failed}`,
      `Files left in place: ${counts.found}`,
    ].join('\n'),
  );
  return counts.failed > 0 ? 1 : 0;
});
