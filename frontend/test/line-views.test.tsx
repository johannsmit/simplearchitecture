import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildModelGraph,
  relationshipViewFields,
  type JgfDocument,
  type JgfEdge,
} from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type * as Labels from '../src/viewing/explorer/canvas/labels';
import {
  isGrayed,
  linkText,
  mergeRelationships,
  type CanvasLink,
} from '../src/viewing/explorer/canvas/view';
import { readShownProperties, shownPropertiesSearch } from '../src/viewing/paths';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { currentLocation, modeller, renderAt, stubApi, viewer, type Handler } from './helpers';

// Viewpoints by relationship metadata. Made-up data (the bakery fixture).

// jsdom has no layout, so no spot is ever free for a label: place every label at the origin.
vi.mock('../src/viewing/explorer/canvas/labels', async (importOriginal) => ({
  ...(await importOriginal<typeof Labels>()),
  placeLabel: () => ({ x: 0, y: 0 }),
}));

const withMetadata = (edge: JgfEdge): JgfEdge => {
  if (edge.source === 'customer') {
    return { ...edge, metadata: { ...edge.metadata, protocol: 'REST', auth: 'OAuth' } };
  }
  if (edge.source === 'till') {
    return { ...edge, metadata: { ...edge.metadata, owner: 'Made-up team' } };
  }
  return edge;
};
const model: JgfDocument = {
  graph: { ...bakeryModel.graph, edges: (bakeryModel.graph.edges ?? []).map(withMetadata) },
};

function api(document: JgfDocument = model): Handler {
  return ({ url, method }) => {
    if (method !== 'GET') return undefined;
    if (url === '/api/models') return Response.json({ models: [bakerySummary] });
    if (url === `/api/models/${bakeryId}`) return Response.json(document);
    return undefined;
  };
}

const at = (show = '') => `/viewing/models/${bakeryId}/elements/shop?depth=1${show}`;
const canvas = () => screen.getByRole('region', { name: /^Diagram:/ });
const cardCount = (count: number) =>
  waitFor(() => {
    expect(canvas().querySelectorAll('.card')).toHaveLength(count);
  });
const line = (name: string) =>
  [...canvas().querySelectorAll('.react-flow__edge')].find(
    (edge) => edge.getAttribute('aria-label') === name,
  ) as HTMLElement;
const customerLine = () => line('Customer relates to Web Shop');
const tillLine = () => line('Till relates to Web Shop');
const labels = () =>
  [...document.querySelectorAll('.edge-label')].map((label) => label.textContent).sort();
const button = () => screen.getByRole('button', { name: /^Show Viewpoints/ });
const pick = (name: string) => {
  if (button().getAttribute('aria-expanded') !== 'true') fireEvent.click(button());
  fireEvent.click(screen.getByRole('checkbox', { name }));
};

async function open(show = '', document: JgfDocument = model) {
  stubApi(viewer, api(document));
  renderAt(at(show));
  await cardCount(6);
}

beforeEach(() => {
  localStorage.clear();
});

describe('which properties a viewpoint can show', () => {
  it('lists custom properties and Architecture state by name, without technical keys', () => {
    const graph = buildModelGraph({
      graph: {
        ...model.graph,
        edges: [
          ...(model.graph.edges ?? []),
          {
            id: 'x1',
            source: 'shop',
            target: 'till',
            relation: 'Relation',
            metadata: {
              description: 'Made-up',
              archimateType: 'Serving',
              'simplearchitecture:stored': 'x',
              empty: ' ',
              shape: { kept: true },
            },
          },
          {
            id: 'x2',
            source: 'shop',
            target: 'till',
            relation: 'Contains',
            metadata: { onlyContains: 'x' },
          },
          {
            id: 'x3',
            source: 'till',
            target: 'shop',
            relation: 'Relation',
            metadata: { shape: 'plain text elsewhere', count: 3 },
          },
        ],
      },
    });
    expect(relationshipViewFields(graph).map((field) => field.label)).toEqual([
      'Architecture state',
      'auth',
      'count',
      'Data',
      'Identity',
      'Identity Context',
      'owner',
      'protocol',
    ]);
  });

  it('has nothing to offer in a model without relationships', () => {
    const graph = buildModelGraph({ graph: { ...model.graph, edges: [] } });
    expect(relationshipViewFields(graph)).toEqual([]);
  });
});

