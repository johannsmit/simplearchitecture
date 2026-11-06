import type { JgfDocument } from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Icon } from '../src/icons';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import {
  currentLocation,
  modeller,
  renderAt,
  requests,
  stubApi,
  viewer,
  type Handler,
} from './helpers';

// Removing a card from the canvas with the × on the card: visual only, never a change to the
// model. Made-up data.

function apiFor(id: string, model: JgfDocument, summary: object): Handler {
  return ({ url, method }) => {
    if (method !== 'GET') return undefined;
    if (url === '/api/models') return Response.json({ models: [summary], editable: true });
    if (url === `/api/models/${id}`) return Response.json(model);
    if (url.startsWith(`/api/models/${id}/elements/`)) {
      const elementId = decodeURIComponent(url.split('/elements/')[1]?.split('?')[0] ?? '');
      return Response.json({
        element: { id: elementId, version: 1, node: model.graph.nodes?.[elementId] },
        warnings: [],
      });
    }
    return undefined;
  };
}
const api = apiFor(bakeryId, bakeryModel, bakerySummary);

const at = (space: 'viewing' | 'modelling') => `/${space}/models/${bakeryId}/elements/shop?depth=1`;
const canvasEl = () => document.getElementById('canvas') as HTMLElement;
const card = (id: string) =>
  canvasEl().querySelector<HTMLElement>(`.card[data-element-id="${CSS.escape(id)}"]`);
/** The × on a card, if it has one. */
const removeOn = (id: string) => card(id)?.querySelector<HTMLButtonElement>('.cremove') ?? null;
const edges = () =>
  [...canvasEl().querySelectorAll('.react-flow__edge')].map((e) => e.getAttribute('aria-label'));
const tree = () => screen.getByRole('tree', { name: 'Elements by type' });
const toolbar = () => document.querySelector('.toolbar') as HTMLElement;
const details = () => screen.getByRole('complementary', { name: 'Details' });
const planner = 'oven/planner #1';
const dragType = 'application/x-simplearchitecture-element';
const dragged = (id: string) => ({
  types: [dragType],
  getData: (type: string) => (type === dragType ? id : ''),
});

async function open(space: 'viewing' | 'modelling') {
  const fetchMock = stubApi(space === 'viewing' ? viewer : modeller, api);
  renderAt(at(space));
  await waitFor(() => {
    expect(card('till')).toBeTruthy();
  });
  return fetchMock;
}

function select(id: string) {
  fireEvent.click(card(id)?.querySelector('.card-main') as HTMLElement);
}

async function removeTill() {
  fireEvent.click(
    within(card('till') as HTMLElement).getByRole('button', {
      name: 'Remove Till from canvas',
    }),
  );
  await waitFor(() => {
    expect(card('till')).toBeNull();
  });
}

