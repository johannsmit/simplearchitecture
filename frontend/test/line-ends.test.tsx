import type {
  JgfDocument,
  ModelSummary,
  StoredView,
  ViewCardLayout,
  ViewLineRoute,
} from '@simplearchitecture/shared';
import { act, createEvent, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { modeller, renderAt, stubApi, type Handler } from './helpers';

// A line moved by hand between cards nested in containers keeps its arrowhead: its last stretch
// always comes into the target card from outside, so the arrowhead is drawn outside the card,
// pointing into it, however far the stretch before it is dragged. Made-up data: two wings of a
// made-up irrigation plant.

const modelId = '55555555-5555-4555-8555-555555555555';

const plant: JgfDocument = {
  graph: {
    id: modelId,
    label: 'Made-up irrigation plant',
    directed: true,
    nodes: {
      north: { label: 'North wing', metadata: { type: 'Application' } },
      south: { label: 'South wing', metadata: { type: 'Application' } },
      scheduler: { label: 'Scheduler', metadata: { type: 'Application' } },
      meters: { label: 'Meters', metadata: { type: 'Application' } },
      valves: { label: 'Valves', metadata: { type: 'Application' } },
      keeper: { label: 'Keeper', metadata: { type: 'Stakeholder' } },
    },
    edges: [
      { id: 'c1', source: 'north', target: 'scheduler', relation: 'Contains' },
      { id: 'c2', source: 'south', target: 'meters', relation: 'Contains' },
      { id: 'c3', source: 'south', target: 'valves', relation: 'Contains' },
      { id: 'r1', source: 'scheduler', target: 'valves', relation: 'Relation' },
      { id: 'r2', source: 'scheduler', target: 'meters', relation: 'Relation' },
      { id: 'r3', source: 'keeper', target: 'scheduler', relation: 'Relation' },
    ],
  },
};

const summary: ModelSummary = {
  id: modelId,
  name: 'Made-up irrigation plant',
  createdAt: '2026-11-01T10:00:00.000Z',
  createdBy: { id: 'u1', name: 'Sam Taylor' },
  nodeCount: 6,
  edgeCount: 6,
};

// On the canvas: Scheduler inside North wing, top right; Meters and Valves side by side inside
// South wing, below on the left. Cards are 168 by 44.
const layout: ViewCardLayout[] = [
  { elementId: 'north', x: 400, y: 0 },
  { elementId: 'scheduler', x: 500, y: 56 },
  { elementId: 'south', x: 0, y: 300 },
  { elementId: 'meters', x: 16, y: 356 },
  { elementId: 'valves', x: 216, y: 356 },
  { elementId: 'keeper', x: 800, y: 200 },
];
const valves = { x: 216, y: 356, width: 168, height: 44 };

// Scheduler to Valves, moved by hand: out of Scheduler's left side, across, down past South
// wing's right side, and across into Valves' right side.
const schedulerToValves = [
  { x: 500, y: 78 },
  { x: 450, y: 78 },
  { x: 450, y: 378 },
  { x: 384, y: 378 },
];

function plantView(routes: ViewLineRoute[]): StoredView {
  const author = { id: 'u1', name: 'Sam Taylor' };
  return {
    id: 'v-plant',
    name: 'Irrigation',
    version: 1,
    elementCount: 6,
    relationshipCount: 6,
    createdAt: '2026-11-05T09:00:00.000Z',
    createdBy: author,
    updatedAt: '2026-11-05T09:00:00.000Z',
    updatedBy: author,
    elementIds: ['north', 'south', 'scheduler', 'meters', 'valves', 'keeper'],
    relationshipIds: ['c1', 'c2', 'c3', 'r1', 'r2', 'r3'],
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
    if (url === `/api/models/${modelId}`) return Response.json(plant);
    if (url === `/api/models/${modelId}/views`) {
      return Response.json({ views: [{ ...view, elementIds: undefined, layout: undefined }] });
    }
    if (!url.startsWith(base)) return undefined;
    const parsed =
      typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : undefined;
    calls.push({ method, url, body: parsed });
    if (method === 'GET') return Response.json({ view });
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
const edgeOf = (label: RegExp) =>
  [...canvasEl().querySelectorAll<HTMLElement>('.react-flow__edge')].find((edge) =>
    label.test(edge.getAttribute('aria-label') ?? ''),
  );
const valvesLine = () => edgeOf(/^Scheduler .* Valves$/) as HTMLElement;
const gripsOf = (edge: HTMLElement) => [...edge.querySelectorAll<SVGPathElement>('.line-grip')];
const layoutSaves = (calls: Call[]) => calls.filter((call) => call.url.endsWith('/layout'));
const savedRoutes = (call: Call | undefined) => (call?.body?.routes ?? []) as ViewLineRoute[];

/** A line's last stretch as drawn: the corner it leaves (after rounding) and its end. */
function lastStretch(edge: HTMLElement) {
  const d = edge.querySelector('path.react-flow__edge-path')?.getAttribute('d') ?? '';
  const numbers = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  return {
    from: { x: numbers.at(-4) ?? NaN, y: numbers.at(-3) ?? NaN },
    end: { x: numbers.at(-2) ?? NaN, y: numbers.at(-1) ?? NaN },
  };
}

/** True when a line's last stretch runs into the box from outside, across one of its sides. */
function comesInFromOutside(stretch: ReturnType<typeof lastStretch>, box: typeof valves): boolean {
  const { from, end } = stretch;
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  if (from.y === end.y) {
    return (end.x === box.x && from.x < box.x) || (end.x === right && from.x > right);
  }
  return (end.y === box.y && from.y < box.y) || (end.y === bottom && from.y > bottom);
}

function zoom() {
  const viewport = canvasEl().querySelector<HTMLElement>('.react-flow__viewport');
  return Number(/scale\(([-\d.]+)\)/.exec(viewport?.style.transform ?? '')?.[1] ?? 1);
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

async function open(routes: ViewLineRoute[]) {
  const fake = server(plantView(routes));
  stubApi(modeller, fake.handler);
  renderAt(`/modelling/models/${modelId}/views/v-plant`);
  await waitFor(() => {
    expect(edgeOf(/^Scheduler .* Valves$/)).toBeDefined();
    expect(edgeOf(/^Scheduler .* Meters$/)).toBeDefined();
  });
  await steady();
  return fake;
}

describe('a line moved by hand between nested cards keeps its arrowhead', () => {
  it('opens with the stored route, coming into the target from outside', async () => {
    const { calls } = await open([{ relationshipId: 'r1', points: schedulerToValves }]);
    expect(lastStretch(valvesLine())).toEqual({
      from: { x: 450 - 8, y: 378 },
      end: { x: 384, y: 378 },
    });
    expect(comesInFromOutside(lastStretch(valvesLine()), valves)).toBe(true);
    expect(layoutSaves(calls)).toEqual([]);
  });

  it('dragged over the target card: the stretch stops beside it, and the end still comes in', async () => {
    const fake = await open([{ relationshipId: 'r1', points: schedulerToValves }]);
    const [upright] = gripsOf(valvesLine());
    // Dragged left, to above the middle of Valves: the line would come down into Valves' top and
    // run back out of its right side, its arrowhead under the card.
    const at = onScreen({ x: 450, y: 200 });
    const by = 150 * zoom();
    pointer(upright as SVGPathElement, 'pointerDown', at.x, at.y);
    pointer(upright as SVGPathElement, 'pointerMove', at.x - by, at.y);
    expect(comesInFromOutside(lastStretch(valvesLine()), valves)).toBe(true);
    pointer(upright as SVGPathElement, 'pointerUp', at.x - by, at.y);
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    // Held 8px out from Valves' right side, where the arrowhead shows.
    expect(savedRoutes(layoutSaves(fake.calls)[0])).toEqual([
      {
        relationshipId: 'r1',
        points: [
          { x: 500, y: 78 },
          { x: 392, y: 78 },
          { x: 392, y: 378 },
          { x: 384, y: 378 },
        ],
      },
    ]);
    expect(lastStretch(valvesLine()).end).toEqual({ x: 384, y: 378 });
    expect(comesInFromOutside(lastStretch(valvesLine()), valves)).toBe(true);
  });

  it('opens a stored route whose end ran back out of its card with the end coming in again', async () => {
    // As saved before: the stretch down lies over Valves, and the last one runs out of its side.
    const { calls } = await open([
      {
        relationshipId: 'r1',
        points: [
          { x: 500, y: 78 },
          { x: 300, y: 78 },
          { x: 300, y: 378 },
          { x: 384, y: 378 },
        ],
      },
    ]);
    expect(lastStretch(valvesLine()).end).toEqual({ x: 384, y: 378 });
    expect(comesInFromOutside(lastStretch(valvesLine()), valves)).toBe(true);
    // Drawn so, and saved so only with the person's next change.
    expect(layoutSaves(calls)).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('a line moved by hand from a Stakeholder keeps its end on the circle', () => {
  // Keeper is a Stakeholder: a circle 48 across at the top middle of its 120 by 70 box, so its
  // left edge is at x 836, y 224. Its line to Scheduler, moved by hand and saved: out of the
  // circle's left, across, up, and across into Scheduler's right side.
  const keeperToScheduler = [
    { x: 836, y: 224 },
    { x: 760, y: 224 },
    { x: 760, y: 78 },
    { x: 668, y: 78 },
  ];
  const keeperLine = () => edgeOf(/^Keeper .* Scheduler$/) as HTMLElement;
  const startOf = (edge: HTMLElement) => {
    const d = edge.querySelector('path.react-flow__edge-path')?.getAttribute('d') ?? '';
    const [x, y] = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    return { x, y };
  };

  it('opens a saved route ending on the circle drawn as saved, and saves nothing', async () => {
    const { calls } = await open([{ relationshipId: 'r3', points: keeperToScheduler }]);
    expect(startOf(keeperLine())).toEqual({ x: 836, y: 224 });
    expect(gripsOf(keeperLine()).map((grip) => grip.getAttribute('d'))).toEqual([
      'M760 224L760 78',
    ]);
    expect(layoutSaves(calls)).toEqual([]);
  });

  it('a drag towards the Stakeholder moves the stretch past the box, up to beside the circle', async () => {
    const fake = await open([{ relationshipId: 'r3', points: keeperToScheduler }]);
    const [upright] = gripsOf(keeperLine());
    const at = onScreen({ x: 760, y: 150 });
    // 60 to the right, to x 820: inside Keeper's box (from x 800), but clear of its circle.
    const by = 60 * zoom();
    pointer(upright as SVGPathElement, 'pointerDown', at.x, at.y);
    pointer(upright as SVGPathElement, 'pointerMove', at.x + by, at.y);
    pointer(upright as SVGPathElement, 'pointerUp', at.x + by, at.y);
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(1);
    });
    expect(savedRoutes(layoutSaves(fake.calls)[0])).toEqual([
      {
        relationshipId: 'r3',
        points: [
          { x: 836, y: 224 },
          { x: 820, y: 224 },
          { x: 820, y: 78 },
          { x: 668, y: 78 },
        ],
      },
    ]);
    expect(startOf(keeperLine())).toEqual({ x: 836, y: 224 });
    await screen.findByText('Saved');
    await steady();

    // Further, over the circle: it stops 8px beside the circle, and the end stays on it.
    const again = onScreen({ x: 820, y: 150 });
    pointer(upright as SVGPathElement, 'pointerDown', again.x, again.y);
    pointer(upright as SVGPathElement, 'pointerMove', again.x + 40 * zoom(), again.y);
    pointer(upright as SVGPathElement, 'pointerUp', again.x + 40 * zoom(), again.y);
    await waitFor(() => {
      expect(layoutSaves(fake.calls)).toHaveLength(2);
    });
    expect(savedRoutes(layoutSaves(fake.calls)[1])[0]?.points.slice(0, 2)).toEqual([
      { x: 836, y: 224 },
      { x: 828, y: 224 },
    ]);
    expect(startOf(keeperLine())).toEqual({ x: 836, y: 224 });
  });
});