describe('the address', () => {
  it('reads repeated names, ignoring blanks, repeats and very long ones', () => {
    const params = new URLSearchParams(
      `show=protocol&show=&show=protocol&show=a%26b&show=${'x'.repeat(101)}`,
    );
    expect(readShownProperties(params)).toEqual(['protocol', 'a&b']);
    const many = new URLSearchParams(Array.from({ length: 30 }, (_, i) => ['show', `k${i}`]));
    expect(readShownProperties(many)).toHaveLength(20);
  });

  it('keeps other parameters and clears cleanly', () => {
    const params = new URLSearchParams('depth=2&show=old');
    expect(shownPropertiesSearch(params, ['a&b', 'c'])).toBe('?depth=2&show=a%26b&show=c');
    expect(shownPropertiesSearch(new URLSearchParams('show=old'), [])).toBe('');
  });
});

describe('a viewpoint on the canvas', () => {
  it('with nothing selected, a line shows its label and nothing is grayed out', async () => {
    await open();
    await waitFor(() => {
      expect(labels()).toContain('Places orders');
    });
    expect(canvas().querySelectorAll('.is-grayed')).toHaveLength(0);
    expect(button().textContent).toBe('Show Viewpoints');
  });

  it('shows the selected values in place of the label and grays out the rest', async () => {
    await open();
    await waitFor(() => {
      expect(labels()).toContain('Places orders');
    });
    pick('protocol');
    await waitFor(() => {
      expect(labels()).toContain('REST');
    });
    expect(labels()).not.toContain('Places orders');
    expect(customerLine().classList.contains('is-grayed')).toBe(false);
    expect(tillLine().classList.contains('is-grayed')).toBe(true);
    expect(currentLocation()).toContain('show=protocol');
    expect(button().textContent).toBe('Show Viewpoints: 1 selected');

    // One of several is enough, and values come in the list's order.
    pick('auth');
    await waitFor(() => {
      expect(labels()).toContain('OAuth · REST');
    });
    pick('owner');
    await waitFor(() => {
      expect(tillLine().classList.contains('is-grayed')).toBe(false);
    });
    expect(labels()).toContain('Made-up team');

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => {
      expect(labels()).toContain('Places orders');
    });
    expect(canvas().querySelectorAll('.is-grayed')).toHaveLength(0);
    expect(currentLocation()).not.toContain('show=');
  });

  it('a grayed-out line still lights up on hover and shows nothing', async () => {
    await open('&show=protocol');
    await waitFor(() => {
      expect(tillLine().classList.contains('is-grayed')).toBe(true);
    });
    fireEvent.mouseEnter(tillLine());
    await waitFor(() => {
      expect(tillLine().classList.contains('is-lit')).toBe(true);
    });
    expect(tillLine().classList.contains('is-grayed')).toBe(false);
    expect(document.querySelector('.edge-label.is-lit')).toBeNull();
  });

  it('moves nothing when the selection changes', async () => {
    await open();
    const positions = () =>
      [...canvas().querySelectorAll<HTMLElement>('.react-flow__node')].map(
        (node) => node.style.transform,
      );
    const before = positions();
    pick('protocol');
    await waitFor(() => {
      expect(labels()).toContain('REST');
    });
    expect(positions()).toEqual(before);
  });

  it('opens a shared link with the same viewpoint, ignoring what the model doesn’t have', async () => {
    await open('&show=protocol&show=made-up-missing');
    await waitFor(() => {
      expect(labels()).toContain('REST');
    });
    expect(button().textContent).toBe('Show Viewpoints: 1 selected');
  });

  it('keeps the selection when moving to another element', async () => {
    await open('&show=protocol');
    await waitFor(() => {
      expect(labels()).toContain('REST');
    });
    const card = canvas().querySelector('.card[data-element-id="customer"] .card-main');
    fireEvent.click(card as HTMLElement, { detail: 2 });
    await waitFor(() => {
      expect(currentLocation()).toContain('/elements/customer?');
    });
    expect(currentLocation()).toContain('show=protocol');
  });

  it('keeps nothing of a selection in the browser’s storage', async () => {
    await open();
    pick('protocol');
    await waitFor(() => {
      expect(labels()).toContain('REST');
    });
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain('protocol');
  });

  it('says when a model has no Relations to choose from', async () => {
    const empty: JgfDocument = { graph: { ...model.graph, edges: [] } };
    stubApi(viewer, api(empty));
    renderAt(at());
    await screen.findByRole('region', { name: /^Diagram:/ });
    fireEvent.click(await screen.findByRole('button', { name: /^Show Viewpoints/ }));
    expect(screen.getByText('No Relations in this model yet.')).toBeDefined();
  });

  it('closes with Esc, focus back on the button, without reaching the canvas’s own keys', async () => {
    await open();
    fireEvent.click(button());
    const box = screen.getByRole('group', { name: 'Relationship properties' });
    const before = currentLocation();
    fireEvent.keyDown(within(box).getAllByRole('checkbox')[0] as HTMLElement, { key: '3' });
    expect(currentLocation()).toBe(before);
    fireEvent.keyDown(within(box).getAllByRole('checkbox')[0] as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Relationship properties' })).toBeNull();
    expect(document.activeElement).toBe(button());
  });
});

