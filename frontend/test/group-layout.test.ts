import { buildModelGraph, type JgfDocument } from '@simplearchitecture/shared';
import ELK from 'elkjs/lib/elk.bundled.js';
import { describe, expect, it } from 'vitest';
import {
  absoluteBoxes,
  layoutCards,
  portId,
  type LayoutCard,
  type PlacedCard,
} from '../src/viewing/explorer/canvas/elkLayout';
import { floatingEnds, type EndBox } from '../src/viewing/explorer/canvas/edgeLine';
import { groupCards, groupMinSize } from '../src/viewing/explorer/canvas/groups';
import {
  crossesAny,
  groupBox,
  groupId,
  groupTextArea,
  isGroupId,
} from '../src/viewing/explorer/canvas/layoutGeometry';
import { keepCards } from '../src/viewing/explorer/canvas/placeCards';
import {
  arrangeCards,
  clampToContainer,
  fitContainers,
  pushedByContainer,
  type Box,
  type Point,
} from '../src/viewing/explorer/canvas/positions';
import { pointOfEnd } from '../src/viewing/explorer/canvas/straightLines';
import { layoutOfCanvas, storedGroupedPositions } from '../src/viewing/explorer/canvas/viewLayout';

// Group by's boxes in the layout, the fits and pushes, and a view's stored layout. Pure: no browser.
// Made-up data.

const billing = groupId('Billing');
const quay = groupId('Quay team');
const notSet = groupId(undefined);

const card = (
  id: string,
  x: number,
  y: number,
  parent?: string,
  width = 168,
  height = 44,
): PlacedCard => ({ id, x, y, width, height, handles: [], ...(parent ? { parent } : {}) });
const layout = (...cards: PlacedCard[]) => new Map(cards.map((each) => [each.id, each]));

const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x + groupBox.padding.left - 0.5 &&
  inner.y >= outer.y + groupBox.padding.top - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width - groupBox.padding.right + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height - groupBox.padding.bottom + 0.5;
const apart = (a: Box, b: Box) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

describe('group ids', () => {
  it('never take an element id, and tell Not set from a value', () => {
    expect(isGroupId(billing)).toBe(true);
    expect(isGroupId('Billing')).toBe(false);
    expect(notSet).not.toBe(groupId(''));
    expect(isGroupId(`\u0000block:${billing}`)).toBe(false);
  });
});

describe('grouping the cards', () => {
  const doc: JgfDocument = {
    graph: {
      nodes: {
        yard: { label: 'Yard', metadata: { type: 'Business', owningTeam: 'Quay team' } },
        gate: { label: 'Gate', metadata: { type: 'Infrastructure', owningTeam: 'Billing' } },
        ledger: { label: 'Ledger', metadata: { type: 'Application', owningTeam: 'Billing' } },
        clerk: { label: 'Clerk', metadata: { type: 'Stakeholder', owningTeam: 'Billing' } },
      },
      edges: [],
    },
  };
  const graph = buildModelGraph(doc);
  const ids = ['yard', 'gate', 'ledger', 'clerk'];

  it("puts top-level cards in their value's box, Not set last, and leaves nested cards to their container", () => {
    const nested = groupCards(graph, ids, new Map([['gate', 'yard']]), 'owningTeam');
    expect(nested.order).toEqual([billing, quay, notSet]);
    expect(nested.groupOf.get('gate')).toBeUndefined();
    expect(nested.members.get(quay)).toEqual(['yard']);
    // A Stakeholder has no Owning team: Not set, whatever its metadata says.
    expect(nested.members.get(notSet)).toEqual(['clerk']);
    const flat = groupCards(graph, ids, new Map(), 'owningTeam');
    expect(flat.members.get(billing)).toEqual(['gate', 'ledger']);
  });

  it('gives a box room for its header, from 200 to 400px', () => {
    expect(groupMinSize(10)).toEqual({ width: 200, height: 116 });
    expect(groupMinSize(250)).toEqual({ width: 274, height: 116 });
    expect(groupMinSize(1000)).toEqual({ width: 400, height: 116 });
  });
});

