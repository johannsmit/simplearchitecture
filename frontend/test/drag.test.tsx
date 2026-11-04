import axe from 'axe-core';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  pillText,
  relatedButtonLabel,
  relatedButtonTitle,
} from '../src/viewing/explorer/canvas/ElementCard';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import {
  currentLocation,
  expectNoSeriousAxeViolations,
  renderAt,
  stubApi,
  viewer,
  type Handler,
} from './helpers';

/** Moving cards on the canvas, the round count button, an unreadable model, heading order. */

const base = `/viewing/models/${bakeryId}`;
const elementUrl = (id: string, depth = 1) =>
  `${base}/elements/${encodeURIComponent(id)}?depth=${depth}`;

function api(model: unknown = bakeryModel): Handler {
  return ({ url, method }) => {
    if (method !== 'GET') return undefined;
    if (url === '/api/models') return Response.json({ models: [bakerySummary] });
    if (url === `/api/models/${bakeryId}`) return Response.json(model);
    return undefined;
  };
}

function open(path: string, model?: unknown) {
  stubApi(viewer, api(model));
  renderAt(path);
}

const canvas = () => screen.getByRole('region', { name: /^Diagram:/ });
const tidy = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Tidy up' });
const live = () => canvas().querySelector('[aria-live="polite"]')?.textContent ?? '';

async function card(name: string): Promise<HTMLElement> {
  let found: HTMLElement | undefined;
  await waitFor(() => {
    found = [...canvas().querySelectorAll<HTMLElement>('.card-main')].find((c) =>
      c.getAttribute('aria-label')?.startsWith(name),
    );
    expect(found).toBeDefined();
  });
  return found as HTMLElement;
}

const nodeOf = (button: HTMLElement) => button.closest('.react-flow__node') as HTMLElement;

/** The card's position on the canvas, from React Flow's transform. */
function position(button: HTMLElement): { x: number; y: number } {
  const match = /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(nodeOf(button).style.transform);
  return { x: Number(match?.[1]), y: Number(match?.[2]) };
}

/** A fresh look-up: React Flow may replace the button's element after a layout. */
async function positionOf(name: string) {
  return position(await card(name));
}

/** A mouse event with `view` set (jsdom refuses it in the constructor; d3-drag needs it). */
function mouse(target: EventTarget, type: string, clientX: number, clientY: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, 'view', { value: window });
  act(() => {
    target.dispatchEvent(event);
  });
}

/** Drags with the mouse (d3-drag listens on the node, then on the window). */
function drag(button: HTMLElement, dx: number, dy: number) {
  const node = nodeOf(button);
  mouse(node, 'mousedown', 100, 100);
  mouse(window, 'mousemove', 100 + dx / 2, 100 + dy / 2);
  mouse(window, 'mousemove', 100 + dx, 100 + dy);
  mouse(window, 'mouseup', 100 + dx, 100 + dy);
}

const edgePaths = () =>
  [...canvas().querySelectorAll('.react-flow__edge path.react-flow__edge-path')].map((p) =>
    p.getAttribute('d'),
  );

