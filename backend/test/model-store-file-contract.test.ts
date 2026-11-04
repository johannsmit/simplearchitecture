import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { FileModelStore } from '../src/storage/file-model-store.js';
import { describeModelStoreContract } from './model-store-contract.js';
import { tempDataDir } from './helpers.js';

let dir: string;
let warnings: { details: object; message: string }[] = [];

beforeEach(() => {
  dir = join(tempDataDir(), 'models');
  warnings = [];
});

afterEach(() => {
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

describeModelStoreContract('FileModelStore', () => ({
  open: (options = {}) =>
    FileModelStore.open(dir, {
      log: { warn: (details, message) => warnings.push({ details, message }) },
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.maxModels === undefined ? {} : { maxModels: options.maxModels }),
      ...(options.maxBytes === undefined ? {} : { maxFileBytes: options.maxBytes }),
    }),
  damage: (id) => {
    const file = join(dir, `${id}.json`);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as {
      graph: { edges: { relation: string }[] };
    };
    const [edge] = stored.graph.edges;
    if (edge) edge.relation = 'Secret relation';
    writeFileSync(file, JSON.stringify(stored));
    return Promise.resolve();
  },
  warnings: () => warnings,
}));
