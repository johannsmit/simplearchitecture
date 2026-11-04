import type { ELK, ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api';

/**
 * Canvas layout with ELK's layered algorithm (React Flow's "Elkjs" and "multiple handles"
 * examples). Pure apart from the ELK instance passed in, so it runs in Node tests and in the
 * browser (where the instance runs ELK in a web worker).
 *
 * - Relationships flow in one direction (`layoutDirection`), with few crossings.
 * - Partitioning keeps the node types in metamodel order as rows (or columns, left to right).
 * - Every relationship gets its own port on each card, and ELK decides the side and order of
 *   the ports. The canvas turns the ports into React Flow handles at the same spots, so edges
 *   never stack on one point. Cards grow taller when they need room for their ports.
 * - ELK routes the lines with right angles around the cards, and the canvas draws those routes
 *   (edgeLine.ts). All levels of nesting are laid out in one pass, so a line into a container gets
 *   a route too.
 * - Cards in a container with no line at them or inside them are packed into a compact block first,
 *   and ELK sees the block as one card (`packedBlock`), so they don't become one long row.
 */

/** Top to bottom. Use 'RIGHT' for left to right: nothing else needs to change. */
export const layoutDirection: 'RIGHT' | 'DOWN' = 'DOWN';

export interface LayoutCard {
  id: string;
  /** Measured card size: the smallest the layout may make it. */
  width: number;
  height: number;
  /** Row (or column) in direction order, e.g. the node type's index in the metamodel. */
  partition: number;
  /**
   * A circle keeps its measured size: its handles go on the circle, not where ELK puts the ports
   *. A container's width and height are its smallest size; it grows to
   * hold its cards. Default: a card, which grows when it needs room for its ports.
   */
  shape?: 'card' | 'circle' | 'container';
  /** The container this card is drawn inside (an id of another card), if any. */
  parent?: string;
}

export interface LayoutLink {
  id: string;
  source: string;
  target: string;
}

export type Side = 'left' | 'right' | 'top' | 'bottom';

/**
 * The line ELK routed from a source handle. Everything is on the canvas's scale, relative to the
 * source card's top left corner, whatever container either end is in. So the route moves with the
 * card, and a shifted layout needs no change. It holds only while the target card is still at
 * `target`, compared on the canvas.
 */
export interface LinkRoute {
  bends: { x: number; y: number }[];
  /** The target card's top left corner when the route was made. */
  target: { x: number; y: number };
}

export interface PlacedHandle {
  /** The port id; also the React Flow handle id. */
  id: string;
  kind: 'source' | 'target';
  side: Side;
  /** Distance along the side: from the card's top for left/right, from its left for top/bottom. */
  offset: number;
  /** A source handle whose line ELK routed. */
  route?: LinkRoute;
}

export interface PlacedCard {
  id: string;
  /** Relative to the container the card is in (`parent`), else to the canvas. */
  x: number;
  y: number;
  /** The container the card is drawn inside. */
  parent?: string;
  width: number;
  height: number;
  handles: PlacedHandle[];
}

export const spacing = {
  /** Between cards in the same row. */
  cards: 28,
  /** Between rows: room for the lines. */
  columns: 96,
  /** Between ports on one side of a card. */
  ports: 12,
} as const;

/**
 * A container: the 40px header, the padding around its cards, and
 * the smallest size. The numbers match .card.is-container in styles/explorer.css.
 */
export const containerBox = {
  header: 40,
  padding: { top: 56, left: 16, bottom: 16, right: 16 },
  minWidth: 200,
  minHeight: 116,
  /** Between rows inside a container. */
  columns: 64,
} as const;

/** Port (and React Flow handle) id of one end of a link. */
export function portId(linkId: string, end: 'source' | 'target'): string {
  return `${linkId}:${end === 'source' ? 's' : 't'}`;
}

/** The options of one level of the graph: the top, or inside a container with lines in it. */
function levelOptions(inside: boolean, direction: 'RIGHT' | 'DOWN'): Record<string, string> {
  const columns = String(inside ? containerBox.columns : spacing.columns);
  return {
    'elk.algorithm': 'layered',
    'elk.direction': direction,
    'elk.partitioning.activate': 'true',
    'elk.spacing.nodeNode': String(spacing.cards),
    'elk.layered.spacing.nodeNodeBetweenLayers': columns,
    'elk.spacing.componentComponent': columns,
    'elk.edgeRouting': 'ORTHOGONAL',
    // Fewer crossings for about twice the time, measured on made-up models.
    'elk.layered.thoroughness': '30',
  };
}

/** How ELK treats a card: `card` with its ports, and a container that may hold more ELK nodes. */
function cardNode(card: LayoutCard, ports: readonly ElkPort[], children?: ElkNode[]): ElkNode {
  const own = {
    'elk.partitioning.partition': String(card.partition),
    // ELK picks each port's side (out of the card towards the flow) and order.
    'elk.portConstraints': 'FREE',
    'elk.spacing.portPort': String(spacing.ports),
    'elk.nodeSize.constraints':
      card.shape === undefined || card.shape === 'card' ? 'PORTS MINIMUM_SIZE' : 'MINIMUM_SIZE',
    'elk.nodeSize.minimum': `(${card.width}, ${card.height})`,
  };
  if (!children) {
    return {
      id: card.id,
      width: card.width,
      height: card.height,
      layoutOptions: own,
      ports: [...ports],
    };
  }
  const { top, left, bottom, right } = containerBox.padding;
  return {
    id: card.id,
    // No width or height: it grows to hold its cards, down to `nodeSize.minimum`.
    layoutOptions: {
      ...levelOptions(true, layoutDirection),
      ...own,
      'elk.padding': `[top=${top},left=${left},bottom=${bottom},right=${right}]`,
    },
    ports: [...ports],
    children,
  };
}

/** The ELK input graph for cards at one level with lines between them, and no nesting. */
export function buildElkGraph(
  cards: readonly LayoutCard[],
  links: readonly LayoutLink[],
  direction: 'RIGHT' | 'DOWN' = layoutDirection,
): ElkNode {
  const known = new Set(cards.map((card) => card.id));
  const usable = links.filter((link) => known.has(link.source) && known.has(link.target));
  const ports = portsOfLinks(usable);
  return {
    id: 'root',
    layoutOptions: rootOptions(direction),
    children: cards.map((card) => cardNode(card, ports.get(card.id) ?? [])),
    edges: edgesOfLinks(usable),
  };
}

/** One pass over every level, with every line's route in the canvas's coordinates. */
function rootOptions(direction: 'RIGHT' | 'DOWN'): Record<string, string> {
  return {
    ...levelOptions(false, direction),
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.json.edgeCoords': 'ROOT',
  };
}

function portsOfLinks(links: readonly LayoutLink[]): Map<string, ElkPort[]> {
  const ports = new Map<string, ElkPort[]>();
  const add = (card: string, id: string) => {
    const list = ports.get(card);
    const port = { id, width: 0, height: 0 };
    if (list) list.push(port);
    else ports.set(card, [port]);
  };
  for (const link of links) {
    add(link.source, portId(link.id, 'source'));
    add(link.target, portId(link.id, 'target'));
  }
  return ports;
}

function edgesOfLinks(links: readonly LayoutLink[]) {
  return links.map((link) => ({
    id: link.id,
    sources: [portId(link.id, 'source')],
    targets: [portId(link.id, 'target')],
  }));
}

function sideOf(port: ElkPort, width: number, height: number): Side {
  const x = (port.x ?? 0) + (port.width ?? 0) / 2;
  const y = (port.y ?? 0) + (port.height ?? 0) / 2;
  const distances: [Side, number][] = [
    ['left', Math.abs(x)],
    ['right', Math.abs(width - x)],
    ['top', Math.abs(y)],
    ['bottom', Math.abs(height - y)],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0]?.[0] ?? 'right';
}

/** A card's handles from its ports. */
function handlesOf(node: ElkNode): PlacedHandle[] {
  const width = node.width ?? 0;
  const height = node.height ?? 0;
  return (node.ports ?? []).map((port): PlacedHandle => {
    const side = sideOf(port, width, height);
    const along =
      side === 'left' || side === 'right'
        ? (port.y ?? 0) + (port.height ?? 0) / 2
        : (port.x ?? 0) + (port.width ?? 0) / 2;
    return {
      id: port.id,
      kind: port.id.endsWith(':s') ? 'source' : 'target',
      side,
      offset: Math.min(Math.max(along, 0), side === 'left' || side === 'right' ? height : width),
    };
  });
}

/** Each routed line's route, by the id of its source port. */
function readRoutes(
  result: ElkNode,
  cardOfPort: ReadonlyMap<string, string>,
  boxes: ReadonlyMap<string, { x: number; y: number }>,
): Map<string, LinkRoute> {
  const routes = new Map<string, LinkRoute>();
  // With `edgeCoords` ROOT, sections are on the canvas, wherever ELK nests the edge in its answer.
  const read = (node: ElkNode) => {
    for (const edge of node.edges ?? []) {
      const [sourcePort] = edge.sources;
      const [targetPort] = edge.targets;
      const [section] = edge.sections ?? [];
      if (sourcePort === undefined || targetPort === undefined || !section) continue;
      const source = boxes.get(cardOfPort.get(sourcePort) ?? '');
      const target = boxes.get(cardOfPort.get(targetPort) ?? '');
      if (!source || !target) continue;
      routes.set(sourcePort, {
        bends: (section.bendPoints ?? []).map((bend) => ({
          x: bend.x - source.x,
          y: bend.y - source.y,
        })),
        target: { x: target.x - source.x, y: target.y - source.y },
      });
    }
    for (const child of node.children ?? []) read(child);
  };
  read(result);
  return routes;
}

/** Ids of the invisible nodes that stand for a block of packed cards in ELK's graph. */
const blockId = (container: string) => `\u0000block:${container}`;

/** What holds the rows of one container in ELK's graph; never drawn. */
interface RowMarks {
  nodes: ElkNode[];
  edges: ElkExtendedEdge[];
}

/**
 * ELK's one pass keeps partitions at the top level only, so inside a container the rows are held by
 * hidden marks: between two rows, a small node that every card of the row above points to, and that
 * points to every card of the row below. Each mark has one port for each way, so ELK bundles its
 * edges into one lane, and they win when a real line points the other way.
 */
function rowMarks(level: string, cards: readonly { id: string; partition: number }[]): RowMarks {
  const rows = [...new Set(cards.map((card) => card.partition))].sort((a, b) => a - b);
  const marks: RowMarks = { nodes: [], edges: [] };
  rows.slice(1).forEach((row, index) => {
    const id = `\u0000row:${level}:${row}`;
    const [into, out] = [`${id}:in`, `${id}:out`];
    marks.nodes.push({
      id,
      width: 1,
      height: 1,
      ports: [
        { id: into, width: 0, height: 0 },
        { id: out, width: 0, height: 0 },
      ],
    });
    const edge = (source: string, target: string) => ({
      id: `${source}>${target}`,
      sources: [source],
      targets: [target],
      layoutOptions: { 'elk.layered.priority.direction': '100' },
    });
    for (const card of cards) {
      if (card.partition === rows[index]) marks.edges.push(edge(card.id, into));
      if (card.partition === row) marks.edges.push(edge(out, card.id));
    }
  });
  return marks;
}

/**
 * Lays out the cards and links with the given ELK instance, in one pass: ELK sees every level, so
 * it routes the lines between levels around the cards, and keeps the rows inside each level. A
 * container takes the size its cards need. Placed cards come parents first, with positions
 * relative to their container.
 *
 * A pass like this can't pack, so cards in a container that have no line at them or anywhere inside
 * them are packed first, about 1.6 wide to 1 high, and ELK places that block as one card. A
 * container with nothing but such cards is one card to ELK, and can take lines of its own.
 */
export async function layoutCards(
  elk: Pick<ELK, 'layout'>,
  cards: readonly LayoutCard[],
  links: readonly LayoutLink[],
): Promise<Map<string, PlacedCard>> {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const parentOf = new Map<string, string>();
  for (const card of cards) {
    if (card.parent !== undefined && card.parent !== card.id && byId.has(card.parent)) {
      parentOf.set(card.id, card.parent);
    }
  }
  // A parent chain that loops back (never from the shared nesting rules) is cut: top level.
  for (const card of cards) {
    const seen = new Set([card.id]);
    for (let up = parentOf.get(card.id); up !== undefined; up = parentOf.get(up)) {
      if (seen.has(up)) {
        parentOf.delete(card.id);
        break;
      }
      seen.add(up);
    }
  }
  const membersOf = new Map<string | undefined, LayoutCard[]>();
  for (const card of cards) {
    const parent = parentOf.get(card.id);
    const list = membersOf.get(parent);
    if (list) list.push(card);
    else membersOf.set(parent, [card]);
  }
  const known = links.filter((link) => byId.has(link.source) && byId.has(link.target));
  // A card with a line at it or inside it takes part in ELK's pass.
  const lined = new Set<string>();
  for (const link of known) {
    for (const end of [link.source, link.target]) {
      for (let at: string | undefined = end; at !== undefined; at = parentOf.get(at)) lined.add(at);
    }
  }
  const hasLinedMember = (id: string) => (membersOf.get(id) ?? []).some((m) => lined.has(m.id));

  const placed = new Map<string, PlacedCard>();
  const sizes = new Map<string, { width: number; height: number }>();
  /** Packs unlined cards; `at` is what their positions are measured from. */
  const packedBlock = async (
    members: readonly LayoutCard[],
    parent: string,
    at: { x: number; y: number },
  ) => {
    await Promise.all(members.filter((m) => membersOf.has(m.id)).map((m) => packContainer(m)));
    const result = await elk.layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'rectpacking',
        'elk.aspectRatio': '1.6',
        'elk.spacing.nodeNode': String(spacing.cards),
        'elk.padding': '[top=0,left=0,bottom=0,right=0]',
      },
      children: members.map((card) => ({ id: card.id, ...(sizes.get(card.id) ?? card) })),
    });
    let width = 0;
    let height = 0;
    for (const box of result.children ?? []) {
      const card = byId.get(box.id);
      if (!card) continue;
      const size = sizes.get(box.id) ?? card;
      const [x, y] = [box.x ?? 0, box.y ?? 0];
      placed.set(box.id, {
        id: box.id,
        x: x + at.x,
        y: y + at.y,
        parent,
        width: size.width,
        height: size.height,
        handles: [],
      });
      width = Math.max(width, x + size.width);
      height = Math.max(height, y + size.height);
    }
    return { width, height };
  };
  /** A container with only unlined cards: laid out now, one card to ELK from here on. */
  const packContainer = async (card: LayoutCard) => {
    const { top, left, bottom, right } = containerBox.padding;
    const members = membersOf.get(card.id) ?? [];
    const block = await packedBlock(members, card.id, { x: left, y: top });
    sizes.set(card.id, {
      width: Math.max(card.width, Math.ceil(left + block.width + right)),
      height: Math.max(card.height, Math.ceil(top + block.height + bottom)),
    });
  };

  const ports = portsOfLinks(known);
  /** Blocks in ELK's graph: which cards each stands for, and their size. */
  const blocks = new Map<string, { parent: string; width: number; height: number }>();
  const hidden: ElkExtendedEdge[] = [];
  const nodeOf = async (card: LayoutCard): Promise<ElkNode> => {
    const own = ports.get(card.id) ?? [];
    if (!membersOf.has(card.id)) return cardNode(card, own);
    if (!hasLinedMember(card.id)) {
      await packContainer(card);
      return cardNode({ ...card, ...sizes.get(card.id), shape: 'container' }, own);
    }
    return cardNode(card, own, await levelNodes(card.id));
  };
  const levelNodes = async (level: string | undefined): Promise<ElkNode[]> => {
    const members = membersOf.get(level) ?? [];
    const unlined = level === undefined ? [] : members.filter((m) => !lined.has(m.id));
    const alone = unlined.length < 2;
    const nodes = await Promise.all(
      members.filter((m) => alone || lined.has(m.id)).map((m) => nodeOf(m)),
    );
    if (level === undefined) return nodes;
    const inRows = members
      .filter((m) => alone || lined.has(m.id))
      .map(({ id, partition }) => ({ id, partition }));
    if (alone) {
      const marks = rowMarks(level, inRows);
      hidden.push(...marks.edges);
      return [...nodes, ...marks.nodes];
    }
    const id = blockId(level);
    const block = await packedBlock(unlined, id, { x: 0, y: 0 });
    blocks.set(id, { parent: level, ...block });
    const partition = Math.min(...unlined.map((m) => m.partition));
    const marks = rowMarks(level, [...inRows, { id, partition }]);
    hidden.push(...marks.edges);
    return [
      ...nodes,
      ...marks.nodes,
      {
        id,
        ...block,
        layoutOptions: {
          'elk.nodeSize.constraints': 'MINIMUM_SIZE',
          'elk.nodeSize.minimum': `(${block.width}, ${block.height})`,
        },
      },
    ];
  };
  const children = await levelNodes(undefined);
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: rootOptions(layoutDirection),
    children,
    edges: [...edgesOfLinks(known), ...hidden],
  };
  // ELK's default cycle breaking threw on a few made-up models in testing, and this retry
  // worked each time. Its crossings differ widely per model, in both directions.
  const result = await elk.layout(graph).catch(() =>
    elk.layout({
      ...graph,
      layoutOptions: {
        ...graph.layoutOptions,
        'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
      },
    }),
  );

  const cardOfPort = new Map<string, string>();
  const read = (node: ElkNode, parent: string | undefined) => {
    for (const child of node.children ?? []) {
      if (child.id.startsWith('\u0000row:')) continue;
      const block = blocks.get(child.id);
      if (block) {
        // A packed card's position so far is within its block.
        for (const card of placed.values()) {
          if (card.parent !== child.id) continue;
          placed.set(card.id, {
            ...card,
            x: card.x + (child.x ?? 0),
            y: card.y + (child.y ?? 0),
            parent: block.parent,
          });
        }
        continue;
      }
      for (const port of child.ports ?? []) cardOfPort.set(port.id, child.id);
      placed.set(child.id, {
        id: child.id,
        x: child.x ?? 0,
        y: child.y ?? 0,
        ...(parent === undefined ? {} : { parent }),
        width: child.width ?? 0,
        height: child.height ?? 0,
        handles: handlesOf(child),
      });
      read(child, child.id);
    }
  };
  read(result, undefined);

  // Parents first (React Flow needs a parent node before its children).
  const ordered = new Map<string, PlacedCard>();
  const visit = (level: string | undefined) => {
    for (const card of membersOf.get(level) ?? []) {
      const at = placed.get(card.id);
      if (!at) continue;
      ordered.set(card.id, at);
      visit(card.id);
    }
  };
  visit(undefined);

  const routes = readRoutes(result, cardOfPort, absoluteBoxes(ordered));
  for (const [id, card] of ordered) {
    if (card.handles.length === 0) continue;
    ordered.set(id, {
      ...card,
      handles: card.handles.map((handle) => {
        const route = routes.get(handle.id);
        return route ? { ...handle, route } : handle;
      }),
    });
  }
  return ordered;
}

/** Positions on the canvas (not relative to a container), parents first in `placed`. */
export function absoluteBoxes(
  placed: ReadonlyMap<string, Omit<PlacedCard, 'handles'>>,
): Map<string, { x: number; y: number; width: number; height: number }> {
  const result = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const card of placed.values()) {
    const parent = card.parent === undefined ? undefined : result.get(card.parent);
    result.set(card.id, {
      x: card.x + (parent?.x ?? 0),
      y: card.y + (parent?.y ?? 0),
      width: card.width,
      height: card.height,
    });
  }
  return result;
}
