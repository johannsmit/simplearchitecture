import type {
  JgfDocument,
  ModelSummary,
  StoredView,
  ViewCardLayout,
} from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getElk } from '../src/viewing/explorer/canvas/elkEngine';
import { modeller, renderAt, stubApi, type Handler } from './helpers';
import { settle } from './settle';

// A Tidy up that hasn't finished is dropped when the canvas changes (another view, the Nest
// switch): nothing is saved for the new canvas, and it opens as it normally would. Made-up data:
// a small bakery.

const modelId = '56565656-5656-4565-8565-565656565656';

const bakery: JgfDocument = {
  graph: {
    id: modelId,
    label: 'Made-up bakery',
    directed: true,
    nodes: {
      baker: { label: 'Baker', metadata: { type: 'Stakeholder' } },
      orders: { label: 'Orders', metadata: { type: 'Application' } },
      ovens: { label: 'Ovens', metadata: { type: 'Application' } },
      store: { label: 'Store room', metadata: { type: 'Infrastructure' } },
      van: { label: 'Van', metadata: { type: 'Other' } },
    },
    edges: [
      { id: 'b1', source: 'baker', target: 'orders', relation: 'Relation' },
      { id: 'b2', source: 'orders', target: 'ovens', relation: 'Relation', label: 'Bakes' },
      { id: 'b3', source: 'ovens', target: 'store', relation: 'Relation' },
      { id: 'b4', source: 'van', target: 'store', relation: 'Relation' },
    ],
  },
};

const summary: ModelSummary = {
  id: modelId,
  name: 'Made-up bakery',
  createdAt: '2026-11-01T10:00:00.000Z',
  createdBy: { id: 'u1', name: 'Sam Taylor' },
  nodeCount: 5,
  edgeCount: 4,
};

const author = { id: 'u1', name: 'Sam Taylor' };

function storedView(
  id: string,
  name: string,
  elementIds: string[],
  relationshipIds: string[],
  layout: ViewCardLayout[],
): StoredView {
  return {
    id,
    name,
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
    routes: [],
  };
}

const morningLayout: ViewCardLayout[] = [
  { elementId: 'baker', x: 40, y: 20 },
  { elementId: 'orders', x: 400, y: 20 },
  { elementId: 'ovens', x: 40, y: 300 },
];
const deliveryLayout: ViewCardLayout[] = [
  { elementId: 'ovens', x: 600, y: 40 },
  { elementId: 'store', x: 80, y: 360 },
  { elementId: 'van', x: 600, y: 360 },
];

interface Call {
  method: string;
  url: string;
}

/** The model and two views, kept by a made-up server. */
function server() {
  const views = new Map<string, StoredView>([
    [
      'v-morning',
      storedView('v-morning', 'Morning', ['baker', 'orders', 'ovens'], ['b1', 'b2'], morningLayout),
    ],
    [
      'v-delivery',
      storedView('v-delivery', 'Delivery', ['ovens', 'store', 'van'], ['b3', 'b4'], deliveryLayout),
    ],
  ]);
  const original = structuredClone(views);
  const calls: Call[] = [];
  const handler: Handler = ({ url, method }) => {
    if (url === '/api/models') return Response.json({ models: [summary], editable: true });
    if (url === `/api/models/${modelId}`) return Response.json(bakery);
    if (url.startsWith(`/api/models/${modelId}/elements/`)) {
      const id = decodeURIComponent(url.split('/elements/')[1] ?? '');
      return Response.json({
        element: { id, version: 1, node: bakery.graph.nodes?.[id] },
        warnings: [],
      });
    }
    if (url === `/api/models/${modelId}/views`) {
      return Response.json({
        views: [...views.values()].map((view) => ({
          ...view,
          elementIds: undefined,
          layout: undefined,
        })),
      });
    }
    const match = /\/views\/([^/]+)(\/.*)?$/.exec(url);
    const view = match ? views.get(decodeURIComponent(match[1] ?? '')) : undefined;
    if (!view) return undefined;
    calls.push({ method, url });
    if (method === 'GET') return Response.json({ view });
    // Any change would be answered as saved: the test checks that none is asked for.
    return Response.json({ view: { ...view, version: view.version + 1 } });
  };
  return { handler, calls, views, original };
}

const canvasEl = () => document.getElementById('canvas') as HTMLElement;
const cardIds = () =>
  [...canvasEl().querySelectorAll('.card[data-element-id]')]
    .map((element) => element.getAttribute('data-element-id') ?? '')
    .sort();
const tidy = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Tidy up' });
const changes = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');

/** A top-level card's place, from React Flow's transform. */
function placeOf(id: string) {
  const node = canvasEl()
    .querySelector(`.card[data-element-id="${CSS.escape(id)}"]`)
    ?.closest<HTMLElement>('.react-flow__node');
  const match = /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(node?.style.transform ?? '');
  return { x: Number(match?.[1]), y: Number(match?.[2]) };
}

