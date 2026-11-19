import type {
  JgfDocument,
  ModelSummary,
  StoredView,
  ViewCardLayout,
  ViewLineRoute,
} from '@simplearchitecture/shared';
import { cleanup, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getElk } from '../src/viewing/explorer/canvas/elkEngine';
import { apiError, modeller, renderAt, stubApi, viewer, type Handler } from './helpers';
import { settle } from './settle';

// Tidy relations: every card stays where it is, and every line is drawn again from the cards,
// lines moved by hand too. Made-up data: a small orchard.

const modelId = '57575757-5757-4575-8575-575757575757';

const orchard: JgfDocument = {
  graph: {
    id: modelId,
    label: 'Made-up orchard',
    directed: true,
    nodes: {
      press: { label: 'Cider press', metadata: { type: 'Application' } },
      store: { label: 'Cold store', metadata: { type: 'Application' } },
      shop: { label: 'Farm shop', metadata: { type: 'Application' } },
      trees: { label: 'Trees', metadata: { type: 'Infrastructure' } },
      barn: { label: 'Barn', metadata: { type: 'Other' } },
    },
    edges: [
      { id: 'o1', source: 'trees', target: 'press', relation: 'Relation' },
      { id: 'o2', source: 'press', target: 'store', relation: 'Relation', label: 'Fills' },
      { id: 'o3', source: 'store', target: 'shop', relation: 'Relation' },
      { id: 'o4', source: 'barn', target: 'shop', relation: 'Contains' },
    ],
  },
};

const summary: ModelSummary = {
  id: modelId,
  name: 'Made-up orchard',
  createdAt: '2026-11-01T10:00:00.000Z',
  createdBy: { id: 'u1', name: 'Sam Taylor' },
  nodeCount: 5,
  edgeCount: 4,
};

const author = { id: 'u1', name: 'Sam Taylor' };

function view(
  id: string,
  elementIds: string[],
  relationshipIds: string[],
  layout: ViewCardLayout[] = [],
  routes: ViewLineRoute[] = [],
): StoredView {
  return {
    id,
    name: id === 'v-harvest' ? 'Harvest' : 'Sheds',
    folder: null,
    version: 1,
    elementCount: elementIds.length,
    relationshipCount: relationshipIds.length,
    createdAt: '2026-11-05T09:00:00.000Z',
    createdBy: author,
    updatedAt: '2026-11-05T09:00:00.000Z',
    updatedBy: author,
    elementIds,
    relationshipIds,
    layout,
    routes,
  };
}

const left: ViewCardLayout[] = [
  { elementId: 'trees', x: 40, y: 20 },
  { elementId: 'press', x: 400, y: 20, width: 320 },
  { elementId: 'store', x: 40, y: 300 },
  { elementId: 'shop', x: 400, y: 300 },
];
// Cider press to Cold store, moved by hand: out of the press's left side, across and down.
const pressToStore = [
  { x: 400, y: 30 },
  { x: 300, y: 30 },
  { x: 300, y: 250 },
  { x: 124, y: 250 },
  { x: 124, y: 300 },
];
const harvest = (routes: ViewLineRoute[] = [{ relationshipId: 'o2', points: pressToStore }]) =>
  view('v-harvest', ['trees', 'press', 'store', 'shop'], ['o1', 'o2', 'o3'], left, routes);

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

