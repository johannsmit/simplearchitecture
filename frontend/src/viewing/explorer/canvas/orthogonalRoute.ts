import type { Box, Point } from './positions';

/**
 * The cheapest right-angled way round boxes in the way, from one of some starts to one of some
 * ends: A* over a sparse grid made of the starts' and ends' coordinates and the boxes' edges,
 * costing length plus `bendCost` for each bend. The route may touch a box's edge but never enter
 * it, so a box grown by some room keeps the route that far from what it stands for. Deterministic:
 * the same points and boxes always give the same route. Pure, so it is tested without a browser.
 */

/** A heading on the grid: right (+x), down (+y), left (-x), up (-y). */
export type Heading = 0 | 1 | 2 | 3;

const steps: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

export const reverse = (heading: Heading) => ((heading + 2) % 4) as Heading;

/** Grids larger than this aren't searched: too slow to keep up with a drag. */
const maxGridPoints = 40_000;

/** A place a route may start or end at, the heading it goes in there, and what it costs extra. */
export interface RouteEnd {
  at: Point;
  /** At a start, the heading it is already going in; at an end, the heading it must leave in. */
  heading: Heading;
  /** Added to the cost of a route from or to here, to prefer some starts or ends on a tie. */
  extra?: number;
}

export interface RouteRequest {
  starts: readonly RouteEnd[];
  ends: readonly RouteEnd[];
  /** The boxes it must not enter; touching their edges is fine. */
  avoid: readonly Box[];
  bendCost: number;
}

export interface Route {
  /** The grid points it passes, from its start to its end, straight stretches included. */
  points: Point[];
  /** Its length plus `bendCost` for each bend, counting the turn into its end's heading, and extras. */
  cost: number;
  /** Which of the starts and of the ends it takes. */
  start: number;
  end: number;
}

const strictlyInside = (point: Point, box: Box) =>
  point.x > box.x && point.x < box.x + box.width && point.y > box.y && point.y < box.y + box.height;

/**
 * A binary heap of states by the least they can cost, then the furthest come (so a search heads on
 * along one of several equally good ways, not all of them), then the order they were pushed, so
 * ties are stable.
 */
class Queue {
  private readonly items: Item[] = [];
  private pushed = 0;

  get size() {
    return this.items.length;
  }

  push(f: number, g: number, state: number) {
    const item = { f, g, order: this.pushed++, state };
    const items = this.items;
    items.push(item);
    let index = items.length - 1;
    while (index > 0) {
      const up = (index - 1) >> 1;
      if (!before(item, items[up] as Item)) break;
      items[index] = items[up] as Item;
      index = up;
    }
    items[index] = item;
  }

  pop(): Item {
    const items = this.items;
    const top = items[0] as Item;
    const last = items.pop() as Item;
    if (items.length > 0) {
      let index = 0;
      for (;;) {
        const left = 2 * index + 1;
        if (left >= items.length) break;
        const right = left + 1;
        const child =
          right < items.length && before(items[right] as Item, items[left] as Item) ? right : left;
        if (!before(items[child] as Item, last)) break;
        items[index] = items[child] as Item;
        index = child;
      }
      items[index] = last;
    }
    return top;
  }
}

interface Item {
  f: number;
  g: number;
  order: number;
  state: number;
}

const before = (a: Item, b: Item) =>
  a.f < b.f || (a.f === b.f && (a.g > b.g || (a.g === b.g && a.order < b.order)));

/**
 * The search's working arrays, kept from one search to the next so a drag doesn't make new ones
 * for every line. An entry counts only when its mark is the current search's, so they are never
 * cleared.
 */
const scratch = {
  size: 0,
  search: 0,
  seen: new Uint32Array(0),
  blocked: new Uint32Array(0),
  closed: new Uint32Array(0),
  cost: new Float64Array(0),
  cameFrom: new Int32Array(0),
};

function scratchFor(size: number) {
  if (size > scratch.size || scratch.search >= 0xffffffff) {
    const room = Math.max(size, 2 * scratch.size);
    Object.assign(scratch, {
      size: room,
      search: 0,
      seen: new Uint32Array(room),
      blocked: new Uint32Array(room),
      closed: new Uint32Array(room),
      cost: new Float64Array(room),
      cameFrom: new Int32Array(room),
    });
  }
  scratch.search += 1;
  return { ...scratch, mark: scratch.search };
}

const sortedUnique = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);

/**
 * The fewest bends from a heading to the end, `dx` and `dy` away, arriving in `toHeading`: none
 * when the end is straight ahead in it, one when the way is along the heading then along
 * `toHeading`, and otherwise at least two. Never more than it takes, so the search stays exact.
 */
function leastBends(dx: number, dy: number, heading: Heading, toHeading: Heading): number {
  // The headings the way still has to go in: -1 for none.
  const sideways = dx === 0 ? -1 : dx > 0 ? 0 : 2;
  const upDown = dy === 0 ? -1 : dy > 0 ? 1 : 3;
  const along = (way: number, one: Heading, other: Heading) =>
    way === -1 || way === one || way === other;
  if (
    heading === toHeading &&
    along(sideways, heading, heading) &&
    along(upDown, heading, heading)
  ) {
    return 0;
  }
  if (
    heading !== toHeading &&
    heading !== reverse(toHeading) &&
    along(sideways, heading, toHeading) &&
    along(upDown, heading, toHeading)
  ) {
    return 1;
  }
  return 2;
}

/** The least a route from a point and heading to an end can cost, ignoring what is in the way. */
function leastCost(
  x: number,
  y: number,
  heading: Heading,
  end: RouteEnd,
  bendCost: number,
): number {
  const [dx, dy] = [end.at.x - x, end.at.y - y];
  return (
    Math.abs(dx) +
    Math.abs(dy) +
    bendCost * leastBends(dx, dy, heading, end.heading) +
    (end.extra ?? 0)
  );
}

