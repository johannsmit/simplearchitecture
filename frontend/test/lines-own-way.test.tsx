import type { JgfDocument, ModelSummary, StoredView } from '@simplearchitecture/shared';
import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderAt, stubApi, viewer, type Handler } from './helpers';
import { settle } from './settle';

// Every line not moved by hand is drawn by the canvas, never on the automatic layout's route: a
// line up from a card nested three containers deep to a card in another container takes the
// short way between them, not round every container. Made-up data: a small data centre.

const modelId = '61616161-6161-4616-8616-616161616161';

const centre: JgfDocument = {
  graph: {
    id: modelId,
    label: 'Made-up data centre',
    directed: true,
    nodes: {
      office: { label: 'Front Office', metadata: { type: 'Business' } },
      desk: { label: 'Billing Desk', metadata: { type: 'Business' } },
      portal: { label: 'Customer Portal', metadata: { type: 'Application' } },
      hall: { label: 'Server Hall', metadata: { type: 'Infrastructure' } },
      cluster: { label: 'Finance Cluster', metadata: { type: 'Infrastructure' } },
      rack: { label: 'Ledger Rack', metadata: { type: 'Infrastructure' } },
      ledger: { label: 'Ledger', metadata: { type: 'Application' } },
    },
    edges: [
      { id: 'k1', source: 'office', target: 'desk', relation: 'Contains' },
      { id: 'k2', source: 'hall', target: 'cluster', relation: 'Contains' },
      { id: 'k3', source: 'cluster', target: 'rack', relation: 'Contains' },
      { id: 'k4', source: 'rack', target: 'ledger', relation: 'Contains' },
      // Desk to Portal to Ledger puts Ledger below Desk; Ledger's line back up to Desk runs
      // against the layout's direction.
      { id: 'r1', source: 'desk', target: 'portal', relation: 'Relation' },
      { id: 'r2', source: 'portal', target: 'ledger', relation: 'Relation' },
      { id: 'r3', source: 'ledger', target: 'desk', relation: 'Relation' },
    ],
  },
};

const summary: ModelSummary = {
  id: modelId,
  name: 'Made-up data centre',
  createdAt: '2026-11-01T10:00:00.000Z',
  createdBy: { id: 'u1', name: 'Sam Taylor' },
  nodeCount: 7,
  edgeCount: 7,
};

/** A view with every element and no stored layout: laid out automatically when it opens. */
function dataCentre(): StoredView {
  const author = { id: 'u1', name: 'Sam Taylor' };
  const edges = centre.graph.edges ?? [];
  return {
    id: 'v-centre',
    name: 'Data centre',
    folder: null,
    version: 1,
    elementCount: 7,
    relationshipCount: edges.length,
    createdAt: '2026-11-05T09:00:00.000Z',
    createdBy: author,
    updatedAt: '2026-11-05T09:00:00.000Z',
    updatedBy: author,
    elementIds: Object.keys(centre.graph.nodes ?? {}),
    relationshipIds: edges.map((edge) => edge.id ?? ''),
    layout: [],
    routes: [],
    groupBy: null,
  };
}

function server(view: StoredView): Handler {
  const base = `/api/models/${modelId}/views/${view.id}`;
  return ({ url, method }) => {
    if (url === '/api/models') return Response.json({ models: [summary] });
    if (url === `/api/models/${modelId}`) return Response.json(centre);
    if (url === `/api/models/${modelId}/views`) {
      return Response.json({ views: [{ ...view, elementIds: undefined, layout: undefined }] });
    }
    if (url === base && method === 'GET') return Response.json({ view });
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

/** A card's box on the canvas, as React Flow draws it (a nested card's too). */
function boxOf(id: string): { x: number; y: number; width: number; height: number } {
  const node = nodeOf(id) as HTMLElement;
  const match = /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(node.style.transform);
  return {
    x: Number(match?.[1]),
    y: Number(match?.[2]),
    width: parseFloat(node.style.width),
    height: parseFloat(node.style.height),
  };
}

/** The corners of a line as drawn: the points its SVG path goes through. */
function pointsOf(label: RegExp) {
  const edge = [...canvasEl().querySelectorAll<HTMLElement>('.react-flow__edge')].find((each) =>
    label.test(each.getAttribute('aria-label') ?? ''),
  );
  const d = edge?.querySelector('path.react-flow__edge-path')?.getAttribute('d') ?? '';
  const numbers = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const points: { x: number; y: number }[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    points.push({ x: numbers[index] as number, y: numbers[index + 1] as number });
  }
  return points;
}

describe('a line against the layout’s direction', () => {
  it('takes the short way between its cards, not the layout’s way round the containers', async () => {
    stubApi(viewer, server(dataCentre()));
    renderAt(`/viewing/models/${modelId}/views/v-centre`);
    await waitFor(() => {
      expect(cardIds()).toEqual(Object.keys(centre.graph.nodes ?? {}).sort());
    });
    await settle();
    const ledger = boxOf('ledger');
    const desk = boxOf('desk');
    // Ledger is below Billing Desk, so its line runs up.
    expect(ledger.y).toBeGreaterThan(desk.y + desk.height);
    const points = pointsOf(/^Ledger .* Billing Desk$/);
    expect(points.length).toBeGreaterThan(1);
    // Every point of the line lies between the two cards (with room for a corner): it never goes
    // below Ledger, above Billing Desk, or out to the side round the containers.
    const room = 24;
    const left = Math.min(ledger.x, desk.x) - room;
    const right = Math.max(ledger.x + ledger.width, desk.x + desk.width) + room;
    const top = Math.min(ledger.y, desk.y) - room;
    const bottom = Math.max(ledger.y + ledger.height, desk.y + desk.height) + room;
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(left);
      expect(point.x).toBeLessThanOrEqual(right);
      expect(point.y).toBeGreaterThanOrEqual(top);
      expect(point.y).toBeLessThanOrEqual(bottom);
    }
  });
});