/** The model and its views, kept by a made-up server with versions, as the API does. */
function server(initial: StoredView[]) {
  const views = new Map(initial.map((each) => [each.id, structuredClone(each)]));
  const calls: Call[] = [];
  const handler: Handler = ({ url, method, body }) => {
    if (url === '/api/models') return Response.json({ models: [summary], editable: true });
    if (url === `/api/models/${modelId}`) return Response.json(orchard);
    if (url.startsWith(`/api/models/${modelId}/elements/`)) {
      const id = decodeURIComponent(url.split('/elements/')[1]?.split('/')[0] ?? '');
      if (url.endsWith('/views')) return Response.json({ views: [] });
      return Response.json({
        element: { id, version: 1, node: orchard.graph.nodes?.[id] },
        warnings: [],
      });
    }
    if (url === `/api/models/${modelId}/views`) {
      return Response.json({
        views: [...views.values()].map((each) => ({
          ...each,
          elementIds: undefined,
          layout: undefined,
        })),
      });
    }
    const match = new RegExp(`^/api/models/${modelId}/views/([^/]+)(/layout)?$`).exec(url);
    const stored = match && views.get(match[1] ?? '');
    if (!match || !stored) return undefined;
    const parsed =
      typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : undefined;
    calls.push({ method, url, body: parsed });
    if (method === 'GET') return Response.json({ view: stored });
    if (parsed?.version !== stored.version) {
      return apiError(409, 'Someone else changed this view.', { currentVersion: stored.version });
    }
    if (match[2] === '/layout') {
      const next = {
        ...stored,
        version: stored.version + 1,
        layout: parsed.cards as ViewCardLayout[],
        routes: (parsed.routes ?? []) as ViewLineRoute[],
      };
      views.set(stored.id, next);
      return Response.json({ view: next });
    }
    return undefined;
  };
  return { handler, calls, views };
}

const canvasEl = () => document.getElementById('canvas') as HTMLElement;
const card = (id: string) =>
  canvasEl().querySelector<HTMLElement>(`.card[data-element-id="${CSS.escape(id)}"]`);
const mainOf = (id: string) => card(id)?.querySelector<HTMLElement>('.card-main') as HTMLElement;
const cardIds = () =>
  [...canvasEl().querySelectorAll('.card[data-element-id]')]
    .map((element) => element.getAttribute('data-element-id') ?? '')
    .sort();
/** Every card's place and size, as React Flow draws it. */
const placesOf = () =>
  [...canvasEl().querySelectorAll<HTMLElement>('.react-flow__node')]
    .map(
      (node) =>
        `${node.querySelector('.card')?.getAttribute('data-element-id') ?? ''} ${node.style.transform} ${node.style.width} ${node.style.height}`,
    )
    .sort();
const lineOf = (name: RegExp) =>
  [...canvasEl().querySelectorAll<HTMLElement>('.react-flow__edge')].find((edge) =>
    name.test(edge.getAttribute('aria-label') ?? ''),
  ) as HTMLElement;
const pathOf = (edge: HTMLElement) =>
  edge.querySelector('path.react-flow__edge-path')?.getAttribute('d') ?? '';
const paths = () =>
  [...canvasEl().querySelectorAll<HTMLElement>('.react-flow__edge')]
    .map((edge) => `${edge.getAttribute('aria-label') ?? ''}: ${pathOf(edge)}`)
    .sort();
const live = () => canvasEl().querySelector('[aria-live="polite"]')?.textContent ?? '';
const tidyUp = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Tidy up' });
const arrow = () => screen.getByRole<HTMLButtonElement>('button', { name: 'More ways to tidy' });
const menu = () => screen.getByRole('menu', { name: 'More ways to tidy' });
const item = (name: string) => within(menu()).getByRole<HTMLButtonElement>('menuitem', { name });
const layoutSaves = (calls: Call[]) => calls.filter((call) => call.url.endsWith('/layout'));
const changes = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');
const linesSwitch = () =>
  screen.getByRole<HTMLInputElement>('switch', { name: 'Show relationships' });

async function openView(
  space: 'viewing' | 'modelling',
  stored: StoredView,
  fake = server([stored]),
) {
  stubApi(space === 'viewing' ? viewer : modeller, fake.handler);
  const rendered = renderAt(`/${space}/models/${modelId}/views/${stored.id}`);
  await waitFor(() => {
    expect(cardIds()).toEqual([...stored.elementIds].sort());
  });
  await settle();
  return { ...fake, rendered };
}

async function openFocus(space: 'viewing' | 'modelling', id = 'press') {
  const fake = server([]);
  stubApi(space === 'viewing' ? viewer : modeller, fake.handler);
  renderAt(`/${space}/models/${modelId}/elements/${id}?depth=1`);
  await waitFor(() => {
    expect(cardIds()).toEqual(['press', 'store', 'trees']);
  });
  await settle();
  return fake;
}

