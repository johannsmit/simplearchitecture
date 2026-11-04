import type { ModelRelationship } from '@simplearchitecture/shared';
import ELK from 'elkjs/lib/elk.bundled.js';
import { describe, expect, it } from 'vitest';
import {
  absoluteBoxes,
  layoutCards,
  portId,
  type LayoutCard,
  type LayoutLink,
  type PlacedCard,
} from '../src/viewing/explorer/canvas/elkLayout';
import { layoutLinks, mergeRelationships } from '../src/viewing/explorer/canvas/view';

// One-pass layout: what must hold on any model. Made-up data.

const elk = new ELK();

/** Seeded: containers with lines inside, cards linked to their own container, self-links, depth. */
function model(seed: number): { cards: LayoutCard[]; links: LayoutLink[] } {
  let state = seed;
  const next = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
  const int = (n: number) => Math.floor(next() * n);
  const cards: LayoutCard[] = [];
  const parents = new Map<string, string>();
  for (let i = 0; i < 40; i++) {
    const id = `c${i}`;
    if (i > 0 && next() < 0.45) parents.set(id, `c${int(i)}`);
    cards.push({ id, width: 170, height: 44, partition: int(5) });
  }
  const holders = new Set(parents.values());
  for (const card of cards) {
    const parent = parents.get(card.id);
    if (parent !== undefined) card.parent = parent;
    if (holders.has(card.id)) Object.assign(card, { shape: 'container', width: 200, height: 116 });
  }
  const links: LayoutLink[] = [];
  for (let k = 0; k < 70; k++) {
    const source = `c${int(40)}`;
    const roll = next();
    const up = parents.get(source);
    const target = roll < 0.1 && up !== undefined ? up : roll < 0.15 ? source : `c${int(40)}`;
    links.push({ id: `l${k}`, source, target });
  }
  return { cards, links };
}

const point = (box: { x: number; y: number; width: number; height: number }, handle: Handle) => {
  if (handle.side === 'left') return [box.x, box.y + handle.offset] as const;
  if (handle.side === 'right') return [box.x + box.width, box.y + handle.offset] as const;
  if (handle.side === 'top') return [box.x + handle.offset, box.y] as const;
  return [box.x + handle.offset, box.y + box.height] as const;
};
type Handle = PlacedCard['handles'][number];

describe('on any model', () => {
  it.each([11, 22, 33, 44, 55, 66])('holds its promises on seed %i', async (seed) => {
    const { cards, links } = model(seed);
    const placed = await layoutCards(elk, cards, links);

    // Every card, and nothing else: the hidden marks and blocks never come out.
    expect([...placed.keys()].sort()).toEqual(cards.map((card) => card.id).sort());
    for (const card of placed.values()) {
      expect(`${card.id}${card.parent ?? ''}`).not.toContain('\u0000');
      for (const handle of card.handles) expect(handle.id).toMatch(/^l\d+:[st]$/);
    }

    const boxes = absoluteBoxes(placed);
    const byId = new Map(cards.map((card) => [card.id, card]));
    const chain = (id: string) => {
      const ups = new Set<string>();
      for (let up = byId.get(id)?.parent; up !== undefined; up = byId.get(up)?.parent) ups.add(up);
      return ups;
    };
    const holders = new Set(cards.flatMap((card) => card.parent ?? []));

    // Nested cards stay inside their container.
    for (const card of cards) {
      if (card.parent === undefined) continue;
      const inner = boxes.get(card.id);
      const outer = boxes.get(card.parent);
      if (!inner || !outer) throw new Error('not placed');
      expect(inner.x).toBeGreaterThanOrEqual(outer.x);
      expect(inner.y).toBeGreaterThanOrEqual(outer.y);
      expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
      expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height + 0.5);
    }

    // The rows of types always hold at the top level.
    const top = cards.filter((card) => card.parent === undefined);
    for (const a of top) {
      for (const b of top) {
        if (a.partition >= b.partition) continue;
        const [upper, lower] = [boxes.get(a.id), boxes.get(b.id)];
        if (!upper || !lower) throw new Error('not placed');
        expect(upper.y + upper.height).toBeLessThanOrEqual(lower.y + 0.5);
      }
    }

    // Every line has a route, and no routed line runs over a card it isn't attached to.
    for (const link of links) {
      if (link.source === link.target) continue;
      const handle = placed
        .get(link.source)
        ?.handles.find((h) => h.id === portId(link.id, 'source'));
      const end = placed.get(link.target)?.handles.find((h) => h.id === portId(link.id, 'target'));
      const [from, to] = [boxes.get(link.source), boxes.get(link.target)];
      if (!handle?.route || !end || !from || !to) throw new Error(`no route for ${link.id}`);
      const line = [
        point(from, handle),
        ...handle.route.bends.map((bend) => [bend.x + from.x, bend.y + from.y] as const),
        point(to, end),
      ];
      const skip = new Set([
        link.source,
        link.target,
        ...chain(link.source),
        ...chain(link.target),
      ]);
      for (const [id, box] of boxes) {
        if (skip.has(id) || holders.has(id)) continue;
        if (chain(id).has(link.source) || chain(id).has(link.target)) continue;
        for (let i = 1; i < line.length; i++) {
          const [a, b] = [line[i - 1], line[i]];
          if (!a || !b) continue;
          for (let step = 0; step <= 30; step++) {
            const x = a[0] + ((b[0] - a[0]) * step) / 30;
            const y = a[1] + ((b[1] - a[1]) * step) / 30;
            const inside =
              x > box.x + 2 &&
              x < box.x + box.width - 2 &&
              y > box.y + 2 &&
              y < box.y + box.height - 2;
            expect(inside, `${link.id} over ${id}`).toBe(false);
          }
        }
      }
    }
  });

  it('fails rather than hangs when both tries throw, and tries exactly twice', async () => {
    let tries = 0;
    const broken = {
      layout: () => {
        tries += 1;
        return Promise.reject(new Error('made-up failure'));
      },
    };
    await expect(
      layoutCards(
        broken,
        [
          { id: 'a', width: 170, height: 44, partition: 1 },
          { id: 'b', width: 170, height: 44, partition: 2 },
        ],
        [{ id: 'l', source: 'a', target: 'b' }],
      ),
    ).rejects.toThrow('made-up failure');
    expect(tries).toBe(2);
  });
});

