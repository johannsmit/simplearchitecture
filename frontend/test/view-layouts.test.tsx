import type {
  JgfDocument,
  ModelSummary,
  StoredView,
  ViewCardLayout,
  ViewLineRoute,
} from '@simplearchitecture/shared';
import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linePath } from '../src/viewing/explorer/canvas/edgeLine';
import { getElk } from '../src/viewing/explorer/canvas/elkEngine';
import {
  apiError,
  expandRelationships,
  modeller,
  renderAt,
  stubApi,
  viewer,
  type Handler,
} from './helpers';
import { settle } from './settle';

// A view keeps its cards where they were put: only the person's moves, resizes, adds, removes and
// Tidy relations save the layout; a layout or a placement the canvas made on its own saves nothing.
// Made-up data: a small greenhouse.

const modelId = '44444444-4444-4444-8444-444444444444';

const greenhouse: JgfDocument = {
  graph: {
    id: modelId,
    label: 'Made-up greenhouse',
    directed: true,
    nodes: {
      gardener: { label: 'Gardener', metadata: { type: 'Stakeholder' } },
      planner: { label: 'Planner', metadata: { type: 'Application' } },
      sensors: { label: 'Sensors', metadata: { type: 'Application' } },
      pump: { label: 'Pump', metadata: { type: 'Infrastructure' } },
      shed: { label: 'Shed', metadata: { type: 'Other' } },
    },
    edges: [
      { id: 'g1', source: 'gardener', target: 'planner', relation: 'Relation' },
      { id: 'g2', source: 'planner', target: 'sensors', relation: 'Relation', label: 'Plans' },
      { id: 'g3', source: 'sensors', target: 'pump', relation: 'Relation' },
      { id: 'g4', source: 'shed', target: 'pump', relation: 'Relation' },
      // A second relationship from Planner to Sensors: in a view with g2, one "×2" line.
      { id: 'g5', source: 'planner', target: 'sensors', relation: 'Relation', label: 'Checks' },
    ],
  },
};

const summary: ModelSummary = {
  id: modelId,
  name: 'Made-up greenhouse',
  createdAt: '2026-11-01T10:00:00.000Z',
  createdBy: { id: 'u1', name: 'Sam Taylor' },
  nodeCount: 5,
  edgeCount: 5,
};

