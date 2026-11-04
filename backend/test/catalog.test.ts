import {
  buildModelGraph,
  catalogCell,
  catalogColumns,
  catalogCounts,
  catalogTable,
  catalogTabs,
  findElements,
  hasCatalogColumn,
  isCatalogTab,
  sortCatalogRows,
  type CatalogSort,
  type JgfDocument,
  type ModelGraph,
} from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';
import { expectGrowthBelow } from './growth.js';

// The catalog: shared rules in shared/src/catalog.ts. Made-up data only.

const document: JgfDocument = {
  graph: {
    label: 'Made-up harbour',
    nodes: {
      crane: {
        label: 'Crane Control',
        metadata: {
          type: 'Application',
          description: '  Moves boxes.\r\nSafely.  ',
          architectureState: 'Target',
          owningTeam: 'Quay team',
          functions: ['Lift', 'Lower'],
          supplierHqCountry: 'NL',
          sourcing: 'Buy',
          colour: 'red',
        },
      },
      berth: {
        label: 'Berth Planner',
        metadata: { type: 'Application', architectureState: 'Deprecate', sourcing: 'Build' },
      },
      gate: {
        label: 'gate app',
        metadata: { type: 'Application', architectureState: 'Current', owningTeam: '  ' },
      },
      gate2: { label: 'Gate App', metadata: { type: 'Application', supplierHqCountry: 'Holland' } },
      item10: { label: 'Item 10', metadata: { type: 'Application', owningTeam: 'Alpha' } },
      item2: { label: 'Item 2', metadata: { type: 'Application', owningTeam: 'alpha' } },
      unnamed: { metadata: { type: 'Application' } },
      pilot: { label: 'Pilot', metadata: { type: 'Stakeholder', description: 'Steers ships.' } },
      harbour: { label: 'Harbour Office', metadata: { type: 'Business', owningTeam: 'Port' } },
      network: { label: 'Quay Network', metadata: { type: 'Infrastructure' } },
      // A standard key of another type is custom metadata here, never a column.
      misc: { label: 'Mooring Log', metadata: { type: 'Other', sourcing: 'Buy' } },
    },
    edges: [],
  },
};

const graph: ModelGraph = buildModelGraph(document);
const all = () => findElements(graph, {});
const names = (tab: Parameters<typeof catalogTable>[1], sort?: CatalogSort) =>
  catalogTable(all(), tab, sort).rows.map((row) => row.element.name);

describe('catalog columns', () => {
  it('has name, type and description on All', () => {
    expect(catalogColumns('all')).toEqual([
      { key: 'name', label: 'Name' },
      { key: 'type', label: 'Type' },
      { key: 'description', label: 'Description' },
    ]);
  });

  it("has name, then the type's standard properties in metamodel order, Functions last", () => {
    expect(catalogColumns('Application').map((column) => column.label)).toEqual([
      'Name',
      'Description',
      'Architecture state',
      'Owning team',
      'Supplier HQ country',
      'Sourcing',
      'Functions',
    ]);
    expect(catalogColumns('Infrastructure').map((column) => column.key)).toEqual([
      'name',
      'description',
      'architectureState',
      'owningTeam',
      'supplierHqCountry',
      'functions',
    ]);
    expect(catalogColumns('Business').map((column) => column.key)).toEqual([
      'name',
      'description',
      'owningTeam',
    ]);
    expect(catalogColumns('Stakeholder').map((column) => column.key)).toEqual([
      'name',
      'description',
    ]);
    expect(catalogColumns('Other').map((column) => column.key)).toEqual(['name', 'description']);
  });

  it('knows its tabs and columns', () => {
    expect(catalogTabs).toEqual([
      'all',
      'Stakeholder',
      'Business',
      'Application',
      'Infrastructure',
      'Other',
    ]);
    expect(isCatalogTab('Application')).toBe(true);
    expect(isCatalogTab('application')).toBe(false);
    expect(isCatalogTab('constructor')).toBe(false);
    expect(hasCatalogColumn('Application', 'sourcing')).toBe(true);
    expect(hasCatalogColumn('Business', 'sourcing')).toBe(false);
    expect(hasCatalogColumn('all', 'type')).toBe(true);
    expect(hasCatalogColumn('all', 'colour')).toBe(false);
  });
});

