import {
  buildModelGraph,
  catalogColumns,
  type JgfDocument,
  type ModelSummary,
} from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetCatalogState } from '../src/viewing/explorer/catalog/Catalog';
import {
  byteOrderMark,
  catalogCsv,
  catalogCsvFileName,
  csvField,
  csvText,
} from '../src/viewing/explorer/catalog/csv';
import { forgetElementFilters } from '../src/viewing/explorer/ElementTree';
import { modeller, renderAt, stubApi, viewer, type Handler } from './helpers';

// Download CSV in the catalog (Modelling). Made-up data: a small café.

describe('a CSV field', () => {
  it('is quoted per RFC 4180 when it holds a comma, a quote or a line break', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('Café, Paris')).toBe('"Café, Paris"');
    expect(csvField('Say "hi"')).toBe('"Say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField('two\r\nlines')).toBe('"two\r\nlines"');
  });

  it('gets a leading quote when a spreadsheet would run it as a formula', () => {
    for (const text of ['=SUM(A1:A9)', '+31 20', '-5', '@risk', '\tindent']) {
      expect(csvField(text)).toBe(`'${text}`);
    }
    // A carriage return at the start is guarded, then quoted for the line break.
    expect(csvField('\rx')).toBe(`"'\rx"`);
    expect(csvField('=1,2')).toBe(`"'=1,2"`);
    // Only at the start.
    expect(csvField('a=b')).toBe('a=b');
    expect(csvField('Self-hosted')).toBe('Self-hosted');
  });

  it('keeps accents and other letters as they are, and an empty value empty', () => {
    expect(csvField('Crème brûlée – ÅÆØ 日本')).toBe('Crème brûlée – ÅÆØ 日本');
    expect(csvField('')).toBe('');
  });
});

describe('CSV text', () => {
  it('starts with a byte order mark and ends each line with CRLF', () => {
    const text = csvText([
      ['Name', 'Team'],
      ['Till', ''],
    ]);
    expect(text.startsWith(byteOrderMark)).toBe(true);
    expect(text).toBe(`${byteOrderMark}Name,Team\r\nTill,\r\n`);
  });
});

const cafe: JgfDocument = {
  graph: {
    id: '66666666-6666-4666-8666-666666666666',
    label: 'Café / Bakery: "Main"',
    directed: true,
    nodes: {
      till: {
        label: 'Till, front',
        metadata: {
          type: 'Application',
          owningTeam: 'Crème team',
          description: 'Takes "cash"\nand cards',
        },
      },
      orders: { label: '=Orders', metadata: { type: 'Application', owningTeam: '-5 legacy' } },
      stock: { label: 'Stock', metadata: { type: 'Application' } },
      oven: { label: 'Oven server', metadata: { type: 'Infrastructure' } },
    },
    edges: [],
  },
};

