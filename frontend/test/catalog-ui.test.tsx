import type { JgfNode } from '@simplearchitecture/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { forgetCatalogState } from '../src/viewing/explorer/catalog/Catalog';
import { forgetElementFilters } from '../src/viewing/explorer/ElementTree';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import {
  apiError,
  currentLocation,
  modeller,
  renderAt,
  requests,
  stubApi,
  viewer,
  type Handler,
} from './helpers';

// The catalog's UI. Made-up data only (the bakery fixture).

const viewing = `/viewing/models/${bakeryId}`;
const modelling = `/modelling/models/${bakeryId}`;
const elementsUrl = `/api/models/${bakeryId}/elements`;

beforeEach(() => {
  forgetElementFilters();
  forgetCatalogState();
});

interface Server {
  versions: Map<string, number>;
  nodes: Map<string, JgfNode>;
  bodies: { method: string; url: string; body: unknown }[];
}

/** The model API, and in Modelling the element routes with versions. */
function api(answer?: (request: Parameters<Handler>[0]) => Response | undefined): {
  handler: Handler;
  server: Server;
} {
  const server: Server = {
    versions: new Map(),
    nodes: new Map(Object.entries(bakeryModel.graph.nodes ?? {})),
    bodies: [],
  };
  const handler: Handler = (request) => {
    const body: unknown = typeof request.body === 'string' ? JSON.parse(request.body) : undefined;
    if (request.method !== 'GET') {
      server.bodies.push({ method: request.method, url: request.url, body });
    }
    const custom = answer?.(request);
    if (custom) return custom;
    if (request.method === 'GET' && request.url === '/api/models') {
      return Response.json({ models: [bakerySummary], editable: true });
    }
    if (request.method === 'GET' && request.url === `/api/models/${bakeryId}`) {
      return Response.json(bakeryModel);
    }
    if (!request.url.startsWith(elementsUrl)) return undefined;
    const id = decodeURIComponent(request.url.slice(elementsUrl.length + 1).split('?')[0] ?? '');
    const version = server.versions.get(id) ?? 1;
    const result = () =>
      Response.json({
        element: { id, version: server.versions.get(id) ?? 1, node: server.nodes.get(id) },
        warnings: [],
      });
    if (request.method === 'GET') return result();
    if (request.method === 'POST') {
      const { name, type } = body as { name: string; type: string };
      server.nodes.set('new-1', { label: name, metadata: { type } });
      return Response.json(
        { element: { id: 'new-1', version: 1, node: server.nodes.get('new-1') }, warnings: [] },
        { status: 201 },
      );
    }
    if (request.method === 'DELETE') {
      return Response.json({
        id,
        deletedRelationshipCount: 0,
        deletedRelationshipIds: [],
        unnestedElementIds: [],
      });
    }
    if (request.method === 'PATCH') {
      const change = body as {
        version: number;
        name?: string;
        description?: string | null;
        metadata?: Record<string, unknown>;
      };
      if (change.version !== version) return apiError(409, 'Changed', { currentVersion: version });
      const node = server.nodes.get(id) ?? {};
      const metadata = Object.fromEntries(
        Object.entries({ ...node.metadata, ...change.metadata }).filter(([, v]) => v !== null),
      );
      server.nodes.set(id, { label: change.name ?? node.label ?? '', metadata });
      server.versions.set(id, version + 1);
      return result();
    }
    return undefined;
  };
  return { handler, server };
}

/** Renders at a path with a handle on the router's history (the browser's Back and Forward). */
function renderWithHistory(path: string) {
  let go: NavigateFunction | undefined;
  function History() {
    go = useNavigate();
    return null;
  }
  render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <App />
        <History />
      </MemoryRouter>
    </StrictMode>,
  );
  return (delta: number) => {
    act(() => {
      void go?.(delta);
    });
  };
}

const grid = () => screen.getByRole('grid');
const viewButton = (name: string) =>
  within(screen.getByRole('group', { name: 'View' })).getByRole('button', { name });