describe('the line rules', () => {
  const member = (metadata: Record<string, unknown>, id = 'm1') => ({
    id,
    source: 'a',
    target: 'b',
    type: 'Relation' as const,
    architectureState: 'Current' as const,
    metadata,
  });
  const one = (metadata: Record<string, unknown>, label?: string) => {
    const [link] = mergeRelationships([{ ...member(metadata), ...(label ? { label } : {}) }]);
    return link as CanvasLink;
  };

  it('never reads an inherited member for a key such as constructor', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(linkText(one({}, 'Made-up'), [key])).toBe('');
      expect(isGrayed(one({}), [key])).toBe(true);
    }
    expect(linkText(one({ constructor: 'Made-up' }), ['constructor'])).toBe('Made-up');
    expect(isGrayed(one({ constructor: 'Made-up' }), ['constructor'])).toBe(false);
  });

  it('counts 0 and false as values, and blank text, null, lists and objects as none', () => {
    expect(linkText(one({ a: 0, b: false }), ['a', 'b'])).toBe('0 · false');
    expect(isGrayed(one({ a: 0 }), ['a'])).toBe(false);
    expect(isGrayed(one({ a: false }), ['a'])).toBe(false);
    for (const a of ['', '   ', null, ['x'], { x: 'y' }]) {
      expect(isGrayed(one({ a }), ['a'])).toBe(true);
      expect(linkText(one({ a }, 'Made-up'), ['a'])).toBe('');
    }
    expect(linkText(one({ a: '  REST ' }), ['a'])).toBe('REST');
  });

  it('shows a label with nothing selected, and every line has an Architecture state', () => {
    expect(linkText(one({ a: 'x' }, 'Made-up'))).toBe('Made-up');
    expect(linkText(one({ a: 'x' }))).toBe('');
    expect(isGrayed(one({}), [])).toBe(false);
    expect(linkText(one({}), ['architectureState'])).toBe('Current');
    expect(isGrayed(one({}), ['architectureState'])).toBe(false);
    expect(linkText(one({ architectureState: 'Made-up' }), ['architectureState'])).toBe('Current');
  });

  it('grays a merged line only if none of them has a selected property, and counts it', () => {
    const merged = (first: Record<string, unknown>, second: Record<string, unknown>) =>
      mergeRelationships([member(first, 'm1'), member(second, 'm2')])[0] as CanvasLink;
    expect(linkText(merged({ a: 'x' }, {}), ['a'])).toBe('×2');
    expect(isGrayed(merged({ a: 'x' }, {}), ['a'])).toBe(false);
    expect(isGrayed(merged({}, { a: 'x' }), ['a'])).toBe(false);
    expect(isGrayed(merged({}, {}), ['a'])).toBe(true);
    expect(linkText(merged({}, {}), ['a'])).toBe('×2');
  });

  it('leaves Contains alone, whatever it holds', () => {
    const [link] = mergeRelationships([
      { ...member({ a: 'x' }), type: 'Contains', label: 'Made-up' },
    ]);
    expect(linkText(link as CanvasLink, ['a'])).toBe('Made-up');
    expect(isGrayed(link as CanvasLink, ['a'])).toBe(false);
    const [plain] = mergeRelationships([{ ...member({}), type: 'Contains' }]);
    expect(isGrayed(plain as CanvasLink, ['a'])).toBe(false);
  });

  it('lists an own key named constructor', () => {
    const graph = buildModelGraph({
      graph: {
        ...model.graph,
        edges: [
          {
            id: 'c1',
            source: 'shop',
            target: 'till',
            relation: 'Relation',
            metadata: { constructor: 'x', flag: false, zero: 0 },
          },
        ],
      },
    });
    expect(relationshipViewFields(graph).map((field) => field.key)).toEqual([
      'architectureState',
      'constructor',
      'data',
      'flag',
      'identity',
      'identityContext',
      'zero',
    ]);
  });

  it('offers Request Data and Response Data as one choice, Data, and never Data kept from before', () => {
    const graph = buildModelGraph({
      graph: {
        ...model.graph,
        edges: [
          {
            id: 'c1',
            source: 'shop',
            target: 'till',
            relation: 'Relation',
            metadata: { requestData: ['a'], responseData: ['b'], data: 'c' },
          },
        ],
      },
    });
    const fields = relationshipViewFields(graph);
    expect(fields.filter((field) => /data/i.test(field.key))).toEqual([
      { key: 'data', label: 'Data' },
    ]);
  });

  // The element filter's exclusions were read for relationships too. On a relationship,
  // `functions` is an ordinary custom key that the form accepts and the panel lists.
  it('offers a custom key named functions, which the form accepts', () => {
    const graph = buildModelGraph({
      graph: {
        ...model.graph,
        edges: [
          {
            id: 'c1',
            source: 'shop',
            target: 'till',
            relation: 'Relation',
            metadata: { functions: 'Made-up' },
          },
        ],
      },
    });
    expect(relationshipViewFields(graph).map((field) => field.key)).toContain('functions');
  });

  it('still leaves out a list named functions', () => {
    const graph = buildModelGraph({
      graph: {
        ...model.graph,
        edges: [
          {
            id: 'c1',
            source: 'shop',
            target: 'till',
            relation: 'Relation',
            metadata: { functions: ['Made-up'] },
          },
        ],
      },
    });
    expect(relationshipViewFields(graph).map((field) => field.key)).not.toContain('functions');
  });
});