describe('the layout with group boxes', () => {
  const groups: LayoutCard[] = [
    { id: billing, width: 200, height: 116, shape: 'container', nameWidth: 90 },
    { id: quay, width: 200, height: 116, shape: 'container', nameWidth: 110 },
    { id: notSet, width: 200, height: 116, shape: 'container', nameWidth: 70 },
  ];
  const cards: LayoutCard[] = [
    ...groups,
    { id: 'clerk', width: 120, height: 70, shape: 'circle', parent: notSet },
    { id: 'ledger', width: 168, height: 44, parent: billing },
    { id: 'portal', width: 168, height: 44, parent: billing },
    { id: 'crane', width: 168, height: 44, parent: quay },
    { id: 'yard', width: 200, height: 116, shape: 'container', parent: quay, nameWidth: 40 },
    { id: 'gate', width: 168, height: 44, parent: 'yard' },
    { id: 'archive', width: 168, height: 44, parent: notSet },
    { id: 'shed', width: 168, height: 44, parent: quay },
  ];
  const links = [
    { id: 'l0', source: 'clerk', target: 'ledger' },
    { id: 'l1', source: 'portal', target: 'ledger' },
    { id: 'l2', source: 'ledger', target: 'crane' },
    { id: 'l3', source: 'crane', target: 'gate' },
    { id: 'l4', source: 'archive', target: 'portal' },
    { id: 'l5', source: 'archive', target: 'shed' },
  ];

  it('holds every card in its box, clear of the padding, with no boxes overlapping', async () => {
    const placed = await layoutCards(new ELK(), cards, links);
    const boxes = absoluteBoxes(placed);
    for (const each of cards) {
      if (each.parent === undefined || !isGroupId(each.parent)) continue;
      expect(inside(boxes.get(each.id) as Box, boxes.get(each.parent) as Box), each.id).toBe(true);
    }
    for (const a of groups) {
      for (const b of groups) {
        if (a !== b) expect(apart(boxes.get(a.id) as Box, boxes.get(b.id) as Box)).toBe(true);
      }
    }
  });

  it("routes no line across a header's value and count, nor through a box it doesn't use", async () => {
    const placed = await layoutCards(new ELK(), cards, links);
    const boxes = absoluteBoxes(placed);
    const handleAt = new Map<string, Point>();
    for (const each of placed.values()) {
      const box = boxes.get(each.id) as Box;
      for (const handle of each.handles) {
        handleAt.set(handle.id, pointOfEnd(box, handle.side, handle.offset));
      }
    }
    let routed = 0;
    for (const each of placed.values()) {
      const box = boxes.get(each.id) as Box;
      for (const handle of each.handles) {
        if (!handle.route) continue;
        const link = links.find((one) => portId(one.id, 'source') === handle.id);
        if (!link) continue;
        routed += 1;
        const line = [
          handleAt.get(handle.id) as Point,
          ...handle.route.bends.map((bend) => ({ x: bend.x + box.x, y: bend.y + box.y })),
          handleAt.get(portId(link.id, 'target')) as Point,
        ];
        const ownGroups = new Set(
          [link.source, link.target].map((id) => {
            let up = placed.get(id)?.parent;
            while (up !== undefined && !isGroupId(up)) up = placed.get(up)?.parent;
            return up;
          }),
        );
        for (const group of groups) {
          const groupBoxNow = boxes.get(group.id) as Box;
          const text = groupTextArea(groupBoxNow, group.nameWidth ?? 0);
          expect(crossesAny(line, [text]), `${link.id} over ${group.id}`).toBe(false);
          if (!ownGroups.has(group.id)) {
            expect(crossesAny(line, [groupBoxNow]), `${link.id} through ${group.id}`).toBe(false);
          }
        }
      }
    }
    expect(routed).toBeGreaterThan(3);
  });

  it('keeps lines without a route off a box they neither start nor end in, and off its header', () => {
    // Two cards in boxes side by side, a third box between them.
    const placed = layout(
      card(billing, 0, 0, undefined, 200, 116),
      card(quay, 260, 0, undefined, 200, 116),
      card(notSet, 520, 0, undefined, 200, 116),
      card('ledger', 16, 48, billing),
      card('crane', 16, 48, quay),
      card('archive', 16, 48, notSet),
    );
    const boxes = new Map<string, EndBox>();
    for (const [id, box] of absoluteBoxes(placed)) {
      const parent = placed.get(id)?.parent;
      boxes.set(id, {
        ...box,
        ...(parent ? { parent } : {}),
        ...(isGroupId(id) ? { headerWidth: 80 } : {}),
      });
    }
    const lines = floatingEnds([{ id: 'x', source: 'ledger', target: 'archive' }], boxes);
    const points = lines.get('x')?.points ?? [];
    expect(points.length).toBeGreaterThan(1);
    expect(crossesAny(points, [boxes.get(quay) as Box])).toBe(false);
    for (const id of [billing, notSet]) {
      expect(crossesAny(points, [groupTextArea(boxes.get(id) as Box, 80)])).toBe(false);
    }
  });

  it("keeps the boxes in the property's order where no line decides", async () => {
    const order = [groupId('Deprecate'), groupId('Current'), groupId('Target'), notSet];
    const placed = await layoutCards(
      new ELK(),
      [
        ...order.map((id): LayoutCard => ({ id, width: 200, height: 116, shape: 'container' })),
        // Sizes that would sort them otherwise.
        { id: 'a', width: 168, height: 44, parent: order[0] as string },
        { id: 'b', width: 400, height: 44, parent: order[1] as string },
        { id: 'c', width: 168, height: 120, parent: order[2] as string },
        { id: 'd', width: 300, height: 44, parent: order[3] as string },
      ],
      [],
    );
    const boxes = absoluteBoxes(placed);
    // In reading order: boxes side by side (their heights overlap) left to right, rows down.
    const read = [...order].sort((a, b) => {
      const [p, q] = [boxes.get(a) as Box, boxes.get(b) as Box];
      const sameRow = p.y < q.y + q.height && q.y < p.y + p.height;
      return sameRow ? p.x - q.x : p.y - q.y;
    });
    expect(read).toEqual(order);
  });
});

