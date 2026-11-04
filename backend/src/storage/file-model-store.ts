import { randomBytes, randomUUID } from 'node:crypto';
import { constants, type Dirent, type Stats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { JgfDocument, ModelAuthor, ModelSummary } from '@simplearchitecture/shared';
import { convertOlderTypes } from '../jgf/older-types.js';
import { JgfJsonError, parseJgfJson } from '../jgf/parse.js';
import { validateJgf } from '../jgf/validate.js';
import { maxModelFileBytes, maxStoredModels, modelReadConcurrency } from '../limits.js';
import { checkDataDirLocation, realPlaces } from './data-dir.js';
import {
  isModelId,
  ModelNotDeletableError,
  ModelStoreError,
  ModelStoreFullError,
  ModelTooLargeError,
  ModelUnreadableError,
  type DeletedModel,
  type ModelStore,
} from './model-store.js';
import {
  isPlainObject,
  mapLimited,
  newestFirst,
  newSummary,
  recordedSummary,
  storedDocument,
  untitledModelName,
  type StoreLogger,
} from './stored-model.js';

export { untitledModelName, type StoreLogger };

export interface FileModelStoreOptions {
  log: StoreLogger;
  /** Clock for `createdAt` (tests). */
  now?: () => number;
  /** Most models the store holds (tests). Default: maxStoredModels. */
  maxModels?: number;
  /** Largest model file written or read, in bytes (tests). Default: maxModelFileBytes. */
  maxFileBytes?: number;
}

const modelFilePattern =
  /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
// Temporary files: written, synced, then renamed over the final name. Left over only by a crash.
const tempFilePattern = /^\.(?:probe|[0-9a-f-]{36})\.[0-9a-f]{16}\.tmp$/;

// Opens a model file for reading without ever following a symlink (where the platform has
// O_NOFOLLOW) or waiting on a FIFO (O_NONBLOCK, which changes nothing for regular files).
const optionalFlags = constants as Partial<Record<'O_NOFOLLOW' | 'O_NONBLOCK', number>>;
const readFlags =
  constants.O_RDONLY | (optionalFlags.O_NOFOLLOW ?? 0) | (optionalFlags.O_NONBLOCK ?? 0);

interface CacheEntry {
  /** The file's identity when it was read: a changed file is read again. */
  version: string;
  /** Undefined when the file is unreadable or damaged (already logged). */
  summary: ModelSummary | undefined;
}

type ReadResult =
  | { ok: true; document: JgfDocument; summary: ModelSummary }
  | { ok: false; reason: string; errors?: number };

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** False when the file system didn't report the entry's type in the directory listing. */
function hasType(entry: Dirent): boolean {
  return entry.isFile() || kindOf(entry) !== 'other';
}

/** What kind of entry this is, for the log: never a name from inside a file. */
function kindOf(entry: Dirent | Stats): string {
  if (entry.isDirectory()) return 'directory';
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isFIFO()) return 'fifo';
  if (entry.isSocket()) return 'socket';
  if (entry.isBlockDevice() || entry.isCharacterDevice()) return 'device';
  return 'other';
}

/**
 * Checks a stored file and returns the model with its server-owned data. Never echoes content.
 * The model is fully validated again: a file changed or damaged on disk must never reach a
 * client as a model it can't handle. Validation takes milliseconds for a real model.
 */
function parseStoredModel(id: string, text: string): ReadResult {
  let document: unknown;
  try {
    // A file with an older edge type reads converted: its type isn't damage.
    document = convertOlderTypes(parseJgfJson(text)).document;
  } catch (error) {
    return { ok: false, reason: error instanceof JgfJsonError ? error.reason : 'invalid' };
  }
  const graph = isPlainObject(document) ? document.graph : undefined;
  if (!isPlainObject(graph) || graph.id !== id || !isPlainObject(graph.metadata)) {
    return { ok: false, reason: 'not-a-stored-model' };
  }
  const summary = recordedSummary(document, id);
  if (summary === undefined) return { ok: false, reason: 'missing-server-data' };
  const validation = validateJgf(document);
  if (!validation.valid) {
    return { ok: false, reason: 'invalid-model', errors: validation.errorCount };
  }
  return { ok: true, document: document as JgfDocument, summary };
}

/**
 * Models as JGF files, one per model: `<id>.json` in one directory (DATA_DIR), owner-only
 * (directory 700, files 600). Each file is a complete JGF document; the server-owned data lives in
 * `graph.id` and `graph.metadata["simplearchitecture:stored"]`, so a file is self-describing.
 *
 * - Writes are atomic: a temporary file in the same directory is written, synced and renamed, and
 *   the directory is synced too.
 * - Only regular files are models. Anything else with a model's name (a folder, symlink, FIFO,
 *   socket or device) is never opened or followed, isn't listed, doesn't count towards the cap,
 *   and is logged once. A file over the size limit is never read.
 * - Saves and deletes run one at a time (a promise queue), so the cap can't be overshot. This
 *   holds within one process only: run a single API process against a DATA_DIR.
 * - The list keeps each model's summary in memory, keyed by the file's identity (inode, size,
 *   mtime). Each list reads the directory and checks the files, and only parses new or changed
 *   ones, a few at a time.
 */
