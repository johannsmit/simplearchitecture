import { createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { floatingEnds, type EndBox } from '../src/viewing/explorer/canvas/edgeLine';
import type { JgfDocument, ModelSummary } from '@simplearchitecture/shared';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { modeller, renderAt, stubApi, viewer, type Handler } from './helpers';

// Lines without a layout route leave and enter where their cards face each other, and a renamed
// card never grows over its neighbour. Made-up data (the bakery fixture).

const canvasEl = () => document.getElementById('canvas') as HTMLElement;
const card = (id: string) =>
  canvasEl().querySelector<HTMLElement>(`.card[data-element-id="${CSS.escape(id)}"]`);
const cardIds = () =>
  [...canvasEl().querySelectorAll('.card[data-element-id]')].map(
    (element) => element.getAttribute('data-element-id') ?? '',
  );
const nodeOf = (id: string) => card(id)?.closest<HTMLElement>('.react-flow__node');

function boxOf(id: string): EndBox {
  const node = nodeOf(id) as HTMLElement;
  const match = /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(node.style.transform);
  return {
    x: Number(match?.[1]),
    y: Number(match?.[2]),
    width: parseFloat(node.style.width),
    height: parseFloat(node.style.height),
  };
}

/** The first and last points of a line's path ("M x y…L x y"). */
function endsOf(label: RegExp) {
  const edge = [...canvasEl().querySelectorAll('.react-flow__edge')].find((e) =>
    label.test(e.getAttribute('aria-label') ?? ''),
  );
  const d = edge?.querySelector('path.react-flow__edge-path')?.getAttribute('d') ?? '';
  const numbers = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  return {
    start: { x: numbers[0] ?? NaN, y: numbers[1] ?? NaN },
    end: { x: numbers.at(-2) ?? NaN, y: numbers.at(-1) ?? NaN },
  };
}

/** The point is on that side of the box. */
function expectOnSide(point: { x: number; y: number }, box: EndBox, side: string) {
  const edge = { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height };
  if (side === 'left' || side === 'right') {
    expect(point.x).toBeCloseTo(edge[side]);
    expect(point.y).toBeGreaterThanOrEqual(box.y);
    expect(point.y).toBeLessThanOrEqual(box.y + box.height);
  } else {
    expect(point.y).toBeCloseTo(edge[side as 'top' | 'bottom']);
    expect(point.x).toBeGreaterThanOrEqual(box.x);
    expect(point.x).toBeLessThanOrEqual(box.x + box.width);
  }
}

/** A made-up model where one element relates to three others of one type: a row of three. */
const rowId = '44444444-4444-4444-8444-444444444444';
const rowModel: JgfDocument = {
  graph: {
    id: rowId,
    label: 'Made-up row',
    directed: true,
    nodes: {
      hub: { label: 'Hub', metadata: { type: 'Business' } },
      one: { label: 'One', metadata: { type: 'Application' } },
      two: { label: 'Two', metadata: { type: 'Application' } },
      three: { label: 'Three', metadata: { type: 'Application' } },
    },
    edges: [
      { id: 'r1', source: 'hub', target: 'one', relation: 'Relation' },
      { id: 'r2', source: 'hub', target: 'two', relation: 'Relation' },
      { id: 'r3', source: 'hub', target: 'three', relation: 'Relation' },
    ],
  },
};
const rowSummary: ModelSummary = { ...bakerySummary, id: rowId, name: 'Made-up row' };

function modelApi(id: string, model: JgfDocument, summary: ModelSummary): Handler {
  const nodes = new Map(Object.entries(model.graph.nodes ?? {}));
  const elementsUrl = `/api/models/${id}/elements/`;
  return ({ url, method, body }) => {
    if (url === '/api/models') return Response.json({ models: [summary], editable: true });
    if (url === `/api/models/${id}`) return Response.json(model);
    if (!url.startsWith(elementsUrl)) return undefined;
    const elementId = decodeURIComponent(url.slice(elementsUrl.length).split('?')[0] ?? '');
    let version = 1;
    if (method === 'PATCH') {
      const change = JSON.parse(String(body)) as { name?: string };
      const node = nodes.get(elementId) ?? { label: '' };
      nodes.set(elementId, { ...node, label: change.name ?? node.label ?? '' });
      version = 2;
    }
    return Response.json({
      element: { id: elementId, version, node: nodes.get(elementId) },
      warnings: [],
    });
  };
}

async function open(
  space: 'viewing' | 'modelling',
  id: string,
  count: number,
  [modelId, model, summary]: [string, JgfDocument, ModelSummary] = [
    bakeryId,
    bakeryModel,
    bakerySummary,
  ],
) {
  stubApi(space === 'viewing' ? viewer : modeller, modelApi(modelId, model, summary));
  renderAt(`/${space}/models/${modelId}/elements/${encodeURIComponent(id)}?depth=1`);
  await waitFor(() => {
    expect(cardIds()).toHaveLength(count);
    expect(canvasEl().querySelectorAll('.react-flow__edge').length).toBeGreaterThan(0);
  });
}

describe('a moved card', () => {
  it('has its line leave and enter where the cards are now, as it moves', async () => {
    await open('viewing', 'till', 2);
    const main = card('till')?.querySelector('.card-main') as HTMLElement;
    main.focus();
    fireEvent.keyDown(main, { key: 'm' });
    // Up and to the right of the shop, step by step: the line follows at every step.
    const steps = [
      { key: 'ArrowUp', shiftKey: true },
      { key: 'ArrowUp', shiftKey: true },
      { key: 'ArrowUp', shiftKey: true },
      { key: 'ArrowRight', shiftKey: true },
      { key: 'ArrowRight', shiftKey: true },
      { key: 'ArrowRight', shiftKey: true },
      { key: 'ArrowRight', shiftKey: true },
      { key: 'ArrowRight', shiftKey: true },
      { key: 'ArrowRight', shiftKey: true },
      { key: 'ArrowRight', shiftKey: true },
      { key: 'ArrowRight', shiftKey: true },
      { key: 'ArrowRight', shiftKey: true },
    ];
    for (const step of steps) {
      fireEvent.keyDown(main, step);
      await waitFor(() => {
        const till = boxOf('till');
        const shop = boxOf('shop');
        const expected = floatingEnds(
          [{ id: 'l', source: 'till', target: 'shop' }],
          new Map([
            ['till', till],
            ['shop', shop],
          ]),
        ).get('l');
        const { start, end } = endsOf(/^Till /);
        expectOnSide(start, till, expected?.start.side ?? '');
        expectOnSide(end, shop, expected?.end.side ?? '');
        expect(start.x).toBeCloseTo(expected?.start.x ?? NaN);
        expect(start.y).toBeCloseTo(expected?.start.y ?? NaN);
        expect(end.x).toBeCloseTo(expected?.end.x ?? NaN);
        expect(end.y).toBeCloseTo(expected?.end.y ?? NaN);
      });
    }
    fireEvent.keyDown(main, { key: 'Enter' });
  });
});

describe('a renamed card', () => {
  it('grows only into free room and never covers its neighbour', async () => {
    await open('modelling', 'hub', 4, [rowId, rowModel, rowSummary]);
    // The leftmost of the row of three has a neighbour right beside it.
    const row = ['one', 'two', 'three'].sort((a, b) => boxOf(a).x - boxOf(b).x);
    const [renamed = '', neighbour = ''] = row;
    expect(boxOf(renamed).y).toBe(boxOf(neighbour).y);
    const others = cardIds().filter((id) => id !== renamed);
    const before = new Map(others.map((id) => [id, nodeOf(id)?.style.transform]));
    const oldName = rowModel.graph.nodes?.[renamed]?.label ?? '';
    await screen.findByRole('form', { name: /^Edit / });
    // Select the card, then rename it in the details panel.
    fireEvent.click(card(renamed)?.querySelector('.card-main') as HTMLElement);
    const nameField = () =>
      within(screen.getByRole('form', { name: /^Edit / })).getByRole<HTMLInputElement>('textbox', {
        name: /^Name/,
      });
    await waitFor(() => {
      expect(nameField().value).toBe(oldName);
    });
    // The version is read before a save.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const longName = `${oldName} with a very long name that needs many more words to fit in`;
    fireEvent.change(nameField(), { target: { value: longName } });
    fireEvent.keyDown(nameField(), { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(card(renamed)?.textContent).toContain('many more words');
    });
    for (const id of others) expect(nodeOf(id)?.style.transform, id).toBe(before.get(id));
    const grown = boxOf(renamed);
    for (const id of others) {
      const other = boxOf(id);
      const apart =
        grown.x + grown.width <= other.x ||
        other.x + other.width <= grown.x ||
        grown.y + grown.height <= other.y ||
        other.y + other.height <= grown.y;
      expect(apart, `the renamed card covers ${id}`).toBe(true);
    }
    // Taller, so the name wraps, and as wide as the room allows.
    expect(grown.height).toBeGreaterThan(44);
    expect(grown.x + grown.width).toBeLessThanOrEqual(boxOf(neighbour).x - 28);
  });
});

describe('a card width set by hand', () => {
  const grip = (id: string) => card(id)?.querySelector<HTMLElement>('.cresize') as HTMLElement;
  const widthOf = (id: string) => parseFloat(nodeOf(id)?.style.width ?? '');
  const tidy = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Tidy up' });

  /** A pointer event at a point (jsdom's has no pointer position of its own). */
  function pointer(
    target: HTMLElement,
    type: 'pointerDown' | 'pointerMove' | 'pointerUp',
    x: number,
  ) {
    const event = createEvent[type](target, { pointerId: 1, bubbles: true });
    Object.defineProperties(event, { clientX: { value: x }, clientY: { value: 10 } });
    fireEvent(target, event);
  }

  it.each(['viewing', 'modelling'] as const)(
    'is set with the grip on the right edge, moving no other card (%s)',
    async (space) => {
      await open(space, 'till', 2);
      const before = widthOf('till');
      const shopAt = nodeOf('shop')?.style.transform;
      expect(card('shop')?.querySelector('.cresize')).toBeTruthy();
      pointer(grip('till'), 'pointerDown', 100);
      pointer(grip('till'), 'pointerMove', 140);
      pointer(grip('till'), 'pointerMove', 180);
      pointer(grip('till'), 'pointerUp', 180);
      await waitFor(() => {
        expect(widthOf('till')).toBeGreaterThan(before);
      });
      expect(nodeOf('shop')?.style.transform).toBe(shopAt);
      // Its line follows, from where the card is now.
      const { start } = endsOf(/^Till /);
      const till = boxOf('till');
      expect(
        [till.x, till.x + till.width].some((x) => Math.abs(start.x - x) < 0.01) ||
          [till.y, till.y + till.height].some((y) => Math.abs(start.y - y) < 0.01),
      ).toBe(true);
      // Tidy up lays out with the width as set.
      const set = widthOf('till');
      expect(tidy().disabled).toBe(false);
      fireEvent.click(tidy());
      await waitFor(() => {
        expect(tidy().disabled).toBe(true);
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(widthOf('till')).toBeGreaterThanOrEqual(set);
    },
  );

  it('has no grip on a Stakeholder circle', async () => {
    await open('viewing', 'customer', 2);
    expect(card('customer')?.querySelector('.cresize')).toBeNull();
    expect(card('shop')?.querySelector('.cresize')).toBeTruthy();
  });

  it('changes with Alt and the arrow keys in move mode, and Esc puts it back', async () => {
    await open('viewing', 'till', 2);
    const main = card('till')?.querySelector('.card-main') as HTMLElement;
    // Wider than the smallest first, so Esc has a width to go back to.
    main.focus();
    fireEvent.keyDown(main, { key: 'm' });
    fireEvent.keyDown(main, { key: 'ArrowRight', altKey: true, shiftKey: true });
    fireEvent.keyDown(main, { key: 'Enter' });
    await waitFor(() => {
      expect(widthOf('till')).toBeGreaterThan(168);
    });
    const before = widthOf('till');
    fireEvent.keyDown(main, { key: 'm' });
    fireEvent.keyDown(main, { key: 'ArrowRight', altKey: true, shiftKey: true });
    await waitFor(() => {
      expect(widthOf('till')).toBe(before + 40);
    });
    fireEvent.keyDown(main, { key: 'ArrowLeft', altKey: true });
    await waitFor(() => {
      expect(widthOf('till')).toBe(before + 32);
    });
    // Never narrower than a card's smallest width.
    for (let step = 0; step < 10; step++) {
      fireEvent.keyDown(main, { key: 'ArrowLeft', altKey: true, shiftKey: true });
    }
    await waitFor(() => {
      expect(widthOf('till')).toBe(168);
    });
    fireEvent.keyDown(main, { key: 'Escape' });
    await waitFor(() => {
      expect(widthOf('till')).toBe(before);
    });
  });
});

describe('the width grip and the connect handle', () => {
  const css = readFileSync(join(import.meta.dirname, '../src/styles/explorer.css'), 'utf8');
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf('}', at));
  };
  const px = (text: string, property: string) => {
    const match = new RegExp(`(?:^|\\s)${property}: (-?[\\d.]+)px`).exec(text);
    return Number(match?.[1] ?? 0);
  };

  it('keeps the grip and its hit area clear of the handle, at any zoom', () => {
    // Both are sized in the card's own pixels, so a zoom scales them alike: checking the smallest
    // card (44px tall) at its own scale holds at every zoom.
    const cardHeight = 44;
    const grip = rule('.cresize');
    const gripTop = cardHeight - px(grip, 'bottom') - px(grip, 'height');
    // The hit area reaches right, left and down only: never up.
    expect(rule('.cresize::before')).toMatch(/inset: 0 -?\d+px -?\d+px;/);
    const handle = rule('.react-flow__handle.connect-handle');
    expect(handle).toContain('top: 50%;');
    const handleReach = px(handle, 'height') / 2 + 7; // its ::before reaches 7px further
    expect(rule('.react-flow__handle.connect-handle::before')).toContain('inset: -7px;');
    expect(gripTop).toBeGreaterThan(cardHeight / 2 + handleReach);
    // The grip hides while the pointer is on the handle.
    expect(css).toMatch(/\.card:has\(> \.connect-handle:hover\) > \.cresize \{/);
  });

  it('still draws a line from the handle of a selected card, which shows the grip', async () => {
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
    onTestFinished(() => {
      Reflect.deleteProperty(document, 'elementFromPoint');
    });
    await open('modelling', 'shop', 6);
    fireEvent.click(card('till')?.querySelector('.card-main') as HTMLElement);
    await waitFor(() => {
      expect(card('till')?.classList.contains('is-selected')).toBe(true);
    });
    const width = parseFloat(nodeOf('till')?.style.width ?? '');
    const handle = await waitFor(() => {
      const found = card('till')?.querySelector<HTMLElement>('.connect-handle');
      if (!found) throw new Error('no handle yet');
      return found;
    });
    fireEvent.mouseDown(handle, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 40, clientY: 40 });
    fireEvent.mouseUp(document, { clientX: 0, clientY: 0 });
    const pop = await screen.findByRole('dialog', { name: 'New element' });
    expect(within(pop).getByText('Then choose the relationship from Till.')).toBeDefined();
    expect(parseFloat(nodeOf('till')?.style.width ?? '')).toBe(width);
  });
});

describe('the widest a width can be set', () => {
  it('is 480px, with the grip and with the keys', async () => {
    await open('viewing', 'till', 2);
    const widthOf = () => parseFloat(nodeOf('till')?.style.width ?? '');
    const grip = card('till')?.querySelector<HTMLElement>('.cresize') as HTMLElement;
    const pointer = (type: 'pointerDown' | 'pointerMove' | 'pointerUp', x: number) => {
      const event = createEvent[type](grip, { pointerId: 1, bubbles: true });
      Object.defineProperties(event, { clientX: { value: x }, clientY: { value: 10 } });
      fireEvent(grip, event);
    };
    pointer('pointerDown', 0);
    pointer('pointerMove', 7000);
    pointer('pointerUp', 7000);
    await waitFor(() => {
      expect(widthOf()).toBe(480);
    });
    const main = card('till')?.querySelector('.card-main') as HTMLElement;
    main.focus();
    fireEvent.keyDown(main, { key: 'm' });
    fireEvent.keyDown(main, { key: 'ArrowRight', altKey: true, shiftKey: true });
    fireEvent.keyDown(main, { key: 'ArrowRight', altKey: true, shiftKey: true });
    fireEvent.keyDown(main, { key: 'Enter' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(widthOf()).toBe(480);
  });
});