describe('catalog cells', () => {
  const crane = graph.elements.get('crane');
  if (!crane) throw new Error('fixture');

  it('reads values as the details panel does', () => {
    expect(catalogCell(crane, 'name')).toEqual({ value: 'Crane Control', text: 'Crane Control' });
    expect(catalogCell(crane, 'type')).toEqual({ value: 'Application', text: 'Application' });
    expect(catalogCell(crane, 'description')).toEqual({
      value: '  Moves boxes.\r\nSafely.  ',
      text: 'Moves boxes.\nSafely.',
    });
    expect(catalogCell(crane, 'functions')).toEqual({
      value: ['Lift', 'Lower'],
      text: 'Lift, Lower',
    });
    expect(catalogCell(crane, 'supplierHqCountry')).toEqual({ value: 'NL', text: 'NL' });
    expect(catalogCell(crane, 'architectureState').text).toBe('Target');
  });

  it('gives empty text for missing, blank or empty values', () => {
    const gate = graph.elements.get('gate');
    const unnamed = graph.elements.get('unnamed');
    if (!gate || !unnamed) throw new Error('fixture');
    expect(catalogCell(gate, 'owningTeam')).toEqual({ value: '  ', text: '' });
    expect(catalogCell(gate, 'description')).toEqual({ value: undefined, text: '' });
    expect(catalogCell(gate, 'functions')).toEqual({ value: undefined, text: '' });
    expect(catalogCell(unnamed, 'name')).toEqual({ value: '', text: '' });
  });

  it('reads own metadata keys only', () => {
    const odd = buildModelGraph({
      graph: { nodes: { odd: { label: 'Odd', metadata: { type: 'Other' } } } },
    }).elements.get('odd');
    if (!odd) throw new Error('fixture');
    // `description` and every other key are read with Object.hasOwn, never from the prototype.
    expect(catalogCell(odd, 'owningTeam')).toEqual({ value: undefined, text: '' });
  });
});

describe('catalog rows and counts', () => {
  it('lists the matches of the tab, cells in column order', () => {
    const table = catalogTable(all(), 'Business');
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.cells.map((cell) => cell.text)).toEqual(['Harbour Office', '', 'Port']);
    expect(catalogTable(all(), 'all').rows).toHaveLength(graph.elements.size);
  });

  it('counts the matches per tab, whichever tab is shown', () => {
    expect(catalogTable(all(), 'Other').counts).toEqual({
      all: 11,
      Stakeholder: 1,
      Business: 1,
      Application: 7,
      Infrastructure: 1,
      Other: 1,
    });
    const matches = findElements(graph, { query: 'gate' });
    expect(catalogCounts(matches)).toEqual({
      all: 2,
      Stakeholder: 0,
      Business: 0,
      Application: 2,
      Infrastructure: 0,
      Other: 0,
    });
    const filtered = findElements(graph, { filters: { architectureState: ['Target', null] } });
    const table = catalogTable(filtered, 'Application');
    expect(table.rows.map((row) => row.element.id)).toEqual([
      'crane',
      'gate2',
      'item2',
      'item10',
      'unnamed',
    ]);
    expect(table.counts.all).toBe(9);
  });

  it('shows an empty table for a tab without matches', () => {
    const table = catalogTable(findElements(graph, { query: 'pilot' }), 'Business');
    expect(table.rows).toEqual([]);
    expect(table.counts.Stakeholder).toBe(1);
  });
});