describe('the catalog as CSV', () => {
  const graph = buildModelGraph(cafe);
  const element = (id: string) =>
    graph.elements.get(id) as NonNullable<ReturnType<typeof graph.elements.get>>;

  it("has the tab's column labels, then each element's full text in the order given", () => {
    const columns = catalogColumns('Application');
    const text = catalogCsv(columns, [element('till'), element('orders'), element('stock')]);
    const lines = text.slice(byteOrderMark.length).split('\r\n');
    expect(lines[0]).toBe(columns.map((column) => column.label).join(','));
    expect(lines[0]?.startsWith('Name,Description,')).toBe(true);
    const owning = columns.findIndex((column) => column.key === 'owningTeam');
    // The description keeps its line break, inside quotes; the team keeps its accent.
    expect(text).toContain('"Till, front","Takes ""cash""\nand cards"');
    expect(text).toContain("'=Orders");
    expect(text).toContain("'-5 legacy");
    expect(text).toContain('Crème team');
    // Not set: an empty field.
    const stock = text
      .slice(byteOrderMark.length)
      .split('\r\n')
      .find((l) => l.startsWith('Stock'));
    expect(stock?.split(',')[owning]).toBe('');
    expect(stock).toBe(`Stock${','.repeat(columns.length - 1)}`);
  });

  it('is named <model>-<type>-<yyyy-mm-dd>.csv, made safe', () => {
    const day = new Date(2026, 10, 6, 23, 30);
    expect(catalogCsvFileName('Café / Bakery: "Main"', 'Application', day)).toBe(
      'Café Bakery Main-Application-2026-11-06.csv',
    );
    expect(catalogCsvFileName('Café', 'all', day)).toBe('Café-All-2026-11-06.csv');
    expect(catalogCsvFileName('  ', 'Business', day)).toBe('model-Business-2026-11-06.csv');
    expect(catalogCsvFileName('../..', 'Other', day)).toBe('model-Other-2026-11-06.csv');
    const long = catalogCsvFileName('x'.repeat(300), 'Other', day);
    expect(long.endsWith('-Other-2026-11-06.csv')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(80 + '-Other-2026-11-06.csv'.length);
  });
});

describe('Download CSV in the catalog', () => {
  const id = cafe.graph.id as string;
  const summary: ModelSummary = {
    id,
    name: cafe.graph.label as string,
    createdAt: '2026-11-01T10:00:00.000Z',
    createdBy: { id: 'u1', name: 'Alex Morgan' },
    nodeCount: 4,
    edgeCount: 0,
  };
  const api: Handler = ({ url, method }) => {
    if (method !== 'GET') return undefined;
    if (url === '/api/models') return Response.json({ models: [summary], editable: true });
    if (url === `/api/models/${id}`) return Response.json(cafe);
    if (url === `/api/models/${id}/views`) return Response.json({ views: [] });
    return undefined;
  };
  const at = (space: 'viewing' | 'modelling') =>
    `/${space}/models/${id}?view=catalog&type=Application`;
  const button = () => screen.queryByRole<HTMLButtonElement>('button', { name: 'Download CSV' });

  let saved: { blob: Blob; name: string }[] = [];
  const real = {
    create: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
    revoke: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL'),
  };
  beforeEach(() => {
    forgetElementFilters();
    forgetCatalogState();
    saved = [];
    let blob: Blob | undefined;
    // jsdom has no object URLs: these stand in, and go again after each test.
    Object.assign(URL, {
      createObjectURL: (value: Blob) => {
        blob = value;
        return 'blob:test';
      },
      revokeObjectURL: () => undefined,
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      if (blob) saved.push({ blob, name: this.download });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [name, descriptor] of [
      ['createObjectURL', real.create],
      ['revokeObjectURL', real.revoke],
    ] as const) {
      if (descriptor) Object.defineProperty(URL, name, descriptor);
      else Reflect.deleteProperty(URL, name);
    }
  });

  const lastCsv = async () => {
    const file = saved.at(-1);
    if (!file) throw new Error('Nothing was downloaded.');
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    // UTF-8 with the byte order mark first.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(file.blob.type).toBe('text/csv;charset=utf-8');
    return { name: file.name, lines: new TextDecoder().decode(bytes).split('\r\n') };
  };

  it('is in Modelling only', async () => {
    stubApi(viewer, api);
    renderAt(at('viewing'));
    await screen.findByRole('grid', { name: 'Application elements' });
    expect(button()).toBeNull();
  });

  it('downloads the rows as filtered and sorted, with the tab in the name', async () => {
    stubApi(modeller, api);
    renderAt(at('modelling'));
    const grid = await screen.findByRole('grid', { name: 'Application elements' });
    // Sorted by Name at first; one click turns it round.
    const nameHeader = within(grid).getByRole('columnheader', { name: /^Name/ });
    expect(nameHeader.getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(nameHeader);
    await waitFor(() => {
      expect(nameHeader.getAttribute('aria-sort')).toBe('descending');
    });
    const download = button() as HTMLButtonElement;
    expect(download.disabled).toBe(false);
    fireEvent.click(download);
    let csv = await lastCsv();
    expect(csv.name).toMatch(/^Café Bakery Main-Application-\d{4}-\d{2}-\d{2}\.csv$/);
    // The decoder drops the byte order mark checked above.
    expect(csv.lines[0]?.startsWith('Name,Description,')).toBe(true);
    const names = () =>
      csv.lines
        .slice(1)
        .map((line) => line.split(',')[0])
        .filter(Boolean);
    expect(names()).toEqual(['"Till', 'Stock', "'=Orders"]);

    // Searching narrows the rows downloaded.
    const search = screen.getByRole('searchbox', { name: 'Search elements' });
    fireEvent.change(search, { target: { value: 'st' } });
    await waitFor(() => {
      expect(within(grid).getAllByRole('row')).toHaveLength(2);
    });
    fireEvent.click(button() as HTMLButtonElement);
    csv = await lastCsv();
    expect(names()).toEqual(['Stock']);
  });

  it('is disabled with no rows', async () => {
    stubApi(modeller, api);
    renderAt(at('modelling'));
    await screen.findByRole('grid', { name: 'Application elements' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search elements' }), {
      target: { value: 'nothing like it' },
    });
    await screen.findAllByText(/No elements match/);
    expect(button()?.disabled).toBe(true);
    fireEvent.click(button() as HTMLButtonElement);
    expect(saved).toEqual([]);
  });
});
