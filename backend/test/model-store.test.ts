import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { storedModelKey, type JgfDocument, type ModelAuthor } from '@simplearchitecture/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sampleModel } from '../src/jgf/sample.js';
import { validateJgf } from '../src/jgf/validate.js';
import {
  maxJsonDepth,
  maxModelNameLength,
  maxSourceIdLength,
  maxStoredModels,
} from '../src/limits.js';
import { repoRoot } from '../src/paths.js';
import { checkDataDirLocation, resolveDataDir } from '../src/storage/data-dir.js';
import { FileModelStore, untitledModelName } from '../src/storage/file-model-store.js';
import {
  ModelNotDeletableError,
  ModelStoreError,
  ModelStoreFullError,
  ModelTooLargeError,
  ModelUnreadableError,
} from '../src/storage/model-store.js';
import { tempDataDir } from './helpers.js';
import { expectGrowthBelow } from './growth.js';

const author: ModelAuthor = { id: 'oid-0001', name: 'Made-up Modeller' };
const secretLabel = 'Made-up secret model label';

let root: string;
let dir: string;
let warnings: { details: object; message: string }[];

beforeEach(() => {
  root = tempDataDir();
  dir = join(root, 'models');
  warnings = [];
});

afterEach(() => {
  chmodSync(root, 0o700);
  // Never through a symlink: one test links `dir` to the repo root, and chmod follows links
  // (this once made the repo root 700).
  if (existsSync(dir) && !lstatSync(dir).isSymbolicLink()) chmodSync(dir, 0o700);
  rmSync(root, { recursive: true, force: true });
});

function open(options: { now?: () => number; maxModels?: number; maxFileBytes?: number } = {}) {
  return FileModelStore.open(dir, {
    log: { warn: (details, message) => warnings.push({ details, message }) },
    ...options,
  });
}

function model(label?: string, extra: Partial<JgfDocument['graph']> = {}): JgfDocument {
  const graph = structuredClone(sampleModel.graph);
  delete graph.label;
  return { graph: { ...graph, ...(label === undefined ? {} : { label }), ...extra } };
}

const mode = (path: string) => statSync(path).mode & 0o777;
const files = () => readdirSync(dir).sort();

describe('FileModelStore.open', () => {
  it('creates a missing directory (and parents), owner-only', async () => {
    await open();
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(mode(dir)).toBe(0o700);
    expect(files()).toEqual([]);
  });

  it('makes an existing directory owner-only', async () => {
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    await open();
    expect(mode(dir)).toBe(0o700);
  });

  it('refuses a path that is a file', async () => {
    writeFileSync(dir, 'not a directory');
    const failure = open();
    await expect(failure).rejects.toThrow(ModelStoreError);
    await expect(failure).rejects.toThrow(`DATA_DIR ${dir} is not a writable directory (EEXIST)`);
  });

  it('refuses a directory it cannot create', async () => {
    chmodSync(root, 0o500);
    await expect(open()).rejects.toThrow(/is not a writable directory \(EACCES\)/);
  });

  it('removes temporary files left by a crash, and nothing else', async () => {
    mkdirSync(dir);
    const leftover = `.${crypto.randomUUID()}.0123456789abcdef.tmp`;
    writeFileSync(join(dir, leftover), '{"half": ');
    writeFileSync(join(dir, 'notes.txt'), 'kept');
    await open();
    expect(files()).toEqual(['notes.txt']);
  });
});