describe('catalog sorting', () => {
  it('sorts by name by default: numbers as people expect, case ignored, ties by id', () => {
    expect(names('Application')).toEqual([
      'Berth Planner',
      'Crane Control',
      // Same name ignoring case: by id (gate before gate2).
      'gate app',
      'Gate App',
      'Item 2',
      'Item 10',
      // No name: last.
      '',
    ]);
  });

  it('sorts descending with empty values still last', () => {
    expect(names('Application', { column: 'name', direction: 'desc' })).toEqual([
      'Item 10',
      'Item 2',
      'gate app',
      'Gate App',
      'Crane Control',
      'Berth Planner',
      '',
    ]);
  });

  it('sorts a choice column in metamodel order, empty last both ways, ties by name', () => {
    const asc = names('Application', { column: 'architectureState', direction: 'asc' });
    expect(asc).toEqual([
      'Berth Planner', // Deprecate
      'gate app', // Current
      'Crane Control', // Target
      'Gate App',
      'Item 2',
      'Item 10',
      '',
    ]);
    const desc = names('Application', { column: 'architectureState', direction: 'desc' });
    expect(desc).toEqual([
      'Crane Control',
      'gate app',
      'Berth Planner',
      'Gate App',
      'Item 2',
      'Item 10',
      '',
    ]);
  });

  it('sorts text with the name collation and blank text counts as empty', () => {
    expect(names('Application', { column: 'owningTeam', direction: 'asc' })).toEqual([
      // "Alpha" and "alpha" are equal: by name.
      'Item 2',
      'Item 10',
      'Crane Control',
      'Berth Planner',
      'gate app',
      'Gate App',
      '',
    ]);
  });

  it('sorts types in metamodel order on All', () => {
    const types = catalogTable(all(), 'all', { column: 'type', direction: 'asc' }).rows.map(
      (row) => row.element.type,
    );
    expect([...new Set(types)]).toEqual([
      'Stakeholder',
      'Business',
      'Application',
      'Infrastructure',
      'Other',
    ]);
    const desc = catalogTable(all(), 'all', { column: 'type', direction: 'desc' }).rows;
    expect(desc[0]?.element.type).toBe('Other');
    // Within a type, still by name ascending.
    expect(desc.slice(2, 4).map((row) => row.element.name)).toEqual([
      'Berth Planner',
      'Crane Control',
    ]);
  });

  it('sorts by name for a column the tab does not have', () => {
    const { columns, rows } = catalogTable(all(), 'Business');
    const sorted = sortCatalogRows(rows, columns, { column: 'sourcing', direction: 'desc' });
    expect(sorted.map((row) => row.element.name)).toEqual(['Harbour Office']);
    expect(names('Stakeholder', { column: 'sourcing', direction: 'desc' })).toEqual(['Pilot']);
    expect(names('Application', { column: 'type', direction: 'desc' })[0]).toBe('Berth Planner');
  });

  it('is stable and leaves the input as it is', () => {
    const { columns, rows } = catalogTable(all(), 'Application');
    const before = rows.map((row) => row.element.id);
    const once = sortCatalogRows(rows, columns, { column: 'sourcing', direction: 'asc' });
    const twice = sortCatalogRows(once, columns, { column: 'sourcing', direction: 'asc' });
    expect(twice.map((row) => row.element.id)).toEqual(once.map((row) => row.element.id));
    expect(rows.map((row) => row.element.id)).toEqual(before);
    expect(once.map((row) => row.element.name)).toEqual([
      'Berth Planner', // Build
      'Crane Control', // Buy
      'gate app',
      'Gate App',
      'Item 2',
      'Item 10',
      '',
    ]);
  });

  it('stays quick for 300 elements, growing no faster than sorting does', async () => {
    const graphOf = (size: number) =>
      buildModelGraph({
        graph: {
          nodes: Object.fromEntries(
            Array.from({ length: size }, (_, i) => [
              `n${i}`,
              {
                label: `Made-up ${i}`,
                metadata: { type: 'Application', owningTeam: `Team ${i % 17}` },
              },
            ]),
          ),
        },
      });
    const tableOf = (graph: ReturnType<typeof graphOf>) =>
      catalogTable(findElements(graph, {}), 'Application', {
        column: 'owningTeam',
        direction: 'desc',
      });
    const graphs = new Map([300, 1200].map((size) => [size, graphOf(size)]));
    const big = graphs.get(300);
    if (!big) throw new Error('fixture');
    const table = tableOf(big);
    expect(table.rows).toHaveLength(300);
    expect(table.rows[0]?.cells[3]?.text).toBe('Team 16');
    await expectGrowthBelow(
      (size: number) => () => {
        const graph = graphs.get(size);
        if (!graph) throw new Error('fixture');
        // Often enough to measure: this is quick.
        for (let i = 0; i < 5; i++) tableOf(graph);
      },
      300,
      1200,
    );
  });
});
