import {
  buildModelGraph,
  containsType,
  neighbourhood,
  nodeTypeDefinitions,
  nodeTypes,
  withContainers,
  type JgfDocument,
  type ModelGraph,
  type NodeType,
} from '@simplearchitecture/shared';
import ELK from 'elkjs/lib/elk.bundled.js';
import { cardShape } from '../src/metamodel-ui';
import {
  cardHeightAt,
  cardSize,
  containerMinSize,
  containerNameWidth,
  textWidth,
} from '../src/viewing/explorer/canvas/cardSize';
import { currentBends, floatingEnds, type EndBox } from '../src/viewing/explorer/canvas/edgeLine';
import {
  absoluteBoxes,
  containerBox,
  layoutCards,
  portId,
  type LayoutCard,
  type PlacedCard,
  type Side,
} from '../src/viewing/explorer/canvas/elkLayout';
import { laidLine } from '../src/viewing/explorer/canvas/lineRoutes';
import { fitContainers, type Box, type Point } from '../src/viewing/explorer/canvas/positions';
import { layoutLinks, mergeRelationships } from '../src/viewing/explorer/canvas/view';
import { nestingParents } from '../src/viewing/explorer/views';

/**
 * Measures of an automatic layout as the canvas draws it, on made-up models: how many container
 * names a line runs across, lines over cards they aren't attached to, crossings, the widest and
 * tallest container, and (as information only, since the layout keeps no such rows) cards out of
 * rows by element type. The canvas's own steps are repeated here: the neighbourhood with its
 * containers, nesting, card sizes, ELK, containers fitted, and each line on ELK's route while it
 * holds, else on its floating ends.
 */

/** A seeded random number generator (an LCG), so a model is the same on every run. */
export function seeded(seed: number) {
  let state = seed >>> 0;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
  return { next, int: (n: number) => Math.floor(next() * n) };
}

const words = [
  'Claims',
  'Billing',
  'Ledger',
  'Portal',
  'Gateway',
  'Policy',
  'Customer',
  'Payments',
  'Archive',
  'Search',
  'Pricing',
  'Quotes',
  'Identity',
  'Reporting',
  'Documents',
  'Broker',
  'Scheduler',
  'Notifications',
  'Underwriting',
  'Analytics',
];

export interface MadeUpModel {
  name: string;
  document: JgfDocument;
  /** Widths set by hand, by element id (rectangle cards only, as on the canvas). */
  widths?: ReadonlyMap<string, number>;
}

/**
 * A made-up model: `elements` elements of every type, some of them containers with nested
 * elements (to `depth` levels), and `relations` Relations, a few elements being hubs.
 */
