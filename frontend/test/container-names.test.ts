import { buildModelGraph, containsType, type JgfDocument } from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';
import { endBoxesOf } from '../src/viewing/explorer/canvas/canvasCards';
import type { Laid } from '../src/viewing/explorer/canvas/canvasModel';
import { containerNameWidth } from '../src/viewing/explorer/canvas/cardSize';
import type { PlacedCard } from '../src/viewing/explorer/canvas/elkLayout';
import { laidForCanvas, nameArea } from '../src/viewing/explorer/canvas/laidRoutes';
import { fitContainers } from '../src/viewing/explorer/canvas/positions';
import {
  add,
  canvasOf,
  crossesBox,
  longNamesModel,
  madeUpSets,
  measure,
  measureModel,
  noMeasures,
} from './layoutMeasures';

// Lines into a container come in beside or under its name, never across it, in an automatic layout.
// Made-up data.

/** Three desks above a platform, each with a line to the engine inside it. */
const desks: JgfDocument = {
  graph: {
    label: 'Made-up desks',
    directed: true,
    nodes: {
      b1: { label: 'Claims Desk', metadata: { type: 'Business' } },
      b2: { label: 'Billing Desk', metadata: { type: 'Business' } },
      b3: { label: 'Broker Desk', metadata: { type: 'Business' } },
      k: { label: 'Policy Platform', metadata: { type: 'Application' } },
      a1: { label: 'Policy Engine', metadata: { type: 'Application' } },
      a2: { label: 'Quotes', metadata: { type: 'Application' } },
    },
    edges: [
      { id: 'holds', source: 'k', target: 'a1', relation: containsType },
      { id: 'holds2', source: 'k', target: 'a2', relation: containsType },
      { id: 'r1', source: 'b1', target: 'a1', relation: 'Relation' },
      { id: 'r2', source: 'b2', target: 'a1', relation: 'Relation' },
      { id: 'r3', source: 'b3', target: 'a1', relation: 'Relation' },
      { id: 'r4', source: 'b2', target: 'a2', relation: 'Relation' },
      { id: 'r5', source: 'k', target: 'a2', relation: 'Relation' },
    ],
  },
};

describe('a line into a container', () => {
  it('comes in beside or under its name, on a fixed model', async () => {
    const graph = buildModelGraph(desks);
    const canvas = await canvasOf(graph, 'a1', 1);
    expect(canvas.containers).toEqual(new Set(['k']));
    const name = canvas.names.get('k');
    if (!name) throw new Error('no name');
    // No line crosses the name, and every line is on the layout's route.
    for (const line of canvas.lines) {
      const across = line.points.some((point, index) => {
        const before = line.points[index - 1];
        return before !== undefined && crossesBox(before, point, name);
      });
      expect(across, `${line.source} → ${line.target}`).toBe(false);
    }
    expect(canvas.lines.filter((line) => line.routed !== true)).toEqual([]);
    expect(measure(canvas).overCards).toBe(0);
  });

  it.each([
    ['hub', 1],
    ['hub', 2],
    ['r', 2],
    ['wide', 1],
  ] as const)(
    'comes in beside or under a long name, wider than the header’s smallest width (%s, depth %i)',
    async (focus, depth) => {
      const graph = buildModelGraph(longNamesModel().document);
      const canvas = await canvasOf(graph, focus, depth);
      expect(canvas.names.size).toBeGreaterThan(0);
      for (const [id, name] of canvas.names) {
        for (const line of canvas.lines) {
          const across = line.points.some((point, index) => {
            const before = line.points[index - 1];
            return before !== undefined && crossesBox(before, point, name);
          });
          expect(across, `${line.source} → ${line.target} across ${id}`).toBe(false);
        }
      }
      expect(measure(canvas).overCards).toBe(0);
    },
  );

  it('keeps its route on the canvas: the containers already fit what they hold', async () => {
    for (const model of [...madeUpSets.moderate(), ...madeUpSets.fuzzed(3)]) {
      const graph = buildModelGraph(model.document);
      const canvas = await canvasOf(graph, graph.relationships[0]?.target ?? '', 2);
      const again = fitContainers(canvas.laid, canvas.containers, {
        minSizeOf: canvas.minSizeOf,
      });
      for (const [id, card] of canvas.laid) {
        const now = again.get(id);
        expect([now?.x, now?.y, now?.width, now?.height], id).toEqual([
          card.x,
          card.y,
          card.width,
          card.height,
        ]);
      }
    }
  });
});