export class FileModelStore implements ModelStore {
  readonly #dir: string;
  readonly #log: StoreLogger;
  readonly #now: () => number;
  readonly #maxModels: number;
  readonly #maxFileBytes: number;
  readonly #cache = new Map<string, CacheEntry>();
  /** Entries with a model's name that aren't regular files, by name → kind, logged once. */
  readonly #notFiles = new Map<string, string>();
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(dir: string, options: FileModelStoreOptions) {
    this.#dir = dir;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
    this.#maxModels = options.maxModels ?? maxStoredModels;
    this.#maxFileBytes = options.maxFileBytes ?? maxModelFileBytes;
  }

  /**
   * Opens the store: refuses a dangerous location, creates the directory if needed, removes group
   * and other permissions (it never adds any), checks that a file can be written, removes
   * temporary files left by a crash and reads every model's summary once. Throws ModelStoreError
   * when the directory can't be used.
   */
  static async open(dir: string, options: FileModelStoreOptions): Promise<FileModelStore> {
    checkDataDirLocation(dir);
    const store = new FileModelStore(dir, options);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // A symlink may lead somewhere the location rules forbid.
      const real = await realpath(dir);
      checkDataDirLocation(real, await realPlaces());
      const info = await lstat(real);
      if (!info.isDirectory()) throw Object.assign(new Error(), { code: 'ENOTDIR' });
      const ownerOnly = info.mode & 0o700;
      if ((info.mode & 0o777) !== ownerOnly) await chmod(real, ownerOnly);
      const probe = join(dir, `.probe.${randomBytes(8).toString('hex')}.tmp`);
      await store.#writeAtomically(probe, '');
      await unlink(probe);
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!tempFilePattern.test(entry.name)) continue;
        if (entry.isFile()) await rm(join(dir, entry.name), { force: true });
        else store.#notAFile(entry.name, kindOf(entry));
      }
    } catch (error) {
      if (error instanceof ModelStoreError) throw error;
      throw new ModelStoreError(
        `DATA_DIR ${dir} is not a writable directory (${errorCode(error) ?? 'error'}). The API never widens a folder's permissions: use a folder the API's user can write to.`,
      );
    }
    await store.list();
    return store;
  }

  async list(): Promise<ModelSummary[]> {
    const ids = await this.#modelIds();
    const present = new Set(ids);
    for (const id of this.#cache.keys()) if (!present.has(id)) this.#cache.delete(id);
    const entries = await mapLimited(ids, modelReadConcurrency, (id) => this.#entry(id));
    return entries.flatMap((entry) => (entry?.summary ? [entry.summary] : [])).sort(newestFirst);
  }

  async listDamaged(): Promise<string[]> {
    const ids = await this.#modelIds();
    const entries = await mapLimited(ids, modelReadConcurrency, (id) => this.#entry(id));
    return ids.filter((_id, index) => entries[index] && !entries[index].summary).sort();
  }

  async get(id: string): Promise<JgfDocument | undefined> {
    if (!isModelId(id)) return undefined;
    const result = await this.#read(id);
    if (result === undefined) return undefined;
    if (!result.ok) throw new ModelUnreadableError(id, result.reason === 'invalid-model');
    return result.document;
  }

  save(document: JgfDocument, createdBy: ModelAuthor): Promise<ModelSummary> {
    return this.#exclusive(async () => {
      if ((await this.#modelIds()).length >= this.#maxModels) {
        throw new ModelStoreFullError(this.#maxModels);
      }
      const summary = newSummary(randomUUID(), document, createdBy, this.#now());
      const { id } = summary;
      const stored = storedDocument(document, summary);
      const text = JSON.stringify(stored);
      // A file the store would refuse to read is never written.
      if (Buffer.byteLength(text, 'utf8') > this.#maxFileBytes) {
        throw new ModelTooLargeError(this.#maxFileBytes);
      }
      const file = this.#path(id);
      await this.#writeAtomically(file, text);
      this.#cache.set(id, { version: this.#versionOf(await lstat(file)), summary });
      return summary;
    });
  }

  delete(id: string): Promise<DeletedModel | undefined> {
    if (!isModelId(id)) return Promise.resolve(undefined);
    return this.#exclusive(async () => {
      const path = this.#path(id);
      let info: Stats;
      try {
        info = await lstat(path);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
      }
      // Not a model file: remove the entry itself (never what a symlink points to), if it can be.
      if (!info.isFile()) {
        this.#notAFile(`${id}.json`, kindOf(info));
        try {
          await (info.isDirectory() ? rmdir(path) : unlink(path));
        } catch (error) {
          if (errorCode(error) === 'ENOENT') return undefined;
          this.#log.warn(
            { file: `${id}.json`, reason: errorCode(error) ?? 'error' },
            'entry could not be deleted',
          );
          throw new ModelNotDeletableError(id);
        }
        this.#notFiles.delete(`${id}.json`);
        await this.#syncDirectory();
        return { id, summary: undefined };
      }
      const entry = await this.#entry(id);
      try {
        await unlink(path);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
      }
      this.#cache.delete(id);
      await this.#syncDirectory();
      return { id, summary: entry?.summary };
    });
  }

  /** Runs saves and deletes one after another, whatever happens to the one before. */
  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  #path(id: string): string {
    return join(this.#dir, `${id}.json`);
  }

  /** Logs, once per name and kind, an entry with a model's name that isn't a regular file. */
  #notAFile(name: string, kind: string): void {
    if (this.#notFiles.get(name) === kind) return;
    this.#notFiles.set(name, kind);
    this.#log.warn({ file: name, reason: 'not-a-regular-file', kind }, 'entry skipped');
  }

  /** Ids of the regular files with a model's name. Other entries are skipped (and logged once). */
  async #modelIds(): Promise<string[]> {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const entry of await readdir(this.#dir, { withFileTypes: true })) {
      const id = modelFilePattern.exec(entry.name)?.[1];
      if (id === undefined) continue;
      // Some file systems don't report the type in the listing: then ask, without following links.
      const typed: Dirent | Stats | undefined = hasType(entry)
        ? entry
        : await lstat(join(this.#dir, entry.name)).catch(() => undefined);
      if (typed?.isFile()) {
        ids.push(id);
      } else if (typed !== undefined) {
        seen.add(entry.name);
        this.#notAFile(entry.name, kindOf(typed));
      }
    }
    for (const name of this.#notFiles.keys()) if (!seen.has(name)) this.#notFiles.delete(name);
    return ids;
  }

  #versionOf(info: Stats): string {
    return `${info.ino}:${info.size}:${info.mtimeMs}`;
  }

  /** The cached summary of a model, read again if the file changed. Undefined if there is none. */
  async #entry(id: string): Promise<CacheEntry | undefined> {
    let info: Stats;
    try {
      info = await lstat(this.#path(id));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        this.#log.warn({ file: `${id}.json`, reason: errorCode(error) }, 'model file skipped');
        return { version: '', summary: undefined };
      }
      this.#cache.delete(id);
      return undefined;
    }
    if (!info.isFile()) {
      this.#notAFile(`${id}.json`, kindOf(info));
      return undefined;
    }
    const version = this.#versionOf(info);
    const cached = this.#cache.get(id);
    if (cached?.version === version) return cached;
    const result = await this.#read(id);
    if (result === undefined) {
      this.#cache.delete(id);
      return undefined;
    }
    const entry = { version, summary: result.ok ? result.summary : undefined };
    this.#cache.set(id, entry);
    return entry;
  }

  /**
   * Reads and checks one model file. Undefined if there is none; problems are logged. Only a
   * regular file within the size limit is read: anything else is never opened, or is closed
   * unread.
   */
  async #read(id: string): Promise<ReadResult | undefined> {
    const file = `${id}.json`;
    const path = this.#path(id);
    const fail = (reason: string, message: string): ReadResult => {
      this.#log.warn({ file, reason }, message);
      return { ok: false, reason };
    };
    let text: string;
    try {
      const before = await lstat(path);
      if (!before.isFile()) {
        this.#notAFile(file, kindOf(before));
        return { ok: false, reason: 'not-a-regular-file' };
      }
      const handle = await open(path, readFlags);
      try {
        // Checked again on the open file, in case the entry was swapped since.
        const info = await handle.stat();
        if (!info.isFile()) {
          this.#notAFile(file, kindOf(info));
          return { ok: false, reason: 'not-a-regular-file' };
        }
        if (info.size > this.#maxFileBytes) return fail('too-large', 'model file is too large');
        const buffer = Buffer.alloc(info.size);
        let length = 0;
        while (length < info.size) {
          const { bytesRead } = await handle.read(buffer, length, info.size - length, length);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        text = buffer.toString('utf8', 0, length);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      return fail(errorCode(error) ?? 'read-error', 'model file could not be read');
    }
    const result = parseStoredModel(id, text);
    if (!result.ok) {
      const errors = result.errors === undefined ? {} : { errors: result.errors };
      this.#log.warn({ file, reason: result.reason, ...errors }, 'model file is damaged');
    }
    return result;
  }

  /** Makes a rename or unlink durable where the platform allows syncing a directory. */
  async #syncDirectory(): Promise<void> {
    let handle;
    try {
      handle = await open(this.#dir, constants.O_RDONLY);
      await handle.sync();
    } catch {
      // Not supported here (e.g. Windows can't open a directory): the rename itself still holds.
    } finally {
      await handle?.close();
    }
  }

  /** Writes a file that is never seen half-written: a synced temporary file, then a rename. */
  async #writeAtomically(file: string, text: string): Promise<void> {
    const temp = join(this.#dir, `.${randomUUID()}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.chmod(0o600); // the umask may have removed bits; never more than 600
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    await this.#syncDirectory();
  }
}