export function madeUpModel(options: {
  seed: number;
  elements: number;
  relations: number;
  /** Share of elements inside a container. */
  nested?: number;
  /** Containers get long names (6 to 10 words), wider than a container's smallest width. */
  longNames?: boolean;
  name?: string;
}): MadeUpModel {
  const random = seeded(options.seed);
  const nodes: Record<string, { label: string; metadata: { type: NodeType } }> = {};
  const ids: string[] = [];
  const typeOf = new Map<string, NodeType>();
  for (let i = 0; i < options.elements; i++) {
    const id = `e${i}`;
    // Fewer Stakeholders and Others, as in a typical landscape.
    const roll = random.next();
    const type: NodeType =
      roll < 0.06
        ? 'Stakeholder'
        : roll < 0.3
          ? 'Business'
          : roll < 0.7
            ? 'Application'
            : roll < 0.93
              ? 'Infrastructure'
              : 'Other';
    const count = 1 + random.int(3);
    const label = Array.from({ length: count }, () => words[random.int(words.length)]).join(' ');
    nodes[id] = { label: `${label} ${i}`, metadata: { type } };
    ids.push(id);
    typeOf.set(id, type);
  }
  const edges: JgfDocument['graph']['edges'] = [];
  // Containers: about one in ten elements (not Stakeholders), holding 1 to 8 elements each.
  const nestedShare = options.nested ?? 0.3;
  const containers = ids.filter((id) => typeOf.get(id) !== 'Stakeholder' && random.next() < 0.1);
  if (options.longNames) {
    for (const id of containers) {
      const count = 6 + random.int(5);
      const label = Array.from({ length: count }, () => words[random.int(words.length)]);
      const node = nodes[id];
      if (node) node.label = `${label.join(' ')} ${id.slice(1)}`;
    }
  }
  const parentOf = new Map<string, string>();
  for (const id of ids) {
    if (containers.length === 0 || random.next() >= nestedShare) continue;
    const container = containers[random.int(containers.length)] as string;
    if (container === id) continue;
    // No loops: the container may not be inside this element.
    let loop = false;
    for (let up: string | undefined = container; up !== undefined; up = parentOf.get(up)) {
      if (up === id) loop = true;
    }
    if (loop) continue;
    parentOf.set(id, container);
    edges.push({ id: `k${id}`, source: container, target: id, relation: containsType });
  }
  // Relations: a few hubs take more.
  const weight = ids.map(() => (random.next() < 0.05 ? 12 : 1));
  const total = weight.reduce((a, b) => a + b, 0);
  const pick = () => {
    let at = random.next() * total;
    for (let i = 0; i < ids.length; i++) {
      at -= weight[i] as number;
      if (at < 0) return ids[i] as string;
    }
    return ids[ids.length - 1] as string;
  };
  for (let k = 0; k < options.relations; k++) {
    const source = pick();
    let target = pick();
    if (target === source) target = ids[random.int(ids.length)] as string;
    if (target === source) continue;
    edges.push({ id: `r${k}`, source, target, relation: 'Relation' });
  }
  return {
    name: options.name ?? `seed ${options.seed}`,
    document: { graph: { label: 'Made-up model', directed: true, nodes, edges } },
  };
}

/** Five focus elements, as QA picks them: the hub, a typical one, a container, a nested one, a quiet one. */
export function focusElements(graph: ModelGraph): string[] {
  const byDegree = [...graph.elements.keys()]
    .map((id) => ({ id, degree: graph.relationshipsByElement.get(id)?.length ?? 0 }))
    .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));
  const holders = new Set<string>();
  const held = new Set<string>();
  for (const relationship of graph.relationships) {
    if (relationship.type !== containsType) continue;
    holders.add(relationship.source);
    held.add(relationship.target);
  }
  const picks = [
    byDegree[0]?.id,
    byDegree[Math.floor(byDegree.length / 2)]?.id,
    byDegree.find((each) => holders.has(each.id))?.id,
    byDegree.find((each) => held.has(each.id) && !holders.has(each.id))?.id,
    byDegree.find((each) => each.degree === 2)?.id,
  ];
  return [...new Set(picks.filter((id): id is string => id !== undefined))];
}

export interface Canvas {
  /** The cards as the layout gave them, before the canvas fits its containers. */
  laid: Map<string, PlacedCard>;
  cards: Map<string, PlacedCard>;
  boxes: Map<string, Box>;
  containers: Set<string>;
  parents: Map<string, string>;
  partition: Map<string, number>;
  /** Every drawn line, as points on the canvas. */
  lines: { id: string; source: string; target: string; points: Point[]; routed?: boolean }[];
  /** Container id → its name's box on the canvas. */
  names: Map<string, Box>;
  /** A container's smallest size, as the canvas gives it. */
  minSizeOf: (id: string) => { width: number; height: number };
}

const elk = new ELK();

/**
 * The canvas the explorer draws for a focus element at a depth, with nesting on. `widths` are
 * widths set by hand, kept by the layout as Tidy up keeps them.
 */
