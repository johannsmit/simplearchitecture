import type { JgfDocument, JgfEdge, MeResponse } from '@simplearchitecture/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

// Single click selects, double click focuses; relationships in Viewing; drag from
// the element list onto the canvas. Made-up data (the bakery fixture).

const dragType = 'application/x-simplearchitecture-element';

/** The bakery, with a description and an original ArchiMate type on one relationship. */
const model: JgfDocument = {
  graph: {
    ...bakeryModel.graph,
    edges: (bakeryModel.graph.edges ?? []).map((edge) =>
      edge.id === 'e1'
        ? {
            ...edge,
            metadata: {
              ...edge.metadata,
              architectureState: 'Target',
              description: 'Orders come in online.',
              archimateType: 'Flow',
            },
          }
        : edge,
    ),
  },
};

function api(editable: boolean): Handler {
  return ({ url, method }) => {
    if (method !== 'GET') return undefined;
    if (url === '/api/models') return Response.json({ models: [bakerySummary], editable });
    if (url === `/api/models/${bakeryId}`) return Response.json(model);
    if (url.startsWith(`/api/models/${bakeryId}/elements/`)) {
      const id = decodeURIComponent(url.split('/elements/')[1]?.split('?')[0] ?? '');
      return Response.json({
        element: { id, version: 1, node: model.graph.nodes?.[id] },
        warnings: [],
      });
    }
    if (url.startsWith(`/api/models/${bakeryId}/relationships/`)) {
      const id = decodeURIComponent(url.split('/relationships/')[1] ?? '');
      const edge = model.graph.edges?.find((e) => e.id === id) as JgfEdge;
      return Response.json({
        relationship: { id, version: 1, edge },
        warnings: [],
        nestingChanges: [],
      });
    }
    return undefined;
  };
}

function open(path: string, me: MeResponse = viewer, editable = false) {
  const fetchMock = stubApi(me, api(editable));
  renderAt(path);
  return fetchMock;
}

const viewingAt = (id: string) =>
  `/viewing/models/${bakeryId}/elements/${encodeURIComponent(id)}?depth=1`;
const details = () => screen.getByRole('complementary', { name: 'Details' });
const tree = () => screen.getByRole('tree', { name: 'Elements by type' });
const canvasEl = () => document.getElementById('canvas') as HTMLElement;
const card = (id: string) =>
  canvasEl().querySelector<HTMLElement>(`.card[data-element-id="${CSS.escape(id)}"]`);
const crumbs = () =>
  [...screen.getByRole('navigation', { name: 'Visited elements' }).querySelectorAll('li')].map(
    (li) => li.textContent,
  );
const changes = (fetchMock: ReturnType<typeof stubApi>) =>
  requests(fetchMock).filter((r) => !r.startsWith('GET '));

async function shopCanvas() {
  await waitFor(() => {
    expect(card('till')).toBeTruthy();
  });
}

function treeRow(name: string): HTMLElement {
  return within(tree()).getByRole('treeitem', { name });
}

function openGroup(type: string) {
  const group = within(tree()).getByRole('treeitem', { name: new RegExp(`^${type},`) });
  if (group.getAttribute('aria-expanded') === 'false') {
    fireEvent.click(group.querySelector('.trow') as HTMLElement);
  }
}

