import type * as Crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const uuids: string[] = [];
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>();
  return { ...actual, randomUUID: () => uuids.shift() ?? actual.randomUUID() };
});

const { newRelationshipId, withRelationshipIds } = await import('../src/jgf/relationship-ids.js');
const { validateImported } = await import('../src/jgf/older-types.js');

afterEach(() => {
  uuids.length = 0;
});

const node = { metadata: { type: 'Application' } };

describe('ids for imported relationships', () => {
  it('never gives an id that is taken', () => {
    uuids.push('taken', 'taken', 'free');
    const taken = new Set(['taken']);
    expect(newRelationshipId(taken)).toBe('free');
    expect(taken.has('free')).toBe(true);
  });

  it('gives each edge without an id a new one, unique in the file, and keeps the others', () => {
    // The first new id would clash with an id later in the file.
    uuids.push('later', 'new-1', 'new-2');
    const input = {
      graph: {
        nodes: { a: node, b: node },
        edges: [
          { source: 'a', target: 'b' },
          { id: 'later', source: 'b', target: 'a' },
          { source: 'b', target: 'a', label: 'Made-up' },
        ],
      },
    };
    const before = structuredClone(input);
    const { document, given } = withRelationshipIds(input);
    expect(given).toBe(2);
    expect(document).toEqual({
      graph: {
        nodes: { a: node, b: node },
        edges: [
          { id: 'new-1', source: 'a', target: 'b' },
          { id: 'later', source: 'b', target: 'a' },
          { id: 'new-2', source: 'b', target: 'a', label: 'Made-up' },
        ],
      },
    });
    expect(input).toEqual(before);
  });

  it('leaves a document with every id, or of another shape, as it is', () => {
    const complete = { graph: { edges: [{ id: 'r', source: 'a', target: 'b' }] } };
    for (const input of [complete, null, [], { graph: {} }, { graph: { edges: 'x' } }]) {
      expect(withRelationshipIds(input)).toEqual({ document: input, given: 0 });
      expect(withRelationshipIds(input).document).toBe(input);
    }
    // Edges that aren't objects stay for the validation to report.
    const odd = { graph: { edges: [7, { source: 'a', target: 'b' }] } };
    uuids.push('new');
    expect(withRelationshipIds(odd).document).toEqual({
      graph: { edges: [7, { id: 'new', source: 'a', target: 'b' }] },
    });
  });

  it('is what an import stores, checked as sent', () => {
    uuids.push('new');
    const { document, validation } = validateImported({
      graph: {
        nodes: { a: node, b: node },
        edges: [{ source: 'a', target: 'b', relation: 'Relation' }],
      },
    });
    expect(validation).toMatchObject({ valid: true, errorCount: 0, warningCount: 0 });
    expect(document).toMatchObject({ graph: { edges: [{ id: 'new', source: 'a', target: 'b' }] } });
  });
});