describe('laidForCanvas', () => {
  // ELK's answer: a container with room left under and beside its card, and a line from a card
  // above straight down to the card inside, through the container's header.
  const elkAnswer = (): Map<string, PlacedCard> =>
    new Map<string, PlacedCard>([
      [
        'above',
        {
          id: 'above',
          x: 120,
          y: 0,
          width: 168,
          height: 44,
          handles: [
            {
              id: 'l0:s',
              kind: 'source',
              side: 'bottom',
              offset: 84,
              route: { bends: [], target: { x: -80, y: 196 } },
            },
          ],
        },
      ],
      ['box', { id: 'box', x: 0, y: 140, width: 300, height: 260, handles: [] }],
      [
        'inner',
        {
          id: 'inner',
          x: 40,
          y: 56,
          parent: 'box',
          width: 168,
          height: 44,
          handles: [{ id: 'l0:t', kind: 'target', side: 'top', offset: 164 }],
        },
      ],
    ]);

  it('fits the container, and the line keeps a route that comes in beside its name', () => {
    const result = laidForCanvas(elkAnswer(), {
      minSizeOf: () => ({ width: 240, height: 116 }),
      nameWidthOf: () => 180,
    });
    const box = result.get('box');
    const inner = result.get('inner');
    const route = result.get('above')?.handles[0]?.route;
    if (!box || !inner || !route) throw new Error('missing');
    // Fitted as the canvas fits it: the corner stays, the card moves left to the padding.
    expect([box.x, box.y, box.width, box.height]).toEqual([0, 140, 240, 116]);
    expect([inner.x, inner.y]).toEqual([16, 56]);
    expect(route.target).toEqual({ x: 16 - 120, y: 196 });
    const line = [
      { x: 204, y: 44 },
      ...route.bends.map((bend) => ({ x: bend.x + 120, y: bend.y })),
      { x: 16 + 164, y: 196 },
    ];
    const name = nameArea(box, 180);
    for (let index = 1; index < line.length; index++) {
      const [a, b] = [line[index - 1], line[index]];
      if (!a || !b) continue;
      expect(a.x === b.x || a.y === b.y, `stretch ${String(index)} right-angled`).toBe(true);
      expect(crossesBox(a, b, name), `stretch ${String(index)} across the name`).toBe(false);
    }
    // It turns to the card under the header, with room for the arrowhead.
    const [last, beforeLast] = [line[line.length - 1], line[line.length - 2]];
    expect(beforeLast?.y).toBeGreaterThan(box.y + 40);
    expect((last?.y ?? 0) - (beforeLast?.y ?? 0)).toBeGreaterThanOrEqual(8);
  });

  it('changes nothing in a layout whose containers already fit and whose lines are clear', () => {
    const answer = elkAnswer();
    const once = laidForCanvas(answer, { minSizeOf: () => ({ width: 240, height: 116 }) });
    const twice = laidForCanvas(once, { minSizeOf: () => ({ width: 240, height: 116 }) });
    expect(twice).toEqual(once);
  });
});

describe('on the made-up models', () => {
  it('at most one container name in ten has a line across it, and no card covers another', async () => {
    const total = noMeasures();
    for (const model of [...madeUpSets.moderate(), ...madeUpSets.fuzzed(6)]) {
      add(total, await measureModel(model, [1]));
    }
    expect(total.containers).toBeGreaterThan(40);
    expect(total.crossedNames / total.containers).toBeLessThanOrEqual(0.1);
    expect(total.overlaps).toBe(0);
  });
});

describe('the ends of lines without a route', () => {
  it('know how wide each container’s name is drawn, so a line may cross its header beside it', () => {
    const graph = buildModelGraph(desks);
    const absolute = new Map([
      ['b1', { x: 0, y: 0, width: 168, height: 44 }],
      ['k', { x: 0, y: 200, width: 400, height: 116 }],
      ['a1', { x: 16, y: 256, width: 168, height: 44 }],
    ]);
    const shown = new Map([['a1', { parent: 'k' } as PlacedCard]]);
    const laid = { containers: new Set(['k']), hood: { focusId: 'b1' } } as unknown as Laid;
    const boxes = endBoxesOf(absolute, graph, laid, shown, new Map());
    expect(boxes.get('k')?.headerWidth).toBe(
      containerNameWidth({ name: 'Policy Platform', focused: false, userIcon: false }),
    );
    expect(boxes.get('a1')?.headerWidth).toBeUndefined();
    expect(boxes.get('b1')?.headerWidth).toBeUndefined();
  });
});
