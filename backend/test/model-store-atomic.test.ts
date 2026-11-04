import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import type { JgfDocument } from '@simplearchitecture/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleModel } from '../src/jgf/sample.js';
import { modelReadConcurrency } from '../src/limits.js';
import { FileModelStore } from '../src/storage/file-model-store.js';
import { tempDataDir } from './helpers.js';

// Watches (and can break) the rename that publishes a written model.
// Also counts model files open at once, and records every open and rename in order.
const renameHook = vi.hoisted(() => ({
  before: undefined as ((from: string, to: string) => void) | undefined,
  openModels: 0,
  mostOpenModels: 0,
  events: [] as string[],
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      renameHook.before?.(from, to);
      renameHook.events.push(`rename ${to}`);
      return actual.rename(from, to);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0]);
      const handle = await actual.open(...args);
      renameHook.events.push(`open ${path}`);
      if (!path.endsWith('.json')) return handle;
      renameHook.openModels += 1;
      renameHook.mostOpenModels = Math.max(renameHook.mostOpenModels, renameHook.openModels);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        renameHook.openModels -= 1;
        return close();
      };
      return handle;
    },
  };
});

const author = { id: 'oid-0001', name: 'Made-up Modeller' };
let dir: string;

beforeEach(() => {
  dir = tempDataDir();
});

afterEach(() => {
  renameHook.before = undefined;
  renameHook.events = [];
  renameHook.mostOpenModels = 0;
  rmSync(dir, { recursive: true, force: true });
});

describe('atomic writes', () => {
  it('writes the whole model to a 600 temporary file in the same directory, then renames it', async () => {
    const store = await FileModelStore.open(dir, { log: { warn: vi.fn() } });
    const seen: { from: string; to: string; content: string; finalExisted: boolean }[] = [];
    renameHook.before = (from, to) => {
      seen.push({
        from,
        to,
        content: readFileSync(from, 'utf8'),
        finalExisted: existsSync(to),
      });
      expect(statSync(from).mode & 0o777).toBe(0o600);
    };

    const summary = await store.save(sampleModel, author);

    expect(seen).toHaveLength(1);
    const [write] = seen;
    expect(write?.to).toBe(join(dir, `${summary.id}.json`));
    expect(write?.from.startsWith(`${dir}/.`)).toBe(true);
    expect(write?.from.endsWith('.tmp')).toBe(true);
    // Until the rename, the model's file doesn't exist: no reader can see it half-written.
    expect(write?.finalExisted).toBe(false);
    expect((JSON.parse(write?.content ?? '') as JgfDocument).graph.id).toBe(summary.id);
    expect(readdirSync(dir)).toEqual([`${summary.id}.json`]);
  });

  it('leaves neither a model nor a temporary file when the rename fails', async () => {
    const store = await FileModelStore.open(dir, { log: { warn: vi.fn() } });
    renameHook.before = () => {
      throw Object.assign(new Error('simulated failure'), { code: 'EIO' });
    };
    await expect(store.save(sampleModel, author)).rejects.toThrow('simulated failure');
    expect(readdirSync(dir)).toEqual([]);
    renameHook.before = undefined;
    expect(await store.list()).toEqual([]);
  });
});

describe('bounded reads and durable writes', () => {
  it(`reads at most ${modelReadConcurrency} model files at once`, async () => {
    const store = await FileModelStore.open(dir, { log: { warn: vi.fn() } });
    const saved = await store.save(sampleModel, author);
    const text = readFileSync(join(dir, `${saved.id}.json`), 'utf8');
    for (let i = 0; i < 40; i += 1) {
      const id = crypto.randomUUID();
      writeFileSync(join(dir, `${id}.json`), text.replaceAll(saved.id, id));
    }
    renameHook.mostOpenModels = 0;
    // A new store reads every file (as at startup); a list after that reads none.
    const fresh = await FileModelStore.open(dir, { log: { warn: vi.fn() } });
    expect(renameHook.mostOpenModels).toBeGreaterThan(0);
    expect(renameHook.mostOpenModels).toBeLessThanOrEqual(modelReadConcurrency);
    expect(await fresh.list()).toHaveLength(41);
  });

  it('syncs the directory after the rename that publishes a model', async () => {
    const store = await FileModelStore.open(dir, { log: { warn: vi.fn() } });
    renameHook.events = [];
    const summary = await store.save(sampleModel, author);
    const renamed = renameHook.events.indexOf(`rename ${join(dir, `${summary.id}.json`)}`);
    expect(renamed).toBeGreaterThanOrEqual(0);
    expect(renameHook.events.slice(renamed + 1)).toContain(`open ${dir}`);
  });
});
