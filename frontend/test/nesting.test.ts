import ELK from 'elkjs/lib/elk.bundled.js';
import { describe, expect, it } from 'vitest';
import { edgeEnds } from '../src/metamodel-ui';
import { containerMinSize, isContainerNameCut } from '../src/viewing/explorer/canvas/cardSize';
import {
  absoluteBoxes,
  containerBox,
  layoutCards,
  portId,
  type LayoutCard,
  type PlacedCard,
} from '../src/viewing/explorer/canvas/elkLayout';
import {
  alignLayout,
  arrangeCards,
  clampToContainer,
} from '../src/viewing/explorer/canvas/positions';

import { cpuMs } from './helpers';

// Nesting on the canvas. Made-up data only.

const elk = new ELK();

const card = (id: string, extra: Partial<LayoutCard> = {}): LayoutCard => ({
  id,
  width: 168,
  height: 44,
  partition: 2,
  ...extra,
});
const container = (id: string, extra: Partial<LayoutCard> = {}): LayoutCard =>
  card(id, { width: 200, height: 116, shape: 'container', ...extra });

function inside(child: PlacedCard, parent: { width: number; height: number }) {
  const { padding } = containerBox;
  expect(child.x).toBeGreaterThanOrEqual(padding.left - 0.5);
  expect(child.y).toBeGreaterThanOrEqual(padding.top - 0.5);
  expect(child.x + child.width).toBeLessThanOrEqual(parent.width - padding.right + 0.5);
  expect(child.y + child.height).toBeLessThanOrEqual(parent.height - padding.bottom + 0.5);
}

const overlap = (a: PlacedCard, b: PlacedCard) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('nested layout', () => {
  it('lays cards out inside their container, parents first, positions relative to it', async () => {
    const placed = await layoutCards(
      elk,
      [
        card('a', { parent: 'box' }),
        container('box', { partition: 1 }),
        card('b', { parent: 'box' }),
        card('outside', { partition: 0 }),
      ],
      [{ id: 'l0', source: 'outside', target: 'a' }],
    );
    expect([...placed.keys()].indexOf('box')).toBeLessThan([...placed.keys()].indexOf('a'));
    const box = placed.get('box');
    const a = placed.get('a');
    const b = placed.get('b');
    if (!box || !a || !b) throw new Error('not placed');
    expect(a.parent).toBe('box');
    expect(box.parent).toBeUndefined();
    inside(a, box);
    inside(b, box);
    expect(overlap(a, b)).toBe(false);
    expect(box.width).toBeGreaterThanOrEqual(containerBox.minWidth);
    // The edge from outside gets a handle on the nested card, from ELK's port.
    expect(a.handles.map((h) => h.id)).toEqual([portId('l0', 'target')]);
    expect(placed.get('outside')?.handles.map((h) => h.id)).toEqual([portId('l0', 'source')]);
    // No handle on the container for a link that only passes through it.
    expect(box.handles).toEqual([]);
  });

  it('keeps 3 levels apart: each container holds the next, nothing covers a header', async () => {
    const placed = await layoutCards(
      elk,
      [
        container('l1'),
        container('l2', { parent: 'l1' }),
        container('l3', { parent: 'l2' }),
        card('leaf', { parent: 'l3' }),
        card('leaf2', { parent: 'l1' }),
      ],
      [],
    );
    for (const [childId, parentId] of [
      ['l2', 'l1'],
      ['l3', 'l2'],
      ['leaf', 'l3'],
      ['leaf2', 'l1'],
    ] as const) {
      const child = placed.get(childId);
      const parent = placed.get(parentId);
      if (!child || !parent) throw new Error('not placed');
      inside(child, parent);
    }
    const l2 = placed.get('l2');
    const leaf2 = placed.get('leaf2');
    if (!l2 || !leaf2) throw new Error('not placed');
    expect(overlap(l2, leaf2)).toBe(false);
    const absolute = absoluteBoxes(placed);
    expect(absolute.get('leaf')?.y).toBeGreaterThan((absolute.get('l1')?.y ?? 0) + 3 * 40);
  });

  it('packs many unrelated cards into a compact block, not one long column', async () => {
    const children = Array.from({ length: 8 }, (_, i) => card(`c${i}`, { parent: 'box' }));
    const placed = await layoutCards(elk, [container('box'), ...children], []);
    const box = placed.get('box');
    if (!box) throw new Error('not placed');
    const columns = new Set(children.map((c) => placed.get(c.id)?.x));
    expect(columns.size).toBeGreaterThan(1);
    expect(box.width).toBeGreaterThan(box.height * 0.8);
  });

  it('lays out about 300 cards with containers in reasonable time', async () => {
    const cards: LayoutCard[] = [];
    const links = [];
    for (let i = 0; i < 30; i++) {
      cards.push(container(`box${i}`, { partition: i % 5 }));
      for (let j = 0; j < 9; j++) cards.push(card(`c${i}-${j}`, { parent: `box${i}` }));
      if (i > 0) links.push({ id: `l${i}`, source: `c${i - 1}-0`, target: `c${i}-1` });
    }
    const start = cpuMs();
    const placed = await layoutCards(elk, cards, links);
    expect(placed.size).toBe(300);
    // A budget: how long a person waits matters here, and ELK's growth isn't ours to prove.
    expect(cpuMs() - start).toBeLessThan(3000);
  });
});