describe('dragging cards with the mouse', () => {
  it('hides the resting labels during a drag, and shows them again on the drop', async () => {
    open(elementUrl('shop'));

    const till = await card('Till');
    await waitFor(() => {
      expect(document.querySelectorAll('.edge-label').length).toBeGreaterThan(0);
    });
    const node = nodeOf(till);
    mouse(node, 'mousedown', 100, 100);
    mouse(window, 'mousemove', 160, 140);
    await waitFor(() => {
      expect(document.querySelectorAll('.edge-label')).toHaveLength(0);
    });
    mouse(window, 'mouseup', 160, 140);
    await waitFor(() => {
      expect(document.querySelectorAll('.edge-label').length).toBeGreaterThan(0);
    });
  });

  it('moves the card, its edges follow, and Tidy up puts it back', async () => {
    open(elementUrl('shop'));

    const till = await card('Till');
    const start = position(till);
    const before = edgePaths();
    expect(tidy().disabled).toBe(true);

    drag(till, 120, 80);
    // The view is zoomed to fit, so the card moves by the distance divided by the zoom.
    await waitFor(() => {
      expect(position(till).x).toBeGreaterThan(start.x);
    });
    expect(position(till).y).toBeGreaterThan(start.y);
    // Edges follow the card.
    expect(edgePaths()).not.toEqual(before);
    // Visual only: the URL doesn't change, and nothing is stored.
    expect(currentLocation()).toBe(elementUrl('shop'));
    expect(Object.keys(localStorage).filter((key) => !key.startsWith('sa-'))).toEqual([]);
    const stored = Object.keys(localStorage).map((key) => localStorage.getItem(key));
    expect(JSON.stringify(stored)).not.toMatch(/till|"x"/i);
    expect(tidy().disabled).toBe(false);

    fireEvent.click(tidy());
    await waitFor(() => {
      expect(position(till)).toEqual(start);
    });
    expect(tidy().disabled).toBe(true);
    // The button is now disabled: focus goes to the canvas, never to <body>.
    expect(document.activeElement).toBe(canvas());
    expect(live()).toBe('Layout tidied up.');
  });

  it('treats a movement under 4px as a click, which selects the element', async () => {
    open(elementUrl('shop'));

    const till = await card('Till');
    const start = position(till);
    drag(till, 3, 0);
    fireEvent.click(till);
    expect(position(till)).toEqual(start);
    // A click selects (no focus change); a double click focuses.
    expect(till.closest('.card')?.classList.contains('is-selected')).toBe(true);
    expect(currentLocation()).toMatch(/\/elements\/shop/);
    fireEvent.click(till, { detail: 2 });
    expect(currentLocation()).toMatch(/\/elements\/till/);
  });
});

describe('moving a card with the keyboard (move mode)', () => {
  it('M starts, arrows move 8px (40px with Shift), Enter drops; other canvas keys wait', async () => {
    open(elementUrl('shop'));

    const shop = await card('Web Shop');
    expect(shop.getAttribute('aria-keyshortcuts')).toBe('M');
    const start = position(shop);
    shop.focus();
    fireEvent.keyDown(shop, { key: 'm' });
    expect(live()).toBe(
      'Moving Web Shop. Use the arrow keys, then Enter to drop or Escape to cancel.',
    );
    expect(screen.getByText(/Arrow keys move it, Shift for bigger steps/).textContent).toContain(
      'Web Shop',
    );
    expect(shop.closest('.card')?.classList.contains('is-moving')).toBe(true);

    fireEvent.keyDown(shop, { key: 'ArrowRight' });
    fireEvent.keyDown(shop, { key: 'ArrowDown', shiftKey: true });
    await waitFor(() => {
      expect(position(shop)).toEqual({ x: start.x + 8, y: start.y + 40 });
    });
    // Depth keys are ignored while moving, and the arrows don't move between cards.
    fireEvent.keyDown(shop, { key: '3' });
    expect(currentLocation()).toBe(elementUrl('shop'));
    expect(document.activeElement).toBe(shop);

    // Enter drops: it doesn't click the card (no navigation).
    const enter = fireEvent.keyDown(shop, { key: 'Enter' });
    expect(enter).toBe(false); // default prevented
    expect(live()).toBe('Web Shop moved.');
    expect(screen.queryByText(/Arrow keys move it/)).toBeNull();
    expect(shop.closest('.card')?.classList.contains('is-moving')).toBe(false);
    expect(position(shop)).toEqual({ x: start.x + 8, y: start.y + 40 });
    expect(tidy().disabled).toBe(false);

    // After the drop, arrows move between cards again.
    fireEvent.keyDown(shop, { key: 'ArrowUp' });
    expect(document.activeElement).not.toBe(shop);
  });

  it('Esc cancels: the card goes back to where it started', async () => {
    open(elementUrl('shop'));

    const shop = await card('Web Shop');
    const start = position(shop);
    shop.focus();
    fireEvent.keyDown(shop, { key: 'M' });
    fireEvent.keyDown(shop, { key: 'ArrowUp' });
    fireEvent.keyDown(shop, { key: 'ArrowUp' });
    await waitFor(() => {
      expect(position(shop).y).toBe(start.y - 16);
    });
    fireEvent.keyDown(shop, { key: 'Escape' });
    await waitFor(() => {
      expect(position(shop)).toEqual(start);
    });
    expect(live()).toBe('Move cancelled.');
    // Nothing moved, so there is nothing to tidy up; focus stays on the card.
    expect(tidy().disabled).toBe(true);
    expect(document.activeElement).toBe(shop);
  });

  it('M again drops too, and so does focus leaving the card', async () => {
    open(elementUrl('shop'));

    const shop = await card('Web Shop');
    shop.focus();
    fireEvent.keyDown(shop, { key: 'm' });
    fireEvent.keyDown(shop, { key: 'ArrowLeft' });
    fireEvent.keyDown(shop, { key: 'm' });
    expect(live()).toBe('Web Shop moved.');

    fireEvent.keyDown(shop, { key: 'm' });
    fireEvent.keyDown(shop, { key: 'ArrowLeft' });
    act(() => {
      screen.getByRole('button', { name: 'Back' }).focus();
      (document.getElementById('canvas') as HTMLElement).focus();
    });
    expect(live()).toBe('Web Shop moved.');
    expect(shop.closest('.card')?.classList.contains('is-moving')).toBe(false);
  });

  it('has no serious axe issues in move mode', async () => {
    open(elementUrl('shop'));

    const shop = await card('Web Shop');
    shop.focus();
    fireEvent.keyDown(shop, { key: 'm' });
    await expectNoSeriousAxeViolations();
  });
});