export async function canvasOf(
  graph: ModelGraph,
  focusId: string,
  depth: number,
  widths: ReadonlyMap<string, number> = new Map(),
): Promise<Canvas> {
  const hood = withContainers(graph, neighbourhood(graph, focusId, { depth }));
  const wanted = nestingParents(graph, hood);
  const containers = new Set(wanted.values());
  const ids = [...hood.hops.keys()].filter((id) => graph.elements.has(id));
  const minOf = (id: string) => {
    const element = graph.elements.get(id);
    return containerMinSize({
      name: element?.name ?? '',
      focused: id === focusId,
      userIcon: element !== undefined && nodeTypeDefinitions[element.type].icon === 'user',
    });
  };
  const partition = new Map<string, number>();
  const cards = ids.map((id): LayoutCard => {
    const element = graph.elements.get(id);
    const parent = wanted.get(id);
    const container = containers.has(id);
    const shape = container ? ('container' as const) : element ? cardShape(element.type) : 'card';
    // Information only: the layout no longer keeps rows by element type.
    partition.set(id, element ? nodeTypes.indexOf(element.type) : 0);
    const name = element?.name ?? '';
    const set = container || shape !== 'card' ? undefined : widths.get(id);
    return {
      id,
      ...(container
        ? minOf(id)
        : set !== undefined
          ? { width: set, height: cardHeightAt({ name, focused: id === focusId }, set) }
          : cardSize({ name, focused: id === focusId, shape: shape as 'card' })),
      shape,
      ...(parent === undefined ? {} : { parent }),
      ...(container && element
        ? {
            nameWidth: containerNameWidth({
              name: element.name,
              focused: id === focusId,
              userIcon: nodeTypeDefinitions[element.type].icon === 'user',
            }),
          }
        : {}),
    };
  });
  const nested = (link: { type: string; source: string; target: string }) =>
    link.type === containsType && wanted.get(link.target) === link.source;
  const laidOut = layoutLinks(hood.relationships, (relationship) => !nested(relationship));
  const byElk = await layoutCards(elk, cards, laidOut);
  const sizes = new Map(
    [...byElk.values()].map((c) => [c.id, { width: c.width, height: c.height }]),
  );
  const placed = fitContainers(byElk, containers, { minSizeOf: minOf });
  const boxes = absoluteBoxes(placed);
  const endBoxes = new Map<string, EndBox>();
  for (const [id, box] of boxes) {
    const element = graph.elements.get(id);
    const circle =
      !containers.has(id) && element !== undefined && cardShape(element.type) === 'circle';
    const parent = placed.get(id)?.parent;
    endBoxes.set(id, {
      ...box,
      ...(circle ? { circle } : {}),
      ...(parent === undefined ? {} : { parent }),
    });
  }
  const drawn = mergeRelationships(hood.relationships).filter((link) => !nested(link));
  const lines: Canvas['lines'] = [];
  const routed = new Set<string>();
  const sameSize = (id: string) => {
    const before = sizes.get(id);
    const now = placed.get(id);
    return before !== undefined && now?.width === before.width && now.height === before.height;
  };
  for (const link of drawn) {
    if (!sameSize(link.source) || !sameSize(link.target)) continue;
    const handle = placed
      .get(link.source)
      ?.handles.find((each) => each.id === portId(link.id, 'source'));
    const bends = currentBends(handle?.route, boxes.get(link.source), boxes.get(link.target));
    const source = endBoxes.get(link.source);
    const target = endBoxes.get(link.target);
    if (!bends || !source || !target) continue;
    const points = laidLine(
      bends,
      {
        handles: placed.get(link.source)?.handles ?? [],
        box: source,
        port: portId(link.id, 'source'),
      },
      {
        handles: placed.get(link.target)?.handles ?? [],
        box: target,
        port: portId(link.id, 'target'),
      },
    );
    if (!points) continue;
    routed.add(link.id);
    lines.push({ id: link.id, source: link.source, target: link.target, points, routed: true });
  }
  const taken = new Map<string, { side: Side; offset: number }[]>();
  for (const link of drawn) {
    if (!routed.has(link.id)) continue;
    for (const [card, end] of [
      [link.source, 'source'],
      [link.target, 'target'],
    ] as const) {
      const handle = placed.get(card)?.handles.find((h) => h.id === portId(link.id, end));
      if (handle) taken.set(card, [...(taken.get(card) ?? []), handle]);
    }
  }
  const floating = floatingEnds(
    drawn.filter((link) => !routed.has(link.id)),
    endBoxes,
    taken,
  );
  for (const link of drawn) {
    const line = floating.get(link.id);
    if (!line) continue;
    lines.push({ id: link.id, source: link.source, target: link.target, points: line.points });
  }
  const names = new Map<string, Box>();
  for (const id of containers) {
    const box = boxes.get(id);
    const element = graph.elements.get(id);
    if (!box || !element) continue;
    names.set(
      id,
      nameBox(box, element.name, id === focusId, nodeTypeDefinitions[element.type].icon === 'user'),
    );
  }
  return {
    laid: byElk,
    cards: placed,
    boxes,
    containers,
    parents: wanted,
    partition,
    lines,
    names,
    minSizeOf: minOf,
  };
}

