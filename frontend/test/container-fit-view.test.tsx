import type {
  JgfDocument,
  ModelSummary,
  StoredView,
  ViewCardLayout,
  ViewLineRoute,
} from '@simplearchitecture/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { modeller, renderAt, stubApi, viewer, type Handler } from './helpers';

// In a view, every container is just big enough for the cards inside it: it opens so, and fits
// again when a card inside it is dropped. Made-up data: a made-up pumping site.

const modelId = '66666666-6666-4666-8666-666666666666';

const site: JgfDocument = {
  graph: {
    id: modelId,
    label: 'Made-up pumping site',
    directed: true,
    nodes: {
      site: { label: 'Site', metadata: { type: 'Application' } },
      hall: { label: 'Hall', metadata: { type: 'Application' } },
      pump: { label: 'Pump', metadata: { type: 'Application' } },
      gauge: { label: 'Gauge', metadata: { type: 'Application' } },
      tank: { label: 'Tank', metadata: { type: 'Application' } },
    },
    edges: [
      { id: 'c1', source: 'site', target: 'hall', relation: 'Contains' },
      { id: 'c2', source: 'hall', target: 'pump', relation: 'Contains' },
      { id: 'c3', source: 'hall', target: 'gauge', relation: 'Contains' },
      { id: 'r1', source: 'pump', target: 'tank', relation: 'Relation' },
    ],
  },
};

const summary: ModelSummary = {
  id: modelId,
  name: 'Made-up pumping site',
  createdAt: '2026-11-01T10:00:00.000Z',
  createdBy: { id: 'u1', name: 'Sam Taylor' },
  nodeCount: 5,
  edgeCount: 4,
};

