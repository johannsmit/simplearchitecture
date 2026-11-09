import type {
  JgfDocument,
  ModelSummary,
  StoredView,
  ViewCardLayout,
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
      { id: 'g2', source: 'planner', target: 'sensors', relation: 'Relation' },
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

function watering(layout: ViewCardLayout[] = []): StoredView {
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
      };
      return Response.json({ view });
    }
    if (url === `${base}/layout`) {
      view = { ...view, version: view.version + 1, layout: parsed.cards as ViewCardLayout[] };
      return Response.json({ view });
    }
    return undefined;
  };
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

/** A box's top left corner, to a tenth of a pixel, as a layout stores it. */
function pick(box: { x: number; y: number }) {
  return { x: Math.round(box.x * 10) / 10, y: Math.round(box.y * 10) / 10 };
}