describe('moved cards and the layout', () => {
  it('clears moved cards on a depth change and on a focus change', async () => {
    open(elementUrl('shop'));

    let till = await card('Till');
    const start = position(till);
    drag(till, 60, 0);
    await waitFor(() => {
      expect(tidy().disabled).toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => {
      expect(tidy().disabled).toBe(true);
    });
    fireEvent.click(screen.getByRole('button', { name: '1' }));
    till = await card('Till');
    await waitFor(() => {
      expect(position(till)).toEqual(start);
    });

    drag(till, 60, 0);
    await waitFor(() => {
      expect(tidy().disabled).toBe(false);
    });
    // Clicking a card focuses its element.
    fireEvent.click(await card('Till'), { detail: 2 });
    expect(currentLocation()).toBe(elementUrl('till'));
    await waitFor(() => {
      expect(tidy().disabled).toBe(true);
    });
  });

  it('keeps a moved card in its place when an element is added from the popup', async () => {
    open(elementUrl('customer'));

    const shop = await card('Web Shop');
    shop.focus();
    fireEvent.keyDown(shop, { key: 'm' });
    for (let i = 0; i < 5; i++) fireEvent.keyDown(shop, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(shop, { key: 'Enter' });
    const movedTo = await positionOf('Web Shop');
    const customerBefore = await positionOf('Customer');

    const count = within(shop.closest('.card') as HTMLElement).getByRole('button', {
      name: '4 related elements not on the canvas, show them',
    });
    fireEvent.click(count);
    fireEvent.click(
      screen.getAllByRole('menuitem', {
        name: 'Oven Planner, Application, add to canvas',
      })[0] as HTMLElement,
    );
    await waitFor(() => {
      expect(canvas().querySelectorAll('.card')).toHaveLength(3);
    });
    await card('Oven Planner');
    expect(await positionOf('Web Shop')).toEqual(movedTo);
    // The focused card (not moved) stays put too: the new layout is aligned on it.
    expect(await positionOf('Customer')).toEqual(customerBefore);
    expect(tidy().disabled).toBe(false);

    // Tidy up lays out all three afresh.
    fireEvent.click(tidy());
    await waitFor(() => {
      expect(tidy().disabled).toBe(true);
    });
    expect(canvas().querySelectorAll('.card')).toHaveLength(3);
  });
});

describe('relationship pill', () => {
  it('shows the relationship icon and the number, with a name and a tooltip', async () => {
    open(elementUrl('customer'));

    await card('Web Shop');
    const count = screen.getByRole('button', {
      name: '4 related elements not on the canvas, show them',
    });
    expect(count.classList.contains('cpill')).toBe(true);
    expect(count.textContent).toBe('4');
    // The decorative spline icon: two nodes and a curve.
    const icon = count.querySelector('svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.querySelectorAll('circle')).toHaveLength(2);
    expect(count.getAttribute('title')).toBe('4 related elements not on the canvas');
    expect(count.getAttribute('aria-haspopup')).toBe('menu');
    expect(pillText(1)).toBe('1');
    expect(pillText(999)).toBe('999');
    expect(pillText(1000)).toBe('999+');
    expect(relatedButtonLabel(1)).toBe('1 related element not on the canvas, show it');
    expect(relatedButtonLabel(1204)).toBe('1,204 related elements not on the canvas, show them');
    expect(relatedButtonTitle(1)).toBe('1 related element not on the canvas');
  });

  it('names the full count when it shows 999+', async () => {
    const nodes: Record<string, { label: string; metadata: { type: string } }> = {
      hub: { label: 'Hub', metadata: { type: 'Application' } },
    };
    const edges = [];
    for (let i = 0; i <= 1001; i++) {
      nodes[`n${i}`] = { label: `Leaf ${i}`, metadata: { type: 'Other' } };
      edges.push({ source: 'hub', target: `n${i}`, relation: 'Relation' });
    }
    // Leaf 0 and the hub are on the canvas; the hub's other 1,001 leaves aren't.
    open(elementUrl('n0'), {
      graph: { nodes, edges },
    });

    const hub = await card('Hub');
    const count = within(hub.closest('.card') as HTMLElement).getByRole('button', {
      name: '1,001 related elements not on the canvas, show them',
    });
    expect(count.textContent).toBe('999+');
  });

  it('counts many relationships to one missing element once', async () => {
    const nodes = {
      hub: { label: 'Hub', metadata: { type: 'Application' } },
      leaf: { label: 'Leaf', metadata: { type: 'Other' } },
      start: { label: 'Start', metadata: { type: 'Other' } },
    };
    const edges = [
      { source: 'start', target: 'hub', relation: 'Relation' },
      ...Array.from({ length: 1001 }, () => ({
        source: 'hub',
        target: 'leaf',
        relation: 'Relation',
      })),
    ];
    open(elementUrl('start'), {
      graph: { nodes, edges },
    });

    const hub = await card('Hub');
    const count = within(hub.closest('.card') as HTMLElement).getByRole('button', {
      name: '1 related element not on the canvas, show it',
    });
    expect(count.textContent).toBe('1');
  });
});

describe('heading order', () => {
  it('has no heading-order issue in the explorer', async () => {
    open(elementUrl('shop'));

    await card('Web Shop');
    const results = await axe.run(document.body, {
      runOnly: ['heading-order'],
      resultTypes: ['violations'],
    });
    expect(results.violations).toEqual([]);
    expect(screen.getByRole('heading', { level: 2, name: 'Elements' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Relationship state' })).toBeTruthy();
  });
});

describe('a model the client can’t read', () => {
  it.each([
    ['edges that are not a list', { graph: { nodes: { a: { label: 'A' } }, edges: 5 } }],
    ['an edge that is not an object', { graph: { nodes: { a: { label: 'A' } }, edges: [5] } }],
    ['a node that is not an object', { graph: { nodes: { a: 'A' } } }],
  ] satisfies [string, unknown][])(
    '%s: a plain message, never error text',
    async (_name, model) => {
      open(base, model);

      const heading = await screen.findByRole('heading', { name: "The model couldn't be loaded." });
      const text = heading.closest('main')?.textContent ?? '';
      expect(text).toContain('The server sent an unexpected model.');
      expect(text).not.toMatch(/is not a function|undefined|TypeError|Cannot read/);
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    },
  );
});