describe('Data in a viewpoint', () => {
  /** The lines of each label on the canvas, sorted by their text. */
  const labelLines = () =>
    [...document.querySelectorAll('.edge-label')]
      .map((label) => [...label.querySelectorAll('.t')].map((part) => part.textContent))
      .sort((a, b) => (a.join('\n') < b.join('\n') ? -1 : 1));

  it('shows Request Data and Response Data under the other values, and grays out the rest', async () => {
    const edges = (model.graph.edges ?? []).map((edge) =>
      edge.source === 'customer'
        ? { ...edge, metadata: { ...edge.metadata, responseData: ['Order numbers', 'Receipts'] } }
        : edge,
    );
    await open('&show=data&show=protocol', { graph: { ...model.graph, edges } });
    await waitFor(() => {
      expect(labelLines()).toContainEqual([
        'REST',
        'Req: Places orders',
        'Resp: Order numbers, Receipts',
      ]);
    });
    // The till's line has neither: gray, and its label gives way.
    expect(tillLine().classList.contains('is-grayed')).toBe(true);
  });

  it('leaves out an empty part, and the other keeps its prefix', () => {
    const relationship = (metadata: Record<string, unknown>) => ({
      id: 'r',
      source: 'a',
      target: 'b',
      type: 'Relation' as const,
      architectureState: 'Target' as const,
      metadata,
    });
    for (const [metadata, text] of [
      [
        { requestData: ['Orders', 'Invoices'], responseData: ['Order ids'] },
        'Req: Orders, Invoices\nResp: Order ids',
      ],
      [{ requestData: ['Orders'] }, 'Req: Orders'],
      [{ responseData: [' Order\n  ids '] }, 'Resp: Order ids'],
      [{ requestData: [], responseData: ['  '] }, ''],
      [{ data: 'From before', requestData: ['Orders'] }, 'Req: Orders'],
    ] as const) {
      const [link] = mergeRelationships([relationship(metadata)]);
      if (!link) throw new Error('no link');
      expect(linkText(link, ['data'])).toBe(text);
      expect(isGrayed(link, ['data'])).toBe(text === '');
      // Other values go first, on one line.
      expect(linkText(link, ['data', 'architectureState'])).toBe(
        text === '' ? 'Target' : `Target\n${text}`,
      );
    }
  });

  it('reads a single text as one value, and counts blanks and objects as not having it', () => {
    const relationship = (value: unknown) => ({
      id: 'r',
      source: 'a',
      target: 'b',
      type: 'Relation' as const,
      architectureState: 'Current' as const,
      metadata: { requestData: value, responseData: value },
    });
    for (const [value, text] of [
      [['Orders', 'Bills'], 'Req: Orders, Bills\nResp: Orders, Bills'],
      ['Orders', 'Req: Orders\nResp: Orders'],
      ['  ', ''],
      [[], ''],
      [['  ', ''], ''],
      [[{ a: 1 }], ''],
      [{ a: 1 }, ''],
      [[1, 'a'], 'Req: 1, a\nResp: 1, a'],
    ] as const) {
      const [link] = mergeRelationships([relationship(value)]);
      if (!link) throw new Error('no link');
      expect(isGrayed(link, ['data'])).toBe(text === '');
      expect(linkText(link, ['data'])).toBe(text);
    }
  });

  it('keeps a label on one line', () => {
    const [link] = mergeRelationships([
      {
        id: 'r',
        source: 'a',
        target: 'b',
        type: 'Relation' as const,
        architectureState: 'Current' as const,
        label: 'Sends\n  orders',
        metadata: {},
      },
    ]);
    if (!link) throw new Error('no link');
    expect(linkText(link)).toBe('Sends orders');
  });

  it('merges Relations whatever their Data, and keeps two-way lines apart', () => {
    const relation = (id: string, data: string, twoWay = false) => ({
      id,
      source: 'a',
      target: 'b',
      type: 'Relation' as const,
      architectureState: 'Current' as const,
      metadata: { requestData: data },
      ...(twoWay ? { twoWay } : {}),
    });
    const merged = mergeRelationships([
      relation('f1', 'Orders'),
      relation('p1', ''),
      relation('f2', 'Invoices'),
      relation('w', 'Orders', true),
    ]);
    expect(merged.map((link) => [link.twoWay, link.count])).toEqual([
      [false, 3],
      [true, 1],
    ]);
    expect(merged.map((link) => linkText(link, ['data']))).toEqual(['×3', 'Req: Orders']);
  });

  it('leaves Contains out of it', async () => {
    const edges = [
      ...(model.graph.edges ?? []),
      { id: 'c1', source: 'till', target: 'shop', relation: 'Contains', label: 'Made-up' },
    ];
    await open('&show=data', { graph: { ...model.graph, edges } });
    await waitFor(() => {
      expect(labels()).toContain('Req: Places orders');
    });
    expect(canvas().querySelectorAll('.is-grayed').length).toBeGreaterThan(0);
    const contains = [...canvas().querySelectorAll('.react-flow__edge')].filter((edge) =>
      edge.getAttribute('aria-label')?.includes(' contains '),
    );
    for (const edge of contains) expect(edge.classList.contains('is-grayed')).toBe(false);
  });

  it('is one choice, Data, for both parts', async () => {
    await open();
    fireEvent.click(button());
    const choices = screen.getAllByRole('checkbox').map((box) => box.closest('label')?.textContent);
    expect(choices).toContain('Data');
    expect(choices).not.toContain('Request Data');
    expect(choices).not.toContain('Response Data');
  });
});