describe('FileModelStore.save', () => {
  it('writes one valid JGF file per model, named by a new UUID, mode 600', async () => {
    const store = await open({ now: () => Date.UTC(2026, 9, 26, 12) });
    const summary = await store.save(model('  Shop landscape  '), author);

    expect(summary).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      name: 'Shop landscape',
      createdAt: '2026-10-26T12:00:00.000Z',
      createdBy: author,
      nodeCount: 6,
      edgeCount: 3,
      sourceId: 'sample-model',
    });
    expect(files()).toEqual([`${summary.id}.json`]);
    const file = join(dir, `${summary.id}.json`);
    expect(mode(file)).toBe(0o600);

    const stored = JSON.parse(readFileSync(file, 'utf8')) as JgfDocument;
    expect(validateJgf(stored)).toMatchObject({ valid: true, errorCount: 0, warningCount: 0 });
    expect(stored.graph.id).toBe(summary.id);
    expect(stored.graph.label).toBe('  Shop landscape  ');
    expect(stored.graph.metadata?.[storedModelKey]).toEqual(summary);
    expect(stored.graph.nodes).toEqual(sampleModel.graph.nodes);
    expect(stored.graph.edges).toEqual(sampleModel.graph.edges);
    expect(await store.get(summary.id)).toEqual(stored);
  });

  it('replaces the id and server data a client sent, and keeps its other metadata', async () => {
    const store = await open();
    const forged = { id: 'not-yours', createdBy: { id: 'someone-else', name: 'x' } };
    const summary = await store.save(
      model('Mine', {
        id: 'client-id',
        metadata: { [storedModelKey]: forged, owner: 'Made-up team' },
      }),
      author,
    );
    const stored = await store.get(summary.id);
    expect(stored?.graph.id).toBe(summary.id);
    expect(stored?.graph.metadata).toEqual({ [storedModelKey]: summary, owner: 'Made-up team' });
  });

  it('names a model without a usable label, and cuts a long one', async () => {
    const store = await open();
    expect((await store.save(model(), author)).name).toBe(untitledModelName);
    expect((await store.save(model('   '), author)).name).toBe(untitledModelName);
    const long = await store.save(model('n'.repeat(5000)), author);
    expect(long.name).toBe(`${'n'.repeat(maxModelNameLength)}…`);
  });

  it('counts an empty model as 0 nodes and 0 edges', async () => {
    const store = await open();
    const summary = await store.save({ graph: {} }, author);
    expect(summary).toMatchObject({ nodeCount: 0, edgeCount: 0, name: untitledModelName });
  });

  it('leaves no temporary files behind', async () => {
    const store = await open();
    await Promise.all([1, 2, 3].map(() => store.save(model('m'), author)));
    expect(files().filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(files()).toHaveLength(3);
  });

  it('fails cleanly when the directory becomes read-only, then works again', async () => {
    const store = await open();
    chmodSync(dir, 0o500);
    await expect(store.save(model('m'), author)).rejects.toThrow(/EACCES/);
    chmodSync(dir, 0o700);
    expect(files()).toEqual([]);
    await store.save(model('m'), author);
    expect(files()).toHaveLength(1);
  });
});

