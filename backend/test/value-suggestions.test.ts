import {
  buildModelGraph,
  elementPropertyValues,
  relationshipPropertyValues,
  suggestedValues,
  type JgfDocument,
} from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';
import { expectGrowthBelow } from './growth.js';

// The values a property already has, for suggesting. Made-up data only.

const node = (metadata: Record<string, unknown>) => ({
  label: 'Made-up',
  metadata: { type: 'Application', ...metadata },
});
const edge = (id: string, metadata: Record<string, unknown>, relation = 'Relation') => ({
  id,
  source: 'a',
  target: 'b',
  relation,
  metadata,
});
const model = (
  nodes: Record<string, ReturnType<typeof node>>,
  edges: ReturnType<typeof edge>[] = [],
): JgfDocument => ({ graph: { nodes: { a: node({}), b: node({}), ...nodes }, edges } });

describe('elementPropertyValues', () => {
  it('lists most used first, then by name, keeping values that differ by case', () => {
    const graph = buildModelGraph(
      model({
        c: node({ owningTeam: 'Web' }),
        d: node({ owningTeam: 'data' }),
        e: node({ owningTeam: 'Web' }),
        f: node({ owningTeam: 'web' }),
        g: node({ owningTeam: 'Billing' }),
      }),
    );
    expect(elementPropertyValues(graph).get('owningTeam')).toEqual([
      'Web',
      'Billing',
      'data',
      'web',
    ]);
  });

  it('reads text, numbers and true/false, trimmed, and skips the rest value by value', () => {
    const graph = buildModelGraph(
      model({
        c: node({ port: 8080, on: false, spaced: '  x  ' }),
        d: node({ port: ['list'], on: true, spaced: '   ' }),
        e: node({ port: { a: 1 }, on: null, spaced: 'two\nlines' }),
        f: node({ port: '443', spaced: 'carriage\rreturn' }),
      }),
    );
    const values = elementPropertyValues(graph);
    expect(values.get('port')).toEqual(['443', '8080']);
    expect(values.get('on')).toEqual(['false', 'true']);
    expect(values.get('spaced')).toEqual(['x']);
  });

  it('uses own keys only: odd names read nothing unless the model has them', () => {
    const none = elementPropertyValues(buildModelGraph(model({})));
    for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'prototype']) {
      expect(none.get(key)).toBeUndefined();
    }
    const odd = elementPropertyValues(buildModelGraph(model({ c: node({ constructor: 'x' }) })));
    expect(odd.get('constructor')).toEqual(['x']);
  });

  it('leaves out the keys the element filter leaves out', () => {
    const values = elementPropertyValues(
      buildModelGraph(
        model({
          c: node({
            description: 'd',
            functions: 'f',
            archimateType: 'a',
            'simplearchitecture:stored': 's',
          }),
        }),
      ),
    );
    for (const key of [
      'type',
      'description',
      'functions',
      'archimateType',
      'simplearchitecture:stored',
    ]) {
      expect(values.has(key)).toBe(false);
    }
  });

  it('counts a country as it would be stored: upper case', () => {
    const graph = buildModelGraph(
      model({
        c: node({ supplierHqCountry: 'nl' }),
        d: node({ supplierHqCountry: 'NL' }),
        e: node({ supplierHqCountry: 'Netherlands' }),
      }),
    );
    expect(elementPropertyValues(graph).get('supplierHqCountry')).toEqual(['NL', 'NETHERLANDS']);
    // A custom key isn't changed like this.
    const other = buildModelGraph(model({ c: node({ zone: 'nl' }) }));
    expect(elementPropertyValues(other).get('zone')).toEqual(['nl']);
  });

  it('is worked out once per graph, and stays linear on a large model', async () => {
    const documentOf = (size: number) =>
      model(
        Object.fromEntries(
          Array.from({ length: size }, (_, i) => [`n${i}`, node({ zone: `z${i % (size / 5)}` })]),
        ),
      );
    const graph = buildModelGraph(documentOf(5000));
    const values = elementPropertyValues(graph);
    expect(values.get('zone')).toHaveLength(1000);
    expect(elementPropertyValues(graph)).toBe(values);
    const inputs = new Map([5000, 20_000].map((size) => [size, documentOf(size)]));
    await expectGrowthBelow(
      (size: number) => {
        // A new graph each time: a graph's values are kept once worked out.
        const fresh = buildModelGraph(inputs.get(size) as JgfDocument);
        return () => elementPropertyValues(fresh);
      },
      5000,
      20_000,
    );
  });
});

describe('relationshipPropertyValues', () => {
  it('keeps a list of its own, apart from the elements’', () => {
    const graph = buildModelGraph(
      model({ c: node({ protocol: 'Element value' }) }, [
        edge('r1', { protocol: 'REST' }),
        edge('r2', { protocol: 'REST' }),
        edge('r3', { protocol: 'SFTP' }),
        edge('r4', { protocol: 'Inside' }, 'Contains'),
      ]),
    );
    expect(relationshipPropertyValues(graph).get('protocol')).toEqual(['REST', 'Inside', 'SFTP']);
    expect(elementPropertyValues(graph).get('protocol')).toEqual(['Element value']);
  });

  it('offers functions, which is an ordinary key here, but not its own fields', () => {
    const graph = buildModelGraph(
      model({}, [
        edge('r1', {
          functions: 'Made-up',
          informationFlow: true,
          architectureState: 'Target',
          description: 'd',
        }),
      ]),
    );
    const values = relationshipPropertyValues(graph);
    expect(values.get('functions')).toEqual(['Made-up']);
    for (const key of ['informationFlow', 'architectureState', 'description']) {
      expect(values.has(key)).toBe(false);
    }
  });
});

describe('suggestedValues', () => {
  const values = ['REST', 'rest', 'Message queue via broker', 'Café', 'SFTP'];

  it('before any change, offers every other value, whatever the field holds', () => {
    expect(suggestedValues(values, 'REST', false)).toEqual([
      'rest',
      'Message queue via broker',
      'Café',
      'SFTP',
    ]);
    expect(suggestedValues(values, 'anything', false)).toEqual(values);
  });

  it('after a change, narrows anywhere in the value, ignoring case and accents, in order', () => {
    expect(suggestedValues(values, 're', true)).toEqual(['REST', 'rest']);
    expect(suggestedValues(values, 'broker', true)).toEqual(['Message queue via broker']);
    expect(suggestedValues(values, 'st', true)).toEqual(['REST', 'rest']);
    expect(suggestedValues(values, 'cafe', true)).toEqual(['Café']);
    expect(suggestedValues(values, '  sftp ', true)).toEqual(['SFTP']);
  });

  it('leaves out the value itself, exactly, and offers all when the field is empty', () => {
    expect(suggestedValues(values, 'rest', true)).toEqual(['REST']);
    expect(suggestedValues(values, '', true)).toEqual(values);
    expect(suggestedValues(values, 'no match', true)).toEqual([]);
  });
});
