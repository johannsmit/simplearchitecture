import { appliedCount } from './migrate.js';
import { runDatabaseCommand } from './cli.js';

// npm run db:migrate -w backend. The API also migrates at startup; this does it on its own.
await runDatabaseCommand(async (database) => {
  if (database.db === undefined) return 1;
  const applied = await appliedCount(database.db, database.migrations);
  console.log(`Migrations applied: ${applied} of ${database.migrations.length}.`);
  return 0;
});
