import {
  buildModelGraph,
  type JgfDocument,
  type JgfEdge,
  type ModelSummary,
} from '@simplearchitecture/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { elementDragType } from '../src/viewing/explorer/canvas/view';
import { ElementTree, forgetOpenRows } from '../src/viewing/explorer/ElementTree';
import {
  currentLocation,
  expectNoSeriousAxeViolations,
  renderAt,
  stubApi,
  viewer,
} from './helpers';

// An element contained by one of the same type is listed under it.
// Made-up data only.

const harbourId = '33333333-3333-4333-8333-333333333333';
const base = `/viewing/models/${harbourId}`;

const contains = (id: string, source: string, target: string): JgfEdge => ({
  id,
  source,
  target,
  relation: 'Contains',
});

/**
 * Applications: Portal holds Search and Basket, Basket holds Payment widget; CRM is held by the
 * Sales business (another type), so it stays at the top of Application.
 */
const harbour: JgfDocument = {
  graph: {
    id: harbourId,
    label: 'Made-up harbour',
    nodes: {
      portal: { label: 'Portal', metadata: { type: 'Application' } },
      search: { label: 'Search', metadata: { type: 'Application' } },
      basket: { label: 'Basket', metadata: { type: 'Application' } },
      pay: { label: 'Payment widget', metadata: { type: 'Application' } },
      crm: { label: 'CRM', metadata: { type: 'Application' } },
      sales: { label: 'Sales', metadata: { type: 'Business' } },
      dc: { label: 'Data centre', metadata: { type: 'Infrastructure' } },
    },
    edges: [
      contains('c1', 'portal', 'search'),
      contains('c2', 'portal', 'basket'),
      contains('c3', 'basket', 'pay'),
      contains('c4', 'sales', 'crm'),
      { id: 'i1', source: 'portal', target: 'crm', relation: 'Relation' },
    ],
  },
};

const summary: ModelSummary = {
  id: harbourId,
  name: 'Made-up harbour',
  createdAt: '2026-10-30T08:00:00.000Z',
  createdBy: { id: 'u1', name: 'Alex Morgan' },
  nodeCount: 7,
  edgeCount: 5,
};

function open(path: string) {
  stubApi(viewer, ({ url, method }) => {
    if (method !== 'GET') return undefined;
    if (url === '/api/models') return Response.json({ models: [summary] });
    if (url === `/api/models/${harbourId}`) return Response.json(harbour);
    return undefined;
  });
  renderAt(path);
}

const tree = () => screen.getByRole('tree', { name: 'Elements by type' });
const item = (name: string | RegExp) => within(tree()).getByRole('treeitem', { name });
const queryItem = (name: string | RegExp) => within(tree()).queryByRole('treeitem', { name });
const rowOf = (treeItem: HTMLElement) => treeItem.querySelector(':scope > .trow') as HTMLElement;
const chevronOf = (treeItem: HTMLElement) =>
  treeItem.querySelector(':scope > .trow > .tchev') as HTMLElement;
/** The visible element rows in order, as "name@level". */
const visibleRows = () =>
  within(tree())
    .getAllByRole('treeitem')
    .filter((row) => row.getAttribute('aria-level') !== '1')
    .map(
      (row) => `${row.getAttribute('aria-label') ?? ''}@${row.getAttribute('aria-level') ?? ''}`,
    );

async function openApplications() {
  await screen.findByRole('tree', { name: 'Elements by type' });
  fireEvent.click(rowOf(item(/^Application,/)));
}

beforeEach(() => {
  forgetOpenRows();
});