describe('FileModelStore.list and get', () => {
  it('lists summaries newest first', async () => {
    let time = Date.UTC(2026, 0, 1);
    const store = await open({ now: () => (time += 1000) });
    const first = await store.save(model('First'), author);
    const second = await store.save(model('Second'), author);
    expect((await store.list()).map((m) => m.name)).toEqual(['Second', 'First']);
    expect(await store.list()).toEqual([second, first]);
  });

  it('reads models saved before it was opened', async () => {
    const before = await open();
    const saved = await before.save(model('Earlier'), author);
    const after = await open();
    expect(await after.list()).toEqual([saved]);
  });

  it('skips a corrupt file in the list with a warning that names the file only', async () => {
    const store = await open();
    const good = await store.save(model('Good'), author);
    const bad = await store.save(model(secretLabel), author);
    const badFile = join(dir, `${bad.id}.json`);
    writeFileSync(badFile, readFileSync(badFile, 'utf8').slice(0, 200)); // cut short

    expect(await store.list()).toEqual([good]);
    expect(warnings).toEqual([
      { details: { file: `${bad.id}.json`, reason: 'invalid' }, message: 'model file is damaged' },
    ]);
    expect(JSON.stringify(warnings)).not.toContain('secret');
    expect(JSON.stringify(warnings)).not.toContain(dir);

    // Read directly, it is a clear, user-safe error.
    await expect(store.get(bad.id)).rejects.toThrow(ModelUnreadableError);
    await expect(store.get(bad.id)).rejects.toThrow(
      'The stored model could not be read. Its file may be damaged; see the API log.',
    );
  });

  it.each([
    ['not JSON', 'model content that is not JSON', 'invalid'],
    ['JSON that is not a model', '[1, 2, 3]', 'not-a-stored-model'],
    ['a JGF document without server data', JSON.stringify(sampleModel), 'not-a-stored-model'],
    [
      'too deeply nested',
      `${'['.repeat(maxJsonDepth + 1)}${']'.repeat(maxJsonDepth + 1)}`,
      'too-deep',
    ],
    ['a reserved key', '{"graph":{"__proto__":{}}}', 'reserved-key'],
  ])('treats %s as damaged', async (_name, content, reason) => {
    const store = await open();
    const id = crypto.randomUUID();
    writeFileSync(join(dir, `${id}.json`), content);
    expect(await store.list()).toEqual([]);
    await expect(store.get(id)).rejects.toThrow(ModelUnreadableError);
    expect(warnings[0]).toEqual({
      details: { file: `${id}.json`, reason },
      message: 'model file is damaged',
    });
  });

  describe('a stored model is fully validated when it is read', () => {
    /** Saves a valid model, then changes its file on disk the way `damage` says. */
    async function damagedModel(damage: (graph: Record<string, unknown>) => void) {
      const store = await open();
      const good = await store.save(model('Good'), author);
      const bad = await store.save(model(secretLabel), author);
      const file = join(dir, `${bad.id}.json`);
      const stored = JSON.parse(readFileSync(file, 'utf8')) as { graph: Record<string, unknown> };
      damage(stored.graph);
      writeFileSync(file, JSON.stringify(stored));
      return { store: await open(), good, bad };
    }

    it.each([
      ['edges that are not a list', (graph: Record<string, unknown>) => (graph.edges = 5)],
      ['nodes that are not an object', (graph: Record<string, unknown>) => (graph.nodes = [1])],
      [
        'an edge to a node that is not there',
        (graph: Record<string, unknown>) =>
          ((graph.edges as object[])[0] = {
            source: 'customer',
            target: 'secret-missing-node',
            relation: 'Relation',
          }),
      ],
      [
        'an edge type the metamodel does not have',
        (graph: Record<string, unknown>) => {
          const edges = graph.edges as { relation: string }[];
          edges[0] = { ...edges[0], relation: 'Secret relation' };
        },
      ],
    ])(
      'treats a model with %s as damaged: left out of the list, a safe error when read',
      async (_name, damage) => {
        const { store, good, bad } = await damagedModel(damage);

        expect(await store.list()).toEqual([good]);
        await expect(store.get(bad.id)).rejects.toThrow(ModelUnreadableError);
        await expect(store.get(bad.id)).rejects.toThrow(
          "The stored model is damaged: it doesn't pass validation, so it can't be shown. See the API log.",
        );
        const warning = warnings.find((w) => JSON.stringify(w).includes(bad.id));
        expect(warning).toMatchObject({
          details: { file: `${bad.id}.json`, reason: 'invalid-model' },
          message: 'model file is damaged',
        });
        expect((warning?.details as { errors?: number }).errors).toBeGreaterThan(0);
        expect(JSON.stringify(warnings)).not.toMatch(/secret/i);
      },
    );

    it('lists damaged and unreadable files by id for Admins, and nothing else', async () => {
      const { store, good, bad } = await damagedModel((graph) => (graph.edges = 5));
      const corrupt = crypto.randomUUID();
      writeFileSync(join(dir, `${corrupt}.json`), 'not JSON');
      mkdirSync(join(dir, `${crypto.randomUUID()}.json`)); // not a file: never listed
      expect(await store.listDamaged()).toEqual([bad.id, corrupt].sort());
      expect(await store.listDamaged()).not.toContain(good.id);
      await store.delete(bad.id);
      expect(await store.listDamaged()).toEqual([corrupt]);
    });

    it('still reads a valid model, and a model of about 200 KB in linear time', async () => {
      const store = await open();
      const saveOf = async (size: number) => {
        const nodes: JgfDocument['graph']['nodes'] = {};
        const edges: NonNullable<JgfDocument['graph']['edges']> = [];
        for (let i = 0; i < size; i++) {
          nodes[`n${i}`] = {
            label: `Made-up element ${i}`,
            metadata: {
              type: 'Application',
              description:
                'A made-up description that is long enough to look like a real one. '.repeat(4),
              functions: ['Made-up function one', 'Made-up function two'],
            },
          };
        }
        for (let i = 0; i < (size * 520) / 300; i++) {
          edges.push({
            source: `n${i % size}`,
            target: `n${(i * 7 + 1) % size}`,
            relation: 'Relation',
          });
        }
        return store.save({ graph: { label: 'Large', nodes, edges } }, author);
      };
      const small = await saveOf(75);
      const saved = await saveOf(300);
      expect(statSync(join(dir, `${saved.id}.json`)).size).toBeGreaterThan(150_000);
      const read = await store.get(saved.id);
      expect(Object.keys(read?.graph.nodes ?? {})).toHaveLength(300);
      await expectGrowthBelow((id: string) => () => store.get(id), small.id, saved.id);
    });
  });

  it('treats a file whose server data names another id as damaged', async () => {
    const store = await open();
    const saved = await store.save(model('Copied'), author);
    const copy = crypto.randomUUID();
    copyFileSync(join(dir, `${saved.id}.json`), join(dir, `${copy}.json`));
    expect(await store.list()).toEqual([saved]);
    await expect(store.get(copy)).rejects.toThrow(ModelUnreadableError);
  });

  it('skips an unreadable file in the list, and reports it when read', async () => {
    const store = await open();
    const saved = await store.save(model(secretLabel), author);
    chmodSync(join(dir, `${saved.id}.json`), 0o000);
    const fresh = await open(); // nothing cached
    expect(await fresh.list()).toEqual([]);
    await expect(fresh.get(saved.id)).rejects.toThrow(ModelUnreadableError);
    expect(warnings).toContainEqual({
      details: { file: `${saved.id}.json`, reason: 'EACCES' },
      message: 'model file could not be read',
    });
  });

  it('parses a file once, and again only when it changes', async () => {
    const store = await open();
    const id = crypto.randomUUID();
    const file = join(dir, `${id}.json`);
    writeFileSync(file, 'damaged');
    await store.list();
    await store.list();
    expect(warnings).toHaveLength(1); // the second list used the cached result

    const source = await store.save(model('Repaired'), author);
    writeFileSync(
      file,
      readFileSync(join(dir, `${source.id}.json`), 'utf8').replaceAll(source.id, id),
    );
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect((await store.list()).map((m) => m.id).sort()).toEqual([id, source.id].sort());
  });

  it('ignores files that are not models', async () => {
    const store = await open();
    writeFileSync(join(dir, 'notes.json'), '{}');
    writeFileSync(join(dir, `${crypto.randomUUID().toUpperCase()}.json`), '{}');
    mkdirSync(join(dir, `${crypto.randomUUID()}.json.d`));
    expect(await store.list()).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it.each([
    '../outside',
    '..%2Foutside',
    'outside',
    '',
    '.',
    `${crypto.randomUUID()}/../outside`,
    crypto.randomUUID().toUpperCase(),
    `${crypto.randomUUID()}.json`,
    `${crypto.randomUUID()}\u0000`,
  ])('never reads or deletes outside the store: %j is not found', async (id) => {
    const store = await open();
    writeFileSync(join(root, 'outside.json'), JSON.stringify(sampleModel));
    expect(await store.get(id)).toBeUndefined();
    expect(await store.delete(id)).toBeUndefined();
    expect(existsSync(join(root, 'outside.json'))).toBe(true);
  });

  it('returns undefined for an unknown id', async () => {
    const store = await open();
    expect(await store.get(crypto.randomUUID())).toBeUndefined();
  });
});

describe('FileModelStore.delete', () => {
  it('removes the file and returns the summary', async () => {
    const store = await open();
    const saved = await store.save(model('Gone'), author);
    expect(await store.delete(saved.id)).toEqual({ id: saved.id, summary: saved });
    expect(files()).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect(await store.get(saved.id)).toBeUndefined();
    expect(await store.delete(saved.id)).toBeUndefined();
  });

  it('deletes a damaged model too', async () => {
    const store = await open();
    const id = crypto.randomUUID();
    writeFileSync(join(dir, `${id}.json`), 'damaged');
    expect(await store.delete(id)).toEqual({ id, summary: undefined });
    expect(files()).toEqual([]);
  });
});

describe('the cap on stored models', () => {
  it(`refuses a save beyond ${maxStoredModels} models with a clear error`, async () => {
    const store = await open();
    const saved = await store.save(model('Template'), author);
    const text = readFileSync(join(dir, `${saved.id}.json`), 'utf8');
    for (let i = 1; i < maxStoredModels; i += 1) {
      const id = crypto.randomUUID();
      writeFileSync(join(dir, `${id}.json`), text.replaceAll(saved.id, id));
    }
    expect(await store.list()).toHaveLength(maxStoredModels);

    const full = store.save(model('One too many'), author);
    await expect(full).rejects.toThrow(ModelStoreFullError);
    await expect(full).rejects.toThrow(
      `The model store is full (${maxStoredModels} models). Delete a model before saving another.`,
    );
    expect(files()).toHaveLength(maxStoredModels);

    await store.delete(saved.id);
    await expect(store.save(model('Fits again'), author)).resolves.toMatchObject({
      name: 'Fits again',
    });
  });

  it('counts damaged files, which take up room until deleted', async () => {
    const store = await open({ maxModels: 2 });
    writeFileSync(join(dir, `${crypto.randomUUID()}.json`), 'damaged');
    await store.save(model('a'), author);
    await expect(store.save(model('b'), author)).rejects.toThrow(ModelStoreFullError);
  });
});

describe('concurrency (one process)', () => {
  it('never overshoots the cap when many saves race', async () => {
    const store = await open({ maxModels: 10 });
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) => store.save(model(`Race ${i}`), author)),
    );
    const saved = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof ModelStoreFullError,
    );
    expect(saved).toHaveLength(10);
    expect(refused).toHaveLength(15);
    expect(files()).toHaveLength(10);
    expect(new Set(saved.map((r) => r.value.id)).size).toBe(10);
  });

  it('keeps a consistent state when saves, deletes and reads interleave', async () => {
    const store = await open();
    const first = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.save(model(`Old ${i}`), author)),
    );
    const [deleted, added, lists] = await Promise.all([
      Promise.all(first.map((m) => store.delete(m.id))),
      Promise.all(Array.from({ length: 10 }, (_, i) => store.save(model(`New ${i}`), author))),
      Promise.all(Array.from({ length: 10 }, () => store.list())),
    ]);
    expect(deleted.every((d) => d !== undefined)).toBe(true);
    for (const list of lists) {
      // Each list sees whole models only, never a half-written one.
      for (const summary of list) expect(summary.nodeCount).toBe(6);
    }
    const final = await store.list();
    expect(final.map((m) => m.id).sort()).toEqual(added.map((m) => m.id).sort());
    expect(files()).toHaveLength(10);
    expect(warnings).toEqual([]);
  });

  it('deletes a model once when two deletes race', async () => {
    const store = await open();
    const saved = await store.save(model('Twice'), author);
    const results = await Promise.all([store.delete(saved.id), store.delete(saved.id)]);
    expect(results.filter((r) => r !== undefined)).toHaveLength(1);
  });

  it('keeps working after a failed save', async () => {
    const store = await open({ maxModels: 1 });
    await store.save(model('a'), author);
    const [failed, next] = await Promise.allSettled([store.save(model('b'), author), store.list()]);
    expect(failed.status).toBe('rejected');
    expect(next.status).toBe('fulfilled');
  });
});