describe('moving in a group box', () => {
  const canvas = () =>
    layout(
      card(billing, 0, 0, undefined, 400, 200),
      card('ledger', 16, 48, billing),
      card('portal', 200, 48, billing),
      card(quay, 0, 260, undefined, 300, 140),
      card('crane', 16, 48, quay),
    );

  it('stops a card at the box padding, top and left', () => {
    expect(clampToContainer({ x: 0, y: 0 }, billing)).toEqual({ x: 16, y: 48 });
    expect(clampToContainer({ x: 0, y: 0 }, 'a container')).toEqual({ x: 16, y: 56 });
  });

  it('pushes the cards a moved card lands on down, within its box, and the box fits them', () => {
    const shown = arrangeCards(canvas(), new Map([['ledger', { x: 200, y: 60 }]]));
    const ledger = shown.get('ledger') as PlacedCard;
    const portal = shown.get('portal') as PlacedCard;
    expect(portal.y).toBeGreaterThanOrEqual(ledger.y + ledger.height + 12);
    expect(portal.parent).toBe(billing);
    const box = shown.get(billing) as PlacedCard;
    expect(box.height).toBeGreaterThanOrEqual(portal.y + portal.height + 16);
    // The other box doesn't move.
    expect(shown.get(quay)).toEqual(canvas().get(quay));
  });

  it('pushes the boxes a moved box lands on down, with their cards', () => {
    const shown = arrangeCards(canvas(), new Map([[quay, { x: 10, y: 20 }]]));
    const billingNow = shown.get(billing) as PlacedCard;
    const quayNow = shown.get(quay) as PlacedCard;
    expect(billingNow.y).toBeGreaterThanOrEqual(quayNow.y + quayNow.height);
    expect(shown.get('ledger')).toEqual(canvas().get('ledger'));
  });

  it('after a drop, a box that grew pushes the box it now covers down', () => {
    const before = canvas();
    const sizes = new Map(
      [...before].map(([id, each]) => [id, { width: each.width, height: each.height }]),
    );
    // The portal was dragged far down: Billing grew to 340px, over Quay team.
    const dropped = fitContainers(
      new Map([...before, ['portal', card('portal', 200, 280, billing)]]),
      [billing],
    );
    const pushed = pushedByContainer(dropped, 'portal', sizes);
    const billingNow = dropped.get(billing) as PlacedCard;
    expect(pushed.get(quay)?.y).toBeGreaterThanOrEqual(billingNow.y + billingNow.height);
    expect(pushed.has('ledger')).toBe(false);
  });
});