/**
 * Where a container's name is drawn: centred in its 40px header, the type mark and the text in an
 * 18px row 11px from the top, with a 4px margin so a line just touching it counts.
 */
export function nameBox(container: Box, name: string, focused: boolean, userIcon: boolean): Box {
  const text = textWidth(name || '(unnamed)', focused ? 13.5 : 12.5, 600);
  const content = Math.min(container.width - 2 * 13, (userIcon ? 18 : 10) + 6 + text);
  const margin = 4;
  return {
    x: container.x + (container.width - content) / 2 - margin,
    y: container.y + 11 - margin,
    width: content + 2 * margin,
    height: 18 + 2 * margin,
  };
}

/** Whether a straight stretch runs through a box's inside (not only along or onto its edge). */
export function crossesBox(a: Point, b: Point, box: Box, inset = 0): boolean {
  const left = box.x + inset;
  const right = box.x + box.width - inset;
  const top = box.y + inset;
  const bottom = box.y + box.height - inset;
  if (a.y === b.y) {
    if (!(a.y > top && a.y < bottom)) return false;
    return Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
  }
  if (a.x === b.x) {
    if (!(a.x > left && a.x < right)) return false;
    return Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
  }
  // Not right-angled (never expected): checked in small steps.
  for (let step = 0; step <= 40; step++) {
    const x = a.x + ((b.x - a.x) * step) / 40;
    const y = a.y + ((b.y - a.y) * step) / 40;
    if (x > left && x < right && y > top && y < bottom) return true;
  }
  return false;
}

export interface Measures {
  canvases: number;
  containers: number;
  /** Containers with a line across their name. */
  crossedNames: number;
  /** Containers with a line across their 40px header (name or not). */
  crossedHeaders: number;
  lines: number;
  overCards: number;
  overContainers: number;
  /** Information only: pairs of top-level cards out of rows by element type; and inside containers. */
  rowsOutTop: number;
  rowsOutInside: number;
  crossings: number;
  /** Pairs of cards at the same level (top level, or in the same container) that cover each other. */
  overlaps: number;
  widestContainer: number;
  tallestContainer: number;
  canvasArea: number;
}

export const noMeasures = (): Measures => ({
  canvases: 0,
  containers: 0,
  crossedNames: 0,
  crossedHeaders: 0,
  lines: 0,
  overCards: 0,
  overContainers: 0,
  rowsOutTop: 0,
  rowsOutInside: 0,
  crossings: 0,
  overlaps: 0,
  widestContainer: 0,
  tallestContainer: 0,
  canvasArea: 0,
});