function siteView(
  elementIds: string[],
  layout: ViewCardLayout[],
  routes: ViewLineRoute[] = [],
): StoredView {
  const author = { id: 'u1', name: 'Sam Taylor' };
  const relationshipIds = ['c1', 'c2', 'c3', 'r1'].filter((id) => {
    const edge = site.graph.edges?.find((each) => each.id === id);
    return edge && elementIds.includes(edge.source) && elementIds.includes(edge.target);
  });
  return {
    id: 'v-site',
    name: 'Site',
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

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

/** The model and one view, kept by a made-up server with versions, as the API does. */
function server(initial: StoredView) {
  let view = structuredClone(initial);
  const calls: Call[] = [];
  const base = `/api/models/${modelId}/views/${initial.id}`;
  const handler: Handler = ({ url, method, body }) => {
    if (url === '/api/models') return Response.json({ models: [summary], editable: true });
    if (url === `/api/models/${modelId}`) return Response.json(site);
    if (url === `/api/models/${modelId}/views`) {
      return Response.json({ views: [{ ...view, elementIds: undefined, layout: undefined }] });
    }
    if (!url.startsWith(base)) return undefined;
    const parsed =
      typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : undefined;
    calls.push({ method, url, body: parsed });
    if (method === 'GET') return Response.json({ view });
    if (url === `${base}/contents`) {
      const elementIds = parsed?.elementIds as string[];
      view = {
        ...view,
        version: view.version + 1,
        elementIds,
        relationshipIds: parsed?.relationshipIds as string[],
        layout: view.layout.filter((each) => elementIds.includes(each.elementId)),
      };
      return Response.json({ view });
    }
    if (url === `${base}/layout`) {
      view = {
        ...view,
        version: view.version + 1,
        layout: parsed?.cards as ViewCardLayout[],
        routes: (parsed?.routes ?? []) as ViewLineRoute[],
      };
      return Response.json({ view });
    }
    return undefined;
  };
  return { handler, calls };
}

const canvasEl = () => document.getElementById('canvas') as HTMLElement;
const card = (id: string) =>
  canvasEl().querySelector<HTMLElement>(`.card[data-element-id="${CSS.escape(id)}"]`);
const mainOf = (id: string) => card(id)?.querySelector<HTMLElement>('.card-main') as HTMLElement;
const nodeOf = (id: string) => card(id)?.closest<HTMLElement>('.react-flow__node');
const layoutSaves = (calls: Call[]) => calls.filter((call) => call.url.endsWith('/layout'));
const savedCards = (call: Call | undefined) => (call?.body?.cards ?? []) as ViewCardLayout[];
const savedRoutes = (call: Call | undefined) => (call?.body?.routes ?? []) as ViewLineRoute[];

/** A card's size, from React Flow's node. */
function sizeOf(id: string) {
  const node = nodeOf(id) as HTMLElement;
  return { width: parseFloat(node.style.width), height: parseFloat(node.style.height) };
}

/** A card's box on the canvas, from React Flow's node. */
function boxOf(id: string) {
  const node = nodeOf(id) as HTMLElement;
  const match = /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(node.style.transform);
  return { x: Number(match?.[1]), y: Number(match?.[2]), ...sizeOf(id) };
}

/** The room a container has round its cards, past its padding: none on any side when it fits. */
function roomIn(container: string, inside: string[]) {
  const box = boxOf(container);
  const boxes = inside.map(boxOf);
  return {
    left: Math.min(...boxes.map((each) => each.x)) - box.x - 16,
    top: Math.min(...boxes.map((each) => each.y)) - box.y - 56,
    right: box.x + box.width - 16 - Math.max(...boxes.map((each) => each.x + each.width)),
    bottom: box.y + box.height - 16 - Math.max(...boxes.map((each) => each.y + each.height)),
  };
}
const noRoom = { left: 0, top: 0, right: 0, bottom: 0 };

/** A line's first point as drawn. */
function startOf(label: RegExp) {
  const edge = [...canvasEl().querySelectorAll<HTMLElement>('.react-flow__edge')].find((each) =>
    label.test(each.getAttribute('aria-label') ?? ''),
  );
  const d = edge?.querySelector('path.react-flow__edge-path')?.getAttribute('d') ?? '';
  const [x, y] = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  return { x, y };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
}

async function open(view: StoredView, role = modeller, space = 'modelling') {
  const fake = server(view);
  stubApi(role, fake.handler);
  renderAt(`/${space}/models/${modelId}/views/${view.id}`);
  await waitFor(() => {
    expect(card(view.elementIds[0] ?? '')).not.toBeNull();
  });
  await settle();
  return fake;
}

const cardWidth = 168;
const smallestContainer = { width: 200, height: 116 };

// A view left with room in its containers: Site holds Hall, which holds Pump, far to the right.
const leftWithRoom: ViewCardLayout[] = [
  { elementId: 'site', x: 0, y: 0 },
  { elementId: 'hall', x: 16, y: 56 },
  { elementId: 'pump', x: 600, y: 112 },
  { elementId: 'tank', x: 1000, y: 300 },
];
// Pump to Tank, moved by hand: out of Pump's bottom, down, and across into Tank's left side.
const pumpToTank: ViewLineRoute = {
  relationshipId: 'r1',
  points: [
    { x: 684, y: 156 },
    { x: 684, y: 322 },
    { x: 1000, y: 322 },
  ],
};

describe('a view opens with its containers fitted', () => {
  it('a container holding a container holding one card far to the right has no empty room', async () => {
    const { calls } = await open(siteView(['site', 'hall', 'pump', 'tank'], leftWithRoom));
    expect(sizeOf('hall')).toEqual(smallestContainer);
    expect(sizeOf('site')).toEqual({ width: 16 + 200 + 16, height: 56 + 116 + 16 });
    await settle();
    expect(layoutSaves(calls)).toEqual([]);
  });

  it('a line moved by hand follows the card the fit moved, and saves nothing', async () => {
    const { calls } = await open(
      siteView(['site', 'hall', 'pump', 'tank'], leftWithRoom, [pumpToTank]),
    );
    // Pump is now at 32, 112 on the canvas: the line leaves the middle of its bottom.
    expect(startOf(/^Pump .* Tank$/)).toEqual({ x: 32 + cardWidth / 2, y: 156 });
    await settle();
    expect(layoutSaves(calls)).toEqual([]);
  });

  it('opens fitted for a Viewer too', async () => {
    const { calls } = await open(
      siteView(['site', 'hall', 'pump', 'tank'], leftWithRoom),
      viewer,
      'viewing',
    );
    expect(sizeOf('hall')).toEqual(smallestContainer);
    expect(layoutSaves(calls)).toEqual([]);
  });
});

describe('moving a card inside a container (keyboard, as dragging)', () => {
  // Fitted: Gauge and Pump side by side in Hall, in Site; Tank on its own.
  const fitted: ViewCardLayout[] = [
    { elementId: 'site', x: 0, y: 0 },
    { elementId: 'hall', x: 16, y: 56 },
    { elementId: 'gauge', x: 32, y: 112 },
    { elementId: 'pump', x: 232, y: 112 },
    { elementId: 'tank', x: 1000, y: 300 },
  ];
  const all = ['site', 'hall', 'gauge', 'pump', 'tank'];
  const hallWidth = 216 + cardWidth + 16;

  function startMove(id: string) {
    const main = mainOf(id);
    main.focus();
    fireEvent.keyDown(main, { key: 'm' });
    return main;
  }

  it('past the right edge the container grows while moving, and the drop saves it so', async () => {
    const fake = await open(siteView(all, fitted));
    expect(sizeOf('hall').width).toBe(hallWidth);
    const main = startMove('pump');
    for (let step = 0; step < 3; step++) {
      fireEvent.keyDown(main, { key: 'ArrowRight', shiftKey: true });
    }
    expect(sizeOf('hall').width).toBe(hallWidth + 120);
    expect(sizeOf('site').width).toBe(16 + hallWidth + 120 + 16);
    fireEvent.keyDown(main, { key: 'Enter' });
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    expect(savedCards(layoutSaves(fake.calls)[0])).toEqual(
      expect.arrayContaining([
        { elementId: 'site', x: 0, y: 0 },
        { elementId: 'hall', x: 16, y: 56 },
        { elementId: 'gauge', x: 32, y: 112 },
        { elementId: 'pump', x: 352, y: 112 },
      ]),
    );
    expect(sizeOf('hall').width).toBe(hallWidth + 120);
  });

  it('left and up it stops at the padding: the container’s corner stays', async () => {
    const fake = await open(siteView(all, fitted));
    const main = startMove('gauge');
    fireEvent.keyDown(main, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(main, { key: 'ArrowUp', shiftKey: true });
    fireEvent.keyDown(main, { key: 'Enter' });
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    expect(savedCards(layoutSaves(fake.calls)[0])).toEqual(
      expect.arrayContaining([
        { elementId: 'site', x: 0, y: 0 },
        { elementId: 'hall', x: 16, y: 56 },
        { elementId: 'gauge', x: 32, y: 112 },
        { elementId: 'pump', x: 232, y: 112 },
      ]),
    );
  });

  it('the leftmost card moved right: on the drop the cards move left together and it shrinks', async () => {
    const fake = await open(siteView(all, fitted, [shifted(pumpRoute(232))]));
    const main = startMove('gauge');
    fireEvent.keyDown(main, { key: 'ArrowRight', shiftKey: true });
    // Until the drop, nothing else moves and the container keeps its size.
    expect(sizeOf('hall').width).toBe(hallWidth);
    fireEvent.keyDown(main, { key: 'Enter' });
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    const [save] = layoutSaves(fake.calls);
    expect(savedCards(save)).toEqual(
      expect.arrayContaining([
        { elementId: 'hall', x: 16, y: 56 },
        { elementId: 'gauge', x: 32, y: 112 },
        { elementId: 'pump', x: 192, y: 112 },
      ]),
    );
    expect(sizeOf('hall').width).toBe(hallWidth - 40);
    // The line moved by hand follows Pump, which the fit moved: it still leaves Pump's bottom
    // and comes into Tank's left side.
    expect(savedRoutes(save)).toEqual([shifted(pumpRoute(192))]);
    await screen.findByText('Saved');

    // A second move starts from the picture as drawn: nothing jumps back.
    const again = startMove('pump');
    fireEvent.keyDown(again, { key: 'ArrowDown' });
    fireEvent.keyDown(again, { key: 'Enter' });
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(2);
    });
    expect(savedCards(layoutSaves(fake.calls)[1])).toEqual(
      expect.arrayContaining([
        { elementId: 'gauge', x: 32, y: 112 },
        { elementId: 'pump', x: 192, y: 120 },
      ]),
    );
  });
});

/** Pump to Tank as moved by hand, with Pump's left side at `x`. */
function pumpRoute(x: number) {
  return [
    { x: x + cardWidth / 2, y: 156 },
    { x: x + cardWidth / 2, y: 322 },
    { x: 1000, y: 322 },
  ];
}
function shifted(points: { x: number; y: number }[]): ViewLineRoute {
  return { relationshipId: 'r1', points };
}

describe('containers fit after an automatic layout', () => {
  const all = ['site', 'hall', 'gauge', 'pump', 'tank'];

  it('a view with no saved layout opens with every container fitted, and saves nothing', async () => {
    const { calls } = await open(siteView(all, []));
    expect(roomIn('hall', ['gauge', 'pump'])).toEqual(noRoom);
    expect(roomIn('site', ['hall'])).toEqual(noRoom);
    await settle();
    expect(layoutSaves(calls)).toEqual([]);
  });

  it('Tidy up saves the fitted layout, and the view opens again just as Tidy up drew it', async () => {
    const fitted: ViewCardLayout[] = [
      { elementId: 'site', x: 0, y: 0 },
      { elementId: 'hall', x: 16, y: 56 },
      { elementId: 'gauge', x: 32, y: 112 },
      { elementId: 'pump', x: 232, y: 112 },
      { elementId: 'tank', x: 1000, y: 300 },
    ];
    const fake = await open(siteView(all, fitted, [shifted(pumpRoute(232))]));
    fireEvent.click(screen.getByRole('button', { name: 'Tidy up' }));
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    await settle();
    expect(roomIn('hall', ['gauge', 'pump'])).toEqual(noRoom);
    expect(roomIn('site', ['hall'])).toEqual(noRoom);
    const drawn = Object.fromEntries(all.map((id) => [id, boxOf(id)]));
    const [save] = layoutSaves(fake.calls);
    expect(savedRoutes(save)).toEqual([]);
    for (const saved of savedCards(save)) {
      expect(saved, saved.elementId).toMatchObject({
        x: drawn[saved.elementId]?.x,
        y: drawn[saved.elementId]?.y,
      });
    }

    // Opened again: the same picture, and nothing saved.
    cleanup();
    stubApi(modeller, fake.handler);
    renderAt(`/modelling/models/${modelId}/views/v-site`);
    await waitFor(() => {
      expect(card('tank')).not.toBeNull();
    });
    await settle();
    for (const id of all) expect(boxOf(id), id).toEqual(drawn[id]);
    expect(layoutSaves(fake.calls)).toHaveLength(1);
  });
});

describe('taking a card out of a container', () => {
  const fitted: ViewCardLayout[] = [
    { elementId: 'site', x: 0, y: 0 },
    { elementId: 'hall', x: 16, y: 56 },
    { elementId: 'gauge', x: 32, y: 112 },
    { elementId: 'pump', x: 232, y: 112 },
    { elementId: 'tank', x: 1000, y: 300 },
  ];
  const all = ['site', 'hall', 'gauge', 'pump', 'tank'];
  const remove = (name: string) => {
    fireEvent.click(
      within(card(name.toLowerCase()) as HTMLElement).getByRole('button', {
        name: `Remove ${name} from view`,
      }),
    );
  };

  it('fits the container, and the containers it is in, and saves that', async () => {
    const fake = await open(siteView(all, fitted));
    remove('Pump');
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    expect(sizeOf('hall')).toEqual(smallestContainer);
    expect(sizeOf('site').width).toBe(16 + 200 + 16);
    expect(savedCards(layoutSaves(fake.calls)[0])).toEqual(
      expect.arrayContaining([
        { elementId: 'site', x: 0, y: 0 },
        { elementId: 'hall', x: 16, y: 56 },
        { elementId: 'gauge', x: 32, y: 112 },
      ]),
    );
  });

  it('the leftmost card taken out: the others move up and left to the padding', async () => {
    const fake = await open(siteView(all, fitted));
    remove('Gauge');
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    expect(savedCards(layoutSaves(fake.calls)[0])).toEqual(
      expect.arrayContaining([
        { elementId: 'hall', x: 16, y: 56 },
        { elementId: 'pump', x: 32, y: 112 },
      ]),
    );
    expect(sizeOf('hall')).toEqual(smallestContainer);
  });
});

describe('a container that grows on a drop', () => {
  // Tank sits just right of Site, at the same height.
  const besideSite: ViewCardLayout[] = [
    { elementId: 'site', x: 0, y: 0 },
    { elementId: 'hall', x: 16, y: 56 },
    { elementId: 'gauge', x: 32, y: 112 },
    { elementId: 'pump', x: 232, y: 112 },
    { elementId: 'tank', x: 480, y: 40 },
  ];
  const all = ['site', 'hall', 'gauge', 'pump', 'tank'];
  const siteHeight = 56 + 116 + 16;

  it('pushes a card it now covers down below it, and shrinking pulls nothing up', async () => {
    const fake = await open(siteView(all, besideSite));
    const main = mainOf('pump');
    main.focus();
    fireEvent.keyDown(main, { key: 'm' });
    for (let step = 0; step < 3; step++) {
      fireEvent.keyDown(main, { key: 'ArrowRight', shiftKey: true });
    }
    // Until the drop, nothing outside moves.
    expect(boxOf('tank')).toMatchObject({ x: 480, y: 40 });
    fireEvent.keyDown(main, { key: 'Enter' });
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    // Just below Site, as a dropped card pushes the cards it lands on.
    expect(boxOf('tank')).toMatchObject({ x: 480, y: siteHeight + 28 });
    expect(savedCards(layoutSaves(fake.calls)[0])).toEqual(
      expect.arrayContaining([
        { elementId: 'pump', x: 352, y: 112 },
        { elementId: 'tank', x: 480, y: siteHeight + 28 },
      ]),
    );
    await screen.findByText('Saved');

    // Moved back: Site shrinks, and Tank stays where it was pushed.
    const again = mainOf('pump');
    again.focus();
    fireEvent.keyDown(again, { key: 'm' });
    for (let step = 0; step < 3; step++) {
      fireEvent.keyDown(again, { key: 'ArrowLeft', shiftKey: true });
    }
    fireEvent.keyDown(again, { key: 'Enter' });
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(2);
    });
    expect(sizeOf('site').width).toBe(16 + 400 + 16);
    expect(boxOf('tank')).toMatchObject({ x: 480, y: siteHeight + 28 });
  });
});
