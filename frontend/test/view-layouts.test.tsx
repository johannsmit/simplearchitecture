import type {
  JgfDocument,
  ModelSummary,
  StoredView,
  ViewCardLayout,
  ViewLineRoute,
} from '@simplearchitecture/shared';
import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { apiError, modeller, renderAt, stubApi, viewer, type Handler } from './helpers';

// A view keeps its cards where they were put: only the person's moves, resizes, adds, removes and
// Tidy up save the layout; a layout or a placement the canvas made on its own saves nothing.
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
    ],
  },
};

const summary: ModelSummary = {
  id: modelId,
  name: 'Made-up greenhouse',
  createdAt: '2026-11-01T10:00:00.000Z',
  createdBy: { id: 'u1', name: 'Sam Taylor' },
  nodeCount: 5,
  edgeCount: 4,
};

function watering(layout: ViewCardLayout[] = [], routes: ViewLineRoute[] = []): StoredView {
  const author = { id: 'u1', name: 'Sam Taylor' };
  return {
    id: 'v-water',
    name: 'Watering',
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
    if (url === '/api/models') return Response.json({ models: [summary], editable: true });
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
const tidy = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Tidy up' });
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

/** Lets any layout or save that might have started finish (ELK runs in-process in the tests). */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
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
    expect(tidy().disabled).toBe(true);
  });

  it('with a stored layout: every card where it was left, with its width, and nothing saved', async () => {
    const { calls } = await open('modelling', watering(left));
    for (const { elementId, x, y } of left) {
      expect(boxOf(elementId), elementId).toMatchObject({ x, y });
    }
    expect(boxOf('planner').width).toBe(320);
    await settle();
    expect(changes(calls)).toEqual([]);
    // It isn't the automatic layout: Tidy up has something to do.
    expect(tidy().disabled).toBe(false);
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

  it('lays out again and saves on Tidy up, with no question', async () => {
    const { calls } = await open('modelling', watering(left));
    fireEvent.click(tidy());
    await waitFor(() => {
      expect(layoutSaves(calls)).toHaveLength(1);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    const cards = savedCards(layoutSaves(calls)[0]);
    expect(cards).not.toEqual(left);
    for (const c of cards) {
      expect(c, c.elementId).toMatchObject({ elementId: c.elementId, ...pick(boxOf(c.elementId)) });
    }
    // The width set by hand stays through Tidy up.
    expect(cards.find((c) => c.elementId === 'planner')?.width).toBe(320);
    await settle();
    expect(layoutSaves(calls)).toHaveLength(1);
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
    fireEvent.click(
      await within(panel).findByRole('button', { name: /^Open relationship: Relates to Pump/ }),
    );
    const form = await screen.findByRole('form', { name: /^Relationship / });
    const ends = within(panel).getByRole('region', { name: 'Ends' });
    fireEvent.click(within(ends).getByRole('button', { name: 'Change To: Pump' }));
    const search = within(ends).getByRole('combobox');
    fireEvent.change(search, { target: { value: 'shed' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    fireEvent.click(within(form).getByRole('button', { name: /^Save/ }));
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
    fireEvent.click(tidy());
    await settle();
    expect(changes(calls)).toEqual([]);
  });
});

describe('moving a line', () => {
  // Planner to Sensors, moved by hand: out of Planner's left side, across, down, across, and
  // down into the top of Sensors. Its two middle stretches can be dragged.
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
  const gripsOf = (edge: HTMLElement) => [...edge.querySelectorAll<SVGPathElement>('.line-grip')];
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
    type: 'pointerDown' | 'pointerMove' | 'pointerUp',
    x: number,
    y: number,
  ) {
    const event = createEvent[type](target, { pointerId: 7, bubbles: true });
    Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y } });
    fireEvent(target, event);
  }
  const savedRoutes = (call: Call | undefined) => (call?.body?.routes ?? []) as ViewLineRoute[];
  const details = () => screen.getByRole('complementary', { name: 'Details' });

  it('opens with each stored route, with its middle stretches to drag, and saves nothing', async () => {
    const { calls } = await open('modelling', routed());
    const edge = plannerLine();
    expect(cornersOf(edge)).toEqual({ start: { x: 400, y: 30 }, end: { x: 124, y: 300 } });
    expect(gripsOf(edge).map((grip) => grip.getAttribute('d'))).toEqual([
      'M300 30L300 250',
      'M300 250L124 250',
    ]);
    expect(gripsOf(edge).map((grip) => grip.getAttribute('class'))).toEqual([
      'line-grip nopan nodrag is-upright',
      'line-grip nopan nodrag is-across',
    ]);
    await settle();
    expect(changes(calls)).toEqual([]);
  });

  it('saves a dragged stretch at once, with the cards, and the view opens with it again', async () => {
    const fake = await open('modelling', routed());
    const [upright] = gripsOf(plannerLine());
    const scale = zoom();
    const at = onScreen({ x: 300, y: 150 });
    pointer(upright as SVGPathElement, 'pointerDown', at.x, at.y);
    pointer(upright as SVGPathElement, 'pointerMove', at.x + 30, at.y + 60);
    pointer(upright as SVGPathElement, 'pointerUp', at.x + 40, at.y + 60);
    fireEvent.click(upright as SVGPathElement);
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    // Moved sideways only (an upright stretch), by the drag on the canvas; the ends stay.
    const x = Math.round((300 + 40 / scale) * 10) / 10;
    const moved = [
      { x: 400, y: 30 },
      { x, y: 30 },
      { x, y: 250 },
      { x: 124, y: 250 },
      { x: 124, y: 300 },
    ];
    const [save] = layoutSaves(fake.calls);
    expect(save?.body?.version).toBe(1);
    expect(savedRoutes(save)).toEqual([{ relationshipId: 'g2', points: moved }]);
    expect(savedCards(save)).toEqual(left);
    // A drag never opens the relationship.
    expect(screen.queryByRole('heading', { name: /relates to/ })).toBeNull();
    await screen.findByText('Saved');

    fake.rendered.unmount();
    stubApi(modeller, fake.handler);
    renderAt(`/modelling/models/${modelId}/views/v-water`);
    await waitFor(() => {
      expect(gripsOf(plannerLine())[0]?.getAttribute('d')).toBe(`M${x} 30L${x} 250`);
    });
    await settle();
    expect(layoutSaves(fake.calls)).toHaveLength(1);
  });

  it('a click on a stretch without a move selects the line, and saves nothing', async () => {
    const { calls } = await open('modelling', routed());
    const [, across] = gripsOf(plannerLine());
    const at = onScreen({ x: 200, y: 250 });
    pointer(across as SVGPathElement, 'pointerDown', at.x, at.y);
    pointer(across as SVGPathElement, 'pointerMove', at.x + 2, at.y + 1);
    pointer(across as SVGPathElement, 'pointerUp', at.x + 2, at.y + 1);
    fireEvent.click(across as SVGPathElement);
    expect(
      await within(details()).findByRole('heading', {
        level: 2,
        name: 'Planner relates to Sensors',
      }),
    ).toBeTruthy();
    await settle();
    expect(layoutSaves(calls)).toEqual([]);
  });

  it('keeps the moved stretches when a card at one end moves; only that end follows', async () => {
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

  it('Tidy up clears the dragged routes and saves the cards; undragged lines then follow cards', async () => {
    const { calls } = await open('modelling', routed());
    fireEvent.click(tidy());
    await waitFor(() => {
      expect(layoutSaves(calls)).toHaveLength(1);
    });
    const [save] = layoutSaves(calls);
    // Only dragged lines are saved: Tidy up drops their routes, and saves no others.
    expect(savedRoutes(save)).toEqual([]);
    expect(savedCards(save)).not.toEqual(left);
    expect(cornersOf(plannerLine()).start).not.toEqual({ x: 400, y: 30 });
    await settle();
    const before = plannerLine().querySelector('path.react-flow__edge-path')?.getAttribute('d');

    // A card moved after Tidy up: its lines re-route round the cards, from where it is now, and
    // still no route is saved for a line nobody dragged.
    moveWithKeys('sensors', [{ key: 'ArrowDown', shiftKey: true }]);
    await waitFor(() => {
      expect(layoutSaves(calls)).toHaveLength(2);
    });
    expect(savedRoutes(layoutSaves(calls)[1])).toEqual([]);
    const after = plannerLine().querySelector('path.react-flow__edge-path')?.getAttribute('d');
    expect(after).not.toBe(before);
    const { end } = cornersOf(plannerLine());
    const sensors = boxOf('sensors');
    const onBorder =
      [sensors.x, sensors.x + sensors.width].some((x) => Math.abs((end.x ?? NaN) - x) < 0.01) ||
      [sensors.y, sensors.y + sensors.height].some((y) => Math.abs((end.y ?? NaN) - y) < 0.01);
    expect(onBorder).toBe(true);
  });

  it('moves the line nearest the pointer, not another line whose grip lies on top', async () => {
    // Sensors to Pump runs 4px beside Planner to Sensors, from y 100 to 250.
    const sensorsToPump = [
      { x: 180, y: 300 },
      { x: 180, y: 100 },
      { x: 304, y: 100 },
      { x: 304, y: 280 },
      { x: 484, y: 280 },
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
    const besideGrip = gripsOf(edgeOf(/^Sensors .* Pump$/)).find(
      (grip) => grip.getAttribute('d') === 'M304 100L304 280',
    ) as SVGPathElement;
    // On Planner to Sensors's stroke, where Sensors to Pump's grip is on top.
    const at = onScreen({ x: 300.5, y: 150 });
    pointer(besideGrip, 'pointerDown', at.x, at.y);
    pointer(besideGrip, 'pointerMove', at.x - 40, at.y);
    pointer(besideGrip, 'pointerUp', at.x - 40, at.y);
    fireEvent.click(besideGrip);
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    const x = Math.round((300 - 40 / scale) * 10) / 10;
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
    await screen.findByText('Saved');
    await steady();
    // On its own stroke, the same grip moves its own line.
    const own = onScreen({ x: 304, y: 150 });
    pointer(besideGrip, 'pointerDown', own.x, own.y);
    pointer(besideGrip, 'pointerMove', own.x + 40, own.y);
    pointer(besideGrip, 'pointerUp', own.x + 40, own.y);
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(2);
    });
    const second = savedRoutes(layoutSaves(fake.calls)[1]);
    expect(second.find((route) => route.relationshipId === 'g2')?.points[1]?.x).toBe(x);
    expect(second.find((route) => route.relationshipId === 'g3')?.points[2]?.x).toBeGreaterThan(
      330,
    );
  });

  it('a drag on the label moves the line’s nearest middle stretch; a click still opens it', async () => {
    const fake = await open('modelling', routed());
    // The fit may still be zooming: the press and the expected points must use the same zoom.
    await steady();
    const label = () =>
      [...canvasEl().querySelectorAll<HTMLElement>('.edge-label')].find(
        (each) => each.textContent === 'Plans',
      ) as HTMLElement;
    expect(label().className).toContain('nopan');
    // Pressed beside the stretch across (y 250), wherever the label sits: that stretch moves.
    const at = onScreen({ x: 150, y: 262 });
    pointer(label(), 'pointerDown', at.x, at.y);
    pointer(label(), 'pointerMove', at.x, at.y + 20);
    pointer(label(), 'pointerUp', at.x, at.y + 30);
    fireEvent.click(label(), { clientX: at.x, clientY: at.y + 30 });
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    const y = Math.round((250 + 30 / zoom()) * 10) / 10;
    expect(savedRoutes(layoutSaves(fake.calls)[0])).toEqual([
      {
        relationshipId: 'g2',
        points: [
          { x: 400, y: 30 },
          { x: 300, y: 30 },
          { x: 300, y },
          { x: 124, y },
          { x: 124, y: 300 },
        ],
      },
    ]);
    expect(screen.queryByRole('heading', { name: /relates to/ })).toBeNull();
    await screen.findByText('Saved');
    await new Promise((resolve) => setTimeout(resolve, 350));
    // A press and click without a move opens the relationship, and saves nothing.
    pointer(label(), 'pointerDown', 100, 100);
    pointer(label(), 'pointerUp', 100, 100);
    fireEvent.click(label(), { clientX: 100, clientY: 100 });
    expect(
      await within(details()).findByRole('heading', {
        level: 2,
        name: 'Planner relates to Sensors',
      }),
    ).toBeTruthy();
    expect(layoutSaves(fake.calls)).toHaveLength(1);
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
    fireEvent.click(
      await within(panel).findByRole('button', { name: /^Open relationship: Relates to Pump/ }),
    );
    const form = await screen.findByRole('form', { name: /^Relationship / });
    const ends = within(panel).getByRole('region', { name: 'Ends' });
    fireEvent.click(within(ends).getByRole('button', { name: 'Change To: Pump' }));
    const search = within(ends).getByRole('combobox');
    fireEvent.change(search, { target: { value: 'shed' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    fireEvent.click(within(form).getByRole('button', { name: /^Save/ }));
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
    expect(canvasEl().querySelectorAll('.line-grip')).toHaveLength(0);
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
    expect(canvasEl().querySelectorAll('.line-grip')).toHaveLength(0);
  });
});

/** A box's top left corner, to a tenth of a pixel, as a layout stores it. */
function pick(box: { x: number; y: number }) {
  return { x: Math.round(box.x * 10) / 10, y: Math.round(box.y * 10) / 10 };
}
