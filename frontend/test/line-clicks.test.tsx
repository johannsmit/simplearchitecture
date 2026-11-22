import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JgfDocument, JgfEdge, ModelSummary } from '@simplearchitecture/shared';
import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nearestLineAt } from '../src/viewing/explorer/canvas/ExplorerCanvas';
import type * as Labels from '../src/viewing/explorer/canvas/labels';
import { admin, renderAt, stubApi, viewer } from './helpers';

// One click on a line or its label opens the relationship. Made-up data only.

// jsdom has no layout, so no spot is ever free for a label: place every label at the origin.
vi.mock('../src/viewing/explorer/canvas/labels', async (importOriginal) => ({
  ...(await importOriginal<typeof Labels>()),
  placeLabel: () => ({ x: 0, y: 0 }),
}));

const modelId = '77777777-7777-4777-8777-777777777777';
const edges: JgfEdge[] = [
  {
    id: 'r-api',
    source: 'hub',
    target: 'api',
    relation: 'Relation',
    metadata: { informationFlow: true },
    label: 'REST calls',
  },
  {
    id: 'r-crm1',
    source: 'hub',
    target: 'crm',
    relation: 'Relation',
    metadata: { informationFlow: true },
  },
  {
    id: 'r-crm2',
    source: 'hub',
    target: 'crm',
    relation: 'Relation',
    metadata: { informationFlow: true },
  },
];
const model: JgfDocument = {
  graph: {
    id: modelId,
    label: 'Made-up lines',
    nodes: {
      hub: { label: 'Hub', metadata: { type: 'Application' } },
      api: { label: 'Gateway', metadata: { type: 'Application' } },
      crm: { label: 'CRM', metadata: { type: 'Application' } },
    },
    edges,
  },
};
const summary: ModelSummary = {
  id: modelId,
  name: 'Made-up lines',
  createdAt: '2026-10-30T08:00:00.000Z',
  createdBy: { id: 'u1', name: 'Alex Morgan' },
  nodeCount: 3,
  edgeCount: 3,
};