const tabs = () => screen.getByRole('tablist', { name: 'Element types' });
const headers = () => within(grid()).getAllByRole('columnheader');
const rowNames = () =>
  within(grid())
    .getAllByRole('rowheader')
    .map((cell) => cell.textContent);
const rowOf = (name: string) => {
  const header = within(grid()).getByRole('rowheader', { name });
  const row = header.closest('tr');
  if (!row) throw new Error(name);
  return row;
};
/** A cell by row name and column header text. */
const cell = (name: string, column: string) => {
  const index = headers().findIndex((header) => header.textContent === column);
  const found = rowOf(name).children[index];
  if (!(found instanceof HTMLElement)) throw new Error(`${name} ${column}`);
  return found;
};
/** Focus moves in an effect, which may run just after the key press returns. */
const focusOn = (element: () => Element) =>
  waitFor(() => {
    expect(document.activeElement).toBe(element());
  });
const heading = () =>
  within(screen.getByRole('complementary', { name: 'Details' })).getByRole('heading', {
    level: 2,
  });

async function openCatalog(path: string, me = viewer, answer?: Parameters<typeof api>[0]) {
  const { handler, server } = api(answer);
  const fetchMock = stubApi(me, handler);
  renderAt(path);
  await screen.findByRole('grid');
  return { server, fetchMock };
}