describe('cards that come, go or change box', () => {
  const sizeOf = (id: string, container: boolean) =>
    isGroupId(id) || container ? { width: 200, height: 116 } : { width: 168, height: 44 };

  it("puts a new card in its value's box: the box grows and pushes the box below down", () => {
    const previous = layout(
      card(billing, 0, 0, undefined, 400, 108),
      card('ledger', 16, 48, billing),
      card('portal', 216, 48, billing),
      card(quay, 0, 140, undefined, 200, 108),
      card('crane', 16, 48, quay),
    );
    const kept = keepCards({
      previous,
      previousContainers: new Set([billing, quay]),
      cards: [
        { id: billing },
        { id: quay },
        { id: 'ledger', parent: billing },
        { id: 'portal', parent: billing },
        { id: 'till', parent: billing },
        { id: 'crane', parent: quay },
      ],
      related: [],
      sizeOf,
      hints: new Map([['till', { at: { x: 100, y: 100 } }]]),
      centre: { x: 0, y: 0 },
    });
    const boxes = absoluteBoxes(kept.placed);
    expect(kept.placed.get('till')?.parent).toBe(billing);
    expect(inside(boxes.get('till') as Box, boxes.get(billing) as Box)).toBe(true);
    expect(apart(boxes.get(billing) as Box, boxes.get(quay) as Box)).toBe(true);
    // The cards already there stay.
    expect(kept.placed.get('ledger')).toMatchObject({ x: 16, y: 48 });
    expect(kept.placed.get('crane')).toMatchObject({ x: 16, y: 48 });
  });

  it('gives a new value a new box at a free spot, near the card', () => {
    const previous = layout(
      card(billing, 0, 0, undefined, 200, 108),
      card('ledger', 16, 48, billing),
    );
    const kept = keepCards({
      previous,
      previousContainers: new Set([billing]),
      cards: [
        { id: billing },
        { id: notSet },
        { id: 'ledger', parent: billing },
        { id: 'till', parent: notSet },
      ],
      related: [],
      sizeOf,
      hints: new Map([['till', { at: { x: 30, y: 60 } }]]),
      centre: { x: 0, y: 0 },
    });
    const boxes = absoluteBoxes(kept.placed);
    expect(kept.placed.get('till')?.parent).toBe(notSet);
    expect(inside(boxes.get('till') as Box, boxes.get(notSet) as Box)).toBe(true);
    expect(apart(boxes.get(billing) as Box, boxes.get(notSet) as Box)).toBe(true);
  });
});

describe("a grouped view's stored layout", () => {
  const canvas = layout(
    card(billing, 100, 100, undefined, 400, 200),
    card('ledger', 16, 48, billing),
    card(notSet, 600, 100, undefined, 300, 200),
    card('yard', 16, 48, notSet, 200, 116),
    card('gate', 16, 56, 'yard'),
  );

  it("names each card's box value (null for Not set), and stores no box", () => {
    expect(layoutOfCanvas(canvas, () => false, true)).toEqual([
      { elementId: 'ledger', x: 116, y: 148, group: 'Billing' },
      { elementId: 'yard', x: 616, y: 148, group: null },
      { elementId: 'gate', x: 632, y: 204, group: null },
    ]);
    expect(layoutOfCanvas(canvas, () => false)).toEqual([
      { elementId: 'ledger', x: 116, y: 148 },
      { elementId: 'yard', x: 616, y: 148 },
      { elementId: 'gate', x: 632, y: 204 },
    ]);
  });

  it('reads back a card only in the box it was saved in, and each box from its cards', () => {
    const stored = layoutOfCanvas(canvas, () => false, true);
    // The ledger's value changed since (it is in Not set now); the yard and the gate didn't.
    const now = new Map([
      ['ledger', notSet],
      ['yard', notSet],
      ['gate', notSet],
    ]);
    const positions = storedGroupedPositions(
      stored,
      (id) => now.get(id),
      new Map([[notSet, ['ledger', 'yard']]]),
    );
    expect(positions.has('ledger')).toBe(false);
    expect(positions.get('yard')).toEqual({ x: 616, y: 148 });
    expect(positions.get('gate')).toEqual({ x: 632, y: 204 });
    expect(positions.get(notSet)).toEqual({ x: 600, y: 100 });
    // Saved without grouping: nothing is read as grouped.
    const plain = layoutOfCanvas(canvas, () => false);
    expect(storedGroupedPositions(plain, (id) => now.get(id), new Map()).size).toBe(0);
  });
});