/** Adds one canvas's measures to `into`. */
export function measure(canvas: Canvas, into: Measures = noMeasures()): Measures {
  const { boxes, containers, parents, lines, names, partition } = canvas;
  const chain = (id: string) => {
    const ups = new Set<string>();
    for (let up = parents.get(id); up !== undefined && !ups.has(up); up = parents.get(up))
      ups.add(up);
    return ups;
  };
  into.canvases += 1;
  into.containers += names.size;
  into.lines += lines.length;
  const stretches = (points: readonly Point[]) =>
    points.slice(1).map((b, i) => [points[i] as Point, b] as const);

  for (const [id, name] of names) {
    const box = boxes.get(id) as Box;
    const header = { x: box.x, y: box.y, width: box.width, height: containerBox.header };
    let crossedName = false;
    let crossedHeader = false;
    for (const line of lines) {
      for (const [a, b] of stretches(line.points)) {
        if (crossesBox(a, b, name)) crossedName = true;
        if (crossesBox(a, b, header, 1)) crossedHeader = true;
      }
    }
    if (crossedName) into.crossedNames += 1;
    if (crossedHeader) into.crossedHeaders += 1;
    into.widestContainer = Math.max(into.widestContainer, box.width);
    into.tallestContainer = Math.max(into.tallestContainer, box.height);
  }

  for (const line of lines) {
    if (line.source === line.target) continue;
    const ends = new Set([line.source, line.target, ...chain(line.source), ...chain(line.target)]);
    let overCard = false;
    let overContainer = false;
    for (const [id, box] of boxes) {
      if (ends.has(id)) continue;
      // A card inside one of the line's own ends is crossed by design only if it is in the way.
      const ups = chain(id);
      if (ups.has(line.source) || ups.has(line.target)) continue;
      for (const [a, b] of stretches(line.points)) {
        if (!crossesBox(a, b, box, 2)) continue;
        if (containers.has(id)) overContainer = true;
        else overCard = true;
      }
    }
    if (overCard) into.overCards += 1;
    if (overContainer) into.overContainers += 1;
  }

  // Rows: within each level, a card of a higher row must be wholly above a card of a lower one.
  const levels = new Map<string | undefined, string[]>();
  for (const id of boxes.keys()) {
    const parent = parents.get(id);
    levels.set(parent, [...(levels.get(parent) ?? []), id]);
  }
  for (const [level, members] of levels) {
    for (const a of members) {
      for (const b of members) {
        if ((partition.get(a) ?? 0) >= (partition.get(b) ?? 0)) continue;
        const upper = boxes.get(a) as Box;
        const lower = boxes.get(b) as Box;
        if (upper.y + upper.height <= lower.y + 0.5) continue;
        if (level === undefined) into.rowsOutTop += 1;
        else into.rowsOutInside += 1;
      }
    }
  }

  for (const members of levels.values()) {
    for (const a of members) {
      for (const b of members) {
        if (a >= b) continue;
        const [one, other] = [boxes.get(a) as Box, boxes.get(b) as Box];
        const apart =
          one.x + one.width <= other.x + 0.5 ||
          other.x + other.width <= one.x + 0.5 ||
          one.y + one.height <= other.y + 0.5 ||
          other.y + other.height <= one.y + 0.5;
        if (!apart) into.overlaps += 1;
      }
    }
  }

  // Crossings: a level stretch of one line through an upright stretch of another.
  const all = lines.flatMap((line, index) =>
    stretches(line.points).map(([a, b]) => ({ index, a, b })),
  );
  const flat = all.filter((s) => s.a.y === s.b.y && s.a.x !== s.b.x);
  const upright = all.filter((s) => s.a.x === s.b.x && s.a.y !== s.b.y);
  for (const h of flat) {
    const [x1, x2] = [Math.min(h.a.x, h.b.x), Math.max(h.a.x, h.b.x)];
    for (const v of upright) {
      if (v.index === h.index) continue;
      const [y1, y2] = [Math.min(v.a.y, v.b.y), Math.max(v.a.y, v.b.y)];
      if (v.a.x > x1 && v.a.x < x2 && h.a.y > y1 && h.a.y < y2) into.crossings += 1;
    }
  }

  let [right, bottom] = [0, 0];
  let [left, top] = [Infinity, Infinity];
  for (const box of boxes.values()) {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  if (boxes.size > 0) into.canvasArea += ((right - left) * (bottom - top)) / 1e6;
  return into;
}

export function add(into: Measures, more: Measures): Measures {
  for (const key of Object.keys(into) as (keyof Measures)[]) {
    into[key] =
      key === 'widestContainer' || key === 'tallestContainer'
        ? Math.max(into[key], more[key])
        : into[key] + more[key];
  }
  return into;
}

/**
 * Containers with long names, wider than the header's smallest width: one holding cards and a
 * nested container, one holding six cards, with lines from cards around them.
 */
export function longNamesModel(): MadeUpModel {
  const node = (label: string, type: NodeType) => ({ label, metadata: { type } });
  const edge = (id: string, source: string, target: string, relation = 'Relation') => ({
    id,
    source,
    target,
    relation,
  });
  return {
    name: 'long names',
    document: {
      graph: {
        label: 'Made-up long names',
        directed: true,
        nodes: {
          hub: node(
            'Customer Onboarding and Identity Verification Platform Services Hub',
            'Application',
          ),
          a1: node('Intake', 'Application'),
          a2: node('Checks', 'Application'),
          a3: node('Scoring', 'Application'),
          sub: node(
            'Document Capture and Optical Character Recognition Pipeline',
            'Infrastructure',
          ),
          b1: node('Scanner', 'Infrastructure'),
          b2: node('Reader', 'Infrastructure'),
          p: node('Applicant', 'Stakeholder'),
          q: node('Sales desk', 'Business'),
          r: node('CRM', 'Application'),
          s: node('Data lake', 'Infrastructure'),
          t: node('Risk office', 'Business'),
          wide: node(
            'Regional Fulfilment, Warehousing, Returns Handling and Last-Mile Delivery Operations Centre',
            'Infrastructure',
          ),
          w1: node('Dock', 'Infrastructure'),
          w2: node('Racks', 'Infrastructure'),
          w3: node('Returns bay', 'Infrastructure'),
          w4: node('Van pool', 'Infrastructure'),
          w5: node('Cold store', 'Infrastructure'),
          w6: node('Parcel sorter', 'Infrastructure'),
        },
        edges: [
          ...['a1', 'a2', 'a3', 'sub'].map((id, i) =>
            edge(`c${String(i)}`, 'hub', id, containsType),
          ),
          ...['b1', 'b2'].map((id, i) => edge(`d${String(i)}`, 'sub', id, containsType)),
          ...['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].map((id, i) =>
            edge(`e${String(i)}`, 'wide', id, containsType),
          ),
          ...(
            [
              ['p', 'a1'],
              ['q', 'a2'],
              ['r', 'a3'],
              ['r', 'b1'],
              ['s', 'b2'],
              ['t', 'a2'],
              ['q', 'b1'],
              ['p', 'b2'],
              ['r', 'a1'],
              ['a3', 's'],
              ['q', 'w3'],
              ['r', 'w6'],
              ['t', 'w1'],
              ['p', 'w4'],
              ['s', 'w5'],
              ['a2', 'w2'],
            ] as const
          ).map(([source, target], i) => edge(`r${String(i)}`, source, target)),
        ],
      },
    },
  };
}

/** The made-up sets QA measures on: large, moderate, fuzzed with fixed seeds, long names and wide cards. */
export const madeUpSets = {
  long: () => [
    longNamesModel(),
    madeUpModel({ seed: 450, elements: 120, relations: 180, longNames: true, name: 'long' }),
  ],
  /** Long container names, and every seventh element's card set by hand to 640 or 1,600px wide. */
  wide: () =>
    [
      longNamesModel(),
      madeUpModel({ seed: 450, elements: 120, relations: 180, longNames: true, name: 'wide' }),
    ].map((model) => ({ ...model, name: `wide ${model.name}`, widths: wideCards(model) })),
  large: () => [madeUpModel({ seed: 300, elements: 300, relations: 600, name: 'large' })],
  moderate: () => [madeUpModel({ seed: 120, elements: 120, relations: 180, name: 'moderate' })],
  fuzzed: (count = 24) =>
    Array.from({ length: count }, (_, i) => {
      const random = seeded(7000 + i);
      const elements = 30 + random.int(90);
      return madeUpModel({
        seed: 7000 + i,
        elements,
        relations: Math.round(elements * (1 + random.next())),
        nested: 0.15 + random.next() * 0.35,
        name: `fuzzed ${i}`,
      });
    }),
};

/** Widths set by hand on a model: every seventh element 1,600px wide, and the next one 640px. */
export function wideCards(model: MadeUpModel): Map<string, number> {
  const widths = new Map<string, number>();
  Object.keys(model.document.graph.nodes ?? {}).forEach((id, index) => {
    if (index % 7 === 0) widths.set(id, 1600);
    else if (index % 7 === 1) widths.set(id, 640);
  });
  return widths;
}

/** Every canvas of a model: each focus element at depths 1 and 2. */
export async function measureModel(model: MadeUpModel, depths = [1, 2]): Promise<Measures> {
  const graph = buildModelGraph(model.document);
  const total = noMeasures();
  for (const focus of focusElements(graph)) {
    for (const depth of depths) {
      measure(await canvasOf(graph, focus, depth, model.widths), total);
    }
  }
  return total;
}