describe('the Canvas | Catalog switch', () => {
  it('sits after the list toggle, and the catalog has no canvas-only controls', async () => {
    await openCatalog(`${viewing}?view=catalog&type=Application`);
    const toolbar = screen.getByRole('group', { name: 'View' }).parentElement;
    const buttons: HTMLElement[] = [...(toolbar?.querySelectorAll('button') ?? [])];
    const listToggle = screen.getByRole('button', { name: 'Hide the element list' });
    expect(buttons.indexOf(viewButton('Canvas'))).toBe(buttons.indexOf(listToggle) + 1);
    expect(viewButton('Catalog').getAttribute('aria-pressed')).toBe('true');
    for (const name of ['Back', 'Tidy up']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('group', { name: 'Relationship depth' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Visited elements' })).toBeNull();
  });

  it('switches views in the address; Back and Forward follow; a tab change replaces', async () => {
    stubApi(viewer, api().handler);
    const browser = renderWithHistory(`${viewing}/elements/shop?depth=2`);
    await screen.findByRole('heading', { level: 2, name: 'Web Shop' });

    fireEvent.click(viewButton('Catalog'));
    await screen.findByRole('grid');
    // Entering the catalog opens the selected element's tab; depth stays.
    expect(within(tabs()).getByRole('tab', { selected: true }).textContent).toMatch(/^Application/);
    expect(screen.getByRole('complementary', { name: 'Details' })).toBeTruthy();

    fireEvent.click(within(tabs()).getByRole('tab', { name: /^All/ }));
    expect(within(tabs()).getByRole('tab', { selected: true }).textContent).toMatch(/^All/);

    browser(-1);
    await screen.findByRole('region', { name: /^Diagram:/ });
    expect(viewButton('Canvas').getAttribute('aria-pressed')).toBe('true');
    browser(1);
    await screen.findByRole('grid');
    // The tab change replaced the entry: Forward comes back on All.
    expect(within(tabs()).getByRole('tab', { selected: true }).textContent).toMatch(/^All/);
  });

  it('writes view and type to the address, next to the depth', async () => {
    stubApi(viewer, api().handler);
    renderAt(`${viewing}/elements/shop?depth=2`);
    await screen.findByRole('heading', { level: 2, name: 'Web Shop' });
    fireEvent.click(viewButton('Catalog'));
    expect(currentLocation()).toBe(
      `${viewing}/elements/shop?depth=2&view=catalog&type=Application`,
    );
    fireEvent.click(viewButton('Canvas'));
    expect(currentLocation()).toBe(`${viewing}/elements/shop?depth=2`);
  });

  it('back to the canvas without a focused element focuses the selected row', async () => {
    await openCatalog(`${viewing}?view=catalog`);
    fireEvent.click(cell('Till', 'Name'));
    await waitFor(() => {
      expect(heading().textContent).toBe('Till');
    });
    fireEvent.click(viewButton('Canvas'));
    expect(currentLocation()).toBe(`${viewing}/elements/till?depth=1`);
  });
});

describe('search, tabs and columns', () => {
  it('moves the one search box above the table, sharing search and filters', async () => {
    stubApi(viewer, api().handler);
    renderAt(viewing);
    await screen.findByRole('tree');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'oven' } });
    fireEvent.click(viewButton('Catalog'));
    await screen.findByRole('grid');
    expect(screen.getAllByRole('searchbox')).toHaveLength(1);
    const search = screen.getByRole('searchbox');
    expect(search.closest('.catalog')).not.toBeNull();
    expect((search as HTMLInputElement).value).toBe('oven');
    expect(rowNames()).toEqual(['Oven Planner']);
    expect(document.querySelector('.cat-search .result-count')?.textContent).toBe(
      '1 of 7 elements match',
    );
    // The list's counts line is not live while the catalog shows.
    expect(document.querySelector('.tree-panel .result-count')?.getAttribute('aria-live')).toBe(
      null,
    );

    fireEvent.change(search, { target: { value: '' } });
    fireEvent.click(viewButton('Canvas'));
    await screen.findByRole('tree');
    expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('');
  });

  it('shows six tabs, All first, with their counts, and narrowed counts', async () => {
    await openCatalog(`${viewing}?view=catalog`);
    expect(
      within(tabs())
        .getAllByRole('tab')
        .map((tab) => tab.getAttribute('aria-label')),
    ).toEqual([
      'All, 7 elements',
      'Stakeholder, 1 element',
      'Business, 1 element',
      'Application, 3 elements',
      'Infrastructure, 1 element',
      'Other, 1 element',
    ]);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'oven' } });
    expect(
      within(tabs())
        .getByRole('tab', { name: /^Application/ })
        .getAttribute('aria-label'),
    ).toBe('Application, 1 element matches');
    expect(
      within(tabs())
        .getByRole('tab', { name: /^Business/ })
        .getAttribute('aria-label'),
    ).toBe('Business, 0 elements match');
  });

  it('moves between tabs with the arrow keys, Home and End (one Tab stop)', async () => {
    await openCatalog(`${viewing}?view=catalog`);
    const all = within(tabs()).getByRole('tab', { name: /^All/ });
    expect(
      within(tabs())
        .getAllByRole('tab')
        .filter((tab) => tab.tabIndex === 0),
    ).toEqual([all]);
    fireEvent.keyDown(all, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(document.activeElement?.textContent).toMatch(/^Stakeholder/);
    });
    expect(currentLocation()).toBe(`${viewing}?view=catalog&type=Stakeholder`);
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    await waitFor(() => {
      expect(document.activeElement?.textContent).toMatch(/^Other/);
    });
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(document.activeElement?.textContent).toMatch(/^All/);
    });
  });

  it('has the columns of each tab, Functions last', async () => {
    await openCatalog(`${viewing}?view=catalog`);
    expect(headers().map((header) => header.textContent)).toEqual(['Name', 'Type', 'Description']);
    fireEvent.click(within(tabs()).getByRole('tab', { name: /^Application/ }));
    expect(headers().map((header) => header.textContent)).toEqual([
      'Name',
      'Description',
      'Architecture state',
      'Owning team',
      'Supplier HQ country',
      'Sourcing',
      'Functions',
    ]);
    fireEvent.click(within(tabs()).getByRole('tab', { name: /^Business/ }));
    expect(headers().map((header) => header.textContent)).toEqual([
      'Name',
      'Description',
      'Owning team',
    ]);
  });

  it('shows values as the details panel does, with "Not set" for empty ones', async () => {
    await openCatalog(`${viewing}?view=catalog&type=Application`);
    expect(cell('Web Shop', 'Architecture state').querySelector('.badge')?.textContent).toBe(
      'Current',
    );
    expect(cell('Web Shop', 'Supplier HQ country').textContent).toMatch(/^NL · /);
    expect(cell('Oven Planner', 'Supplier HQ country').querySelector('.not-iso')).not.toBeNull();
    expect(cell('Web Shop', 'Functions').textContent).toBe('Order capture, Payment');
    expect(cell('Web Shop', 'Functions').title).toBe('Order capture\nPayment');
    // Line breaks in a description show as spaces.
    expect(cell('Web Shop', 'Description').textContent).toMatch(/^Takes orders online\. Runbook/);
    expect(cell('Till', 'Owning team').textContent).toBe('–Not set');
    expect(cell('Till', 'Owning team').querySelector('[aria-hidden="true"]')?.textContent).toBe(
      '–',
    );
  });

  it('says why there are no rows, with a way out', async () => {
    await openCatalog(`${viewing}?view=catalog&type=Business`);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'oven' } });
    expect(screen.getByText(/No Business elements match\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'See the match' }));
    expect(rowNames()).toEqual(['Oven Planner']);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText(/No elements match “zzz”\./)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear search' }));
    expect(rowNames()).toHaveLength(7);
  });
});

