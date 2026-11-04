import { readFileSync } from 'node:fs';
import { storedModelKey, type JgfDocument, type ModelAuthor } from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';
import { sampleModel } from '../src/jgf/sample.js';
import { validateJgf } from '../src/jgf/validate.js';
import { maxModelNameLength, maxSourceIdLength } from '../src/limits.js';
import { convertOef } from '../src/oef/mapper.js';
import {
  ModelStoreFullError,
  ModelTooLargeError,
  ModelUnreadableError,
  type ModelStore,
} from '../src/storage/model-store.js';
import { storedDocument, untitledModelName } from '../src/storage/stored-model.js';
import { agreedMapping } from './helpers.js';

/**
 * The behaviour every ModelStore shares, run against the file store and the PostgreSQL store.
 * Store-specific behaviour (files, permissions, rows) is tested next to each store.
 */
export interface StoreHarness {
  open(options?: {
    now?: () => number;
    maxModels?: number;
    maxBytes?: number;
  }): Promise<ModelStore>;
  /** Changes a stored model behind the store's back: its first edge gets a made-up type. */
  damage(id: string): Promise<void>;
  /** The warnings the store logged since the test started. */
  warnings(): { details: object; message: string }[];
}

const author: ModelAuthor = { id: 'oid-0001', name: 'Made-up Modeller' };
const secretLabel = 'Made-up secret model label';

export function model(label?: string, extra: Partial<JgfDocument['graph']> = {}): JgfDocument {
  const graph = structuredClone(sampleModel.graph);
  delete graph.label;
  return { graph: { ...graph, ...(label === undefined ? {} : { label }), ...extra } };
}

/** JSON with every object's keys sorted: equal text means equal documents, values and all. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/** Made-up documents of every shape a stored model can have. */
export function roundTripDocuments(): [string, JgfDocument][] {
  const bakery = readFileSync(new URL('./fixtures/bakery-oef.xml', import.meta.url), 'utf8');
  const odd: JgfDocument = {
    graph: {
      id: 'odd-shapes',
      label: 'Odd shapes ✨ 漢字',
      type: 'made-up-type',
      directed: false,
      metadata: { owner: 'Made-up team', nested: { list: [1, 2.5, -0.125, null, true, 'x'] } },
      nodes: {
        '42': { label: 'A number-like id', metadata: { type: 'Application' } },
        'no-label': { metadata: { type: 'Business', description: '' } },
        'emoji-👍': {
          label: '👍 thumbs',
          metadata: { type: 'Other', count: 1e21, deep: { a: { b: { c: [] } } } },
        },
        'type-not-first': { label: 'T', metadata: { description: 'd', type: 'Stakeholder' } },
      },
      edges: [
        { source: '42', target: 'no-label', relation: 'Relation' },
        {
          id: 'e-2',
          source: 'emoji-👍',
          target: '42',
          relation: 'Relation',
          directed: true,
          label: 'Edge label',
          metadata: { data: 'Made-up data', architectureState: 'Target', note: 'Made-up note' },
        },
        { id: 'e-3', source: '42', target: 'type-not-first', relation: 'Contains' },
      ],
    },
  };
  return [
    ['the sample model', sampleModel],
    ['the OEF fixture, converted', convertOef(bakery, agreedMapping).jgf],
    ['a model with odd but valid shapes', odd],
    ['an empty model', { graph: {} }],
    ['a model with empty nodes and edges', { graph: { label: 'Empty', nodes: {}, edges: [] } }],
  ];
}