/** Opens the tidy menu and chooses an item in it. */
function choose(name: string) {
  fireEvent.click(arrow());
  fireEvent.click(item(name));
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('Tidy relations in a view in Modelling', () => {
  it('moves no card, redraws the line moved by hand, says so, saves, and reopens the same', async () => {
    const fake = await openView('modelling', harvest());
    const before = placesOf();
    const moved = pathOf(lineOf(/^Cider press .* Cold store$/));
    expect(moved.startsWith('M400 30')).toBe(true);
    expect(tidyUp().disabled).toBe(false);

    choose('Tidy relations');
    expect(document.activeElement).toBe(canvasEl());
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    expect(live()).toBe('Relations tidied up, including lines moved by hand. No card moved.');
    expect(placesOf()).toEqual(before);
    // The line moved by hand is drawn from its cards again.
    expect(pathOf(lineOf(/^Cider press .* Cold store$/))).not.toBe(moved);
    // The cards as they were, widths set by hand included; no line keeps a route of its own.
    const [save] = layoutSaves(fake.calls);
    expect(save?.body?.cards).toEqual(left);
    expect(save?.body?.routes ?? []).toEqual([]);
    await screen.findByText('Saved');
    const tidied = paths();

    // Opened again: the cards and the redrawn lines as they were left. Nothing more is saved.
    fake.rendered.unmount();
    cleanup();
    await openView('modelling', harvest(), fake);
    expect(placesOf()).toEqual(before);
    expect(paths()).toEqual(tidied);
    expect(layoutSaves(fake.calls)).toHaveLength(1);
  });

  it('drops the automatic layout’s routes too, enables Tidy up, and names no hand-moved line', async () => {
    // No stored layout: the view opens laid out by ELK, with its routes.
    const fake = await openView(
      'modelling',
      view('v-harvest', ['trees', 'press', 'store', 'shop'], ['o1', 'o2', 'o3']),
    );
    expect(tidyUp().disabled).toBe(true);
    const before = placesOf();

    fireEvent.click(arrow());
    // Tidy up can't be used, so the menu starts on Tidy relations.
    expect(item('Tidy up').getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(item('Tidy relations'));
    fireEvent.click(item('Tidy relations'));
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    expect(live()).toBe('Relations tidied up. No card moved.');
    expect(placesOf()).toEqual(before);
    // Tidy up would save a route for each line; after Tidy relations, none has one.
    expect(layoutSaves(fake.calls)[0]?.body?.routes ?? []).toEqual([]);
    expect(tidyUp().disabled).toBe(false);
  });

  it('runs with T on the canvas or a card, either case, and not with Ctrl, ⌘ or Alt', async () => {
    const fake = await openView('modelling', harvest());
    const before = placesOf();
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      fireEvent.keyDown(canvasEl(), { key: 't', ...modifier });
    }
    await settle();
    expect(changes(fake.calls)).toEqual([]);

    mainOf('store').focus();
    fireEvent.keyDown(mainOf('store'), { key: 'T' });
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    expect(live()).toBe('Relations tidied up, including lines moved by hand. No card moved.');
    // Focus stays on the card; nothing moved.
    expect(document.activeElement).toBe(mainOf('store'));
    expect(placesOf()).toEqual(before);

    fireEvent.keyDown(canvasEl(), { key: 't' });
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(2);
    });
    expect(live()).toBe('Relations tidied up. No card moved.');
  });

  it('ignores T in a field and in move mode', async () => {
    const fake = await openView('modelling', harvest());
    const search = screen.getByRole('searchbox');
    fireEvent.keyDown(search, { key: 't' });

    const main = mainOf('store');
    main.focus();
    fireEvent.keyDown(main, { key: 'm' });
    fireEvent.keyDown(main, { key: 't' });
    fireEvent.keyDown(main, { key: 'Escape' });
    await settle();
    expect(changes(fake.calls)).toEqual([]);
    expect(live()).not.toContain('Relations tidied up');
  });

  it('keeps a container and the card nested in it, and the open relationship', async () => {
    // The Barn holds the Farm shop: drawn inside it, with a line into it from the Cold store.
    const barnView = view(
      'v-barn',
      ['press', 'store', 'shop', 'barn'],
      ['o2', 'o3', 'o4'],
      [
        { elementId: 'press', x: 400, y: 20 },
        { elementId: 'store', x: 40, y: 300 },
        { elementId: 'barn', x: 400, y: 300 },
        { elementId: 'shop', x: 416, y: 356 },
      ],
    );
    const fake = await openView('modelling', barnView);
    const container = () => canvasEl().querySelector('.card.is-container');
    expect(container()?.getAttribute('data-element-id')).toBe('barn');
    const before = placesOf();
    // Open the relationship by its label.
    const label = [...canvasEl().querySelectorAll<HTMLElement>('.edge-label')].find(
      (each) => each.textContent === 'Fills',
    ) as HTMLElement;
    fireEvent.click(label);
    const open = await screen.findByDisplayValue('Fills');

    fireEvent.keyDown(canvasEl(), { key: 't' });
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    expect(live()).toBe('Relations tidied up. No card moved.');
    // Every card, the container and the card inside it included, keeps its place and size.
    expect(placesOf()).toEqual(before);
    expect(layoutSaves(fake.calls)[0]?.body?.cards).toEqual(barnView.layout);
    // The relationship is still open.
    expect(open.isConnected).toBe(true);
    expect(screen.getByDisplayValue('Fills')).toBe(open);
  });
});