describe('sorting', () => {
  it('sorts by a header, then reverses; empty values last both ways; one aria-sort', async () => {
    await openCatalog(`${viewing}?view=catalog&type=Application`);
    expect(rowNames()).toEqual(['Oven Planner', 'Till', 'Web Shop']);
    expect(headers()[0]?.getAttribute('aria-sort')).toBe('ascending');

    fireEvent.click(within(grid()).getByRole('columnheader', { name: /^Architecture state/ }));
    expect(rowNames()).toEqual(['Till', 'Web Shop', 'Oven Planner']);
    fireEvent.click(within(grid()).getByRole('columnheader', { name: /^Architecture state/ }));
    expect(rowNames()).toEqual(['Oven Planner', 'Web Shop', 'Till']);
    expect(headers().filter((header) => header.hasAttribute('aria-sort'))).toHaveLength(1);
    expect(
      within(grid())
        .getByRole('columnheader', { name: /^Architecture state/ })
        .getAttribute('aria-sort'),
    ).toBe('descending');

    fireEvent.click(within(grid()).getByRole('columnheader', { name: /^Owning team/ }));
    expect(rowNames()).toEqual(['Web Shop', 'Oven Planner', 'Till']);
    fireEvent.click(within(grid()).getByRole('columnheader', { name: /^Owning team/ }));
    expect(rowNames()).toEqual(['Web Shop', 'Oven Planner', 'Till']);
  });

  it('keeps the sort per tab for the session', async () => {
    await openCatalog(`${viewing}?view=catalog&type=Application`);
    fireEvent.click(within(grid()).getByRole('columnheader', { name: /^Name/ }));
    expect(rowNames()).toEqual(['Web Shop', 'Till', 'Oven Planner']);
    fireEvent.click(within(tabs()).getByRole('tab', { name: /^All/ }));
    expect(rowNames()[0]).toBe('Back Office Server');
    fireEvent.click(within(tabs()).getByRole('tab', { name: /^Application/ }));
    expect(rowNames()).toEqual(['Web Shop', 'Till', 'Oven Planner']);
  });
});