describe('one layout link per relationship', () => {
  const relationship = (
    id: string,
    source: string,
    target: string,
    extra: Partial<ModelRelationship> = {},
  ): ModelRelationship => ({
    id,
    source,
    target,
    type: 'Relation',
    architectureState: 'Current',
    metadata: {},
    ...extra,
  });
  const list = [
    relationship('held', 'box', 'a', { type: 'Contains' }),
    relationship('m1', 'a', 'b'),
    relationship('both', 'a', 'b', { twoWay: true }),
    relationship('m2', 'a', 'b'),
    relationship('two', 'a', 'b', { twoWay: true }),
    relationship('m3', 'a', 'b'),
  ];

  it('gives every drawn line the layout link of its first relationship', () => {
    const lines = mergeRelationships(list);
    const laid = layoutLinks(list, (r) => r.id !== 'held');
    const ids = new Set(laid.map((link) => link.id));
    const drawn = lines.filter((line) => line.type !== 'Contains');
    expect(drawn.map((line) => line.count)).toEqual([3, 2]);
    for (const line of drawn) {
      expect(ids.has(line.id), line.id).toBe(true);
      const link = laid.find((candidate) => candidate.id === line.id);
      expect([link?.source, link?.target]).toEqual([line.source, line.target]);
    }
    expect(laid).toHaveLength(5);
  });

  it('gives the layout the same input whatever a change of direction merges or splits', () => {
    const shape = (relationships: readonly ModelRelationship[]) =>
      layoutLinks(relationships, () => true);
    const ticked = list.map((r) => (r.id === 'm2' ? { ...r, twoWay: true } : r));
    expect(mergeRelationships(ticked).length).toBe(mergeRelationships(list).length);
    const splitting = list.map((r) => (r.twoWay === true ? { ...r, twoWay: false } : r));
    expect(mergeRelationships(splitting).length).toBe(mergeRelationships(list).length - 1);
    expect(shape(splitting)).toEqual(shape(list));
    expect(shape(ticked)).toEqual(shape(list));
  });

  it('routes the merged line, and keeps room for the others on real ELK', async () => {
    const cards: LayoutCard[] = [
      { id: 'a', width: 170, height: 44, partition: 1 },
      { id: 'b', width: 170, height: 44, partition: 2 },
    ];
    const relationships = [relationship('m1', 'a', 'b'), relationship('m2', 'a', 'b')];
    const [line] = mergeRelationships(relationships);
    const placed = await layoutCards(
      elk,
      cards,
      layoutLinks(relationships, () => true),
    );
    if (!line) throw new Error('no line');
    const handle = placed.get('a')?.handles.find((h) => h.id === portId(line.id, 'source'));
    expect(handle?.route).toBeDefined();
    expect(placed.get('a')?.handles).toHaveLength(2);
  });
});