describe('one pass over every level', () => {
  const fits = (
    child: { x: number; y: number; width: number; height: number },
    parent: PlacedCard,
  ) =>
    child.x >= 0 &&
    child.y >= 0 &&
    child.x + child.width <= parent.width &&
    child.y + child.height <= parent.height;

  it('keeps a compact block next to the cards that have lines', async () => {
    const quiet = Array.from({ length: 8 }, (_, i) => card(`q${i}`, { parent: 'box' }));
    const placed = await layoutCards(
      elk,
      [container('box'), card('out', { partition: 0 }), card('lined', { parent: 'box' }), ...quiet],
      [{ id: 'l0', source: 'out', target: 'lined' }],
    );
    const box = placed.get('box');
    if (!box) throw new Error('not placed');
    for (const { id } of [...quiet, card('lined')]) {
      const at = placed.get(id);
      if (!at) throw new Error('not placed');
      expect(at.parent).toBe('box');
      inside(at, box);
    }
    expect(new Set(quiet.map((c) => placed.get(c.id)?.y)).size).toBeGreaterThan(1);
    expect(new Set(quiet.map((c) => placed.get(c.id)?.x)).size).toBeGreaterThan(1);
    expect(box.width).toBeLessThan(1000);
    const lined = placed.get('lined') as PlacedCard;
    for (const { id } of quiet) expect(overlap(lined, placed.get(id) as PlacedCard)).toBe(false);
  });

  it('packs a container with no lines in it, and keeps it one card with a line of its own', async () => {
    const placed = await layoutCards(
      elk,
      [
        container('box'),
        container('inner', { parent: 'box' }),
        card('deep', { parent: 'inner' }),
        card('sibling', { parent: 'box' }),
        card('other', { partition: 0 }),
      ],
      [{ id: 'l0', source: 'other', target: 'box' }],
    );
    const absolute = absoluteBoxes(placed);
    expect(placed.get('deep')?.parent).toBe('inner');
    expect(placed.get('inner')?.parent).toBe('box');
    inside(placed.get('deep') as PlacedCard, placed.get('inner') as PlacedCard);
    inside(placed.get('inner') as PlacedCard, placed.get('box') as PlacedCard);
    expect(placed.get('box')?.handles.map((h) => h.id)).toEqual([portId('l0', 'target')]);
    expect(absolute.get('deep')?.y).toBeGreaterThan(absolute.get('inner')?.y ?? 0);
  });

  it('keeps the rows inside a container, also against a line pointing up', async () => {
    const placed = await layoutCards(
      elk,
      [
        container('box'),
        card('top', { parent: 'box', partition: 0 }),
        card('mid', { parent: 'box', partition: 1 }),
        card('low', { parent: 'box', partition: 3 }),
        card('out', { partition: 4 }),
      ],
      [
        { id: 'up', source: 'low', target: 'top' },
        { id: 'in', source: 'out', target: 'mid' },
        { id: 'in2', source: 'out', target: 'low' },
      ],
    );
    const y = (id: string) => placed.get(id)?.y ?? 0;
    expect(y('top')).toBeLessThan(y('mid'));
    expect(y('mid')).toBeLessThan(y('low'));
    // What holds the rows is ELK's only: no card, and no handle, comes of it.
    expect([...placed.keys()].sort()).toEqual(['box', 'low', 'mid', 'out', 'top']);
    for (const placedCard of placed.values()) {
      expect(placedCard.handles.every((h) => /^(up|in|in2):[st]$/.test(h.id))).toBe(true);
    }
  });

  it('lays out a model on which ELK’s usual cycle breaking throws', async () => {
    let seed = 3;
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const ids = Array.from({ length: 80 }, (_, i) => `n${i}`);
    const parents = new Map<string, string>();
    for (let i = 0; parents.size < 24 && i < 72;) {
      const size = 2 + Math.floor(next() * 5);
      for (let j = 1; j <= size; j++) parents.set(ids[i + j] as string, ids[i] as string);
      i += size + 1 + Math.floor(next() * 5);
    }
    const holders = new Set(parents.values());
    const cards = ids.map((id) => {
      const partition = Math.floor(next() * 5);
      const parent = parents.get(id);
      return holders.has(id)
        ? container(id, { partition, ...(parent ? { parent } : {}) })
        : card(id, { partition, ...(parent ? { parent } : {}) });
    });
    const links = [];
    while (links.length < 150) {
      const source = ids[Math.floor(next() * 80)] as string;
      const target = ids[Math.floor(next() * 80)] as string;
      if (source !== target) links.push({ id: `l${links.length}`, source, target });
    }
    const throwing = new ELK();
    // The point of this test: the usual settings do throw here.
    await expect(
      layoutCards(
        {
          layout: (graph) =>
            graph.layoutOptions?.['elk.layered.cycleBreaking.strategy'] === undefined
              ? throwing.layout(graph)
              : Promise.reject(new Error('no second try')),
        },
        cards,
        links,
      ),
    ).rejects.toThrow();
    const placed = await layoutCards(elk, cards, links);
    expect(placed.size).toBe(80);
    for (const link of links) {
      const source = placed.get(link.source);
      expect(source?.handles.find((h) => h.id === portId(link.id, 'source'))?.route).toBeDefined();
    }
  });

  it('copes with a line from a card to its own container, and on a nested card to itself', async () => {
    const placed = await layoutCards(
      elk,
      [container('box'), container('sub', { parent: 'box' }), card('a', { parent: 'sub' })],
      [
        { id: 'up', source: 'a', target: 'box' },
        { id: 'down', source: 'box', target: 'a' },
        { id: 'loop', source: 'a', target: 'a' },
        { id: 'chain', source: 'sub', target: 'box' },
      ],
    );
    const a = placed.get('a');
    if (!a) throw new Error('not placed');
    inside(a, placed.get('sub') as PlacedCard);
    for (const id of ['up', 'loop']) {
      expect(a.handles.find((h) => h.id === portId(id, 'source'))?.route).toBeDefined();
    }
    expect(fits(a, placed.get('sub') as PlacedCard)).toBe(true);
  });
});