describe('select and focus', () => {
  it('a single click on a card selects it: the canvas, breadcrumbs and URL stay', async () => {
    open(viewingAt('shop'));
    await shopCanvas();
    const before = canvasEl().querySelectorAll('.card').length;
    const main = card('till')?.querySelector('.card-main') as HTMLElement;

    fireEvent.click(main);
    expect(currentLocation()).toBe(viewingAt('shop'));
    expect(crumbs()).toEqual(['Web Shop']);
    expect(card('till')?.classList.contains('is-selected')).toBe(true);
    // The focus element keeps its look; the canvas is the same.
    expect(card('shop')?.classList.contains('is-focus')).toBe(true);
    expect(card('till')?.classList.contains('is-focus')).toBe(false);
    expect(canvasEl().querySelectorAll('.card')).toHaveLength(before);
    expect(within(details()).getByRole('heading', { level: 2, name: 'Till' })).toBeTruthy();
    expect(
      within(tree()).getByRole('treeitem', { selected: true }).getAttribute('aria-label'),
    ).toBe('Till');

    // The second click of a double click focuses: what a single click did before.
    fireEvent.click(main, { detail: 2 });
    expect(currentLocation()).toBe(viewingAt('till'));
    await waitFor(() => {
      expect(crumbs()).toEqual(['Web Shop', 'Till']);
    });
  });

  it('a click on a list row selects, a double click focuses; an element off the canvas shows in the panel only', async () => {
    open(viewingAt('shop'));
    await shopCanvas();
    openGroup('Other');
    const lonely = treeRow('Recipe Archive');
    const row = lonely.querySelector('.trow') as HTMLElement;

    fireEvent.click(row);
    expect(currentLocation()).toBe(viewingAt('shop'));
    expect(lonely.getAttribute('aria-selected')).toBe('true');
    expect(
      within(details()).getByRole('heading', { level: 2, name: 'Recipe Archive' }),
    ).toBeTruthy();
    // Not brought onto the canvas.
    expect(card('lonely')).toBeNull();

    fireEvent.click(row, { detail: 2 });
    expect(currentLocation()).toBe(viewingAt('lonely'));
  });

  it('the keyboard: arrows move the selection, Enter focuses; Space selects a list row', async () => {
    open(viewingAt('shop'));
    await shopCanvas();
    const shop = card('shop')?.querySelector('.card-main') as HTMLElement;
    shop.focus();
    fireEvent.keyDown(shop, { key: 'ArrowUp' });
    const moved = document.activeElement as HTMLElement;
    const id = moved.closest('.card')?.getAttribute('data-element-id') ?? '';
    expect(id).not.toBe('shop');
    expect(moved.closest('.card')?.classList.contains('is-selected')).toBe(true);
    expect(currentLocation()).toBe(viewingAt('shop'));
    fireEvent.keyDown(moved, { key: 'Enter' });
    expect(currentLocation()).toBe(viewingAt(id));

    openGroup('Application');
    const till = treeRow('Till');
    // The list acts on the row its cursor is on, which follows the focus.
    act(() => {
      till.focus();
    });
    fireEvent.keyDown(till, { key: ' ' });
    expect(till.getAttribute('aria-selected')).toBe('true');
    expect(currentLocation()).toBe(viewingAt(id));
  });

  it('links still focus with one click (a relationship in the details panel)', async () => {
    open(viewingAt('shop'));
    await shopCanvas();
    fireEvent.click(within(details()).getByRole('button', { name: / Till, Application$/ }));
    expect(currentLocation()).toBe(viewingAt('till'));
  });

  it('in Modelling, a single click opens the selected element’s form without moving the canvas', async () => {
    open(`/modelling/models/${bakeryId}/elements/shop?depth=1`, modeller, true);
    await screen.findByRole('form', { name: 'Edit Web Shop' });
    await shopCanvas();
    fireEvent.click(card('till')?.querySelector('.card-main') as HTMLElement);
    expect(await screen.findByRole('form', { name: 'Edit Till' })).toBeTruthy();
    expect(currentLocation()).toBe(`/modelling/models/${bakeryId}/elements/shop?depth=1`);
    // Modelling is editing mode; there is no Editing pill, the region still says so.
    expect(document.querySelector('.mode-pill')).toBeNull();
    expect(screen.getByRole('region', { name: 'Explorer, editing' })).toBeTruthy();
  });
});

