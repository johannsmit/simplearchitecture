import {
  buildModelGraph,
  catalogColumns,
  catalogPropertyColumn,
  catalogTable,
  customMetadata,
  elementDefinitionsForKeys,
  elementKeyRole,
  elementPropertyKeyProblem,
  elementPropertyNameProblem,
  elementValueFit,
  filterFields,
  hasCatalogColumn,
  isDefinableElementKey,
  newElementKeys,
  referenceKey,
  type ElementPropertyDefinition,
  type JgfDocument,
} from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';

// The shared rules of element properties, as the API and the web app apply them: keys and names,
// how a value reads under its kind, the keys a model brings, and the filters' and the catalog's
// use of them. Made-up data only.

const ref = (...ids: string[]) => ({ [referenceKey]: ids });
const define = (
  key: string,
  name: string,
  kind: ElementPropertyDefinition['kind'],
  options?: string[],
): ElementPropertyDefinition => ({
  key,
  name,
  kind,
  ...(options === undefined ? {} : { options }),
  fromModels: false,
  version: 1,
});

const stage = define('stage', 'Stage', 'choice', ['Draft', 'Live', 'Retired']);
const costCentre = define('costCentre', 'Cost centre', 'text');
const hostedOn = define('hostedOn', 'Hosted on', 'reference');
const definitions = [stage, hostedOn, costCentre];

// Made up: a small workshop.
const workshop: JgfDocument = {
  graph: {
    nodes: {
      saw: {
        label: 'Saw',
        metadata: {
          type: 'Application',
          functions: ['Cut'],
          stage: 'Live',
          costCentre: 'CC-1',
          hostedOn: ref('bench'),
        },
      },
      drill: {
        label: 'Drill',
        metadata: { type: 'Application', stage: 'Draft', costCentre: ref('bench') },
      },
      bench: {
        label: 'Bench',
        metadata: { type: 'Other', stage: 'Unlisted', costCentre: ['a', 'list'], sourcing: 'Buy' },
      },
    },
  },
};
const graph = buildModelGraph(workshop, [], definitions);

describe('keys and names of element properties', () => {
  it('never takes a standard key of any element type, the type, __proto__ or internal keys', () => {
    for (const key of ['owningTeam', 'sourcing', 'stakeholderKind', 'type', '__proto__', '']) {
      expect(isDefinableElementKey(key), key).toBe(false);
    }
    expect(isDefinableElementKey('simplearchitecture:x')).toBe(false);
    // Keys standard on relationships only, and archimateType, are free on elements.
    for (const key of ['identity', 'archimateType', 'costCentre']) {
      expect(isDefinableElementKey(key), key).toBe(true);
    }
    expect(elementPropertyKeyProblem('supplierHqCountry', [])).toMatch(/standard property/);
    expect(elementPropertyKeyProblem('Identity', [])).toBeUndefined();
    expect(elementPropertyNameProblem('Supplier HQ country', [])).toMatch(/standard property/);
    expect(elementPropertyNameProblem('Cost centre', [costCentre])).toMatch(/already/);
    expect(elementPropertyNameProblem('Identity', [])).toBeUndefined();
  });

  it('says what a key is on an element of a type: standard, defined, Was a property, or custom', () => {
    expect(elementKeyRole('Application', 'sourcing', definitions)).toEqual({ role: 'standard' });
    expect(elementKeyRole('Other', 'sourcing', definitions)).toEqual({ role: 'was-property' });
    expect(elementKeyRole('Other', 'stage', definitions)).toEqual({
      role: 'defined',
      definition: stage,
    });
    expect(elementKeyRole('Other', 'vendor', definitions)).toEqual({ role: 'custom' });
  });

  it('reads a value under its kind: fits, not in the list, or not this kind', () => {
    expect(elementValueFit(stage, 'Live')).toBe('fits');
    expect(elementValueFit(stage, 'Unlisted')).toBe('not-listed');
    expect(elementValueFit(stage, ref('saw'))).toBe('not-this-kind');
    expect(elementValueFit(costCentre, 'CC-1')).toBe('fits');
    expect(elementValueFit(costCentre, 7)).toBe('fits');
    expect(elementValueFit(costCentre, ref('saw'))).toBe('not-this-kind');
    expect(elementValueFit(costCentre, ['a'])).toBe('not-this-kind');
    expect(elementValueFit(hostedOn, ref('saw'))).toBe('fits');
    expect(elementValueFit(hostedOn, 'Bench')).toBe('not-this-kind');
  });

  it('finds the keys a model brings, a Reference only when every value is one', () => {
    const found = newElementKeys(
      Object.values(workshop.graph.nodes ?? {}),
      (key) => key === 'stage',
    );
    expect(found).toEqual([
      { key: 'costCentre', values: 3, references: false },
      { key: 'hostedOn', values: 1, references: true },
    ]);
    expect(elementDefinitionsForKeys(found, [])).toEqual([
      { key: 'costCentre', name: 'costCentre', kind: 'text', fromModels: true },
      { key: 'hostedOn', name: 'hostedOn', kind: 'reference', fromModels: true },
    ]);
  });
});

describe('the filters, the catalog and the panel with element properties', () => {
  it('offers Text and Choice properties by name, a choice in its options’ order, odd values not set', () => {
    const fields = filterFields(graph).filter((field) => !field.standard);
    expect(fields.map((field) => [field.key, field.label])).toEqual([
      ['costCentre', 'Cost centre'],
      ['stage', 'Stage'],
    ]);
    expect(fields[0]).toMatchObject({ values: [{ value: 'CC-1', count: 1 }], notSetCount: 2 });
    expect(fields[1]?.values.map((entry) => entry.value)).toEqual(['Draft', 'Live', 'Unlisted']);
  });

  it('gives each tab a column per property, by name, before Functions, under a key of its own', () => {
    expect(catalogColumns('Application', definitions).map((column) => column.key)).toEqual([
      'name',
      'description',
      'architectureState',
      'owningTeam',
      'supplierHqCountry',
      'sourcing',
      'property:costCentre',
      'property:hostedOn',
      'property:stage',
      'functions',
    ]);
    expect(catalogColumns('all', definitions).map((column) => column.label)).toEqual([
      'Name',
      'Type',
      'Description',
      'Cost centre',
      'Hosted on',
      'Stage',
    ]);
    expect(hasCatalogColumn('Other', catalogPropertyColumn('stage'), definitions)).toBe(true);
    expect(hasCatalogColumn('Other', 'stage', definitions)).toBe(false);
  });

  it('fills the cells as stored, a Reference as names, and sorts a choice by its options', () => {
    const table = catalogTable(
      [...graph.elements.values()],
      'all',
      { column: catalogPropertyColumn('stage'), direction: 'asc' },
      graph.elements,
      definitions,
    );
    const at = (key: string) => table.columns.findIndex((column) => column.key === key);
    const cells = (key: string) => table.rows.map((row) => row.cells[at(key)]?.text);
    expect(table.rows.map((row) => row.element.id)).toEqual(['drill', 'saw', 'bench']);
    expect(cells(catalogPropertyColumn('hostedOn'))).toEqual(['', 'Bench', '']);
    expect(cells(catalogPropertyColumn('costCentre'))).toEqual(['Bench', 'CC-1', 'a, list']);
  });

  it('leaves element properties out of the custom metadata: only Was a property values stay', () => {
    const bench = graph.elements.get('bench');
    expect(bench && customMetadata(bench, definitions).map(([key]) => key)).toEqual(['sourcing']);
  });
});