// Entries in DATA_DIR that aren't regular files. Only someone with access
// to the folder (700) can create them, but the store must stay usable and free their slots.
describe('entries that are not regular files', () => {
  /** Opens a FIFO for writing without blocking, which releases any reader stuck on it. */
  function releaseFifo(path: string): void {
    try {
      closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {
      // No reader is waiting.
    }
  }

  // Reading a FIFO blocked a libuv thread until a writer opened it. List never
  // answered, and after four attempts every file operation of the API hung too.
  it('skips a FIFO named like a model instead of hanging', async () => {
    const store = await open();
    const saved = await store.save(model('Fine'), author);
    const id = crypto.randomUUID();
    const fifo = join(dir, `${id}.json`);
    execFileSync('mkfifo', [fifo]);
    try {
      const listed = await Promise.race([
        store.list(),
        new Promise<'hung'>((resolve) => {
          setTimeout(() => {
            resolve('hung');
          }, 1000);
        }),
      ]);
      expect(listed).toEqual([saved]);
      await expect(store.get(id)).rejects.toThrow(ModelUnreadableError);
      expect(await store.delete(id)).toEqual({ id, summary: undefined });
    } finally {
      releaseFifo(fifo);
    }
  });

  // A directory named like a model couldn't be deleted (unlink failed, the route
  // answered 500), and a broken symlink took a place under the cap, was never listed, and delete
  // said 404.
  it('deletes a directory or a broken symlink named like a model', async () => {
    const store = await open({ maxModels: 2 });
    const folder = crypto.randomUUID();
    mkdirSync(join(dir, `${folder}.json`));
    const broken = crypto.randomUUID();
    symlinkSync(join(root, 'missing-target.json'), join(dir, `${broken}.json`));
    expect(await store.list()).toEqual([]);
    expect(await store.delete(folder)).toEqual({ id: folder, summary: undefined });
    expect(await store.delete(broken)).toEqual({ id: broken, summary: undefined });
    expect(files()).toEqual([]);
    await store.save(model('a'), author);
    await store.save(model('b'), author);
  });

  // A symlink is no longer opened and found damaged. It is not a
  // regular file, so it is never followed at all: not listed, not read, not counted, logged once.
  // That also covers a symlink to a valid model outside DATA_DIR, which used to be listed and served.
  it('never follows a symlink named like a model, and delete removes only the link', async () => {
    const store = await open();
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, secretLabel);
    const id = crypto.randomUUID();
    symlinkSync(outside, join(dir, `${id}.json`));

    // A symlink to a valid stored model outside DATA_DIR is not served either.
    const elsewhere = await FileModelStore.open(join(root, 'elsewhere'), {
      log: { warn: () => undefined },
    });
    const valid = await elsewhere.save(model('Outside'), author);
    symlinkSync(join(root, 'elsewhere', `${valid.id}.json`), join(dir, `${valid.id}.json`));

    expect(await store.list()).toEqual([]);
    await store.list();
    await expect(store.get(id)).rejects.toThrow(ModelUnreadableError);
    await expect(store.get(valid.id)).rejects.toThrow(ModelUnreadableError);
    const skipped = (file: string) => ({
      details: { file, reason: 'not-a-regular-file', kind: 'symlink' },
      message: 'entry skipped',
    });
    expect(warnings).toEqual(
      expect.arrayContaining([skipped(`${id}.json`), skipped(`${valid.id}.json`)]),
    );
    expect(warnings).toHaveLength(2); // once each, however often listed or read
    expect(JSON.stringify(warnings)).not.toContain(secretLabel);

    expect(await store.delete(id)).toEqual({ id, summary: undefined });
    expect(await store.delete(valid.id)).toEqual({ id: valid.id, summary: undefined });
    expect(files()).toEqual([]);
    expect(readFileSync(outside, 'utf8')).toBe(secretLabel);
    expect(await elsewhere.list()).toEqual([valid]);
  });
});

