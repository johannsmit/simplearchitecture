import { loadDatabaseConfig, type DatabaseConfig } from '../config.js';
import { DatabaseService, type DatabaseLogger } from './service.js';

/** Logs ids, kinds and codes only (as the API does), to stderr. */
export const cliLog: DatabaseLogger = {
  info: () => undefined,
  warn: (details, message) => {
    console.error(`warning: ${message} ${JSON.stringify(details)}`);
  },
  error: (details, message) => {
    console.error(`error: ${message} ${JSON.stringify(details)}`);
  },
};

/**
 * Runs a `db:*` command: reads the database settings, connects (applying the migrations) and
 * hands over. Prints a safe message and exits 1 on failure: never the URL or a driver message.
 */
export async function runDatabaseCommand(
  task: (database: DatabaseService, config: DatabaseConfig) => Promise<number>,
): Promise<never> {
  let code = 1;
  try {
    const config = loadDatabaseConfig();
    const database = await DatabaseService.connect(config, cliLog);
    try {
      code = await task(database, config);
    } finally {
      await database.close();
    }
  } catch (error) {
    const safe = error instanceof Error && error.name !== 'Error' && error.name !== 'TypeError';
    console.error(safe ? error.message : 'The command failed.');
  }
  process.exit(code);
}