export function orthogonalRoute(request: RouteRequest): Route | undefined {
  const { avoid, bendCost } = request;
  const outside = (end: RouteEnd) => !avoid.some((box) => strictlyInside(end.at, box));
  const starts = request.starts.filter(outside);
  const ends = request.ends.filter(outside);
  // The least a route can still cost from a point and heading: to the nearest end, ignoring what
  // is in the way, with the fewest bends it takes.
  const estimate = (x: number, y: number, heading: Heading) => {
    let least = Infinity;
    for (const end of ends) least = Math.min(least, leastCost(x, y, heading, end, bendCost));
    return least;
  };
  if (starts.length === 0 || ends.length === 0) return undefined;
  const points = [...starts, ...ends].map((end) => end.at);
  const xs = sortedUnique([
    ...points.map((point) => point.x),
    ...avoid.flatMap((box) => [box.x, box.x + box.width]),
  ]);
  const ys = sortedUnique([
    ...points.map((point) => point.y),
    ...avoid.flatMap((box) => [box.y, box.y + box.height]),
  ]);
  const [nx, ny] = [xs.length, ys.length];
  if (nx * ny > maxGridPoints) return undefined;
  const xAt = new Map(xs.map((x, index) => [x, index]));
  const yAt = new Map(ys.map((y, index) => [y, index]));
  const node = (point: Point) => (yAt.get(point.y) as number) * nx + (xAt.get(point.x) as number);
  const done = nx * ny * 4;
  const { blocked, cost, cameFrom, closed, seen, mark } = scratchFor(done + 1);
  const isClosed = (state: number) => closed[state] === mark;
  const costOf = (state: number) => (seen[state] === mark ? (cost[state] as number) : Infinity);
  const reach = (state: number, so: number, before: number) => {
    seen[state] = mark;
    cost[state] = so;
    cameFrom[state] = before;
  };
  // A stretch between two grid points next to each other is either all inside a box or not in it,
  // as every box edge is a grid line: blocked[node * 4 + heading] marks the stretches inside one.
  for (const box of avoid) {
    const [left, right] = [xAt.get(box.x) as number, xAt.get(box.x + box.width) as number];
    const [top, bottom] = [yAt.get(box.y) as number, yAt.get(box.y + box.height) as number];
    for (let j = top + 1; j < bottom; j++) {
      for (let i = left; i < right; i++) {
        blocked[(j * nx + i) * 4] = mark;
        blocked[(j * nx + i + 1) * 4 + 2] = mark;
      }
    }
    for (let i = left + 1; i < right; i++) {
      for (let j = top; j < bottom; j++) {
        blocked[(j * nx + i) * 4 + 1] = mark;
        blocked[((j + 1) * nx + i) * 4 + 3] = mark;
      }
    }
  }
  // The ends by their grid point: arriving there finishes the route, with the turn into it.
  const endsAt = new Map<number, number[]>();
  ends.forEach((end, index) => {
    const at = node(end.at);
    endsAt.set(at, [...(endsAt.get(at) ?? []), index]);
  });
  const queue = new Queue();
  starts.forEach((start) => {
    const state = node(start.at) * 4 + start.heading;
    const so = start.extra ?? 0;
    if (so >= costOf(state)) return;
    reach(state, so, -1);
    queue.push(so + estimate(start.at.x, start.at.y, start.heading), so, state);
  });
  let finish = -1;
  while (queue.size > 0) {
    const { state } = queue.pop();
    if (isClosed(state)) continue;
    closed[state] = mark;
    if (state === done) break;
    const at = Math.floor(state / 4);
    const heading = (state % 4) as Heading;
    const so = cost[state] as number;
    for (const index of endsAt.get(at) ?? []) {
      const end = ends[index] as RouteEnd;
      if (heading === reverse(end.heading)) continue;
      const total = so + (heading === end.heading ? 0 : bendCost) + (end.extra ?? 0);
      if (total < costOf(done)) {
        reach(done, total, state);
        finish = index;
        queue.push(total, total, done);
      }
    }
    const [i, j] = [at % nx, Math.floor(at / nx)];
    for (let next = 0 as Heading; next < 4; next = (next + 1) as Heading) {
      if (next === reverse(heading) || blocked[at * 4 + next] === mark) continue;
      const [di, dj] = steps[next] as [number, number];
      const [ni, nj] = [i + di, j + dj];
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const [x, y] = [xs[ni] as number, ys[nj] as number];
      const reached =
        so +
        Math.abs(x - (xs[i] as number)) +
        Math.abs(y - (ys[j] as number)) +
        (next === heading ? 0 : bendCost);
      const nextState = (nj * nx + ni) * 4 + next;
      if (reached >= costOf(nextState)) continue;
      reach(nextState, reached, state);
      queue.push(reached + estimate(x, y, next), reached, nextState);
    }
  }
  if (!isClosed(done)) return undefined;
  const corners: Point[] = [];
  let first = done;
  for (let state = cameFrom[done] as number; state !== -1; state = cameFrom[state] as number) {
    const at = Math.floor(state / 4);
    corners.push({ x: xs[at % nx] as number, y: ys[Math.floor(at / nx)] as number });
    first = state;
  }
  corners.reverse();
  const startAt = Math.floor(first / 4);
  const start = starts.findIndex((one) => node(one.at) === startAt && one.heading === first % 4);
  return {
    points: corners,
    cost: costOf(done),
    start: request.starts.indexOf(starts[start] as RouteEnd),
    end: request.ends.indexOf(ends[finish] as RouteEnd),
  };
}
