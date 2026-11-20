import type {
  JgfDocument,
  ModelSummary,
  StoredView,
  ViewCardLayout,
} from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { modeller, renderAt, stubApi, viewer, type Handler } from './helpers';
import { settle } from './settle';

// The automatic layout (a new canvas, Tidy up) places cards by their relationships alone: an
// element's type sets no row, on a focus canvas, in a view and inside a container. Each line here
// points against the order the element types are listed in, so rows by type would turn it upside
// down. Made-up data: a small observatory.

const modelId = '55555555-4444-4555-8555-555555555555';

const observatory: JgfDocument = {
  graph: {
    id: modelId,
    label: 'Made-up observatory',
    directed: true,
    nodes: {
      dome: { label: 'Dome', metadata: { type: 'Other' } },
      lens: { label: 'Lens', metadata: { type: 'Infrastructure' } },
      tracker: { label: 'Star tracker', metadata: { type: 'Application' } },
      booking: { label: 'Night booking', metadata: { type: 'Business' } },
      visitor: { label: 'Visitor', metadata: { type: 'Stakeholder' } },
      site: { label: 'Hill site', metadata: { type: 'Business' } },
      cooler: { label: 'Cooler', metadata: { type: 'Other' } },
      sensor: { label: 'Sensor', metadata: { type: 'Infrastructure' } },
      panel: { label: 'Panel', metadata: { type: 'Application' } },
    },
    edges: [
      { id: 'o1', source: 'dome', target: 'lens', relation: 'Relation' },
      { id: 'o2', source: 'lens', target: 'tracker', relation: 'Relation' },
      { id: 'o3', source: 'tracker', target: 'booking', relation: 'Relation' },
      { id: 'o4', source: 'booking', target: 'visitor', relation: 'Relation' },
      { id: 'k1', source: 'site', target: 'cooler', relation: 'Contains' },
      { id: 'k2', source: 'site', target: 'sensor', relation: 'Contains' },
      { id: 'k3', source: 'site', target: 'panel', relation: 'Contains' },
      { id: 'o5', source: 'cooler', target: 'sensor', relation: 'Relation' },
      { id: 'o6', source: 'sensor', target: 'panel', relation: 'Relation' },
      { id: 'o7', source: 'dome', target: 'cooler', relation: 'Relation' },
    ],
  },
};

const chain = ['o1', 'o2', 'o3', 'o4'] as const;
const inside = ['o5', 'o6'] as const;
const ends = (id: string) => {
  const edge = observatory.graph.edges?.find((each) => each.id === id);
  return [edge?.source ?? '', edge?.target ?? ''] as const;
};

const summary: ModelSummary = {
  id: modelId,
  name: 'Made-up observatory',
  createdAt: '2026-11-01T10:00:00.000Z',
  createdBy: { id: 'u1', name: 'Sam Taylor' },
  nodeCount: 9,
  edgeCount: 10,
};

function stargazing(layout: ViewCardLayout[] = []): StoredView {
  const author = { id: 'u1', name: 'Sam Taylor' };
  const edges = observatory.graph.edges ?? [];
  return {
    id: 'v-stars',
    name: 'Stargazing',
    folder: null,
    version: 1,
    elementCount: 9,
    relationshipCount: edges.length,
    createdAt: '2026-11-05T09:00:00.000Z',
    createdBy: author,
    updatedAt: '2026-11-05T09:00:00.000Z',
    updatedBy: author,
    elementIds: Object.keys(observatory.graph.nodes ?? {}),
    relationshipIds: edges.map((edge) => edge.id ?? ''),
    layout,
    routes: [],
    groupBy: null,
  };
}

/** The model and one view, with layout saves kept, as the API does. */
function server(initial: StoredView): Handler {
  let view = structuredClone(initial);
  const base = `/api/models/${modelId}/views/${initial.id}`;
  return ({ url, method, body }) => {
    if (url === '/api/models') return Response.json({ models: [summary], editable: true });
    if (url === `/api/models/${modelId}`) return Response.json(observatory);
    if (url === `/api/models/${modelId}/views`) {
      return Response.json({ views: [{ ...view, elementIds: undefined, layout: undefined }] });
    }
    if (url === base && method === 'GET') return Response.json({ view });
    if (url === `${base}/layout`) {
      const parsed = JSON.parse(body as string) as { cards: ViewCardLayout[] };
      view = { ...view, version: view.version + 1, layout: parsed.cards };
      return Response.json({ view });
    }
    return undefined;
  };
}

const canvasEl = () => document.getElementById('canvas') as HTMLElement;
const nodeOf = (id: string) =>
  canvasEl()
    .querySelector<HTMLElement>(`.card[data-element-id="${CSS.escape(id)}"]`)
    ?.closest<HTMLElement>('.react-flow__node');
const cardIds = () =>
  [...canvasEl().querySelectorAll('.card[data-element-id]')]
    .map((element) => element.getAttribute('data-element-id') ?? '')
    .sort();

/** A card's box from React Flow's transform and size: relative to its container, if any. */
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

/** Each line's source card is wholly above its target card. */
function expectPointingDown(links: readonly string[]) {
  for (const link of links) {
    const [source, target] = ends(link);
    const upper = boxOf(source);
    const lower = boxOf(target);
    expect(upper.y + upper.height, `${source} above ${target}`).toBeLessThanOrEqual(lower.y);
  }
}

describe('the automatic layout keeps no rows by element type', () => {
  it('on a focus canvas, cards follow their lines down, against the order of the types', async () => {
    stubApi(viewer, server(stargazing()));
    renderAt(`/viewing/models/${modelId}/elements/tracker?depth=2`);
    await waitFor(() => {
      expect(cardIds()).toEqual(['booking', 'dome', 'lens', 'tracker', 'visitor']);
    });
    await settle();
    expectPointingDown(chain);
  });

  it('in a view laid out when it opens, at the top level and inside a container', async () => {
    stubApi(viewer, server(stargazing()));
    renderAt(`/viewing/models/${modelId}/views/v-stars`);
    await waitFor(() => {
      expect(cardIds()).toEqual(Object.keys(observatory.graph.nodes ?? {}).sort());
    });
    await settle();
    expectPointingDown(chain);
    expectPointingDown(inside);
  });

  it('after Tidy up in a view: a saved layout upside down is laid out by its lines', async () => {
    // Saved with every line pointing up.
    const upsideDown: ViewCardLayout[] = [
      { elementId: 'visitor', x: 0, y: 0 },
      { elementId: 'booking', x: 0, y: 120 },
      { elementId: 'tracker', x: 0, y: 240 },
      { elementId: 'lens', x: 0, y: 360 },
      { elementId: 'dome', x: 0, y: 480 },
      { elementId: 'site', x: 400, y: 0 },
      { elementId: 'panel', x: 420, y: 60 },
      { elementId: 'sensor', x: 420, y: 140 },
      { elementId: 'cooler', x: 420, y: 220 },
    ];
    stubApi(modeller, server(stargazing(upsideDown)));
    renderAt(`/modelling/models/${modelId}/views/v-stars`);
    await waitFor(() => {
      expect(cardIds()).toEqual(Object.keys(observatory.graph.nodes ?? {}).sort());
    });
    await settle();
    // The stored layout opens as saved.
    expect(boxOf('visitor').y).toBeLessThan(boxOf('dome').y);
    fireEvent.click(screen.getByRole('button', { name: 'Tidy up' }));
    await waitFor(() => {
      expect(screen.getByText('Layout tidied up.')).toBeTruthy();
    });
    await settle();
    expectPointingDown(chain);
    expectPointingDown(inside);
  });
});