describe("sourceId: the client's own graph id", () => {
  it('is kept in the server data and the summary', async () => {
    const store = await open();
    const saved = await store.save(model('With id', { id: 'id-5f2c-oef-model' }), author);
    expect(saved.sourceId).toBe('id-5f2c-oef-model');
    const stored = await store.get(saved.id);
    expect(stored?.graph.id).toBe(saved.id);
    expect(stored?.graph.metadata?.[storedModelKey]).toEqual(saved);
    expect(await store.list()).toEqual([saved]);
  });

  it('is absent when the client sent no id, or an empty one', async () => {
    const store = await open();
    for (const extra of [{}, { id: '' }, { id: '   ' }]) {
      const document = model('No id', extra);
      if (!('id' in extra)) delete document.graph.id;
      const saved = await store.save(document, author);
      expect(saved).not.toHaveProperty('sourceId');
    }
  });

  it(`is cut to ${maxSourceIdLength} characters, never inside a surrogate pair`, async () => {
    const store = await open();
    const long = await store.save(model('Long', { id: 'x'.repeat(5000) }), author);
    expect(long.sourceId).toBe(`${'x'.repeat(maxSourceIdLength)}…`);
    const emoji = await store.save(
      model('Emoji', { id: `${'x'.repeat(maxSourceIdLength - 1)}🍞🍞` }),
      author,
    );
    expect(emoji.sourceId).toBe(`${'x'.repeat(maxSourceIdLength - 1)}…`);
  });

  it('reads files written before sourceId existed, and files with fields from a newer version', async () => {
    const store = await open();
    const saved = await store.save(model('Older', { id: 'to-be-removed' }), author);
    const file = join(dir, `${saved.id}.json`);
    const document = JSON.parse(readFileSync(file, 'utf8')) as JgfDocument;
    const meta = document.graph.metadata ?? {};

    const older: Partial<typeof saved> = { ...saved };
    delete older.sourceId;
    meta[storedModelKey] = older;
    writeFileSync(file, JSON.stringify(document));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(await store.list()).toEqual([older]);

    meta[storedModelKey] = { ...saved, updatedAt: '2030-01-01T00:00:00.000Z', tags: ['x'] };
    writeFileSync(file, JSON.stringify(document));
    utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    // Listed (not damaged), and the unknown fields are left out of the summary.
    expect(await store.list()).toEqual([saved]);
    expect(warnings).toEqual([]);
  });
});