describe('Tidy relations where nothing is saved', () => {
  it('redraws in a view in Viewing, and saves nothing', async () => {
    const fake = await openView('viewing', harvest());
    const before = placesOf();
    choose('Tidy relations');
    expect(live()).toBe('Relations tidied up, including lines moved by hand. No card moved.');
    await settle();
    expect(placesOf()).toEqual(before);
    expect(changes(fake.calls)).toEqual([]);
  });

  it('redraws on a focused element’s canvas, after a card was moved, and saves nothing', async () => {
    const fake = await openFocus('modelling');
    const main = mainOf('trees');
    main.focus();
    fireEvent.keyDown(main, { key: 'm' });
    fireEvent.keyDown(main, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(main, { key: 'Enter' });
    await settle();
    const before = placesOf();

    fireEvent.keyDown(canvasEl(), { key: 't' });
    expect(live()).toBe('Relations tidied up. No card moved.');
    await settle();
    expect(placesOf()).toEqual(before);
    expect(changes(fake.calls)).toEqual([]);
  });
});

describe('when Tidy relations can be used', () => {
  it('not with Show relationships off: then the arrow is off too while Tidy up is', async () => {
    const fake = await openView(
      'modelling',
      view('v-harvest', ['trees', 'press', 'store', 'shop'], ['o1', 'o2', 'o3']),
    );
    expect(arrow().disabled).toBe(false);
    fireEvent.click(linesSwitch());
    await waitFor(() => {
      expect(arrow().disabled).toBe(true);
    });
    fireEvent.keyDown(canvasEl(), { key: 't' });
    await settle();
    expect(changes(fake.calls)).toEqual([]);
    expect(live()).not.toContain('Relations tidied up');

    // A card moved: Tidy up can be used, so the arrow can, with Tidy relations still off.
    const main = mainOf('shop');
    main.focus();
    fireEvent.keyDown(main, { key: 'm' });
    fireEvent.keyDown(main, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(main, { key: 'Enter' });
    await waitFor(() => {
      expect(arrow().disabled).toBe(false);
    });
    fireEvent.click(arrow());
    expect(item('Tidy relations').getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(item('Tidy up'));
    // A disabled item does nothing, and the menu stays open.
    const saves = layoutSaves(fake.calls).length;
    fireEvent.click(item('Tidy relations'));
    expect(menu()).toBeTruthy();
    await settle();
    expect(layoutSaves(fake.calls)).toHaveLength(saves);
  });

  it('not on a canvas with no line', async () => {
    await openView('modelling', view('v-sheds', ['barn', 'trees'], []));
    expect(tidyUp().disabled).toBe(true);
    expect(arrow().disabled).toBe(true);
  });

  it('not while the canvas is laid out', async () => {
    const elk = getElk();
    const slow = vi.spyOn(elk, 'layout');
    let answer: () => void = () => undefined;
    slow.mockImplementationOnce(
      (graph) =>
        new Promise((resolve, reject) => {
          answer = () => {
            slow.mockRestore();
            elk.layout(graph).then(resolve, reject);
          };
        }),
    );
    const fake = server([]);
    stubApi(modeller, fake.handler);
    renderAt(`/modelling/models/${modelId}/elements/press?depth=1`);
    await waitFor(() => {
      expect(canvasEl().textContent).toContain('Laying out…');
    });
    expect(arrow().disabled).toBe(true);
    fireEvent.keyDown(canvasEl(), { key: 't' });
    answer();
    await waitFor(() => {
      expect(arrow().disabled).toBe(false);
    });
    expect(live()).not.toContain('Relations tidied up');
  });
});

describe('the tidy menu', () => {
  it('is a menu button with both actions, described, and works from the keyboard', async () => {
    await openView('modelling', harvest());
    const button = arrow();
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('title')).toBe('More ways to tidy');
    expect(document.getElementById(button.getAttribute('aria-controls') ?? '')).toBeTruthy();
    // Tidy up is unchanged.
    expect(tidyUp().getAttribute('title')).toBe(
      'Put every card and line back in the automatic layout',
    );

    button.focus();
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const items = within(menu()).getAllByRole('menuitem');
    expect(items.map((each) => each.textContent)).toEqual([
      'Tidy upPut every card and line back in the automatic layout',
      'Tidy relationsRedraw every line, including lines moved by hand. No card moves.T',
    ]);
    const described = (element: HTMLElement) =>
      document.getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent;
    expect(described(item('Tidy up'))).toBe('Put every card and line back in the automatic layout');
    expect(described(item('Tidy relations'))).toBe(
      'Redraw every line, including lines moved by hand. No card moves.',
    );
    expect(item('Tidy relations').getAttribute('aria-keyshortcuts')).toBe('T');
    expect(item('Tidy relations').querySelector('kbd')?.getAttribute('aria-hidden')).toBe('true');

    // Both can be used: focus starts on the first; the arrow keys wrap.
    expect(document.activeElement).toBe(item('Tidy up'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(item('Tidy relations'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('Tidy up'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(item('Tidy relations'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(item('Tidy up'));

    // Esc closes it, back on the arrow.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);

    // Tab closes it and leaves focus to move on from the arrow.
    fireEvent.click(button);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('closes on a press on the canvas or a card, and does nothing else', async () => {
    const fake = await openView('modelling', harvest());
    const pane = canvasEl().querySelector<HTMLElement>('.react-flow__pane') as HTMLElement;
    const node = card('store')?.closest<HTMLElement>('.react-flow__node') as HTMLElement;
    for (const target of [pane, node]) {
      fireEvent.click(arrow());
      expect(arrow().getAttribute('aria-expanded')).toBe('true');
      // As a browser sends it: from this window, which the canvas's pan and drag read.
      for (const type of ['mouseDown', 'mouseUp'] as const) {
        const event = createEvent[type](target, { bubbles: true, button: 0 });
        Object.defineProperty(event, 'view', { value: window });
        fireEvent(target, event);
        if (type === 'mouseDown') expect(arrow().getAttribute('aria-expanded')).toBe('false');
      }
    }
    await settle();
    expect(changes(fake.calls)).toEqual([]);
    expect(live()).not.toContain('Relations tidied up');
  });

  it('chooses Tidy up as the main button does', async () => {
    const fake = await openView('modelling', harvest());
    choose('Tidy up');
    expect(document.activeElement).toBe(canvasEl());
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    // Tidy up's routes: every line gets one.
    const routes = (layoutSaves(fake.calls)[0]?.body?.routes ?? []) as ViewLineRoute[];
    expect(routes.map((route) => route.relationshipId).sort()).toEqual(['o1', 'o2', 'o3']);
  });

  it('shows no arrow in the catalog', async () => {
    await openView('modelling', harvest());
    fireEvent.click(screen.getByRole('button', { name: 'Catalog' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'More ways to tidy' })).toBeNull();
    });
  });
});