describe('the address', () => {
  it('ignores hostile values without an error, and writes them back encoded', async () => {
    const hostile = encodeURIComponent('<img src=x onerror=alert(1)>');
    await open(
      `&show=${hostile}&show=__proto__&show=constructor&show=%E0%A4%A&show=%00&show=protocol`,
    );
    await waitFor(() => {
      expect(labels()).toContain('REST');
    });
    expect(button().textContent).toBe('Show Viewpoints: 1 selected');
    expect(document.querySelector('img[src="x"]')).toBeNull();
    pick('auth');
    await waitFor(() => {
      expect(currentLocation()).toContain('show=auth');
    });
    // A tick writes only what this model has.
    expect(currentLocation()).not.toContain('onerror');
    expect(currentLocation()).not.toContain('__proto__');
  });

  it('keeps the selection through depth and the catalog, and leaves storage alone', async () => {
    await open('&show=protocol');
    await waitFor(() => {
      expect(labels()).toContain('REST');
    });
    fireEvent.keyDown(canvas(), { key: '2' });
    await waitFor(() => {
      expect(currentLocation()).toContain('depth=2');
    });
    expect(currentLocation()).toContain('show=protocol');
    fireEvent.click(screen.getByRole('button', { name: 'Catalog' }));
    await waitFor(() => {
      expect(currentLocation()).toContain('view=catalog');
    });
    expect(currentLocation()).toContain('show=protocol');
    fireEvent.click(screen.getByRole('button', { name: 'Canvas' }));
    await waitFor(() => {
      expect(currentLocation()).not.toContain('view=catalog');
    });
    expect(currentLocation()).toContain('show=protocol');
    const stored = JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]);
    expect(stored).not.toContain('protocol');
  });

  it('keeps the selection on the link into Modelling', async () => {
    stubApi(modeller, api());
    renderAt(at('&show=protocol'));
    await cardCount(6);
    const link = await screen.findByRole('link', { name: 'Open in Modelling' });
    expect(link.getAttribute('href')).toContain('show=protocol');
  });

  // A tick past the cap (or on a stored key over 100 characters) bounced back with no word.
  it('says why no more can be ticked past the cap of 20', async () => {
    const metadata = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${10 + i}`, 'x']));
    const many: JgfDocument = {
      graph: {
        ...model.graph,
        edges: (model.graph.edges ?? []).map((edge) =>
          edge.source === 'customer' ? { ...edge, metadata } : edge,
        ),
      },
    };
    const show = Object.keys(metadata)
      .slice(0, 20)
      .map((key) => `&show=${key}`)
      .join('');
    await open(show, many);
    expect(button().textContent).toBe('Show Viewpoints: 20 selected');
    fireEvent.click(button());
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'k30' }).disabled).toBe(true);
    expect(
      screen.getByText('At most 20 properties at a time.').closest('[role="status"]'),
    ).not.toBeNull();
    // A ticked box can still be cleared, and that frees the others.
    const ticked = screen.getByRole<HTMLInputElement>('checkbox', { name: 'k10' });
    expect(ticked.disabled).toBe(false);
    fireEvent.click(ticked);
    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'k30' }).disabled).toBe(false);
    });
  });

  it('says why a stored key over 100 characters cannot be ticked', async () => {
    const long = 'k'.repeat(101);
    const document: JgfDocument = {
      graph: {
        ...model.graph,
        edges: (model.graph.edges ?? []).map((edge) =>
          edge.source === 'customer' ? { ...edge, metadata: { [long]: 'x' } } : edge,
        ),
      },
    };
    await open('', document);
    fireEvent.click(button());
    const box = screen.getByRole<HTMLInputElement>('checkbox', {
      name: `${long} (name too long to select)`,
    });
    expect(box.disabled).toBe(true);
  });
});

describe('the selector for a keyboard user', () => {
  it('keeps focus on a box after ticking it', async () => {
    await open();
    fireEvent.click(button());
    const box = screen.getByRole<HTMLInputElement>('checkbox', { name: 'protocol' });
    box.focus();
    fireEvent.click(box);
    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'protocol' }).checked).toBe(
        true,
      );
    });
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'protocol' }));
  });

  // Clear removes itself while it has focus, so focus fell out of the list to the page.
  it('keeps focus in the selector after Clear', async () => {
    await open('&show=protocol');
    fireEvent.click(button());
    const clear = screen.getByRole('button', { name: 'Clear' });
    clear.focus();
    fireEvent.click(clear);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    });
    expect(document.querySelector('.line-props')?.contains(document.activeElement)).toBe(true);
  });

  it('closes when focus tabs out of it, and not when it moves inside', async () => {
    await open();
    fireEvent.click(button());
    const box = screen.getByRole('checkbox', { name: 'protocol' });
    fireEvent.blur(box, { relatedTarget: screen.getByRole('checkbox', { name: 'auth' }) });
    expect(button().getAttribute('aria-expanded')).toBe('true');
    fireEvent.blur(box, { relatedTarget: canvas() });
    expect(button().getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the gray look', () => {
  // jsdom applies rules in order only. The rules compared here have the same specificity, so their
  // order is what decides in a browser too.
  const lineWith = (classes: string) => {
    const edge = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    edge.setAttribute('class', `react-flow__edge ${classes}`);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'react-flow__edge-path');
    edge.append(path);
    document.body.append(edge);
    onTestFinished(() => {
      edge.remove();
    });
    return { opacity: getComputedStyle(edge).opacity, width: getComputedStyle(path).strokeWidth };
  };
  const labelWith = (classes: string) => {
    const label = document.createElement('div');
    label.className = `edge-label ${classes}`;
    document.body.append(label);
    onTestFinished(() => {
      label.remove();
    });
    return getComputedStyle(label).opacity;
  };
  const styled = () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(
      join(import.meta.dirname, '../src/styles/explorer.css'),
      'utf8',
    );
    document.head.append(style);
    onTestFinished(() => {
      style.remove();
    });
  };

  it('a dimmed line stays dimmed whether or not it is also gray', () => {
    styled();
    expect(lineWith('is-dim').opacity).toBe('0.15');
    expect(lineWith('is-dim is-grayed').opacity).toBe('0.15');
    expect(lineWith('is-grayed').opacity).toBe('0.4');
  });

  it('a gray line is thin whatever its state, and its count fades with it', () => {
    styled();
    expect(lineWith('is-grayed is-target').width).toBe('1');
    expect(lineWith('is-target').width).toBe('2');
    expect(labelWith('is-grayed')).toBe('0.55');
    expect(labelWith('is-grayed is-dim')).toBe('0.35');
  });

  it('marks the count of a merged gray line', async () => {
    await open('&show=protocol');
    const count = () =>
      [...document.querySelectorAll('.edge-label')].find((l) => l.textContent === '×2');
    await waitFor(() => {
      expect(count()?.classList.contains('is-grayed')).toBe(true);
    });
  });
});
