import type {
  JgfDocument,
  ModelSummary,
  StoredView,
  ViewCardLayout,
} from '@simplearchitecture/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { modeller, renderAt, stubApi, viewer, type Handler } from './helpers';
import { settle } from './settle';

// Several cards selected with Shift, Ctrl or Cmd + click, and dragged together, on the explorer
// canvas and in an open view. Made-up data: the bakery fixture, and a small made-up tea room.

const canvasEl = () => document.getElementById('canvas') as HTMLElement;
const card = (id: string) =>
  canvasEl().querySelector<HTMLElement>(`.card[data-element-id="${CSS.escape(id)}"]`);
const mainOf = (id: string) => card(id)?.querySelector<HTMLElement>('.card-main') as HTMLElement;
const nodeOf = (id: string) => card(id)?.closest<HTMLElement>('.react-flow__node') as HTMLElement;
const selectedIds = () =>
  [...canvasEl().querySelectorAll('.card.is-selected')]
    .map((element) => element.getAttribute('data-element-id') ?? '')
    .sort();
const live = () => canvasEl().querySelector('p.vh[aria-live="polite"]')?.textContent ?? '';
const details = () => screen.getByRole('complementary', { name: 'Details' });
const detailsName = () => within(details()).getByRole('heading', { level: 2 }).textContent;

/** A card's position, from React Flow's transform. */
function positionOf(id: string) {
  const match = /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(nodeOf(id).style.transform);
  return { x: Number(match?.[1]), y: Number(match?.[2]) };
}

/** A mouse event with `view` set (jsdom refuses it in the constructor; d3-drag needs it). */
function mouse(target: EventTarget, type: string, clientX: number, clientY: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, 'view', { value: window });
  act(() => {
    target.dispatchEvent(event);
  });
}

/** Drags a card with the mouse (d3-drag listens on the node, then on the window). */
function drag(id: string, dx: number, dy: number) {
  const node = nodeOf(id);
  mouse(node, 'mousedown', 100, 100);
  mouse(window, 'mousemove', 100 + dx / 2, 100 + dy / 2);
  mouse(window, 'mousemove', 100 + dx, 100 + dy);
  mouse(window, 'mouseup', 100 + dx, 100 + dy);
}

const offset = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
  x: Math.round(b.x - a.x),
  y: Math.round(b.y - a.y),
});

function bakeryApi(): Handler {
  return ({ url, method }) => {
    if (method !== 'GET') return undefined;
    if (url === '/api/models') return Response.json({ models: [bakerySummary] });
    if (url === `/api/models/${bakeryId}`) return Response.json(bakeryModel);
    return undefined;
  };
}

async function openShop() {
  stubApi(viewer, bakeryApi());
  renderAt(`/viewing/models/${bakeryId}/elements/shop?depth=1`);
  await waitFor(() => {
    expect(card('till')).toBeTruthy();
  });
  await settle();
}