describe('relationship information in Viewing', () => {
  async function openE1(me: MeResponse, editable = false) {
    const fetchMock = open(viewingAt('shop'), me, editable);
    await shopCanvas();
    fireEvent.click(
      within(details()).getByRole('button', { name: /^Open relationship: .*Customer/ }),
    );
    await within(details()).findByRole('heading', {
      level: 2,
      name: 'Customer relates to Web Shop',
    });
    return fetchMock;
  }

  it('shows the relationship read-only, with no edit actions for a Viewer', async () => {
    const fetchMock = await openE1(viewer);
    const panel = details();
    expect(within(panel).getByRole('button', { name: /^From: Customer/ })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: /^To: Web Shop/ })).toBeTruthy();
    expect(within(panel).getByText('Orders come in online.')).toBeTruthy();
    expect(within(panel).getByText('Target')).toBeTruthy();
    // The type line, and Data as a row of its own, never a custom one.
    expect(panel.querySelector('.d-type')?.textContent).toBe('Relation');
    expect(within(panel).queryByText('Information flow')).toBeNull();
    expect(within(panel).getByText('Data')).toBeTruthy();
    expect(within(panel).queryByText('data')).toBeNull();
    expect(within(panel).getByText('archimateType')).toBeTruthy();
    expect(within(panel).getByText('Flow')).toBeTruthy();
    // The label, and Data (set from it where Information flow once was).
    expect(within(panel).getAllByText(/Places orders/)).toHaveLength(2);
    // No inputs, no Delete, no Open in Modelling.
    expect(panel.querySelector('input, textarea, select')).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Delete relationship' })).toBeNull();
    expect(within(panel).queryByRole('link', { name: 'Open in Modelling' })).toBeNull();
    // The canvas and URL stay; the line is drawn selected.
    expect(currentLocation()).toBe(viewingAt('shop'));
    expect(changes(fetchMock)).toEqual([]);

    // Esc goes back to the element.
    fireEvent.keyDown(within(panel).getByRole('heading', { level: 2 }), { key: 'Escape' });
    expect(
      await within(details()).findByRole('heading', { level: 2, name: 'Web Shop' }),
    ).toBeTruthy();
  });

  it('a click on a line opens it, and a click on empty canvas goes back', async () => {
    open(viewingAt('shop'));
    await shopCanvas();
    await waitFor(() => {
      expect(canvasEl().querySelectorAll('.react-flow__edge').length).toBeGreaterThan(0);
    });
    const line = [...canvasEl().querySelectorAll<HTMLElement>('.react-flow__edge')].find((edge) =>
      edge.getAttribute('aria-label')?.startsWith('Till'),
    ) as HTMLElement;
    fireEvent.click(line);
    expect(
      await within(details()).findByRole('heading', { level: 2, name: /^Till .* Web Shop$/ }),
    ).toBeTruthy();
    expect(currentLocation()).toBe(viewingAt('shop'));
    fireEvent.click(canvasEl().querySelector('.react-flow__pane') as HTMLElement);
    expect(
      await within(details()).findByRole('heading', { level: 2, name: 'Web Shop' }),
    ).toBeTruthy();
  });

  it('gives a Modeller "Open in Modelling", which opens the same relationship editable', async () => {
    await openE1(modeller, true);
    const link = within(details()).getByRole('link', { name: 'Open in Modelling' });
    await act(async () => {
      fireEvent.click(link);
      await Promise.resolve();
    });
    expect(currentLocation()).toBe(`/modelling/models/${bakeryId}/elements/shop?depth=1`);
    expect(
      await screen.findByRole('form', {
        name: 'Relationship Customer relates to Web Shop',
      }),
    ).toBeTruthy();
  });
});

describe('drag from the element list onto the canvas', () => {
  function dataTransfer(id: string) {
    return { types: [dragType], getData: (type: string) => (type === dragType ? id : '') };
  }

  it('drops a row on the canvas: the element is added there, the focus stays, no server call', async () => {
    const fetchMock = open(viewingAt('shop'));
    await shopCanvas();
    openGroup('Other');
    const row = treeRow('Recipe Archive').querySelector('.trow') as HTMLElement;
    expect(row.getAttribute('draggable')).toBe('true');
    const tidy = screen.getByRole('button', { name: 'Tidy up' });
    expect((tidy as HTMLButtonElement).disabled).toBe(true);

    fireEvent.dragOver(canvasEl(), { dataTransfer: dataTransfer('lonely') });
    fireEvent.drop(canvasEl(), {
      dataTransfer: dataTransfer('lonely'),
      clientX: 300,
      clientY: 200,
    });
    await waitFor(() => {
      expect(card('lonely')).toBeTruthy();
    });
    expect(currentLocation()).toBe(viewingAt('shop'));
    // It was placed at the drop point (a moved card, so Tidy up can reset it).
    await waitFor(() => {
      expect((tidy as HTMLButtonElement).disabled).toBe(false);
    });
    expect(changes(fetchMock)).toEqual([]);
  });

  it('selects an element already on the canvas instead; Shift+Enter on a row adds it', async () => {
    open(viewingAt('shop'));
    await shopCanvas();
    fireEvent.drop(canvasEl(), { dataTransfer: dataTransfer('till'), clientX: 10, clientY: 10 });
    await waitFor(() => {
      expect(card('till')?.classList.contains('is-selected')).toBe(true);
    });
    expect(within(details()).getByRole('heading', { level: 2, name: 'Till' })).toBeTruthy();

    // Something else dragged in (not a list row) does nothing.
    const cards = canvasEl().querySelectorAll('.card').length;
    fireEvent.drop(canvasEl(), {
      dataTransfer: {
        types: ['text/plain'],
        getData: (type: string) => (type === 'text/plain' ? 'lonely' : ''),
      },
    });
    expect(canvasEl().querySelectorAll('.card')).toHaveLength(cards);

    openGroup('Other');
    const lonely = treeRow('Recipe Archive');
    // Select the row (the panel shows it, the canvas stays), then Shift+Enter adds it.
    fireEvent.click(lonely.querySelector('.trow') as HTMLElement);
    expect(card('lonely')).toBeNull();
    fireEvent.keyDown(lonely, { key: 'Enter', shiftKey: true });
    await waitFor(() => {
      expect(card('lonely')).toBeTruthy();
    });
    expect(currentLocation()).toBe(viewingAt('shop'));
  });
});