describe.each(['viewing', 'modelling'] as const)('in %s', (space) => {
  it('takes the card and its lines off with its ×, with the element still in the list', async () => {
    const fetchMock = await open(space);
    await waitFor(() => {
      expect(edges().some((label) => label?.startsWith('Till '))).toBe(true);
    });
    const button = within(card('till') as HTMLElement).getByRole('button', {
      name: 'Remove Till from canvas',
    });
    expect(button.title).toBe('Remove from canvas. The element stays in the model.');
    await removeTill();
    expect(edges().some((label) => label?.startsWith('Till '))).toBe(false);
    expect(currentLocation()).toBe(at(space));
    expect(within(tree()).getAllByText('Till').length).toBeGreaterThan(0);
    expect(screen.getByText('Removed “Till” from the canvas. It stays in the model.')).toBeTruthy();
    expect(document.activeElement).toBe(canvasEl());
    expect(requests(fetchMock).filter((r) => !r.startsWith('GET '))).toEqual([]);
  });

  it('has no Remove (or + Element) in the toolbar', async () => {
    await open(space);
    expect(within(toolbar()).queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(within(toolbar()).queryByRole('button', { name: /Element/ })).toBeNull();
  });
});

describe('the × on a card', () => {
  it('is never on the focus element', async () => {
    await open('viewing');
    expect(removeOn('shop')).toBeNull();
    for (const id of ['till', planner, 'server']) {
      if (card(id)) expect(removeOn(id)).toBeTruthy();
    }
    // Selected, the focus element still has none.
    select('shop');
    expect(removeOn('shop')).toBeNull();
  });

  it('is neutral: the x icon, never the trash icon, and no Delete wording', async () => {
    await open('modelling');
    const button = removeOn('till') as HTMLButtonElement;
    const svg = button.querySelector('svg')?.outerHTML;
    expect(svg).toBe(renderToStaticMarkup(<Icon name="x" />));
    expect(svg).not.toBe(renderToStaticMarkup(<Icon name="trash" />));
    expect(button.getAttribute('aria-label')).not.toMatch(/delete/i);
    expect(button.className).toContain('nodrag');
    expect(button.className).toContain('nopan');
  });

  it('is a tab stop after its card only on the tabbable card, before the related pill', async () => {
    await open('viewing');
    const shopMain = card('shop')?.querySelector('.card-main') as HTMLElement;
    expect(shopMain.tabIndex).toBe(0);
    expect((removeOn('till') as HTMLButtonElement).tabIndex).toBe(-1);
    // The arrow keys move the tab stop to another card: its × comes with it.
    select('till');
    const tillMain = card('till')?.querySelector('.card-main') as HTMLElement;
    tillMain.focus();
    await waitFor(() => {
      expect(tillMain.tabIndex).toBe(0);
    });
    expect((removeOn('till') as HTMLButtonElement).tabIndex).toBe(0);
    const order = [...(card('till') as HTMLElement).querySelectorAll('button')].map(
      (b) => b.className.split(' ')[0],
    );
    expect(order.indexOf('cremove')).toBe(order.indexOf('card-main') + 1);
    if (order.includes('cpill')) expect(order.indexOf('cpill')).toBeGreaterThan(1);
  });

  it('removes with Enter on the button, never focusing the card, and focus goes to the canvas', async () => {
    await open('viewing');
    const button = removeOn('till') as HTMLButtonElement;
    button.focus();
    // Enter presses the button (the browser clicks it); the canvas's Enter (focus) doesn't run.
    const notCancelled = fireEvent.keyDown(button, { key: 'Enter' });
    expect(notCancelled).toBe(true);
    fireEvent.click(button);
    await waitFor(() => {
      expect(card('till')).toBeNull();
    });
    expect(currentLocation()).toBe(at('viewing'));
    expect(document.activeElement).toBe(canvasEl());
  });

  it('leaves the selection alone when another card is removed', async () => {
    await open('viewing');
    select(planner);
    await within(details()).findByRole('heading', { name: 'Oven Planner' });
    await removeTill();
    expect(within(details()).getByRole('heading', { name: 'Oven Planner' })).toBeTruthy();
  });

  it('takes the selection back to the focus element when its own card goes', async () => {
    await open('viewing');
    select('till');
    await within(details()).findByRole('heading', { name: 'Till' });
    await removeTill();
    await within(details()).findByRole('heading', { name: 'Web Shop' });
  });

  it('asks about unsaved changes only when the removed card is the selected one', async () => {
    await open('modelling');
    select('till');
    const form = await screen.findByRole('form', { name: /^Edit Till/ });
    fireEvent.change(within(form).getByRole('textbox', { name: /^Name/ }), {
      target: { value: 'Till 2' },
    });
    // Another card: no question, and the form keeps its changes.
    fireEvent.click(removeOn(planner) as HTMLButtonElement);
    await waitFor(() => {
      expect(card(planner)).toBeNull();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(form).getByRole<HTMLInputElement>('textbox', { name: /^Name/ }).value).toBe(
      'Till 2',
    );
    // Its own card: asks first, and Keep editing leaves it on the canvas.
    fireEvent.click(removeOn('till') as HTMLButtonElement);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(card('till')).toBeTruthy();
  });
});

describe('a removed card', () => {
  it('stays off through Tidy up and a change of depth', async () => {
    await open('viewing');
    await removeTill();
    // Another element dropped on the canvas is a moved card, so Tidy up can run.
    fireEvent.drop(canvasEl(), { dataTransfer: dragged('lonely'), clientX: 300, clientY: 200 });
    const tidy = screen.getByRole<HTMLButtonElement>('button', { name: 'Tidy up' });
    await waitFor(() => {
      expect(tidy.disabled).toBe(false);
    });
    fireEvent.click(tidy);
    await waitFor(() => {
      expect(tidy.disabled).toBe(true);
    });
    expect(card('till')).toBeNull();
    const depth = screen.getByRole('group', { name: 'Relationship depth' });
    fireEvent.click(within(depth).getByRole('button', { name: '2' }));
    await waitFor(() => {
      expect(within(depth).getByRole('button', { name: '2' }).getAttribute('aria-pressed')).toBe(
        'true',
      );
    });
    expect(card('lonely')).toBeTruthy();
    expect(card('till')).toBeNull();
  });

  it('comes back when dragged from the list onto the canvas', async () => {
    await open('viewing');
    await removeTill();
    fireEvent.drop(canvasEl(), { dataTransfer: dragged('till'), clientX: 200, clientY: 200 });
    await waitFor(() => {
      expect(card('till')).toBeTruthy();
    });
  });
});

describe('a container the focus element is drawn inside', () => {
  const nestedId = 'nested-remove';
  const nested: JgfDocument = {
    graph: {
      label: 'Nesting',
      nodes: {
        hub: { label: 'Hub', metadata: { type: 'Application' } },
        svc: { label: 'Service', metadata: { type: 'Application' } },
        db: { label: 'Store', metadata: { type: 'Infrastructure' } },
      },
      edges: [
        { id: 'c1', source: 'hub', target: 'svc', relation: 'Contains' },
        { id: 'r1', source: 'svc', target: 'db', relation: 'Relation' },
      ],
    },
  };
  const summary = { ...bakerySummary, id: nestedId, name: 'Nesting' };

  it('has no ×, while the other cards have one', async () => {
    stubApi(viewer, apiFor(nestedId, nested, summary));
    renderAt(`/viewing/models/${nestedId}/elements/svc?depth=1`);
    await waitFor(() => {
      expect(card('hub')).toBeTruthy();
      expect(card('db')).toBeTruthy();
    });
    expect(removeOn('svc')).toBeNull();
    expect(removeOn('hub')).toBeNull();
    expect(removeOn('db')).toBeTruthy();
  });
});

describe('the styles', () => {
  const css = readFileSync(join(import.meta.dirname, '../src/styles/explorer.css'), 'utf8');
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  };

  it('hide the × until the card is hovered, selected or focused, and keep it in the tab order', () => {
    expect(rule('.card > .cremove')).toMatch(/opacity: 0;[\s\S]*pointer-events: none;/);
    expect(css).toMatch(
      /\.card:hover > \.cremove,\s*\.card\.is-selected > \.cremove,\s*\.card:focus-within > \.cremove \{\s*opacity: 1;/,
    );
    // Never display: none or visibility: hidden, which would take it out of the tab order.
    expect(rule('.card > .cremove')).not.toMatch(/display: none|visibility/);
  });

  it('draw an 18px neutral circle on the top-left corner with a 24px target', () => {
    const button = rule('.cremove');
    expect(button).toContain('width: 18px;');
    expect(button).toContain('height: 18px;');
    expect(button).toContain('top: -9px;');
    expect(button).toContain('left: -9px;');
    expect(button).toContain('border: 1px solid var(--border-strong);');
    expect(button).not.toMatch(/critical/);
    expect(rule('.cremove::before')).toContain('inset: -3px;');
  });

  it('move the state badge clear of it', () => {
    expect(rule('.cbadge')).toContain('left: 17px;');
  });
});