export function describeModelStoreContract(name: string, setup: () => StoreHarness): void {
  describe(`${name}: the ModelStore contract`, () => {
    const harness = setup();

    it('saves a model under a new UUID with server-owned data, and reads it back', async () => {
      const store = await harness.open({ now: () => Date.UTC(2026, 9, 26, 12) });
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
      const stored = await store.get(summary.id);
      expect(validateJgf(stored)).toMatchObject({ valid: true, errorCount: 0, warningCount: 0 });
      expect(stored?.graph.id).toBe(summary.id);
      expect(stored?.graph.label).toBe('  Shop landscape  ');
      expect(stored?.graph.metadata?.[storedModelKey]).toEqual(summary);
      expect(stored?.graph.nodes).toStrictEqual(sampleModel.graph.nodes);
      expect(stored?.graph.edges).toStrictEqual(sampleModel.graph.edges);
      // The order of the nodes is kept.
      expect(Object.keys(stored?.graph.nodes ?? {})).toEqual(
        Object.keys(sampleModel.graph.nodes ?? {}),
      );
    });

    it.each(roundTripDocuments())('round-trips %s exactly', async (_name, document) => {
      expect(validateJgf(document).valid).toBe(true);
      const store = await harness.open();
      const summary = await store.save(document, author);
      const expected = storedDocument(document, summary);
      const stored = await store.get(summary.id);
      expect(stored).toStrictEqual(expected);
      expect(canonical(stored)).toBe(canonical(expected));
      expect(Object.keys(stored?.graph.nodes ?? {})).toEqual(
        Object.keys(document.graph.nodes ?? {}),
      );
      // And again from a fresh store (nothing from memory).
      expect(canonical(await (await harness.open()).get(summary.id))).toBe(canonical(expected));
    });

    it('replaces the id and server data a client sent, and keeps its other metadata', async () => {
      const store = await harness.open();
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
      expect(summary.sourceId).toBe('client-id');
    });

    it('names a model without a usable label, and cuts a long one', async () => {
      const store = await harness.open();
      expect((await store.save(model(), author)).name).toBe(untitledModelName);
      expect((await store.save(model('   '), author)).name).toBe(untitledModelName);
      const long = await store.save(model('n'.repeat(5000)), author);
      expect(long.name).toBe(`${'n'.repeat(maxModelNameLength)}…`);
      expect((await store.list()).map((summary) => summary.name)).toContain(long.name);
    });

    it('lists summaries newest first, also from a store opened later', async () => {
      let time = Date.UTC(2026, 0, 1);
      const store = await harness.open({ now: () => (time += 1000) });
      const first = await store.save(model('First'), author);
      const second = await store.save(model('Second'), author);
      expect(await store.list()).toEqual([second, first]);
      expect(await (await harness.open()).list()).toEqual([second, first]);
    });

    it('returns undefined for an unknown id or one that is not a UUID', async () => {
      const store = await harness.open();
      expect(await store.get(crypto.randomUUID())).toBeUndefined();
      expect(await store.get('../etc/passwd')).toBeUndefined();
      expect(await store.delete(crypto.randomUUID())).toBeUndefined();
      expect(await store.delete("x' or '1'='1")).toBeUndefined();
    });

    it('deletes a model and returns its summary, once', async () => {
      const store = await harness.open();
      const summary = await store.save(model('Gone soon'), author);
      expect(await store.delete(summary.id)).toEqual({ id: summary.id, summary });
      expect(await store.get(summary.id)).toBeUndefined();
      expect(await store.list()).toEqual([]);
      expect(await store.delete(summary.id)).toBeUndefined();
    });

    it('stores an exported model again as a new one, with the same elements and relationships', async () => {
      const store = await harness.open();
      const first = await store.save(model('Exported'), author);
      const exported = await store.get(first.id);
      if (exported === undefined) throw new Error('not stored');

      const second = await store.save(JSON.parse(JSON.stringify(exported)) as JgfDocument, author);
      expect(second.id).not.toBe(first.id);
      const restored = await store.get(second.id);
      expect(restored?.graph.nodes).toEqual(exported.graph.nodes);
      expect(restored?.graph.edges).toEqual(exported.graph.edges);
    });

    describe('a stored model is fully validated when it is read', () => {
      it('leaves a damaged model out of the list, lists it for Admins and refuses to show it', async () => {
        const store = await harness.open();
        const good = await store.save(model('Good'), author);
        const bad = await store.save(model(secretLabel), author);
        await harness.damage(bad.id);
        const reopened = await harness.open();

        expect(await reopened.list()).toEqual([good]);
        expect(await reopened.listDamaged()).toEqual([bad.id]);
        await expect(reopened.get(bad.id)).rejects.toThrow(ModelUnreadableError);
        await expect(reopened.get(bad.id)).rejects.toThrow(
          "The stored model is damaged: it doesn't pass validation, so it can't be shown. See the API log.",
        );
        const logged = JSON.stringify(harness.warnings());
        expect(logged).toContain(bad.id);
        expect(logged).toContain('invalid-model');
        expect(logged).not.toMatch(/secret/i);

        // Nothing is changed or removed until an Admin deletes it.
        expect(await reopened.delete(bad.id)).toEqual({ id: bad.id, summary: undefined });
        expect(await reopened.listDamaged()).toEqual([]);
        expect(await reopened.list()).toEqual([good]);
      });
    });

    describe('the cap on stored models', () => {
      it('refuses a save beyond the cap with a clear error, and counts damaged models', async () => {
        const store = await harness.open({ maxModels: 3 });
        const saved = [];
        for (let i = 0; i < 3; i++) saved.push(await store.save(model(`M${i}`), author));
        await expect(store.save(model('One too many'), author)).rejects.toThrow(
          ModelStoreFullError,
        );
        await expect(store.save(model('One too many'), author)).rejects.toThrow(
          'The model store is full (3 models). Delete a model before saving another.',
        );
        await harness.damage(saved[0]?.id ?? '');
        const reopened = await harness.open({ maxModels: 3 });
        await expect(reopened.save(model('Still full'), author)).rejects.toThrow(
          ModelStoreFullError,
        );
        await reopened.delete(saved[0]?.id ?? '');
        await expect(reopened.save(model('Room again'), author)).resolves.toMatchObject({
          name: 'Room again',
        });
      });

      it('never overshoots the cap when many saves race', async () => {
        const store = await harness.open({ maxModels: 5 });
        const results = await Promise.allSettled(
          Array.from({ length: 12 }, (_, i) => store.save(model(`Race ${i}`), author)),
        );
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
        const refused = results.filter((result) => result.status === 'rejected');
        expect(refused.every((result) => result.reason instanceof ModelStoreFullError)).toBe(true);
        expect(await store.list()).toHaveLength(5);
      });
    });

    it('deletes a model once when two deletes race, and keeps working after a failed save', async () => {
      const store = await harness.open({ maxModels: 1 });
      const summary = await store.save(model('Only'), author);
      await expect(store.save(model('Too many'), author)).rejects.toThrow(ModelStoreFullError);
      const [a, b] = await Promise.all([store.delete(summary.id), store.delete(summary.id)]);
      expect([a, b].filter((result) => result !== undefined)).toHaveLength(1);
      await expect(store.save(model('Next'), author)).resolves.toMatchObject({ name: 'Next' });
    });

    describe("sourceId: the client's own graph id", () => {
      it('is absent when the client sent no id, or an empty one', async () => {
        const store = await harness.open();
        const graph = structuredClone(sampleModel.graph);
        delete graph.id;
        expect((await store.save({ graph }, author)).sourceId).toBeUndefined();
        expect((await store.save(model('x', { id: '  ' }), author)).sourceId).toBeUndefined();
      });

      it(`is cut to ${maxSourceIdLength} characters, never inside a surrogate pair`, async () => {
        const store = await harness.open();
        const id = `${'a'.repeat(maxSourceIdLength - 1)}😀tail`;
        const summary = await store.save(model('x', { id }), author);
        expect(summary.sourceId).toBe(`${'a'.repeat(maxSourceIdLength - 1)}…`);
        expect((await store.list())[0]?.sourceId).toBe(summary.sourceId);
      });
    });

    it('never stores a model over the size limit, and stores nothing of it', async () => {
      const store = await harness.open({ maxBytes: 600 });
      await expect(store.save(model('Large'), author)).rejects.toThrow(ModelTooLargeError);
      expect(await store.list()).toEqual([]);
      expect(await store.listDamaged()).toEqual([]);
      await expect(store.save({ graph: { label: 'Small' } }, author)).resolves.toMatchObject({
        name: 'Small',
      });
    });
  });
}
