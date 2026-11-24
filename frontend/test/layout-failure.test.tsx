import type { JgfDocument, ModelSummary } from '@simplearchitecture/shared';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getElk } from '../src/viewing/explorer/canvas/elkEngine';
import type * as ElkLayout from '../src/viewing/explorer/canvas/elkLayout';
import {
  layoutFailureMessage,
  LayoutTimeoutError,
  withinTimeLimit,
} from '../src/viewing/explorer/canvas/elkLayout';
import { admin, renderAt, stubApi } from './helpers';

// When the automatic layout fails or takes too long, the canvas says what happened and what to do,
// and stays usable: its cards are placed without the layout. Made-up data only.

// The time limit is 30 seconds; here it is short, so the test doesn't wait that long.
const shortLimit = 2000;
vi.mock('../src/viewing/explorer/canvas/elkLayout', async (importOriginal) => ({
  ...(await importOriginal<typeof ElkLayout>()),
  layoutTimeLimit: 2000,
}));

const modelId = '79797979-7979-4979-8979-797979797979';
const model: JgfDocument = {
  graph: {
    id: modelId,
    label: 'Made-up orchard',
    nodes: {
      grower: { label: 'Grower', metadata: { type: 'Stakeholder' } },
      ledger: { label: 'Ledger', metadata: { type: 'Application' } },
      scales: { label: 'Scales', metadata: { type: 'Application' } },
      barn: { label: 'Barn', metadata: { type: 'Infrastructure' } },
    },
    edges: [
      { id: 'o1', source: 'grower', target: 'ledger', relation: 'Relation' },
      { id: 'o2', source: 'ledger', target: 'scales', relation: 'Relation', label: 'Weighs' },
      { id: 'o3', source: 'scales', target: 'barn', relation: 'Relation' },
    ],
  },
};
const summary: ModelSummary = {
  id: modelId,
  name: 'Made-up orchard',
  createdAt: '2026-11-01T10:00:00.000Z',
  createdBy: { id: 'u1', name: 'Sam Taylor' },
  nodeCount: 4,
  edgeCount: 3,
};

function open() {
  stubApi(admin, ({ url, method }) => {
    if (method !== 'GET') return undefined;
    if (url === '/api/models') return Response.json({ models: [summary] });
    if (url === `/api/models/${modelId}`) return Response.json(model);
    const element = /\/elements\/([^?]+)$/.exec(url)?.[1];
    if (element !== undefined) {
      const id = decodeURIComponent(element);
      return Response.json({
        element: { id, version: 1, node: model.graph.nodes?.[id] },
        warnings: [],
      });
    }
    return undefined;
  });
  renderAt(`/modelling/models/${modelId}/elements/ledger`);
}

const canvas = () => screen.getByRole('region', { name: /^Diagram:/ });
const cardIds = () =>
  [...canvas().querySelectorAll('.card[data-element-id]')]
    .map((element) => element.getAttribute('data-element-id') ?? '')
    .sort();
const status = () =>
  [...canvas().querySelectorAll('.canvas-overlay')].map((each) => each.textContent).join(' ');

/** No card covers another. */
function apart() {
  const boxes = [...canvas().querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => {
    const [x = 0, y = 0] =
      /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(node.style.transform)?.slice(1).map(Number) ??
      [];
    return { x, y, width: parseFloat(node.style.width), height: parseFloat(node.style.height) };
  });
  return boxes.every((a, i) =>
    boxes.every(
      (b, j) =>
        i === j ||
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y,
    ),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a layout that fails', () => {
  it('says what happened and what to do, and places the cards without it', async () => {
    // A layout in ELK's worker fails with a plain object, not an Error.
    vi.spyOn(getElk(), 'layout').mockRejectedValue({ message: 'java.lang.IllegalStateException' });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    open();
    await waitFor(() => {
      expect(status()).toContain("The diagram couldn't be laid out automatically");
    });
    expect(status()).toContain('Reload the page to try again.');
    expect(status()).not.toContain('Unknown error');
    // Usable: every card is there, none on another.
    expect(cardIds()).toEqual(['grower', 'ledger', 'scales']);
    expect(apart()).toBe(true);
    expect(canvas().querySelectorAll('.react-flow__edge')).toHaveLength(2);
  });

  it('gives up after the time limit, stops the layout, and places the cards without it', async () => {
    const elk = getElk();
    vi.spyOn(elk, 'layout').mockReturnValue(new Promise(() => undefined));
    const stop = vi.spyOn(elk, 'terminateWorker').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    open();
    await waitFor(() => {
      expect(canvas().textContent).toContain('Laying out…');
    });
    expect(cardIds()).toEqual([]);
    await waitFor(() => {
      expect(status()).toContain('took longer than 2 seconds to lay out');
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(cardIds()).toEqual(['grower', 'ledger', 'scales']);
    expect(apart()).toBe(true);
  });
});

describe('the time limit', () => {
  it('is 30 seconds', async () => {
    const real = await vi.importActual<typeof ElkLayout>(
      '../src/viewing/explorer/canvas/elkLayout',
    );
    expect(real.layoutTimeLimit).toBe(30_000);
    expect(shortLimit).toBeLessThan(real.layoutTimeLimit);
  });

  it('answers with the layout when it comes in time, and stops the clock', async () => {
    vi.useFakeTimers();
    try {
      const timed = withinTimeLimit(Promise.resolve('laid'), 30_000);
      await expect(timed.promise).resolves.toBe('laid');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up once the limit has passed', async () => {
    vi.useFakeTimers();
    try {
      const timed = withinTimeLimit(new Promise(() => undefined), 30_000);
      const answer = timed.promise.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(29_999);
      await vi.advanceTimersByTimeAsync(1);
      const error = await answer;
      expect(error).toBeInstanceOf(LayoutTimeoutError);
      expect(layoutFailureMessage(error)).toBe(
        'The diagram took longer than 30 seconds to lay out, so its cards are placed simply. Reload the page to try again, or show fewer elements.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('can be stopped when the layout is no longer wanted', () => {
    vi.useFakeTimers();
    try {
      const timed = withinTimeLimit(new Promise(() => undefined), 30_000);
      timed.cancel();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