describe('container sizes', () => {
  it('is at least 200 × 116, wide enough for its name up to 280px', () => {
    expect(containerMinSize({ name: 'Shop', focused: false, userIcon: false })).toEqual({
      width: 200,
      height: 116,
    });
    const long = 'A very long container name that never fits on one line in a header';
    expect(containerMinSize({ name: long, focused: false, userIcon: false }).width).toBe(280);
    expect(isContainerNameCut({ name: long, focused: false, userIcon: false })).toBe(true);
    expect(isContainerNameCut({ name: 'Shop', focused: true, userIcon: true })).toBe(false);
  });
});

describe('moving cards inside a container', () => {
  const parent: PlacedCard = { id: 'box', x: 100, y: 100, width: 400, height: 200, handles: [] };
  const child: PlacedCard = {
    id: 'a',
    x: 16,
    y: 56,
    width: 168,
    height: 44,
    handles: [],
    parent: 'box',
  };

  it('keeps a card within the content area, under the header', () => {
    expect(clampToContainer({ x: -50, y: 0 }, child, parent)).toEqual({ x: 16, y: 56 });
    expect(clampToContainer({ x: 900, y: 900 }, child, parent)).toEqual({
      x: 400 - 16 - 168,
      y: 200 - 16 - 44,
    });
    expect(clampToContainer({ x: 50, y: 70 }, child, parent)).toEqual({ x: 50, y: 70 });
  });

  it('moves a nested card relative to its container, clamped; the container stays put', () => {
    const placed = new Map([
      ['box', parent],
      ['a', child],
    ]);
    const shown = arrangeCards(placed, new Map([['a', { x: 1000, y: 60 }]]));
    expect(shown.get('a')).toMatchObject({ x: 216, y: 60, parent: 'box' });
    expect(shown.get('box')).toBe(parent);
    // Dragging the container moves it only: its cards stay where they are inside it.
    const moved = arrangeCards(placed, new Map([['box', { x: 300, y: 300 }]]));
    expect(moved.get('a')).toBe(child);
    expect(absoluteBoxes(moved).get('a')).toMatchObject({ x: 316, y: 356 });
  });

  it('aligns a new layout on a nested focused card, shifting only the top level', () => {
    const before = new Map([
      ['box', parent],
      ['a', child],
    ]);
    const after = new Map([
      ['box', { ...parent, x: 0, y: 0 }],
      ['a', child],
    ]);
    const aligned = alignLayout(before, after, 'a');
    expect(aligned.get('box')).toMatchObject({ x: 100, y: 100 });
    expect(aligned.get('a')).toMatchObject({ x: 16, y: 56 });
  });
});

describe('Contains as a line', () => {
  it('has a diamond at the container and no arrowhead; other types an arrowhead', () => {
    expect(edgeEnds('Contains')).toEqual({ start: 'diamond', end: 'none' });
    expect(edgeEnds('Relation')).toEqual({ start: 'none', end: 'arrow' });
  });
});