describe('selecting several cards', () => {
  it('Shift, Ctrl and Cmd + click add a card; the details panel shows the last one added', async () => {
    await openShop();
    fireEvent.click(mainOf('till'));
    expect(selectedIds()).toEqual(['till']);

    fireEvent.click(mainOf('server'), { shiftKey: true });
    fireEvent.click(mainOf('customer'), { ctrlKey: true });
    fireEvent.click(mainOf('ordering'), { metaKey: true });
    expect(selectedIds()).toEqual(['customer', 'ordering', 'server', 'till']);
    expect(detailsName()).toBe('Order to bake');
    expect(live()).toBe('4 cards selected.');
  });

  it('the same click takes a card out; out goes the details card, the one added before shows', async () => {
    await openShop();
    fireEvent.click(mainOf('till'));
    fireEvent.click(mainOf('server'), { shiftKey: true });
    fireEvent.click(mainOf('customer'), { shiftKey: true });

    // Not the details card: the panel stays.
    fireEvent.click(mainOf('server'), { ctrlKey: true });
    expect(selectedIds()).toEqual(['customer', 'till']);
    expect(detailsName()).toBe('Customer');

    // The details card: the one added before it shows.
    fireEvent.click(mainOf('customer'), { shiftKey: true });
    expect(selectedIds()).toEqual(['till']);
    expect(detailsName()).toBe('Till');
  });

  it('a plain click, a click on empty canvas, Esc or the arrow keys leave one card at most', async () => {
    await openShop();
    const several = () => {
      fireEvent.click(mainOf('till'));
      fireEvent.click(mainOf('server'), { shiftKey: true });
      fireEvent.click(mainOf('customer'), { shiftKey: true });
      expect(selectedIds()).toHaveLength(3);
    };

    several();
    fireEvent.click(mainOf('server'));
    expect(selectedIds()).toEqual(['server']);
    expect(detailsName()).toBe('Back Office Server');

    several();
    fireEvent.click(canvasEl().querySelector('.react-flow__pane') as HTMLElement);
    expect(selectedIds()).toEqual(['customer']);

    several();
    mainOf('customer').focus();
    fireEvent.keyDown(mainOf('customer'), { key: 'Escape' });
    expect(selectedIds()).toEqual(['customer']);
    expect(detailsName()).toBe('Customer');

    // An arrow key selects the nearest card that way (whichever way has one).
    several();
    const from = mainOf('customer');
    from.focus();
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowUp', 'ArrowLeft']) {
      if (document.activeElement !== from) break;
      fireEvent.keyDown(from, { key });
    }
    expect(document.activeElement).not.toBe(from);
    expect(selectedIds()).toHaveLength(1);
    expect(selectedIds()).not.toContain('customer');
  });

  it('M moves only the card it starts on, and leaves it alone selected', async () => {
    await openShop();
    fireEvent.click(mainOf('till'));
    fireEvent.click(mainOf('server'), { shiftKey: true });
    const till = positionOf('till');
    const server = positionOf('server');
    mainOf('server').focus();
    fireEvent.keyDown(mainOf('server'), { key: 'm' });
    fireEvent.keyDown(mainOf('server'), { key: 'ArrowRight' });
    fireEvent.keyDown(mainOf('server'), { key: 'Enter' });
    await settle();
    expect(offset(server, positionOf('server'))).toEqual({ x: 8, y: 0 });
    expect(positionOf('till')).toEqual(till);
    expect(selectedIds()).toEqual(['server']);
  });
});

describe('dragging several selected cards', () => {
  it('moves every selected card by the same offset, and nothing else', async () => {
    await openShop();
    fireEvent.click(mainOf('till'));
    fireEvent.click(mainOf('customer'), { shiftKey: true });
    const before = {
      till: positionOf('till'),
      customer: positionOf('customer'),
      server: positionOf('server'),
    };

    drag('till', 120, 80);
    await settle();
    const moved = offset(before.till, positionOf('till'));
    expect(moved.x).toBeGreaterThan(0);
    expect(moved.y).toBeGreaterThan(0);
    expect(offset(before.customer, positionOf('customer'))).toEqual(moved);
    expect(positionOf('server')).toEqual(before.server);
    // Still both selected.
    expect(selectedIds()).toEqual(['customer', 'till']);
  });

  it('a card not selected moves alone, and the selection of several ends', async () => {
    await openShop();
    fireEvent.click(mainOf('till'));
    fireEvent.click(mainOf('customer'), { shiftKey: true });
    const before = { till: positionOf('till'), customer: positionOf('customer') };

    drag('server', 120, 80);
    await settle();
    expect(positionOf('till')).toEqual(before.till);
    expect(positionOf('customer')).toEqual(before.customer);
    expect(selectedIds()).toEqual(['customer']);
  });
});

// An open view in Modelling saves one layout for a drop of several cards.

const modelId = '55555555-5555-4555-8555-555555555555';

const tearoom: JgfDocument = {
  graph: {
    id: modelId,
    label: 'Made-up tea room',
    directed: true,
    nodes: {
      host: { label: 'Host', metadata: { type: 'Stakeholder' } },
      bookings: { label: 'Bookings', metadata: { type: 'Application' } },
      menu: { label: 'Menu Board', metadata: { type: 'Application' } },
      urn: { label: 'Urn', metadata: { type: 'Infrastructure' } },
    },
    edges: [
      { id: 't1', source: 'host', target: 'bookings', relation: 'Relation' },
      { id: 't2', source: 'bookings', target: 'menu', relation: 'Relation' },
      { id: 't3', source: 'menu', target: 'urn', relation: 'Relation' },
    ],
  },
};