describe('entries that are not regular files, at startup', () => {
  it('starts with a FIFO in DATA_DIR without hanging, and never counts it', async () => {
    mkdirSync(dir, { recursive: true });
    const fifo = join(dir, `${crypto.randomUUID()}.json`);
    execFileSync('mkfifo', [fifo]);
    const opened = await Promise.race([
      open({ maxModels: 1 }),
      new Promise<'hung'>((resolve) => {
        setTimeout(() => {
          resolve('hung');
        }, 2000);
      }),
    ]);
    expect(opened).not.toBe('hung');
    if (opened === 'hung') return;
    // The FIFO takes no place under the cap.
    await expect(opened.save(model('Fits'), author)).resolves.toMatchObject({ name: 'Fits' });
    expect(warnings.map((w) => w.details)).toContainEqual({
      file: fifo.slice(dir.length + 1),
      reason: 'not-a-regular-file',
      kind: 'fifo',
    });
  });

  it('refuses to delete a folder that is not empty, with a clear error', async () => {
    const store = await open();
    const id = crypto.randomUUID();
    mkdirSync(join(dir, `${id}.json`));
    writeFileSync(join(dir, `${id}.json`, 'inside.txt'), 'kept');
    await expect(store.delete(id)).rejects.toThrow(ModelNotDeletableError);
    expect(readFileSync(join(dir, `${id}.json`, 'inside.txt'), 'utf8')).toBe('kept');
    expect(await store.list()).toEqual([]);
  });

  it('cleans up only temporary files that are regular files at startup', async () => {
    mkdirSync(dir, { recursive: true });
    const folder = `.probe.${'a'.repeat(16)}.tmp`;
    mkdirSync(join(dir, folder));
    await open(); // no longer refuses to start
    expect(files()).toEqual([folder]);
  });
});