describe('nested element list', () => {
  it('lists same-type contained elements under their container, with levels', async () => {
    open(base);
    await openApplications();

    // Children are hidden until their parent opens; CRM (held by a Business) stays on top.
    expect(visibleRows()).toEqual(['CRM@2', 'Portal@2']);
    expect(item(/^Application,/).getAttribute('aria-level')).toBe('1');
    // The group counts every element of the type, nested or not.
    expect(item(/^Application,/).getAttribute('aria-label')).toBe('Application, 5 elements');
    expect(item('Portal').getAttribute('aria-expanded')).toBe('false');
    // Leaves carry no aria-expanded.
    expect(item('CRM').hasAttribute('aria-expanded')).toBe(false);

    fireEvent.click(chevronOf(item('Portal')));
    expect(visibleRows()).toEqual(['CRM@2', 'Portal@2', 'Basket@3', 'Search@3']);
    fireEvent.click(chevronOf(item('Basket')));
    expect(visibleRows()).toEqual([
      'CRM@2',
      'Portal@2',
      'Basket@3',
      'Payment widget@4',
      'Search@3',
    ]);
    // A child sits in its parent's group, never also at the top.
    expect(item('Payment widget').parentElement?.closest('[role="treeitem"]')).toBe(item('Basket'));
    expect(within(tree()).getAllByRole('treeitem', { name: 'Search' })).toHaveLength(1);
    // The indent grows by one step per level.
    expect(rowOf(item('Portal')).style.getPropertyValue('--indent')).toBe('0');
    expect(rowOf(item('Payment widget')).style.getPropertyValue('--indent')).toBe('2');
    // The other type's group: Sales has no children in the list.
    fireEvent.click(rowOf(item(/^Business,/)));
    expect(item('Sales').hasAttribute('aria-expanded')).toBe(false);

    await expectNoSeriousAxeViolations(tree());
  });

  it('toggles with the chevron without selecting or focusing', async () => {
    open(base);
    await openApplications();
    const before = currentLocation();

    fireEvent.click(chevronOf(item('Portal')), { detail: 1 });
    fireEvent.click(chevronOf(item('Portal')), { detail: 2 });
    fireEvent.click(chevronOf(item('Portal')), { detail: 1 });
    expect(item('Portal').getAttribute('aria-expanded')).toBe('true');
    expect(item('Portal').getAttribute('aria-selected')).toBe('false');
    expect(currentLocation()).toBe(before);
    // The chevron is no Tab stop: the row stays the tree's one stop.
    expect(chevronOf(item('Portal')).hasAttribute('tabindex')).toBe(false);
    expect(chevronOf(item('Portal')).querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('selects with a click and focuses with a double click on a child row', async () => {
    open(base);
    await openApplications();
    fireEvent.click(chevronOf(item('Portal')));

    fireEvent.click(rowOf(item('Search')), { detail: 1 });
    await waitFor(() => {
      expect(item('Search').getAttribute('aria-selected')).toBe('true');
    });
    fireEvent.click(rowOf(item('Search')), { detail: 2 });
    await waitFor(() => {
      expect(currentLocation()).toContain(`${base}/elements/search`);
    });
  });

  it('opens the path to the selected element by itself', async () => {
    open(`${base}/elements/pay`);

    await waitFor(() => {
      expect(item('Payment widget').getAttribute('aria-selected')).toBe('true');
    });
    expect(item('Portal').getAttribute('aria-expanded')).toBe('true');
    expect(item('Basket').getAttribute('aria-expanded')).toBe('true');
    expect(item('Payment widget').getAttribute('aria-level')).toBe('4');
  });

  it('moves through the rows with the keys', async () => {
    open(base);
    await openApplications();
    const tree_ = tree();
    const key = (name: string) => {
      fireEvent.keyDown(tree_, { key: name });
    };
    act(() => {
      item('Portal').focus();
    });

    key('ArrowRight');
    expect(item('Portal').getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(item('Portal'));
    key('ArrowRight');
    await waitFor(() => {
      expect(document.activeElement).toBe(item('Basket'));
    });
    // ↓ goes through visible rows, children included.
    key('ArrowDown');
    await waitFor(() => {
      expect(document.activeElement).toBe(item('Search'));
    });
    // ← on a leaf: to the parent.
    key('ArrowLeft');
    await waitFor(() => {
      expect(document.activeElement).toBe(item('Portal'));
    });
    // ← on an open parent: closes it.
    key('ArrowLeft');
    expect(item('Portal').getAttribute('aria-expanded')).toBe('false');
    expect(queryItem('Search')).toBeNull();
    // ← on a closed top-level row: to the type group.
    key('ArrowLeft');
    await waitFor(() => {
      expect(document.activeElement).toBe(item(/^Application,/));
    });
    // * opens every type group, not elements.
    key('*');
    expect(item(/^Business,/).getAttribute('aria-expanded')).toBe('true');
    expect(item('Portal').getAttribute('aria-expanded')).toBe('false');
    // Type-ahead reaches child rows once they show.
    act(() => {
      item('Portal').focus();
    });
    key('ArrowRight');
    key('s');
    await waitFor(() => {
      expect(document.activeElement).toBe(item('Search'));
    });
    // Enter on a parent focuses the element; it doesn't open or close the row.
    act(() => {
      item('Portal').focus();
    });
    key('Enter');
    await waitFor(() => {
      expect(currentLocation()).toContain(`${base}/elements/portal`);
    });
    expect(item('Portal').getAttribute('aria-expanded')).toBe('true');
  });

  it('shows a matching child under muted parents while searching, and counts matches only', async () => {
    open(base);
    await screen.findByRole('tree', { name: 'Elements by type' });

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search elements' }), {
      target: { value: 'payment' },
    });
    await waitFor(() => {
      expect(visibleRows()).toEqual([
        'Portal, not a match@2',
        'Basket, not a match@3',
        'Payment widget@4',
      ]);
    });
    expect(screen.getByText('1 of 7 elements match')).toBeTruthy();
    expect(item(/^Application,/).getAttribute('aria-label')).toBe('Application, 1 element');
    const portal = item('Portal, not a match');
    expect(rowOf(portal).classList.contains('is-context')).toBe(true);
    expect(rowOf(portal).querySelector('mark')).toBeNull();
    expect(rowOf(item('Payment widget')).querySelector('mark')?.textContent).toBe('Payment');
    // Open and can't be closed while searching.
    expect(portal.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(chevronOf(portal));
    expect(portal.getAttribute('aria-expanded')).toBe('true');
    // A context row works like any row: a click selects it.
    fireEvent.click(rowOf(portal), { detail: 1 });
    await waitFor(() => {
      expect(item('Portal, not a match').getAttribute('aria-selected')).toBe('true');
    });

    // A matching parent without matching children shows as a leaf.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search elements' }), {
      target: { value: 'basket' },
    });
    await waitFor(() => {
      expect(visibleRows()).toEqual(['Portal, not a match@2', 'Basket@3']);
    });
    expect(item('Basket').hasAttribute('aria-expanded')).toBe(false);
  });
});

describe('ElementTree on its own', () => {
  const graphWith = (edges: JgfEdge[]) => buildModelGraph({ graph: { ...harbour.graph, edges } });

  function renderTree(graph = buildModelGraph(harbour), selectedId?: string) {
    const calls = { focus: vi.fn(), select: vi.fn(), add: vi.fn() };
    const props = {
      modelId: harbourId,
      onFocusElement: calls.focus,
      onSelectElement: calls.select,
      onAddToCanvas: calls.add,
    };
    const view = render(<ElementTree {...props} graph={graph} selectedId={selectedId} />);
    const rerender = (next: typeof graph, selected?: string) => {
      view.rerender(<ElementTree {...props} graph={next} selectedId={selected} />);
    };
    return { calls, rerender };
  }

  it('adds a child row to the canvas with Shift+Enter and by dragging', () => {
    const { calls } = renderTree(buildModelGraph(harbour), 'search');
    act(() => {
      item('Search').focus();
    });
    fireEvent.keyDown(tree(), { key: 'Enter', shiftKey: true });
    expect(calls.add).toHaveBeenCalledWith('search');
    expect(calls.focus).not.toHaveBeenCalled();

    fireEvent.keyDown(tree(), { key: ' ' });
    expect(calls.select).toHaveBeenCalledWith('search');

    const setData = vi.fn();
    fireEvent.dragStart(rowOf(item('Search')), { dataTransfer: { setData } });
    expect(setData).toHaveBeenCalledWith(elementDragType, 'search');
    expect(rowOf(item('Search')).getAttribute('draggable')).toBe('true');
  });

  it('moves a row at once when a Contains changes (Modelling), and opens its new path', () => {
    const { rerender } = renderTree(buildModelGraph(harbour), 'search');
    expect(item('Search').getAttribute('aria-level')).toBe('3');

    // Search moves from Portal into Basket: the selected row follows, its new path opens.
    const moved = graphWith([
      contains('c2', 'portal', 'basket'),
      contains('c3', 'basket', 'pay'),
      contains('c4', 'sales', 'crm'),
      contains('c5', 'basket', 'search'),
    ]);
    rerender(moved, 'search');
    expect(item('Search').getAttribute('aria-level')).toBe('4');
    expect(item('Search').parentElement?.closest('[role="treeitem"]')).toBe(item('Basket'));
    expect(item('Basket').getAttribute('aria-expanded')).toBe('true');
    expect(item('Search').getAttribute('aria-selected')).toBe('true');

    // The Contains is deleted: Search goes back to the top of its group.
    rerender(
      graphWith([contains('c2', 'portal', 'basket'), contains('c3', 'basket', 'pay')]),
      'search',
    );
    expect(item('Search').getAttribute('aria-level')).toBe('2');
  });

  it('stops indenting at level 8, while aria-level keeps counting', () => {
    const nodes = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        `n${i}`,
        { label: `Level ${i}`, metadata: { type: 'Other' } },
      ]),
    );
    const edges = Array.from({ length: 9 }, (_, i) => contains(`d${i}`, `n${i}`, `n${i + 1}`));
    renderTree(buildModelGraph({ graph: { nodes, edges } }), 'n9');
    expect(item('Level 9').getAttribute('aria-level')).toBe('11');
    expect(rowOf(item('Level 9')).style.getPropertyValue('--indent')).toBe('6');
    expect(rowOf(item('Level 5')).style.getPropertyValue('--indent')).toBe('5');
  });

  it('shows only the empty text for a model without elements', () => {
    render(
      <ElementTree
        modelId="empty"
        graph={buildModelGraph({ graph: { nodes: {}, edges: [] } })}
        selectedId={undefined}
        onFocusElement={vi.fn()}
        top={<p>Top slot</p>}
        emptyText="No elements yet. Add the first one with New element."
      />,
    );
    expect(screen.getByText('Top slot')).toBeTruthy();
    expect(screen.getByText('No elements yet. Add the first one with New element.')).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});