const tearoomSummary: ModelSummary = {
  id: modelId,
  name: 'Made-up tea room',
  createdAt: '2026-11-01T10:00:00.000Z',
  createdBy: { id: 'u1', name: 'Robin Ash' },
  nodeCount: 4,
  edgeCount: 3,
};

const stored = [
  { elementId: 'host', x: 40, y: 20 },
  { elementId: 'bookings', x: 400, y: 20 },
  { elementId: 'menu', x: 40, y: 300 },
  { elementId: 'urn', x: 400, y: 300 },
];

function afternoon(): StoredView {
  const author = { id: 'u1', name: 'Robin Ash' };
  return {
    id: 'v-tea',
    name: 'Afternoon',
    folder: null,
    version: 1,
    elementCount: 4,
    relationshipCount: 3,
    createdAt: '2026-11-05T09:00:00.000Z',
    createdBy: author,
    updatedAt: '2026-11-05T09:00:00.000Z',
    updatedBy: author,
    elementIds: ['host', 'bookings', 'menu', 'urn'],
    relationshipIds: ['t1', 't2', 't3'],
    layout: stored,
    routes: [],
    groupBy: null,
  };
}

/** The model and one view, kept by a made-up server with versions; the layout saves it gets. */
function viewServer() {
  let view = afternoon();
  const saves: ViewCardLayout[][] = [];
  const base = `/api/models/${modelId}/views/${view.id}`;
  const handler: Handler = ({ url, method, body }) => {
    if (url === '/api/models') return Response.json({ models: [tearoomSummary] });
    if (url === `/api/models/${modelId}`) return Response.json(tearoom);
    if (url.startsWith(`/api/models/${modelId}/elements/`)) {
      const id = decodeURIComponent(url.split('/elements/')[1] ?? '');
      return Response.json({
        element: { id, version: 1, node: tearoom.graph.nodes?.[id] },
        warnings: [],
      });
    }
    if (url === `/api/models/${modelId}/views`) {
      return Response.json({ views: [{ ...view, elementIds: undefined, layout: undefined }] });
    }
    if (url === base && method === 'GET') return Response.json({ view });
    if (url === `${base}/layout` && method !== 'GET' && typeof body === 'string') {
      const parsed = JSON.parse(body) as { cards: ViewCardLayout[] };
      saves.push(parsed.cards);
      view = { ...view, version: view.version + 1, layout: parsed.cards };
      return Response.json({ view });
    }
    return undefined;
  };
  return { handler, saves };
}

async function openView(handler: Handler) {
  stubApi(modeller, handler);
  const rendered = renderAt(`/modelling/models/${modelId}/views/v-tea`);
  await waitFor(() => {
    expect(card('urn')).toBeTruthy();
  });
  await settle();
  return rendered;
}

describe('dragging several cards in a view (Modelling)', () => {
  it('saves once for the drop, and the view opens with every moved card in place', async () => {
    const fake = viewServer();
    const rendered = await openView(fake.handler);
    fireEvent.click(mainOf('host'));
    fireEvent.click(mainOf('menu'), { ctrlKey: true });
    expect(selectedIds()).toEqual(['host', 'menu']);

    drag('menu', 120, 80);
    await settle();
    expect(fake.saves).toHaveLength(1);
    const host = positionOf('host');
    const menu = positionOf('menu');
    const moved = offset({ x: 40, y: 300 }, menu);
    expect(moved.x).toBeGreaterThan(0);
    expect(offset({ x: 40, y: 20 }, host)).toEqual(moved);
    const saved = new Map(fake.saves[0]?.map((c) => [c.elementId, { x: c.x, y: c.y }]));
    // Saved to a tenth of a pixel.
    const near = (a: { x: number; y: number } | undefined, b: { x: number; y: number }) => {
      expect(a?.x).toBeCloseTo(b.x, 0);
      expect(a?.y).toBeCloseTo(b.y, 0);
    };
    near(saved.get('host'), host);
    near(saved.get('menu'), menu);
    expect(saved.get('bookings')).toEqual({ x: 400, y: 20 });
    expect(saved.get('urn')).toEqual({ x: 400, y: 300 });

    // Opened again: the same places.
    rendered.unmount();
    await openView(fake.handler);
    near(positionOf('host'), host);
    near(positionOf('menu'), menu);
    expect(fake.saves).toHaveLength(1);
  });
});