function watering(layout: ViewCardLayout[] = [], routes: ViewLineRoute[] = []): StoredView {
  const author = { id: 'u1', name: 'Sam Taylor' };
  return {
    id: 'v-water',
    name: 'Watering',
    folder: null,
    version: 1,
    elementCount: 4,
    relationshipCount: 3,
    createdAt: '2026-11-05T09:00:00.000Z',
    createdBy: author,
    updatedAt: '2026-11-05T09:00:00.000Z',
    updatedBy: author,
    elementIds: ['gardener', 'planner', 'sensors', 'pump'],
    relationshipIds: ['g1', 'g2', 'g3'],
    layout,
    routes,
    groupBy: null,
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
  const next: { failWith?: Response } = {};
  const base = `/api/models/${modelId}/views/${initial.id}`;
  const handler: Handler = ({ url, method, body }) => {
    if (url === '/api/models') return Response.json({ models: [summary] });
    if (url === `/api/models/${modelId}`) return Response.json(greenhouse);
    if (url.startsWith(`/api/models/${modelId}/elements/`)) {
      const id = decodeURIComponent(url.split('/elements/')[1] ?? '');
      return Response.json({
        element: { id, version: 1, node: greenhouse.graph.nodes?.[id] },
        warnings: [],
      });
    }
    if (url === `/api/models/${modelId}/views`) {
      return Response.json({ views: [{ ...view, elementIds: undefined, layout: undefined }] });
    }
    if (url.startsWith(`/api/models/${modelId}/relationships/`)) {
      return relationship(url, method, body);
    }
    if (!url.startsWith(base)) return undefined;
    const parsed =
      typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : undefined;
    calls.push({ method, url, body: parsed });
    if (method === 'GET') return Response.json({ view });
    if (next.failWith) {
      const answer = next.failWith;
      delete next.failWith;
      return answer;
    }
    if (parsed?.version !== view.version) {
      return apiError(409, 'Someone else changed this view.', { currentVersion: view.version });
    }
    if (url === `${base}/contents`) {
      const elementIds = parsed.elementIds as string[];
      view = {
        ...view,
        version: view.version + 1,
        elementIds,
        relationshipIds: parsed.relationshipIds as string[],
        layout: view.layout.filter((card) => elementIds.includes(card.elementId)),
        routes: view.routes.filter((route) =>
          (parsed.relationshipIds as string[]).includes(route.relationshipId),
        ),
      };
      return Response.json({ view });
    }
    if (url === `${base}/layout`) {
      view = {
        ...view,
        version: view.version + 1,
        layout: parsed.cards as ViewCardLayout[],
        routes: (parsed.routes ?? []) as ViewLineRoute[],
      };
      return Response.json({ view });
    }
    return undefined;
  };
  // Relationships with versions; a new end goes into the view with a new version, as the API does.
  const edges = new Map(
    (greenhouse.graph.edges ?? []).map((edge) => [edge.id ?? '', { edge, version: 1 }]),
  );
  function relationship(url: string, method: string, body: unknown) {
    const id = decodeURIComponent(url.split('/relationships/')[1] ?? '');
    const stored = edges.get(id);
    if (!stored) return apiError(404, 'Not found', { missing: 'relationship' });
    let viewsChanged: { id: string; version: number }[] | undefined;
    if (method === 'PATCH') {
      const change = JSON.parse(body as string) as {
        source?: string;
        target?: string;
        reverse?: boolean;
      };
      calls.push({ method, url, body: change });
      const edge = { ...stored.edge, ...change };
      Reflect.deleteProperty(edge, 'version');
      Reflect.deleteProperty(edge, 'reverse');
      if (change.reverse === true) [edge.source, edge.target] = [edge.target, edge.source];
      edges.set(id, { edge, version: stored.version + 1 });
      if (view.relationshipIds.includes(id)) {
        const fresh = [edge.source, edge.target].filter((end) => !view.elementIds.includes(end));
        // Other ends: the line's route goes too, in the same new version.
        const moved = edge.source !== stored.edge.source || edge.target !== stored.edge.target;
        const routed = moved && view.routes.some((route) => route.relationshipId === id);
        if (fresh.length > 0 || routed) {
          view = {
            ...view,
            version: view.version + 1,
            elementIds: [...view.elementIds, ...fresh],
            routes: view.routes.filter((route) => !routed || route.relationshipId !== id),
          };
          viewsChanged = [{ id: view.id, version: view.version }];
        }
      }
      viewsChanged ??= [];
    }
    const now = edges.get(id) ?? stored;
    return Response.json({
      relationship: { id, version: now.version, edge: now.edge },
      warnings: [],
      nestingChanges: [],
      ...(viewsChanged ? { viewsChanged } : {}),
    });
  }
  return {
    handler,
    calls,
    next,
    view: () => view,
    set: (changed: StoredView) => {
      view = changed;
    },
  };
}

const canvasEl = () => document.getElementById('canvas') as HTMLElement;
const card = (id: string) =>
  canvasEl().querySelector<HTMLElement>(`.card[data-element-id="${CSS.escape(id)}"]`);
const mainOf = (id: string) => card(id)?.querySelector<HTMLElement>('.card-main') as HTMLElement;
const nodeOf = (id: string) => card(id)?.closest<HTMLElement>('.react-flow__node');
const cardIds = () =>
  [...canvasEl().querySelectorAll('.card[data-element-id]')]
    .map((element) => element.getAttribute('data-element-id') ?? '')
    .sort();
const layoutSaves = (calls: Call[]) => calls.filter((call) => call.url.endsWith('/layout'));
const changes = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');
const savedCards = (call: Call | undefined) => (call?.body?.cards ?? []) as ViewCardLayout[];

/** A top-level card's box, from React Flow's transform and size. */
function boxOf(id: string) {
  const node = nodeOf(id) as HTMLElement;
  const match = /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(node.style.transform);
  return {
    x: Number(match?.[1]),
    y: Number(match?.[2]),
    width: parseFloat(node.style.width),
    height: parseFloat(node.style.height),
  };
}

async function open(space: 'viewing' | 'modelling', view: StoredView) {
  const fake = server(view);
  stubApi(space === 'viewing' ? viewer : modeller, fake.handler);
  const rendered = renderAt(`/${space}/models/${modelId}/views/${view.id}`);
  await waitFor(() => {
    expect(cardIds()).toEqual([...view.elementIds].sort());
  });
  await settle();
  return { ...fake, rendered };
}

/** Moves a card with the keyboard: M, the keys, then Enter. */
function moveWithKeys(id: string, keys: { key: string; shiftKey?: boolean; altKey?: boolean }[]) {
  const main = mainOf(id);
  main.focus();
  fireEvent.keyDown(main, { key: 'm' });
  for (const key of keys) fireEvent.keyDown(main, key);
  fireEvent.keyDown(main, { key: 'Enter' });
}

const left = [
  { elementId: 'gardener', x: 40, y: 20 },
  { elementId: 'planner', x: 400, y: 20, width: 320 },
  { elementId: 'sensors', x: 40, y: 300 },
  { elementId: 'pump', x: 400, y: 300 },
];

describe('opening a view', () => {
  it('with no stored layout: laid out as before, and nothing is saved', async () => {
    const { calls } = await open('modelling', watering());
    await settle();
    expect(changes(calls)).toEqual([]);
  });

  it('with a stored layout: every card where it was left, with its width, and nothing saved', async () => {
    const { calls } = await open('modelling', watering(left));
    for (const { elementId, x, y } of left) {
      expect(boxOf(elementId), elementId).toMatchObject({ x, y });
    }
    expect(boxOf('planner').width).toBe(320);
    await settle();
    expect(changes(calls)).toEqual([]);
  });

  it('with a card stored far wider than 480px: opens at that width', async () => {
    const wide = left.map((c) => (c.elementId === 'planner' ? { ...c, width: 1600 } : c));
    const { calls } = await open('modelling', watering(wide));
    expect(boxOf('planner')).toMatchObject({ x: 400, y: 20, width: 1600 });
    await settle();
    expect(changes(calls)).toEqual([]);
  });

  it('puts a card without a stored position at a free spot, and saves nothing', async () => {
    const { calls } = await open('modelling', watering(left.slice(0, 3)));
    for (const { elementId, x, y } of left.slice(0, 3)) {
      expect(boxOf(elementId), elementId).toMatchObject({ x, y });
    }
    const pump = boxOf('pump');
    for (const other of ['gardener', 'planner', 'sensors']) {
      const box = boxOf(other);
      const apart =
        pump.x + pump.width <= box.x ||
        box.x + box.width <= pump.x ||
        pump.y + pump.height <= box.y ||
        box.y + box.height <= pump.y;
      expect(apart, `pump covers ${other}`).toBe(true);
    }
    await settle();
    expect(changes(calls)).toEqual([]);
  });

  it('switching Nest contained elements shows the stored layout again, and saves nothing', async () => {
    const { calls } = await open('modelling', watering(left));
    const nest = screen.getByRole<HTMLInputElement>('switch', { name: 'Nest contained elements' });
    fireEvent.click(nest);
    await settle();
    fireEvent.click(nest);
    await settle();
    for (const { elementId, x, y } of left) {
      expect(boxOf(elementId), elementId).toMatchObject({ x, y });
    }
    expect(boxOf('planner').width).toBe(320);
    expect(changes(calls)).toEqual([]);
  });

  it('opens in Viewing as it was left too', async () => {
    await open('viewing', watering(left));
    for (const { elementId, x, y } of left) {
      expect(boxOf(elementId), elementId).toMatchObject({ x, y });
    }
  });
});

describe('saving the layout (Modelling)', () => {
  it('saves every card after a move, at once, and the view opens the same way again', async () => {
    const fake = await open('modelling', watering(left));
    moveWithKeys('sensors', [{ key: 'ArrowRight' }, { key: 'ArrowDown', shiftKey: true }]);
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    const [save] = layoutSaves(fake.calls);
    expect(save?.body?.version).toBe(1);
    expect(savedCards(save)).toEqual([
      { elementId: 'gardener', x: 40, y: 20 },
      { elementId: 'planner', x: 400, y: 20, width: 320 },
      { elementId: 'sensors', x: 48, y: 340 },
      { elementId: 'pump', x: 400, y: 300 },
    ]);
    await screen.findByText('Saved');

    // Opened again: the same layout.
    fake.rendered.unmount();
    stubApi(modeller, fake.handler);
    renderAt(`/modelling/models/${modelId}/views/v-water`);
    await waitFor(() => {
      expect(cardIds()).toEqual(['gardener', 'planner', 'pump', 'sensors']);
    });
    await settle();
    expect(boxOf('sensors')).toMatchObject({ x: 48, y: 340 });
    expect(boxOf('planner')).toMatchObject({ x: 400, y: 20, width: 320 });
    expect(layoutSaves(fake.calls)).toHaveLength(1);
  });

  it('saves the automatic layout too once the person moves a card', async () => {
    const { calls } = await open('modelling', watering());
    const before = boxOf('planner');
    moveWithKeys('planner', [{ key: 'ArrowLeft' }]);
    await waitFor(() => {
      expect(layoutSaves(calls)).toHaveLength(1);
    });
    const cards = savedCards(layoutSaves(calls)[0]);
    expect(cards.map((c) => c.elementId)).toEqual(['gardener', 'planner', 'sensors', 'pump']);
    expect(cards.find((c) => c.elementId === 'planner')).toEqual({
      elementId: 'planner',
      x: before.x - 8,
      y: before.y,
    });
    for (const c of cards) {
      if (c.elementId === 'planner') continue;
      expect(c, c.elementId).toEqual({ elementId: c.elementId, ...pick(boxOf(c.elementId)) });
    }
  });

  it('saves a width set by hand, and nothing for a cancelled move', async () => {
    const { calls } = await open('modelling', watering(left));
    const main = mainOf('sensors');
    main.focus();
    fireEvent.keyDown(main, { key: 'm' });
    fireEvent.keyDown(main, { key: 'ArrowDown' });
    fireEvent.keyDown(main, { key: 'Escape' });
    await settle();
    expect(changes(calls)).toEqual([]);

    moveWithKeys('sensors', [{ key: 'ArrowRight', altKey: true, shiftKey: true }]);
    await waitFor(() => {
      expect(layoutSaves(calls)).toHaveLength(1);
    });
    const sensors = savedCards(layoutSaves(calls)[0]).find((c) => c.elementId === 'sensors');
    expect(sensors).toEqual({ elementId: 'sensors', x: 40, y: 300, width: boxOf('sensors').width });
    expect(sensors?.width).toBeGreaterThan(168);
  });

  it('saves after a card is added or taken off, once the canvas has placed it', async () => {
    const { calls } = await open('modelling', watering(left));
    const drop = createEvent.drop(canvasEl(), {
      dataTransfer: {
        types: ['application/x-simplearchitecture-element'],
        getData: () => 'shed',
      },
    });
    Object.defineProperties(drop, { clientX: { value: 600 }, clientY: { value: 500 } });
    fireEvent(canvasEl(), drop);
    await waitFor(() => {
      expect(layoutSaves(calls)).toHaveLength(1);
    });
    // After the contents, with the version they left.
    expect(changes(calls).map((call) => call.url.split('/').at(-1))).toEqual([
      'contents',
      'layout',
    ]);
    expect(layoutSaves(calls)[0]?.body?.version).toBe(2);
    const added = savedCards(layoutSaves(calls)[0]);
    expect(added.find((c) => c.elementId === 'shed')).toEqual({
      elementId: 'shed',
      ...pick(boxOf('shed')),
    });
    for (const stays of left) expect(added).toContainEqual(stays);

    fireEvent.click(
      within(card('gardener') as HTMLElement).getByRole('button', {
        name: 'Remove Gardener from view',
      }),
    );
    await waitFor(() => {
      expect(layoutSaves(calls)).toHaveLength(2);
    });
    expect(savedCards(layoutSaves(calls)[1]).map((c) => c.elementId)).toEqual([
      'planner',
      'sensors',
      'pump',
      'shed',
    ]);
  });

  it('says when a layout was not saved because someone else changed the view', async () => {
    const fake = await open('modelling', watering(left));
    fake.set({ ...fake.view(), version: 2 });
    moveWithKeys('pump', [{ key: 'ArrowUp' }]);
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain(
      "Someone else changed this view. Your change wasn't saved.",
    );
    expect(within(notice).getByRole('button', { name: 'Reload view' })).toBeTruthy();
  });

  it('says when a layout could not be saved, and saves again with the next move', async () => {
    const fake = await open('modelling', watering(left));
    fake.next.failWith = apiError(503, 'Unavailable');
    moveWithKeys('pump', [{ key: 'ArrowUp' }]);
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain("Your change to the view wasn't saved.");
    // The card stays where it was put.
    expect(boxOf('pump')).toMatchObject({ x: 400, y: 292 });
    moveWithKeys('pump', [{ key: 'ArrowUp' }]);
    await waitFor(() => {
      expect(fake.view().version).toBe(2);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fake.view().layout).toContainEqual({ elementId: 'pump', x: 400, y: 284 });
  });
});

describe('a relationship’s new end in a view', () => {
  it('joins the view at a free spot, the old end stays, and the layout is saved', async () => {
    const { calls } = await open('modelling', watering(left));
    fireEvent.click(mainOf('sensors'));
    const panel = screen.getByRole('complementary', { name: 'Details' });
    await expandRelationships();
    fireEvent.click(
      await within(panel).findByRole('button', { name: /^Open relationship: Relates to Pump/ }),
    );
    await screen.findByRole('form', { name: /^Relationship / });
    const ends = within(panel).getByRole('region', { name: 'Ends' });
    fireEvent.click(within(ends).getByRole('button', { name: /^To: Pump/ }));
    const search = within(ends).getByRole('combobox');
    fireEvent.change(search, { target: { value: 'shed' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    // Picked: saved at once.
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => {
      expect(cardIds()).toEqual(['gardener', 'planner', 'pump', 'sensors', 'shed']);
    });
    await waitFor(() => {
      expect(layoutSaves(calls)).toHaveLength(1);
    });
    // The relationship's own change, then the layout with the version the view still has: the
    // view's contents were never sent.
    expect(changes(calls).map((call) => call.url.split('/').slice(-2).join('/'))).toEqual([
      'relationships/g3',
      'v-water/layout',
    ]);
    expect(changes(calls)[0]?.body).toEqual({ version: 1, target: 'shed' });
    // With the view's version the change gave it: saved, with no conflict.
    expect(layoutSaves(calls)[0]?.body?.version).toBe(2);
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    const saved = savedCards(layoutSaves(calls)[0]);
    // No card moved; the new one is where the canvas put it, covering none of them.
    for (const stays of left) expect(saved).toContainEqual(stays);
    const shed = boxOf('shed');
    expect(saved.find((c) => c.elementId === 'shed')).toEqual({ elementId: 'shed', ...pick(shed) });
    for (const other of left) {
      const box = boxOf(other.elementId);
      const apart =
        shed.x + shed.width <= box.x ||
        box.x + box.width <= shed.x ||
        shed.y + shed.height <= box.y ||
        box.y + box.height <= shed.y;
      expect(apart, other.elementId).toBe(true);
    }
  });
});

describe('a view someone else changed with a new end', () => {
  it('reports the conflict with Reload view on the next change, not a refusal', async () => {
    const fake = await open('modelling', watering(left));
    // Elsewhere, Sensors to Pump now goes to the shed: the server added it, with a new version.
    fake.set({ ...fake.view(), version: 2, elementIds: [...fake.view().elementIds, 'shed'] });
    fireEvent.click(
      within(card('gardener') as HTMLElement).getByRole('button', {
        name: 'Remove Gardener from view',
      }),
    );
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain(
      "Someone else changed this view. Your change wasn't saved.",
    );
    expect(within(notice).getByRole('button', { name: 'Reload view' })).toBeTruthy();
  });
});

describe('a view for a Viewer', () => {
  it('moves cards, and saves nothing', async () => {
    const { calls } = await open('viewing', watering(left));
    moveWithKeys('pump', [{ key: 'ArrowUp' }]);
    await waitFor(() => {
      expect(boxOf('pump')).toMatchObject({ x: 400, y: 292 });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Tidy relations' }));
    await settle();
    expect(changes(calls)).toEqual([]);
  });
});

describe('moving a line', () => {
  // Planner to Sensors, moved by hand: out of Planner's left side, across, down, across, and
  // down into the top of Sensors. Its three bends can be dragged.
  const plannerToSensors = [
    { x: 400, y: 30 },
    { x: 300, y: 30 },
    { x: 300, y: 250 },
    { x: 124, y: 250 },
    { x: 124, y: 300 },
  ];
  const routed = () => watering(left, [{ relationshipId: 'g2', points: plannerToSensors }]);
  const edgeOf = (label: RegExp) =>
    [...canvasEl().querySelectorAll<HTMLElement>('.react-flow__edge')].find((edge) =>
      label.test(edge.getAttribute('aria-label') ?? ''),
    ) as HTMLElement;
  const plannerLine = () => edgeOf(/^Planner .* Sensors$/);
  /** The bend handles showing on a line (not those fading out). */
  const handlesOf = (edge: HTMLElement) => [
    ...canvasEl().querySelectorAll<HTMLElement>(
      `.bend-handle[data-line="${CSS.escape(edge.getAttribute('data-id') ?? '')}"]:not(.is-leaving)`,
    ),
  ];
  const allHandles = () => [
    ...canvasEl().querySelectorAll<HTMLElement>('.bend-handle:not(.is-leaving)'),
  ];
  /** Where a handle sits on the canvas, and how it is scaled. */
  function placeOf(handle: HTMLElement) {
    const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.e]+)\)/.exec(
      handle.style.transform,
    );
    return { x: Number(match?.[1]), y: Number(match?.[2]), scale: Number(match?.[3]) };
  }
  const bendsShown = (edge: HTMLElement) =>
    handlesOf(edge).map((handle) => {
      const { x, y } = placeOf(handle);
      return { x, y };
    });
  const handleAt = (edge: HTMLElement, point: { x: number; y: number }) =>
    handlesOf(edge).find((handle) => {
      const at = placeOf(handle);
      return at.x === point.x && at.y === point.y;
    }) as HTMLElement;
  const pointAt = (edge: HTMLElement) => {
    fireEvent.mouseEnter(edge);
  };
  const pointAway = (edge: HTMLElement) => {
    fireEvent.mouseLeave(edge);
  };
  const live = () => canvasEl().querySelector('[aria-live="polite"]')?.textContent ?? '';
  /** The corners a line is drawn through, from the source's end. */
  function cornersOf(edge: HTMLElement) {
    const d = edge.querySelector('path.react-flow__edge-path')?.getAttribute('d') ?? '';
    const numbers = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    return {
      start: { x: numbers[0], y: numbers[1] },
      end: { x: numbers.at(-2), y: numbers.at(-1) },
    };
  }
  /** The canvas's zoom: a drag of N screen pixels moves N / zoom on the canvas. */
  function zoom() {
    const viewport = canvasEl().querySelector<HTMLElement>('.react-flow__viewport');
    return Number(/scale\(([-\d.]+)\)/.exec(viewport?.style.transform ?? '')?.[1] ?? 1);
  }
  /** Waits until the canvas's pan and zoom stop changing (a fit can still be running). */
  async function steady() {
    const viewport = () =>
      canvasEl().querySelector<HTMLElement>('.react-flow__viewport')?.style.transform;
    let before = viewport();
    for (let tries = 0; tries < 20; tries++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      const now = viewport();
      if (now === before) return;
      before = now;
    }
  }
  /** Where a point on the canvas is on the screen (jsdom puts the canvas at the screen's corner). */
  function onScreen(point: { x: number; y: number }) {
    const viewport = canvasEl().querySelector<HTMLElement>('.react-flow__viewport');
    const [x = 0, y = 0] =
      /translate\(([-\d.]+)px, ?([-\d.]+)px\)/
        .exec(viewport?.style.transform ?? '')
        ?.slice(1)
        .map(Number) ?? [];
    return { x: x + point.x * zoom(), y: y + point.y * zoom() };
  }
  /** A pointer event at a point (jsdom's has no pointer position of its own). */
  function pointer(
    target: Element,
    type: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel',
    x: number,
    y: number,
  ) {
    const event = createEvent[type](target, { pointerId: 7, bubbles: true });
    Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y } });
    fireEvent(target, event);
  }
  /** A mouse event at a point, from this window (the canvas pans with the mouse). */
  function mouse(
    target: Element | Window,
    type: 'mouseDown' | 'mouseMove' | 'mouseUp',
    x: number,
    y: number,
  ) {
    const event = createEvent[type](target, { bubbles: true, clientX: x, clientY: y });
    Object.defineProperty(event, 'view', { value: window });
    fireEvent(target, event);
  }
  const savedRoutes = (call: Call | undefined) => (call?.body?.routes ?? []) as ViewLineRoute[];
  const details = () => screen.getByRole('complementary', { name: 'Details' });

  /** Drags a handle by `by` screen pixels: pressed, moved, released and clicked. */
  function dragHandle(handle: HTMLElement, by: { x: number; y: number }) {
    const at = onScreen(placeOf(handle));
    pointer(handle, 'pointerDown', at.x, at.y);
    pointer(handle, 'pointerMove', at.x + by.x / 2, at.y + by.y / 2);
    pointer(handle, 'pointerMove', at.x + by.x, at.y + by.y);
    pointer(handle, 'pointerUp', at.x + by.x, at.y + by.y);
    fireEvent.click(handle, { clientX: at.x + by.x, clientY: at.y + by.y });
  }
  const openHeading = () => screen.queryByRole('heading', { name: /relates to/ });
  const opened = (name: string) => within(details()).findByRole('heading', { level: 2, name });

  it('opens with each stored route, saves nothing, and shows a square on each bend of the line pointed at', async () => {
    const { calls } = await open('modelling', routed());
    await steady();
    const edge = plannerLine();
    expect(cornersOf(edge)).toEqual({ start: { x: 400, y: 30 }, end: { x: 124, y: 300 } });
    expect(allHandles()).toEqual([]);
    pointAt(edge);
    expect(bendsShown(edge)).toEqual([
      { x: 300, y: 30 },
      { x: 300, y: 250 },
      { x: 124, y: 250 },
    ]);
    // Only that line's.
    expect(allHandles()).toHaveLength(3);
    // The same size on the screen at any zoom.
    for (const handle of handlesOf(edge)) expect(placeOf(handle).scale).toBeCloseTo(1 / zoom(), 6);
    expect(handlesOf(edge)[0]?.getAttribute('aria-hidden')).toBe('true');
    pointAway(edge);
    expect(allHandles()).toEqual([]);
    // A line lit because a card at its end is pointed at shows none.
    fireEvent.mouseEnter(nodeOf('planner') as HTMLElement);
    expect(edge.getAttribute('class')).toContain('is-lit');
    expect(allHandles()).toEqual([]);
    await settle();
    expect(changes(calls)).toEqual([]);
  });

  it('keeps the handles the same size on the screen when zooming', async () => {
    await open('modelling', routed());
    await steady();
    const before = zoom();
    pointAt(plannerLine());
    fireEvent.keyDown(canvasEl(), { key: '+' });
    await steady();
    expect(zoom()).toBeGreaterThan(before);
    expect(handlesOf(plannerLine())).toHaveLength(3);
    for (const handle of handlesOf(plannerLine())) {
      expect(placeOf(handle).scale).toBeCloseTo(1 / zoom(), 6);
    }
  });

  it('shows the bends of the open relationship’s line until it is closed', async () => {
    await open('modelling', routed());
    fireEvent.click(plannerLine());
    expect(await opened('Planner relates to Sensors')).toBeTruthy();
    pointAway(plannerLine());
    expect(bendsShown(plannerLine())).toHaveLength(3);
    // Moving a card with the keyboard hides them, and the drop shows them again.
    const main = mainOf('pump');
    main.focus();
    fireEvent.keyDown(main, { key: 'm' });
    expect(allHandles()).toEqual([]);
    fireEvent.keyDown(main, { key: 'Enter' });
    expect(bendsShown(plannerLine())).toHaveLength(3);
    fireEvent.keyDown(canvasEl(), { key: 'Escape' });
    await waitFor(() => {
      expect(openHeading()).toBeNull();
    });
    expect(allHandles()).toEqual([]);
  });

  it('saves a dragged bend at once, with the cards, says so, and the view opens with it again', async () => {
    const fake = await open('modelling', routed());
    await steady();
    const scale = zoom();
    pointAt(plannerLine());
    // 60 left on the canvas: the stretch down moves with the bend, the one across stays.
    dragHandle(handleAt(plannerLine(), { x: 300, y: 250 }), { x: -60 * scale, y: 0 });
    expect(live()).toBe('Line moved.');
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    const moved = [
      { x: 400, y: 30 },
      { x: 240, y: 30 },
      { x: 240, y: 250 },
      { x: 124, y: 250 },
      { x: 124, y: 300 },
    ];
    const [save] = layoutSaves(fake.calls);
    expect(save?.body?.version).toBe(1);
    expect(savedRoutes(save)).toEqual([{ relationshipId: 'g2', points: moved }]);
    expect(savedCards(save)).toEqual(left);
    // A drag never opens the relationship.
    expect(openHeading()).toBeNull();
    await screen.findByText('Saved');

    fake.rendered.unmount();
    stubApi(modeller, fake.handler);
    renderAt(`/modelling/models/${modelId}/views/v-water`);
    await waitFor(() => {
      expect(cornersOf(plannerLine()).start).toEqual({ x: 400, y: 30 });
    });
    pointAt(plannerLine());
    expect(bendsShown(plannerLine())).toEqual([
      { x: 240, y: 30 },
      { x: 240, y: 250 },
      { x: 124, y: 250 },
    ]);
    await settle();
    expect(layoutSaves(fake.calls)).toHaveLength(1);
  });

  it('a ×2 line moved by a bend keeps the new route for both its relationships', async () => {
    const twice = {
      ...routed(),
      relationshipCount: 4,
      relationshipIds: ['g1', 'g2', 'g3', 'g5'],
      routes: [
        { relationshipId: 'g2', points: plannerToSensors },
        { relationshipId: 'g5', points: plannerToSensors },
      ],
    };
    const fake = await open('modelling', twice);
    await steady();
    const scale = zoom();
    const line = edgeOf(/^Planner .* Sensors/);
    expect(cornersOf(line)).toEqual({ start: { x: 400, y: 30 }, end: { x: 124, y: 300 } });
    pointAt(line);
    expect(bendsShown(line)).toHaveLength(3);
    dragHandle(handleAt(line, { x: 300, y: 250 }), { x: -60 * scale, y: 0 });
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    const moved = [
      { x: 400, y: 30 },
      { x: 240, y: 30 },
      { x: 240, y: 250 },
      { x: 124, y: 250 },
      { x: 124, y: 300 },
    ];
    const saved = savedRoutes(layoutSaves(fake.calls)[0]);
    expect(
      saved.filter((route) => route.relationshipId !== 'g1' && route.relationshipId !== 'g3'),
    ).toEqual(
      expect.arrayContaining([
        { relationshipId: 'g2', points: moved },
        { relationshipId: 'g5', points: moved },
      ]),
    );
    expect(openHeading()).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the squares while the pointer goes from a square back onto its line, also after a drop', async () => {
    const fake = await open('modelling', routed());
    await steady();
    const scale = zoom();
    const stretch = () =>
      plannerLine().querySelector('path.react-flow__edge-interaction') as Element;
    pointAt(plannerLine());
    // Onto a square (the line stays pointed at), then off it along the line.
    const square = handleAt(plannerLine(), { x: 300, y: 250 });
    fireEvent.mouseEnter(square, { relatedTarget: stretch() });
    fireEvent.mouseLeave(square, { relatedTarget: stretch() });
    expect(bendsShown(plannerLine())).toHaveLength(3);
    // Off a square onto empty canvas: they go.
    const pane = canvasEl().querySelector('.react-flow__pane') as Element;
    fireEvent.mouseEnter(handleAt(plannerLine(), { x: 300, y: 250 }), { relatedTarget: stretch() });
    fireEvent.mouseLeave(handleAt(plannerLine(), { x: 300, y: 250 }), { relatedTarget: pane });
    expect(allHandles()).toEqual([]);
    // A drop with the pointer resting on the square, then along the line to the next bend.
    pointAt(plannerLine());
    const dragged = handleAt(plannerLine(), { x: 300, y: 250 });
    fireEvent.mouseEnter(dragged, { relatedTarget: stretch() });
    dragHandle(dragged, { x: -60 * scale, y: 0 });
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    const moved = handleAt(plannerLine(), { x: 240, y: 250 });
    fireEvent.mouseLeave(moved, { relatedTarget: stretch() });
    expect(bendsShown(plannerLine())).toEqual([
      { x: 240, y: 30 },
      { x: 240, y: 250 },
      { x: 124, y: 250 },
    ]);
  });

  it('keeps saying "Line moved." once the moved line is saved', async () => {
    const fake = await open('modelling', routed());
    await steady();
    pointAt(plannerLine());
    dragHandle(handleAt(plannerLine(), { x: 300, y: 250 }), { x: -60 * zoom(), y: 0 });
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    await screen.findByText('Saved');
    await settle();
    expect(live()).toBe('Line moved.');
  });

  it('says "Line moved." again for a second move in a row', async () => {
    const fake = await open('modelling', routed());
    await steady();
    pointAt(plannerLine());
    dragHandle(handleAt(plannerLine(), { x: 300, y: 250 }), { x: -60 * zoom(), y: 0 });
    await screen.findByText('Saved');
    await settle();
    expect(live()).toBe('Line moved.');
    // The second drag empties the live region, so its drop changes it and is announced.
    pointAt(plannerLine());
    const handle = handleAt(plannerLine(), { x: 240, y: 250 });
    const at = onScreen({ x: 240, y: 250 });
    pointer(handle, 'pointerDown', at.x, at.y);
    pointer(handle, 'pointerMove', at.x, at.y - 40 * zoom());
    expect(live()).toBe('');
    pointer(handle, 'pointerUp', at.x, at.y - 40 * zoom());
    expect(live()).toBe('Line moved.');
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(2);
    });
  });

  it('slides the end next to a dragged bend along its card, snapping to the middle of its side', async () => {
    const fake = await open('modelling', routed());
    await steady();
    const scale = zoom();
    pointAt(plannerLine());
    // Down by 20 on the canvas, past Planner's middle (y 42), and left by 60.
    dragHandle(handleAt(plannerLine(), { x: 300, y: 30 }), { x: -60 * scale, y: 20 * scale });
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    expect(savedRoutes(layoutSaves(fake.calls)[0])[0]?.points.slice(0, 3)).toEqual([
      { x: 400, y: 42 },
      { x: 240, y: 42 },
      { x: 240, y: 250 },
    ]);
    expect(cornersOf(plannerLine()).start).toEqual({ x: 400, y: 42 });
    await screen.findByText('Saved');
    await steady();
    // Far down: the end stops 8px above Planner's bottom corner (Planner is 44 high, at y 20).
    pointAt(plannerLine());
    dragHandle(handleAt(plannerLine(), { x: 240, y: 42 }), { x: 0, y: 200 * scale });
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(2);
    });
    expect(savedRoutes(layoutSaves(fake.calls)[1])[0]?.points.slice(0, 2)).toEqual([
      { x: 400, y: 56 },
      { x: 240, y: 56 },
    ]);
  });

  it('a click on a bend, a stretch or the label opens the relationship, and saves nothing', async () => {
    const { calls } = await open('modelling', routed());
    await steady();
    const close = async () => {
      fireEvent.keyDown(canvasEl(), { key: 'Escape' });
      await waitFor(() => {
        expect(openHeading()).toBeNull();
      });
    };
    // A bend: pressed, moved 2px (under the 4px threshold), released.
    pointAt(plannerLine());
    const handle = handleAt(plannerLine(), { x: 300, y: 250 });
    const at = onScreen({ x: 300, y: 250 });
    pointer(handle, 'pointerDown', at.x, at.y);
    pointer(handle, 'pointerMove', at.x + 2, at.y + 1);
    pointer(handle, 'pointerUp', at.x + 2, at.y + 1);
    fireEvent.click(handle, { clientX: at.x + 2, clientY: at.y + 1 });
    expect(await opened('Planner relates to Sensors')).toBeTruthy();
    await close();
    // A stretch.
    fireEvent.click(plannerLine());
    expect(await opened('Planner relates to Sensors')).toBeTruthy();
    await close();
    // The label.
    const label = [...canvasEl().querySelectorAll<HTMLElement>('.edge-label')].find(
      (each) => each.textContent === 'Plans',
    ) as HTMLElement;
    pointer(label, 'pointerDown', 100, 100);
    pointer(label, 'pointerUp', 100, 100);
    fireEvent.click(label, { clientX: 100, clientY: 100 });
    expect(await opened('Planner relates to Sensors')).toBeTruthy();
    await settle();
    expect(layoutSaves(calls)).toEqual([]);
  });

  it('a drag on a stretch or the label pans the canvas, and moves no line', async () => {
    const { calls } = await open('modelling', routed());
    await steady();
    const viewport = () =>
      canvasEl().querySelector<HTMLElement>('.react-flow__viewport')?.style.transform;
    const path = pathOf(plannerLine());
    const label = [...canvasEl().querySelectorAll<HTMLElement>('.edge-label')].find(
      (each) => each.textContent === 'Plans',
    ) as HTMLElement;
    // Nothing on a line or its label keeps the canvas from panning.
    expect(label.className).not.toContain('nopan');
    expect(plannerLine().querySelector('.nopan')).toBeNull();
    // The label pans as empty canvas does.
    const before = viewport();
    const at = onScreen({ x: 200, y: 250 });
    mouse(label, 'mouseDown', at.x, at.y);
    mouse(window, 'mouseMove', at.x + 30, at.y + 20);
    mouse(window, 'mouseMove', at.x + 60, at.y + 40);
    mouse(window, 'mouseUp', at.x + 60, at.y + 40);
    fireEvent.click(label, { clientX: at.x + 60, clientY: at.y + 40 });
    await steady();
    expect(viewport()).not.toBe(before);
    expect(viewport()).toMatch(/^translate\(/);
    // The line pans by the pointer's move.
    const [x = 0, y = 0] =
      /translate\(([-\d.]+)px, ?([-\d.]+)px\)/
        .exec(viewport() ?? '')
        ?.slice(1)
        .map(Number) ?? [];
    const stretch = plannerLine().querySelector('path') as Element;
    pointer(stretch, 'pointerDown', 50, 50);
    pointer(stretch, 'pointerMove', 70, 60);
    pointer(stretch, 'pointerMove', 110, 90);
    pointer(stretch, 'pointerUp', 110, 90);
    fireEvent.click(plannerLine(), { clientX: 110, clientY: 90 });
    await steady();
    expect(viewport()).toMatch(new RegExp(`^translate\\(${x + 60}px, ?${y + 40}px\\)`));
    expect(pathOf(plannerLine())).toBe(path);
    await settle();
    expect(layoutSaves(calls)).toEqual([]);
    expect(openHeading()).toBeNull();
  });

  it('Esc during a drag puts the line back, saves nothing and says so; the release opens nothing', async () => {
    const { calls } = await open('modelling', routed());
    await steady();
    const path = pathOf(plannerLine());
    pointAt(plannerLine());
    const handle = handleAt(plannerLine(), { x: 300, y: 250 });
    const at = onScreen({ x: 300, y: 250 });
    pointer(handle, 'pointerDown', at.x, at.y);
    pointer(handle, 'pointerMove', at.x + 40, at.y - 30);
    expect(pathOf(plannerLine())).not.toBe(path);
    fireEvent.keyDown(handle, { key: 'Escape' });
    expect(pathOf(plannerLine())).toBe(path);
    expect(live()).toBe('Line move cancelled.');
    // The rest of the drag does nothing, and the release opens nothing.
    pointer(handle, 'pointerMove', at.x + 60, at.y - 40);
    expect(pathOf(plannerLine())).toBe(path);
    pointer(handle, 'pointerUp', at.x + 60, at.y - 40);
    fireEvent.click(handle, { clientX: at.x + 60, clientY: at.y - 40 });
    await settle();
    expect(pathOf(plannerLine())).toBe(path);
    expect(openHeading()).toBeNull();
    expect(changes(calls)).toEqual([]);
    expect(screen.queryByText('Saving…')).toBeNull();
  });

  it('Esc cancels only the drag: the open relationship stays open', async () => {
    const { calls } = await open('modelling', routed());
    await steady();
    fireEvent.click(plannerLine());
    expect(await opened('Planner relates to Sensors')).toBeTruthy();
    const path = pathOf(plannerLine());
    const handle = handleAt(plannerLine(), { x: 124, y: 250 });
    const at = onScreen({ x: 124, y: 250 });
    pointer(handle, 'pointerDown', at.x, at.y);
    pointer(handle, 'pointerMove', at.x, at.y - 30);
    fireEvent.keyDown(handle, { key: 'Escape' });
    pointer(handle, 'pointerUp', at.x, at.y - 30);
    await settle();
    expect(pathOf(plannerLine())).toBe(path);
    expect(
      within(details()).getByRole('heading', { level: 2, name: 'Planner relates to Sensors' }),
    ).toBeTruthy();
    expect(changes(calls)).toEqual([]);
  });

  it('a cancelled pointer or the window losing focus puts the line back, and saves nothing', async () => {
    const { calls } = await open('modelling', routed());
    await steady();
    const path = pathOf(plannerLine());
    pointAt(plannerLine());
    for (const end of ['pointerCancel', 'blur'] as const) {
      const handle = handleAt(plannerLine(), { x: 300, y: 250 });
      const at = onScreen({ x: 300, y: 250 });
      pointer(handle, 'pointerDown', at.x, at.y);
      pointer(handle, 'pointerMove', at.x + 40, at.y - 30);
      expect(pathOf(plannerLine())).not.toBe(path);
      if (end === 'blur') fireEvent.blur(window);
      else pointer(handle, 'pointerCancel', at.x + 40, at.y - 30);
      expect(pathOf(plannerLine()), end).toBe(path);
      expect(live()).toBe('Line move cancelled.');
      pointer(handle, 'pointerUp', at.x + 40, at.y - 30);
    }
    await settle();
    expect(changes(calls)).toEqual([]);
  });

  it('a straight line shows no bends, pointed at or open', async () => {
    // Gardener's circle to Planner's left side, straight across.
    const straight = [
      { x: 124, y: 44 },
      { x: 400, y: 44 },
    ];
    await open('modelling', watering(left, [{ relationshipId: 'g1', points: straight }]));
    const gardenerLine = edgeOf(/^Gardener .* Planner$/);
    expect(pathOf(gardenerLine)).toBe(linePath(straight));
    pointAt(gardenerLine);
    fireEvent.click(gardenerLine);
    expect(await opened('Gardener relates to Planner')).toBeTruthy();
    expect(allHandles()).toEqual([]);
  });

  it('keeps the moved bends when a card at one end moves; only that end follows', async () => {
    const { calls } = await open('modelling', routed());
    moveWithKeys('sensors', [{ key: 'ArrowRight' }, { key: 'ArrowDown' }]);
    await waitFor(() => {
      expect(layoutSaves(calls)).toHaveLength(1);
    });
    expect(savedRoutes(layoutSaves(calls)[0])).toEqual([
      {
        relationshipId: 'g2',
        points: [
          { x: 400, y: 30 },
          { x: 300, y: 30 },
          { x: 300, y: 250 },
          { x: 132, y: 250 },
          { x: 132, y: 308 },
        ],
      },
    ]);
    expect(cornersOf(plannerLine()).end).toEqual({ x: 132, y: 308 });
  });

  /** The SVG path a line is drawn with. */
  const pathOf = (edge: HTMLElement) =>
    edge.querySelector('path.react-flow__edge-path')?.getAttribute('d');

  it('grabs the bend nearest the pointer where two lines’ handles lie on top of each other', async () => {
    // Sensors to Pump has a bend 4px right of and below Planner to Sensors's at x 300, y 250.
    const sensorsToPump = [
      { x: 180, y: 300 },
      { x: 180, y: 100 },
      { x: 304, y: 100 },
      { x: 304, y: 254 },
      { x: 484, y: 254 },
      { x: 484, y: 300 },
    ];
    const fake = await open(
      'modelling',
      watering(left, [
        { relationshipId: 'g2', points: plannerToSensors },
        { relationshipId: 'g3', points: sensorsToPump },
      ]),
    );
    await steady();
    const scale = zoom();
    const pumpLine = () => edgeOf(/^Sensors .* Pump$/);
    // Planner to Sensors open, Sensors to Pump pointed at: both show their bends.
    fireEvent.click(plannerLine());
    await opened('Planner relates to Sensors');
    pointAt(pumpLine());
    expect(bendsShown(plannerLine())).toHaveLength(3);
    expect(bendsShown(pumpLine())).toHaveLength(4);
    // Pressed on Sensors to Pump's handle, at Planner to Sensors's bend: that one moves.
    const handle = handleAt(pumpLine(), { x: 304, y: 254 });
    const at = onScreen({ x: 300, y: 250 });
    pointer(handle, 'pointerDown', at.x, at.y);
    pointer(handle, 'pointerMove', at.x - 60 * scale, at.y);
    pointer(handle, 'pointerUp', at.x - 60 * scale, at.y);
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    const x = 240;
    expect(savedRoutes(layoutSaves(fake.calls)[0])).toEqual([
      {
        relationshipId: 'g2',
        points: [
          { x: 400, y: 30 },
          { x, y: 30 },
          { x, y: 250 },
          { x: 124, y: 250 },
          { x: 124, y: 300 },
        ],
      },
      { relationshipId: 'g3', points: sensorsToPump },
    ]);
  });

  it('drops the route of a line given another end, with no conflict', async () => {
    const sensorsToPump = [
      { x: 208, y: 310 },
      { x: 300, y: 310 },
      { x: 300, y: 330 },
      { x: 400, y: 330 },
    ];
    const fake = await open(
      'modelling',
      watering(left, [
        { relationshipId: 'g2', points: plannerToSensors },
        { relationshipId: 'g3', points: sensorsToPump },
      ]),
    );
    fireEvent.click(mainOf('sensors'));
    const panel = details();
    await expandRelationships();
    fireEvent.click(
      await within(panel).findByRole('button', { name: /^Open relationship: Relates to Pump/ }),
    );
    await screen.findByRole('form', { name: /^Relationship / });
    const ends = within(panel).getByRole('region', { name: 'Ends' });
    fireEvent.click(within(ends).getByRole('button', { name: /^To: Pump/ }));
    const search = within(ends).getByRole('combobox');
    fireEvent.change(search, { target: { value: 'shed' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    // Picked: saved at once.
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    // With the version the change gave the view, and only the route that still applies.
    expect(layoutSaves(fake.calls)[0]?.body?.version).toBe(2);
    expect(savedRoutes(layoutSaves(fake.calls)[0])).toEqual([
      { relationshipId: 'g2', points: plannerToSensors },
    ]);
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('has nothing to drag for a Viewer, or in Viewing, though the route shows', async () => {
    const { calls } = await open('viewing', routed());
    expect(cornersOf(plannerLine())).toEqual({ start: { x: 400, y: 30 }, end: { x: 124, y: 300 } });
    pointAt(plannerLine());
    expect(allHandles()).toEqual([]);
    await settle();
    expect(changes(calls)).toEqual([]);
  });

  it('has nothing to drag in Viewing for a Modeller either', async () => {
    const fake = server(routed());
    stubApi(modeller, fake.handler);
    renderAt(`/viewing/models/${modelId}/views/v-water`);
    await waitFor(() => {
      expect(cardIds()).toEqual(['gardener', 'planner', 'pump', 'sensors']);
    });
    await settle();
    expect(cornersOf(plannerLine()).start).toEqual({ x: 400, y: 30 });
    pointAt(plannerLine());
    fireEvent.click(plannerLine());
    await within(details()).findByRole('heading', {
      level: 2,
      name: 'Planner relates to Sensors',
    });
    expect(allHandles()).toEqual([]);
  });

  describe('when the automatic layout fails', () => {
    const status = () =>
      [...canvasEl().querySelectorAll('.canvas-overlay')].map((each) => each.textContent).join(' ');
    const failed = "The diagram couldn't be laid out automatically";
    function failLayouts() {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      return vi.spyOn(getElk(), 'layout').mockRejectedValue(new Error('Made-up layout failure'));
    }
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('a view with no stored layout says so on opening, and saves nothing', async () => {
      failLayouts();
      const fake = server(watering());
      stubApi(modeller, fake.handler);
      renderAt(`/modelling/models/${modelId}/views/v-water`);
      await waitFor(() => {
        expect(status()).toContain(failed);
      });
      expect(status()).toContain('so its cards are placed simply.');
      expect(cardIds()).toEqual(['gardener', 'planner', 'pump', 'sensors']);
      await settle();
      expect(changes(fake.calls)).toEqual([]);
    });
  });
});

/** A box's top left corner, to a tenth of a pixel, as a layout stores it. */
function pick(box: { x: number; y: number }) {
  return { x: Math.round(box.x * 10) / 10, y: Math.round(box.y * 10) / 10 };
}