function open(space: 'viewing' | 'modelling') {
  stubApi(space === 'viewing' ? viewer : admin, ({ url, method }) => {
    if (method !== 'GET') return undefined;
    if (url === '/api/models') return Response.json({ models: [summary] });
    if (url === `/api/models/${modelId}`) return Response.json(model);
    const relationship = /\/relationships\/(.+)$/.exec(url)?.[1];
    if (relationship !== undefined) {
      const edge = edges.find((e) => e.id === decodeURIComponent(relationship));
      return Response.json({ relationship: { id: edge?.id, version: 1, edge }, warnings: [] });
    }
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
}

const canvas = () => screen.getByRole('region', { name: /^Diagram:/ });
const details = () => screen.getByRole('complementary', { name: 'Details' });

async function line(name: RegExp): Promise<HTMLElement> {
  await waitFor(() => {
    expect(canvas().querySelectorAll('.react-flow__edge').length).toBe(2);
  });
  return [...canvas().querySelectorAll<HTMLElement>('.react-flow__edge')].find((edge) =>
    name.test(edge.getAttribute('aria-label') ?? ''),
  ) as HTMLElement;
}

/** Hovers the line: it lights up and shows its label. */
async function labelOf(edge: HTMLElement): Promise<HTMLElement> {
  fireEvent.mouseEnter(edge);
  return waitFor(() => {
    const label = document.querySelector<HTMLElement>('.edge-label.is-lit');
    expect(label).not.toBeNull();
    return label as HTMLElement;
  });
}

/**
 * A press on an element that moves the pointer from one point to another before it lets go, with
 * the events a browser sends: the canvas's pan listens to the mouse events, the label to both.
 */
function pressAndMove(
  target: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const send = (type: keyof typeof createEvent, at: { x: number; y: number }) => {
    const event = createEvent[type](target, { button: 0, bubbles: true });
    // jsdom refuses a view in the constructor, and the pan reads it.
    Object.defineProperties(event, {
      clientX: { value: at.x },
      clientY: { value: at.y },
      view: { value: window },
    });
    fireEvent(target, event);
  };
  send('pointerDown', from);
  send('mouseDown', from);
  send('pointerMove', to);
  send('mouseMove', to);
  send('pointerUp', to);
  send('mouseUp', to);
  send('click', to);
}

describe('a click on a line or its label', () => {
  it.each(['viewing', 'modelling'] as const)(
    'opens the relationship from its label at once (%s)',
    async (space) => {
      open(space);
      const label = await labelOf(await line(/Gateway/));
      expect(label.textContent).toBe('REST calls');

      // From the line onto its label: the line stays lit, so the label stays.
      const edge = await line(/Gateway/);
      // A browser sends both in one go, so React handles them together.
      act(() => {
        fireEvent.mouseLeave(edge);
        fireEvent.mouseEnter(label);
      });
      expect(document.querySelector('.edge-label')).toBe(label);

      fireEvent.pointerDown(label, { clientX: 100, clientY: 100 });
      fireEvent.click(label, { clientX: 101, clientY: 100 });
      expect(
        await within(details()).findByRole('heading', {
          level: 2,
          name: 'Hub relates to Gateway',
        }),
      ).toBeTruthy();
    },
  );

  it('offers the chooser from the label of a line holding several relationships', async () => {
    open('viewing');
    const label = await labelOf(await line(/CRM/));
    fireEvent.click(label);
    expect(await screen.findByRole('menu', { name: '2 relationships' })).toBeTruthy();
  });

  it.each([
    ['viewing', 2],
    ['viewing', 3],
    ['modelling', 3],
    ['modelling', 4],
  ] as const)(
    'opens the relationship from its label after a press that moved a little (%s, %ipx)',
    async (space, by) => {
      open(space);
      const label = await labelOf(await line(/Gateway/));
      pressAndMove(label, { x: 100, y: 100 }, { x: 100 + by, y: 100 });
      expect(
        await within(details()).findByRole('heading', {
          level: 2,
          name: 'Hub relates to Gateway',
        }),
      ).toBeTruthy();
    },
  );

  it('pans and opens nothing when the press on the label moved further (a drag)', async () => {
    open('viewing');
    const label = await labelOf(await line(/Gateway/));
    const viewport = () =>
      canvas().querySelector<HTMLElement>('.react-flow__viewport')?.style.transform;
    // Until the fit after the layout has stopped moving the view, so only the drag can move it.
    let before = viewport();
    for (let tries = 0; tries < 30; tries++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      if (viewport() === before && tries > 1) break;
      before = viewport();
    }
    pressAndMove(label, { x: 100, y: 100 }, { x: 130, y: 120 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(viewport()).not.toBe(before);
    expect(within(details()).queryByRole('heading', { name: /relates to/ })).toBeNull();
  });

  it('opens nothing when the press on the label moved (a pan)', async () => {
    open('viewing');
    const label = await labelOf(await line(/Gateway/));
    fireEvent.pointerDown(label, { clientX: 100, clientY: 100 });
    fireEvent.click(label, { clientX: 160, clientY: 130 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(details()).queryByRole('heading', { name: /relates to/ })).toBeNull();
  });

  it('gives each line a 20px click area', async () => {
    open('viewing');
    const edge = await line(/Gateway/);
    expect(edge.querySelector('.react-flow__edge-interaction')?.getAttribute('stroke-width')).toBe(
      '20',
    );
  });

  it('keeps every line drawn while a card or line is hovered', async () => {
    open('viewing');
    const edge = await line(/Gateway/);
    let dropped = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node instanceof Element && node.querySelector('.react-flow__edge')) dropped++;
        }
      }
    });
    observer.observe(canvas(), { childList: true, subtree: true });
    fireEvent.mouseEnter(edge);
    fireEvent.mouseLeave(edge);
    fireEvent.mouseEnter(canvas().querySelector('.react-flow__node') as HTMLElement);
    await new Promise((resolve) => setTimeout(resolve, 50));
    observer.disconnect();
    expect(dropped).toBe(0);
    expect(canvas().querySelectorAll('.react-flow__edge')).toHaveLength(2);
  });

  it('styles the label and the click area so a browser hits them', () => {
    const css = readFileSync(join(import.meta.dirname, '../src/styles/explorer.css'), 'utf8');
    expect(css).toMatch(/\.canvas \.react-flow__edge-interaction \{\s*stroke: transparent;/);
    expect(css).toMatch(/\.edge-label \{[^}]*pointer-events: all;[^}]*cursor: pointer;/);
  });
});

describe('nearestLineAt', () => {
  const original = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint');
  afterEach(() => {
    if (original) Object.defineProperty(document, 'elementsFromPoint', original);
    else Reflect.deleteProperty(document, 'elementsFromPoint');
  });

  /** A fake straight line from (x1, y) to (x2, y) on screen, as elementsFromPoint returns it. */
  function fakeLine(id: string, x1: number, x2: number, y: number): Element {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'react-flow__edge');
    g.setAttribute('data-id', id);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'react-flow__edge-interaction');
    g.appendChild(path);
    Object.assign(path, {
      getScreenCTM: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      getTotalLength: () => x2 - x1,
      getPointAtLength: (at: number) => ({ x: x1 + at, y }),
    });
    return path;
  }

  it('picks the line nearest the pointer, not the one drawn on top', () => {
    const onTop = fakeLine('l-top', 0, 100, 58);
    const below = fakeLine('l-below', 0, 100, 50);
    document.elementsFromPoint = () => [onTop, below];
    expect(nearestLineAt(40, 51, 'l-top')).toBe('l-below');
    expect(nearestLineAt(40, 57, 'l-top')).toBe('l-top');
  });

  it('falls back to the line clicked when no line is found', () => {
    document.elementsFromPoint = () => [];
    expect(nearestLineAt(1, 1, 'l-clicked')).toBe('l-clicked');
    document.elementsFromPoint = () => {
      throw new TypeError('not implemented');
    };
    expect(nearestLineAt(1, 1, 'l-clicked')).toBe('l-clicked');
  });
});