/** The next layout waits until `answer()` is called; the ones after it run at once. */
function slowNextLayout() {
  const elk = getElk();
  const slow = vi.spyOn(elk, 'layout');
  const pending: { answer: () => void } = { answer: () => undefined };
  slow.mockImplementationOnce(
    (graph) =>
      new Promise((resolve, reject) => {
        pending.answer = () => {
          slow.mockRestore();
          elk.layout(graph).then(resolve, reject);
        };
      }),
  );
  return pending;
}

async function open(viewId: string, expected: string[]) {
  const fake = server();
  stubApi(modeller, fake.handler);
  // The Views list in the left panel starts open.
  localStorage.setItem('sa-views-open', 'true');
  renderAt(`/modelling/models/${modelId}/views/${viewId}`);
  await waitFor(() => {
    expect(cardIds()).toEqual(expected);
  });
  await settle();
  return fake;
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('a Tidy up that has not finished', () => {
  it('is dropped when another view opens: nothing is saved, and the view opens as it was left', async () => {
    const { calls, views, original } = await open('v-morning', ['baker', 'orders', 'ovens']);
    const layout = slowNextLayout();
    fireEvent.click(tidy());
    await waitFor(() => {
      expect(canvasEl().textContent).toContain('Laying out…');
    });

    const list = await screen.findByRole('list', { name: 'Views in this model' });
    fireEvent.click(within(list).getByRole('link', { name: 'Delivery' }));
    await waitFor(() => {
      expect(cardIds()).toEqual(['ovens', 'store', 'van']);
    });
    // The old canvas's layout answers late: it is for no canvas now.
    layout.answer();
    await settle();
    await settle();

    expect(changes(calls)).toEqual([]);
    for (const { elementId, x, y } of deliveryLayout) {
      expect(placeOf(elementId), elementId).toEqual({ x, y });
    }
    expect(views.get('v-delivery')).toEqual(original.get('v-delivery'));
    expect(views.get('v-morning')).toEqual(original.get('v-morning'));
    expect(screen.queryByText('Layout tidied up.')).toBeNull();
  });

  it('is dropped when Nest contained elements is switched: nothing is saved', async () => {
    const { calls } = await open('v-morning', ['baker', 'orders', 'ovens']);
    const layout = slowNextLayout();
    fireEvent.click(tidy());
    await waitFor(() => {
      expect(canvasEl().textContent).toContain('Laying out…');
    });

    fireEvent.click(screen.getByRole('switch', { name: 'Nest contained elements' }));
    await settle();
    layout.answer();
    await settle();
    await settle();

    expect(changes(calls)).toEqual([]);
    // The view opens as it was left, from its stored layout.
    for (const { elementId, x, y } of morningLayout) {
      expect(placeOf(elementId), elementId).toEqual({ x, y });
    }
    expect(screen.queryByText('Layout tidied up.')).toBeNull();
  });

  it('still saves when it finishes on the canvas it was chosen for', async () => {
    const { calls } = await open('v-morning', ['baker', 'orders', 'ovens']);
    const layout = slowNextLayout();
    fireEvent.click(tidy());
    await waitFor(() => {
      expect(canvasEl().textContent).toContain('Laying out…');
    });
    layout.answer();
    await waitFor(() => {
      expect(changes(calls).map((call) => call.url)).toEqual([
        `/api/models/${modelId}/views/v-morning/layout`,
      ]);
    });
  });

  it('is dropped on a focus canvas too: a failed layout of the new canvas keeps no old card', async () => {
    const fake = server();
    stubApi(modeller, fake.handler);
    renderAt(`/modelling/models/${modelId}/elements/orders`);
    await waitFor(() => {
      expect(cardIds()).toEqual(['baker', 'orders', 'ovens']);
    });
    await settle();
    // A card moved with the keyboard (M, Shift + Down, Enter), so Tidy up has something to do.
    const main = canvasEl().querySelector<HTMLElement>('.card[data-element-id="ovens"] .card-main');
    main?.focus();
    for (const key of [{ key: 'm' }, { key: 'ArrowDown', shiftKey: true }, { key: 'Enter' }]) {
      fireEvent.keyDown(main as HTMLElement, key);
    }
    await waitFor(() => {
      expect(tidy().disabled).toBe(false);
    });
    const elk = getElk();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Tidy up's layout never answers; the new canvas's layout fails.
    vi.spyOn(elk, 'layout')
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockRejectedValue(new Error('Made-up layout failure'));
    fireEvent.click(tidy());
    await waitFor(() => {
      expect(canvasEl().textContent).toContain('Laying out…');
    });

    fireEvent.click(screen.getByRole('switch', { name: 'Nest contained elements' }));
    // A new canvas, not a tidied one: its cards are placed without the layout.
    await waitFor(() => {
      expect(canvasEl().textContent).toContain(
        "The diagram couldn't be laid out automatically, so its cards are placed simply.",
      );
    });
    expect(cardIds()).toEqual(['baker', 'orders', 'ovens']);
    expect(changes(fake.calls)).toEqual([]);
  });
});