describe('the size limit on model files', () => {
  it('never reads a file over the limit', async () => {
    const store = await open({ maxFileBytes: 4000 });
    const saved = await store.save(model('Small'), author);
    const file = join(dir, `${saved.id}.json`);
    const document = JSON.parse(readFileSync(file, 'utf8')) as JgfDocument;
    (document.graph.metadata ?? {}).padding = 'p'.repeat(5000);
    writeFileSync(file, JSON.stringify(document));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));

    expect(await store.list()).toEqual([]);
    await expect(store.get(saved.id)).rejects.toThrow(ModelUnreadableError);
    expect(warnings[0]).toEqual({
      details: { file: `${saved.id}.json`, reason: 'too-large' },
      message: 'model file is too large',
    });
    expect(await store.delete(saved.id)).toEqual({ id: saved.id, summary: undefined });
  });

  it('never writes a file it would refuse to read', async () => {
    const store = await open({ maxFileBytes: 4000 });
    const big = model('Big', { metadata: { padding: 'p'.repeat(5000) } });
    await expect(store.save(big, author)).rejects.toThrow(ModelTooLargeError);
    await expect(store.save(big, author)).rejects.toThrow(
      'The model is too large to store (more than 4000 bytes).',
    );
    expect(files()).toEqual([]);
  });
});

