import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import {
  ConfigError,
  ignoredSettings,
  loadConfig,
  replacedSettings,
  type Config,
} from './config.js';
import { DatabaseError } from './db/db.js';
import { MigrationError } from './db/migrate.js';
import { DatabaseStartError, failureMessages } from './db/service.js';
import { loadOefMapping, OefMappingError, type OefMapping } from './oef/mapping-config.js';
import { resolveFromRepoRoot } from './paths.js';
import { ModelStoreError } from './storage/model-store.js';
import { loadWebApp, WebAppError } from './web-app.js';

let config: Config;
let oefMapping: OefMapping;
let webApp: ReturnType<typeof loadWebApp> | undefined;
try {
  config = loadConfig();
  oefMapping = loadOefMapping(config.OEF_MAPPING_PATH);
  // The built web app, served from this origin (the image always has it). In development the
  // web app usually runs on Vite instead, so an unbuilt one is fine there; production needs it.
  try {
    webApp = loadWebApp(resolveFromRepoRoot('frontend/dist'));
  } catch (error) {
    if (!(error instanceof WebAppError) || config.NODE_ENV === 'production') throw error;
  }
} catch (error) {
  if (
    error instanceof ConfigError ||
    error instanceof OefMappingError ||
    error instanceof WebAppError
  ) {
    console.error(`API not started. ${error.message}`);
    process.exit(1);
  }
  throw error;
}

let app: FastifyInstance;
try {
  app = await buildApp(config, { oefMapping, ...(webApp === undefined ? {} : { webApp }) });
  app.log.info({ served: webApp !== undefined }, 'built web app');
  const ignored = ignoredSettings();
  if (ignored.length > 0) {
    app.log.warn({ settings: ignored }, 'settings not read (fixed): ignored');
  }
  for (const replaced of replacedSettings()) {
    app.log.warn(replaced, 'setting no longer read: ignored, set its replacement');
  }
} catch (error) {
  if (
    error instanceof ModelStoreError ||
    error instanceof DatabaseStartError ||
    error instanceof MigrationError
  ) {
    console.error(`API not started. ${error.message}`);
    process.exit(1);
  }
  // A database error at startup (e.g. reading the models): its kind only, never the driver text.
  if (error instanceof DatabaseError) {
    console.error(`API not started. ${failureMessages[error.failure]}`);
    process.exit(1);
  }
  throw error;
}

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.once('SIGINT', (signal) => void shutdown(signal));
process.once('SIGTERM', (signal) => void shutdown(signal));

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start');
  process.exit(1);
}
