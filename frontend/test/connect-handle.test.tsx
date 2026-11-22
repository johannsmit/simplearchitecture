import type { JgfDocument, ModelSummary } from '@simplearchitecture/shared';
import { act, createEvent, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  connectHandleAt,
  connectHandleCentre,
  connectHandleReach,
} from '../src/viewing/explorer/canvas/connectHandle';
import { admin, renderAt, stubApi, viewer } from './helpers';

// In Modelling, a card's connect handle can always be grabbed, even where a line's label lies over
// it. Made-up data only.

const modelId = '78787878-7878-4878-8878-787878787878';
const model: JgfDocument = {
  graph: {
    id: modelId,
    label: 'Made-up handles',
    nodes: {
      hub: { label: 'Hub', metadata: { type: 'Application' } },
      api: { label: 'Gateway', metadata: { type: 'Application' } },
    },
    edges: [{ id: 'r-api', source: 'hub', target: 'api', relation: 'Relation', label: 'Calls' }],
  },
};
const summary: ModelSummary = {
  id: modelId,
  name: 'Made-up handles',
  createdAt: '2026-10-30T08:00:00.000Z',
  createdBy: { id: 'u1', name: 'Alex Morgan' },
  nodeCount: 2,
  edgeCount: 1,
};

async function open(space: 'viewing' | 'modelling') {
  stubApi(space === 'viewing' ? viewer : admin, ({ url, method }) => {
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
  renderAt(`/${space}/models/${modelId}/elements/hub`);
  await waitFor(() => {
    expect(label()).not.toBeNull();
  });
  // Until the canvas's pan and zoom stop changing (the fit can still be running).
  const viewport = () =>
    canvas().querySelector<HTMLElement>('.react-flow__viewport')?.style.transform;
  let before = viewport();
  for (let tries = 0; tries < 30; tries++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    const now = viewport();
    if (now === before && tries > 1) return;
    before = now;
  }
}

const canvas = () => screen.getByRole('region', { name: /^Diagram:/ });
const label = () => document.querySelector<HTMLElement>('.edge-label');
const nodeOf = (id: string) =>
  canvas()
    .querySelector<HTMLElement>(`.card[data-element-id="${id}"]`)
    ?.closest<HTMLElement>('.react-flow__node') as HTMLElement;

/** Where a card's connect handle is on the screen (jsdom puts the canvas at the screen's corner). */
function handleOnScreen(id: string) {
  const node = nodeOf(id);
  const [x = 0, y = 0] =
    /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(node.style.transform)?.slice(1).map(Number) ?? [];
  const centre = connectHandleCentre(
    { x, y, width: parseFloat(node.style.width), height: parseFloat(node.style.height) },
    'card',
  );
  const viewport = canvas().querySelector<HTMLElement>('.react-flow__viewport');
  const transform = viewport?.style.transform ?? '';
  const [tx = 0, ty = 0] =
    /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(transform)?.slice(1).map(Number) ?? [];
  const zoom = Number(/scale\(([-\d.]+)\)/.exec(transform)?.[1] ?? 1);
  return { x: tx + centre.x * zoom, y: ty + centre.y * zoom, zoom };
}

function pointerMove(target: Element, at: { x: number; y: number }) {
  const event = createEvent.pointerMove(target, { bubbles: true });
  Object.defineProperties(event, { clientX: { value: at.x }, clientY: { value: at.y } });
  fireEvent(target, event);
}

const labelZ = 2000;
const lifted = (id: string) =>
  Number(nodeOf(id).style.zIndex) > labelZ &&
  nodeOf(id).querySelector('.card')?.classList.contains('is-connect-hot') === true;

describe('a label over a connect handle (Modelling)', () => {
  it('lets the handle through: its card comes above the labels, with the handle shown', async () => {
    await open('modelling');
    expect(lifted('hub')).toBe(false);
    const at = handleOnScreen('hub');
    // The label lies over Hub's handle there: the pointer is on the label.
    pointerMove(label() as HTMLElement, at);
    await waitFor(() => {
      expect(lifted('hub')).toBe(true);
    });
    const handle = nodeOf('hub').querySelector('.connect-handle');
    expect(handle).not.toBeNull();
    // While the pointer stays at the handle (5px from its centre on the canvas), now on the handle
    // itself, the card stays above.
    pointerMove(handle as Element, { x: at.x + 5 * at.zoom, y: at.y });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lifted('hub')).toBe(true);
    // Away from it, the labels are on top again.
    pointerMove(label() as HTMLElement, { x: at.x + 200, y: at.y + 200 });
    await waitFor(() => {
      expect(lifted('hub')).toBe(false);
    });
  });

  it('leaves the cards as they are elsewhere, and in Viewing', async () => {
    await open('modelling');
    const at = handleOnScreen('hub');
    pointerMove(label() as HTMLElement, { x: at.x + 200, y: at.y });
    pointerMove(canvas(), at);
    expect(lifted('hub')).toBe(false);
  });

  it('has no handle to let through in Viewing', async () => {
    await open('viewing');
    pointerMove(label() as HTMLElement, handleOnScreen('hub'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lifted('hub')).toBe(false);
  });
});

describe('connectHandleAt', () => {
  const box = { x: 100, y: 40, width: 168, height: 44 };

  it('finds the card whose handle is under the point, the nearest of several', () => {
    const cards = [
      { id: 'a', box, shape: 'card' as const },
      { id: 'b', box: { ...box, x: 270 }, shape: 'card' as const },
    ];
    expect(connectHandleCentre(box, 'card')).toEqual({ x: 268, y: 62 });
    expect(connectHandleAt({ x: 268, y: 62 }, cards)).toBe('a');
    expect(connectHandleAt({ x: 268 + connectHandleReach, y: 62 }, cards)).toBe('a');
    expect(connectHandleAt({ x: 268 + connectHandleReach + 1, y: 62 }, cards)).toBeUndefined();
    expect(connectHandleAt({ x: 100, y: 62 }, cards)).toBeUndefined();
  });

  it('knows where a container’s and a Stakeholder’s handles are', () => {
    expect(connectHandleCentre({ ...box, height: 200 }, 'container')).toEqual({ x: 268, y: 60 });
    expect(connectHandleCentre({ ...box, width: 120, height: 80 }, 'circle')).toEqual({
      x: 184,
      y: 64,
    });
  });
});