describe('DATA_DIR location and permissions', () => {
  it.each([
    ['~/models', join('/home/someone', 'models')],
    ['~', '/home/someone'],
    ['data', join(repoRoot, 'data')],
    ['/srv/models', '/srv/models'],
  ])('resolves %s to %s', (value, expected) => {
    expect(resolveDataDir(value, '/home/someone')).toBe(expected);
  });

  it('refuses ~user with a clear message', () => {
    expect(() => resolveDataDir('~someone/models')).toThrow(
      'DATA_DIR ~someone/models is not supported: only a leading ~/ (your home directory) is expanded. Use an absolute path.',
    );
  });

  it.each([
    ['the file-system root', '/'],
    ['the repo root', repoRoot],
    ['a parent of the repo root', dirname(repoRoot)],
    ['the home directory', homedir()],
  ])('refuses %s, before touching it', async (_name, path) => {
    expect(() => {
      checkDataDirLocation(path);
    }).toThrow(/is not allowed: it is /);
    await expect(FileModelStore.open(path, { log: { warn: () => undefined } })).rejects.toThrow(
      ModelStoreError,
    );
  });

  it('allows a folder inside the repo or the home directory', () => {
    expect(() => {
      checkDataDirLocation(join(repoRoot, 'data'));
    }).not.toThrow();
    expect(() => {
      checkDataDirLocation('/home/someone/models', { home: '/home/someone', repoRoot: '/repo' });
    }).not.toThrow();
    expect(() => {
      checkDataDirLocation('/home/someone', { home: '/home/someone', repoRoot: '/repo' });
    }).toThrow(/your home directory/);
  });

  it('refuses a symlink that leads to the repo root', async () => {
    symlinkSync(repoRoot, dir);
    await expect(open()).rejects.toThrow(/is not allowed: it is the repo root/);
  });

  it('never makes a read-only folder writable', async () => {
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    await expect(open()).rejects.toThrow(
      `DATA_DIR ${dir} is not a writable directory (EACCES). The API never widens a folder's permissions: use a folder the API's user can write to.`,
    );
    expect(mode(dir)).toBe(0o500);
  });

  it('removes group and other permissions from a 777 folder', async () => {
    mkdirSync(dir);
    chmodSync(dir, 0o777);
    await open();
    expect(mode(dir)).toBe(0o700);
  });
});