describe('selection and keys', () => {
  it('a click selects the row and the details panel shows it; the address stays', async () => {
    await openCatalog(`${viewing}?view=catalog&type=Application`);
    fireEvent.click(cell('Till', 'Owning team'));
    await waitFor(() => {
      expect(heading().textContent).toBe('Till');
    });
    expect(rowOf('Till').getAttribute('aria-selected')).toBe('true');
    expect(currentLocation()).toBe(`${viewing}?view=catalog&type=Application`);
    expect(screen.getByRole('button', { name: 'Show on canvas' })).toBeTruthy();
  });

  it('double-click (Viewing), Shift+Enter and Show on canvas open the canvas on the element', async () => {
    await openCatalog(`${viewing}?view=catalog&type=Application`);
    fireEvent.doubleClick(cell('Till', 'Name'));
    expect(currentLocation()).toBe(`${viewing}/elements/till?depth=1`);
  });

  it('Show on canvas focuses the selected element', async () => {
    await openCatalog(`${viewing}?view=catalog&type=Application`);
    fireEvent.click(cell('Web Shop', 'Name'));
    fireEvent.click(await screen.findByRole('button', { name: 'Show on canvas' }));
    expect(currentLocation()).toBe(`${viewing}/elements/shop?depth=1`);
  });

  it('moves with the arrow keys; the panel follows once the cursor rests', async () => {
    await openCatalog(`${viewing}?view=catalog&type=Application`);
    const first = cell('Oven Planner', 'Name');
    expect(first.tabIndex).toBe(0);
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    await focusOn(() => cell('Till', 'Name'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    await focusOn(() => cell('Till', 'Description'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    await focusOn(() => cell('Till', 'Functions'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home', ctrlKey: true });
    await focusOn(() => first);
    fireEvent.keyDown(first, { key: 'End', ctrlKey: true });
    await focusOn(() => cell('Web Shop', 'Functions'));
    await waitFor(() => {
      expect(heading().textContent).toBe('Web Shop');
    });
    // ↑ from the first row goes to the header; Enter there sorts.
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home', ctrlKey: true });
    await focusOn(() => first);
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' });
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('role')).toBe('columnheader');
    });
    fireEvent.keyDown(document.activeElement as Element, { key: 'Enter' });
    expect(rowNames()).toEqual(['Web Shop', 'Till', 'Oven Planner']);
  });

  it('Enter in Viewing and Shift+Enter focus the element on the canvas; a letter jumps', async () => {
    await openCatalog(`${viewing}?view=catalog&type=Application`);
    const first = cell('Oven Planner', 'Name');
    first.focus();
    fireEvent.keyDown(first, { key: 'w' });
    await focusOn(() => cell('Web Shop', 'Name'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Enter', shiftKey: true });
    expect(currentLocation()).toBe(`${viewing}/elements/shop?depth=1`);
  });

  it('a selection from the list takes its tab along', async () => {
    await openCatalog(`${viewing}?view=catalog&type=Application`);
    const tree = screen.getByRole('tree');
    fireEvent.click(
      within(tree).getByRole('treeitem', { name: /^Stakeholder/ }).firstChild as Element,
    );
    fireEvent.click(within(tree).getByRole('treeitem', { name: 'Customer' }).firstChild as Element);
    await waitFor(() => {
      expect(currentLocation()).toBe(`${viewing}?view=catalog&type=Stakeholder`);
    });
    expect(rowOf('Customer').getAttribute('aria-selected')).toBe('true');
  });

  it('is read-only in Viewing', async () => {
    await openCatalog(`${viewing}?view=catalog&type=Application`);
    expect(grid().getAttribute('aria-readonly')).toBe('true');
    const target = cell('Web Shop', 'Owning team');
    target.focus();
    fireEvent.keyDown(target, { key: 'F2' });
    expect(screen.queryByRole('combobox', { name: /^Owning team/ })).toBeNull();
    expect(document.querySelector('.is-editable')).toBeNull();
  });
});

describe('editing a cell (Modelling)', () => {
  const path = `${modelling}?view=catalog&type=Application`;

  async function select(name: string, column: string) {
    const target = cell(name, column);
    fireEvent.click(target);
    await waitFor(() => {
      expect(heading().textContent).toBe(name);
    });
    target.focus();
    return target;
  }

  it('Enter opens, saves one field with the version, and moves down; the panel follows', async () => {
    const { server, fetchMock } = await openCatalog(path, modeller);
    expect(grid().hasAttribute('aria-readonly')).toBe(false);
    const target = await select('Till', 'Owning team');
    await waitFor(() => {
      expect(requests(fetchMock)).toContain(`GET ${elementsUrl}/till`);
    });
    fireEvent.keyDown(target, { key: 'Enter' });
    const input = screen.getByRole('combobox', { name: 'Owning team, Till' });
    fireEvent.change(input, { target: { value: ' Till team ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(cell('Till', 'Owning team').textContent).toBe('Till team');
    });
    expect(server.bodies).toEqual([
      {
        method: 'PATCH',
        url: `${elementsUrl}/till`,
        body: { version: 1, metadata: { owningTeam: 'Till team' } },
      },
    ]);
    expect(document.activeElement).toBe(cell('Web Shop', 'Owning team'));
    // The details panel shows the same value.
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Owning team' }).value).toBe(
      'Till team',
    );
    // The saved row didn't move.
    expect(rowNames()).toEqual(['Oven Planner', 'Till', 'Web Shop']);
  });

  it('opens with F2, a character or Delete; Tab saves and moves right; Esc cancels', async () => {
    const { server } = await openCatalog(path, modeller);
    const target = await select('Till', 'Owning team');
    fireEvent.keyDown(target, { key: 'F2' });
    let input = screen.getByRole('combobox', { name: 'Owning team, Till' });
    expect((input as HTMLInputElement).value).toBe('');
    fireEvent.change(input, { target: { value: 'Mine' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('combobox', { name: 'Owning team, Till' })).toBeNull();
    expect(cell('Till', 'Owning team').textContent).toBe('–Not set');
    expect(document.activeElement).toBe(cell('Till', 'Owning team'));

    fireEvent.keyDown(cell('Till', 'Owning team'), { key: 'K' });
    input = screen.getByRole('combobox', { name: 'Owning team, Till' });
    expect((input as HTMLInputElement).value).toBe('K');
    fireEvent.keyDown(input, { key: 'Tab' });
    await waitFor(() => {
      expect(document.activeElement).toBe(cell('Till', 'Supplier HQ country'));
    });
    expect(cell('Till', 'Owning team').textContent).toBe('K');

    fireEvent.click(cell('Till', 'Description'));
    fireEvent.keyDown(cell('Till', 'Description'), { key: 'Delete' });
    const area = screen.getByRole('textbox', { name: 'Description, Till' });
    expect((area as HTMLTextAreaElement).value).toBe('');
    fireEvent.keyDown(area, { key: 'Escape' });
    expect(server.bodies).toHaveLength(1);
  });

  it('keeps an empty name open with "Enter a name." and sends nothing', async () => {
    const { server } = await openCatalog(path, modeller);
    const target = await select('Till', 'Name');
    fireEvent.keyDown(target, { key: 'Delete' });
    const input = screen.getByRole('textbox', { name: 'Name, Till' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('Enter a name.')).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(server.bodies).toEqual([]);
  });

  it("shows the server's message for the field and keeps the cell open", async () => {
    await openCatalog(path, modeller, (request) =>
      request.method === 'PATCH'
        ? apiError(422, 'Rejected', {
            fields: [{ field: 'metadata.owningTeam', message: 'Must be at most 200 characters.' }],
          })
        : undefined,
    );
    const target = await select('Till', 'Owning team');
    fireEvent.keyDown(target, { key: 'x' });
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Owning team, Till' }), {
      key: 'Enter',
    });
    expect(await screen.findByText('Must be at most 200 characters.')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Owning team, Till' })).toBeTruthy();
  });

  it('shows a conflict with Reload, keeping the typed value until reloaded', async () => {
    const { server } = await openCatalog(path, modeller);
    const target = await select('Till', 'Owning team');
    // Someone else saved meanwhile.
    server.versions.set('till', 2);
    server.nodes.set('till', {
      label: 'Till',
      metadata: { type: 'Application', architectureState: 'Deprecate', owningTeam: 'Theirs' },
    });
    fireEvent.keyDown(target, { key: 'M' });
    const input = screen.getByRole('combobox', { name: 'Owning team, Till' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Someone else changed this element')).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('M');
    expect(input.hasAttribute('readonly')).toBe(true);
    const reload = screen.getByRole('button', { name: 'Reload' });
    await waitFor(() => {
      expect(document.activeElement).toBe(reload);
    });
    fireEvent.click(reload);
    await waitFor(() => {
      expect(cell('Till', 'Owning team').textContent).toBe('Theirs');
    });
    expect(screen.queryByRole('combobox', { name: 'Owning team, Till' })).toBeNull();
  });

  it('picks a choice from the list and saves it', async () => {
    const { server } = await openCatalog(path, modeller);
    const target = await select('Web Shop', 'Architecture state');
    fireEvent.keyDown(target, { key: 'Enter' });
    const combo = screen.getByRole('combobox', { name: 'Architecture state, Web Shop' });
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Not set', 'Deprecate', 'Current', 'Target']);
    fireEvent.keyDown(combo, { key: 'ArrowDown' });
    fireEvent.keyDown(combo, { key: 'Enter' });
    await waitFor(() => {
      expect(cell('Web Shop', 'Architecture state').textContent).toBe('Target');
    });
    expect(server.bodies[0]?.body).toEqual({
      version: 1,
      metadata: { architectureState: 'Target' },
    });
  });

  // A click elsewhere saves the open cell, then does what it does.
  it('a click on another row with a changed open cell saves it, then selects that row', async () => {
    const { server } = await openCatalog(path, modeller);
    const target = await select('Till', 'Owning team');
    fireEvent.keyDown(target, { key: 'Enter' });
    const input = screen.getByRole('combobox', { name: 'Owning team, Till' });
    fireEvent.change(input, { target: { value: 'Till team' } });

    const other = cell('Web Shop', 'Name');
    fireEvent.mouseDown(other);
    input.blur();
    fireEvent.click(other);

    await waitFor(() => {
      expect(cell('Till', 'Owning team').textContent).toBe('Till team');
    });
    expect(server.bodies.filter((b) => b.method === 'PATCH')).toHaveLength(1);
    await waitFor(() => {
      expect(heading().textContent).toBe('Web Shop');
    });
    expect(rowOf('Web Shop').getAttribute('aria-selected')).toBe('true');
  });

  it('asks before leaving with a changed, open cell', async () => {
    const { handler } = api();
    stubApi(modeller, handler);
    const browser = renderWithHistory(`${modelling}/elements/shop?depth=1`);
    await screen.findByRole('form', { name: /^Edit / });
    fireEvent.click(viewButton('Catalog'));
    await screen.findByRole('grid');
    const target = cell('Web Shop', 'Owning team');
    fireEvent.click(target);
    fireEvent.keyDown(target, { key: 'Enter' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Owning team, Web Shop' }), {
      target: { value: 'Changed' },
    });
    browser(-1);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading').textContent).toBe('Save changes to “Web Shop”?');
  });

  it('a save in the details panel shows in the table', async () => {
    await openCatalog(path, modeller);
    await select('Till', 'Name');
    const field = screen.getByRole('combobox', { name: 'Owning team' });
    fireEvent.change(field, { target: { value: 'Panel team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(cell('Till', 'Owning team').textContent).toBe('Panel team');
    });
  });

  it('after a delete in the panel, the next row is selected and focused', async () => {
    await openCatalog(path, modeller);
    await select('Till', 'Name');
    const details = screen.getByRole('complementary', { name: 'Details' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(within(details).getByRole('button', { name: 'Delete element' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete “Till”?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete element' }));
    await waitFor(() => {
      expect(rowNames()).toEqual(['Oven Planner', 'Web Shop']);
    });
    await waitFor(() => {
      expect(heading().textContent).toBe('Web Shop');
    });
    expect(document.activeElement).toBe(cell('Web Shop', 'Name'));
    expect(currentLocation()).toBe(path);
  });

  it('New element keeps the catalog and selects the new row in its tab', async () => {
    await openCatalog(path, modeller);
    fireEvent.click(screen.getByRole('button', { name: 'New element' }));
    const pop = screen.getByRole('dialog', { name: 'New element' });
    fireEvent.change(within(pop).getByRole('textbox', { name: /^Name/ }), {
      target: { value: 'Flour Stock' },
    });
    fireEvent.click(within(pop).getByRole('radio', { name: 'Infrastructure' }));
    fireEvent.submit(pop.querySelector('form') as HTMLFormElement);
    await waitFor(() => {
      expect(currentLocation()).toBe(`${modelling}?view=catalog&type=Infrastructure`);
    });
    expect(rowNames()).toEqual(['Back Office Server', 'Flour Stock']);
    expect(rowOf('Flour Stock').getAttribute('aria-selected')).toBe('true');
  });
});
