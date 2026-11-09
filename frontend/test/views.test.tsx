import type { JgfDocument, ModelSummary, StoredView } from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  apiError,
  currentLocation,
  modeller,
  renderAt,
  stubApi,
  viewer,
  type Handler,
} from './helpers';

// Views: a named, stored set of elements and relationships, opened, changed and saved at once.
// Made-up data: a small library.

const libraryId = '33333333-3333-4333-8333-333333333333';

const library: JgfDocument = {
  graph: {
    id: libraryId,
    label: 'Made-up library',
    directed: true,
    nodes: {
      reader: { label: 'Reader', metadata: { type: 'Stakeholder' } },
      catalogue: { label: 'Catalogue', metadata: { type: 'Application' } },
      loans: { label: 'Loans', metadata: { type: 'Application' } },
      search: { label: 'Search', metadata: { type: 'Application' } },
      building: { label: 'Library building', metadata: { type: 'Infrastructure' } },
      server: { label: 'Book server', metadata: { type: 'Infrastructure' } },
      archive: { label: 'Archive', metadata: { type: 'Other' } },
    },
    edges: [
      { id: 'r1', source: 'reader', target: 'catalogue', relation: 'Relation' },
      { id: 'r2', source: 'catalogue', target: 'loans', relation: 'Relation', label: 'Lends' },
      { id: 'r3', source: 'catalogue', target: 'loans', relation: 'Relation', label: 'Holds' },
      { id: 'r4', source: 'building', target: 'server', relation: 'Contains' },
      { id: 'r5', source: 'loans', target: 'server', relation: 'Relation', label: 'Stores on' },
      { source: 'search', target: 'catalogue', relation: 'Relation' },
      { id: 'r6', source: 'catalogue', target: 'search', relation: 'Relation' },
      { id: 'r7', source: 'archive', target: 'loans', relation: 'Relation' },
    ],
  },
};

const summary: ModelSummary = {
  id: libraryId,
  name: 'Made-up library',
  createdAt: '2026-11-01T10:00:00.000Z',
  createdBy: { id: 'u1', name: 'Alex Morgan' },
  nodeCount: 7,
  edgeCount: 8,
};

const author = { id: 'u1', name: 'Alex Morgan' };

function stored(id: string, name: string, elementIds: string[], relationshipIds: string[] = []) {
  const view: StoredView = {
    id,
    name,
    version: 1,
    elementCount: elementIds.length,
    relationshipCount: relationshipIds.length,
    createdAt: '2026-11-05T09:00:00.000Z',
    createdBy: author,
    updatedAt: '2026-11-05T09:00:00.000Z',
    updatedBy: author,
    elementIds,
    relationshipIds,
    layout: [],
  };
  return view;
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

/** A model, and its views kept by a made-up server with versions, as the API does. */
function server(initial: StoredView[] = []) {
  const views = new Map(initial.map((view) => [view.id, structuredClone(view)]));
  const calls: Call[] = [];
  /** Answers the next change with this instead. */
  const next: { failWith?: Response } = {};
  let created = 0;
  const base = `/api/models/${libraryId}/views`;
  const summaryOf = (view: StoredView) => {
    const copy: Partial<StoredView> = { ...view };
    delete copy.elementIds;
    delete copy.relationshipIds;
    delete copy.layout;
    return copy;
  };
  const handler: Handler = ({ url, method, body }) => {
    if (method === 'GET' && url === '/api/models') {
      return Response.json({ models: [summary], editable: true });
    }
    if (method === 'GET' && url === `/api/models/${libraryId}`) return Response.json(library);
    if (method === 'GET' && url.startsWith(`/api/models/${libraryId}/elements/`)) {
      const id = decodeURIComponent(url.split('/elements/')[1] ?? '');
      return Response.json({
        element: { id, version: 1, node: library.graph.nodes?.[id] },
        warnings: [],
      });
    }
    if (method === 'GET' && url.startsWith(`/api/models/${libraryId}/relationships/`)) {
      const id = decodeURIComponent(url.split('/relationships/')[1] ?? '');
      const edge = library.graph.edges?.find((e) => e.id === id);
      return Response.json({
        relationship: { id, version: 1, edge },
        warnings: [],
        nestingChanges: [],
      });
    }
    if (method === 'POST' && url === `/api/models/${libraryId}/elements`) {
      const request = JSON.parse(String(body)) as { name: string; type: string };
      return Response.json(
        {
          element: {
            id: 'shelf',
            version: 1,
            node: { label: request.name, metadata: { type: request.type } },
          },
          warnings: [],
        },
        { status: 201 },
      );
    }
    if (!url.startsWith(base)) return undefined;
    const parsed =
      typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : undefined;
    calls.push({ method, url, body: parsed });
    if (method !== 'GET' && next.failWith) {
      const answer = next.failWith;
      delete next.failWith;
      return answer;
    }
    const path = url.slice(base.length).split('?')[0] ?? '';
    const [, viewId = '', part] = path.split('/');
    const view = views.get(decodeURIComponent(viewId));
    if (method === 'GET' && path === '') {
      return Response.json({ views: [...views.values()].map(summaryOf) });
    }
    if (method === 'POST' && path === '') {
      const name = String(parsed?.name);
      const taken = [...views.values()].find(
        (other) => other.name.toLowerCase() === name.toLowerCase(),
      );
      if (taken) {
        return apiError(422, 'The change is not valid.', {
          fields: [
            {
              field: 'name',
              message: `This model already has a view called “${taken.name}”. Choose another name.`,
            },
          ],
        });
      }
      created += 1;
      const made = stored(
        `v-new-${created}`,
        name,
        parsed?.elementIds as string[],
        (parsed?.relationshipIds as string[] | undefined) ?? [],
      );
      views.set(made.id, made);
      return Response.json({ view: made }, { status: 201 });
    }
    if (!view) return apiError(404, 'This view does not exist.', { missing: 'view' });
    if (method === 'GET') return Response.json({ view });
    const version =
      method === 'DELETE'
        ? Number(new URL(url, 'http://x').searchParams.get('version'))
        : parsed?.version;
    if (version !== view.version) {
      return apiError(409, 'Someone else changed this view.', { currentVersion: view.version });
    }
    if (method === 'DELETE') {
      views.delete(view.id);
      return Response.json({ id: view.id });
    }
    view.version += 1;
    if (method === 'PATCH') {
      view.name = String(parsed?.name);
      return Response.json({ view: summaryOf(view) });
    }
    if (method === 'PUT' && part === 'contents') {
      view.elementIds = parsed?.elementIds as string[];
      view.relationshipIds = parsed?.relationshipIds as string[];
      view.elementCount = view.elementIds.length;
      view.relationshipCount = view.relationshipIds.length;
      const kept = new Set(view.elementIds);
      view.layout = view.layout.filter((card) => kept.has(card.elementId));
      return Response.json({ view });
    }
    if (method === 'PUT' && part === 'layout') {
      view.layout = parsed?.cards as StoredView['layout'];
      return Response.json({ view });
    }
    return undefined;
  };
  return { views, calls, next, handler };
}

type Space = 'viewing' | 'modelling';
const modelAt = (space: Space) => `/${space}/models/${libraryId}`;
const viewAt = (space: Space, id: string) => `${modelAt(space)}/views/${id}`;
const canvasEl = () => document.getElementById('canvas') as HTMLElement;
const card = (id: string) =>
  canvasEl().querySelector<HTMLElement>(`.card[data-element-id="${CSS.escape(id)}"]`);
const cardIds = () =>
  [...canvasEl().querySelectorAll('.card[data-element-id]')]
    .map((element) => element.getAttribute('data-element-id'))
    .sort();
const edgeCount = () => canvasEl().querySelectorAll('.react-flow__edge').length;
const labels = () => [...canvasEl().querySelectorAll('.edge-label')].map((l) => l.textContent);
/** The left panel, and its Views section's header and contents. */
const leftPanel = () => screen.getByRole('complementary', { name: 'Elements and views' });
const viewsHeader = () => within(leftPanel()).getByRole('button', { name: 'Views' });
const viewsSection = () => leftPanel().querySelector('.views-sec') as HTMLElement;
const viewsList = () => screen.getByRole('list', { name: 'Views in this model' });
const findViewsList = () => screen.findByRole('list', { name: 'Views in this model' });
const toolbar = () => document.querySelector('.toolbar') as HTMLElement;
const dragType = 'application/x-simplearchitecture-element';
const dragged = (id: string) => ({
  types: [dragType],
  getData: (type: string) => (type === dragType ? id : ''),
});
const changes = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');
/** New contents saved, without the layouts saved after them. */
const contentsSaves = (calls: Call[]) =>
  changes(calls).filter((call) => !call.url.endsWith('/layout'));
const layoutSaves = (calls: Call[]) =>
  changes(calls).filter((call) => call.url.endsWith('/layout'));

function open(path: string, space: Space, views: StoredView[] = []) {
  const fake = server(views);
  const fetchMock = stubApi(space === 'viewing' ? viewer : modeller, fake.handler);
  renderAt(path);
  return { ...fake, fetchMock };
}

async function shown(ids: string[]) {
  await waitFor(() => {
    expect(cardIds()).toEqual([...ids].sort());
  });
}

/** Opens the Views section (when closed) and gives its contents. */
async function openPanel() {
  if (viewsHeader().getAttribute('aria-expanded') !== 'true') fireEvent.click(viewsHeader());
  await waitFor(() => {
    expect(viewsHeader().getAttribute('aria-expanded')).toBe('true');
  });
  return within(viewsSection());
}

const lending = () => stored('v-lending', 'Lending', ['loans', 'server'], ['r5']);
const reading = () =>
  stored('v-reading', 'Reading', ['reader', 'catalogue', 'loans'], ['r1', 'r2']);

describe('Views in the left panel', () => {
  it.each(['viewing', 'modelling'] as const)(
    'sits under the element list, closed at first, with no Views button in the toolbar (%s)',
    async (space) => {
      const { fetchMock } = open(`${modelAt(space)}/elements/catalogue`, space);
      await waitFor(() => {
        expect(card('catalogue')).toBeTruthy();
      });
      expect(within(toolbar()).queryByRole('button', { name: /Views/ })).toBeNull();
      const tree = within(leftPanel()).getByRole('tree', { name: 'Elements by type' });
      // Right after the list, before the legend.
      expect(tree.compareDocumentPosition(viewsHeader()) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      const legend = within(leftPanel()).getByRole('button', { name: 'Legend' });
      expect(viewsHeader().compareDocumentPosition(legend) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(viewsHeader().getAttribute('aria-expanded')).toBe('false');
      expect(viewsHeader().hasAttribute('aria-controls')).toBe(false);
      // Nothing is read while it is closed.
      expect(fetchMock.mock.calls.some(([url]) => url === `/api/models/${libraryId}/views`)).toBe(
        false,
      );
      // In the catalog too.
      fireEvent.click(
        within(screen.getByRole('group', { name: 'Show as' })).getByRole('button', {
          name: 'Catalog',
        }),
      );
      await screen.findByRole('grid');
      expect(viewsHeader()).toBeTruthy();
    },
  );

  it('remembers open or closed in this browser', async () => {
    open(`${modelAt('viewing')}/elements/catalogue`, 'viewing', [lending()]);
    await waitFor(() => {
      expect(card('catalogue')).toBeTruthy();
    });
    const panel = await openPanel();
    await panel.findByRole('link', { name: 'Lending' });
    expect(localStorage.getItem('sa-views-open')).toBe('true');
    expect(viewsHeader().getAttribute('aria-controls')).toBe(
      viewsSection().querySelector('.psec-body')?.id,
    );
    fireEvent.click(viewsHeader());
    expect(viewsHeader().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list', { name: 'Views in this model' })).toBeNull();
    expect(localStorage.getItem('sa-views-open')).toBe('false');
  });

  it('opens at once when it was open before', async () => {
    localStorage.setItem('sa-views-open', 'true');
    open(`${modelAt('viewing')}/elements/catalogue`, 'viewing', [lending()]);
    expect(
      await within(await findViewsList()).findByRole('link', { name: 'Lending' }),
    ).toBeTruthy();
    expect(viewsHeader().getAttribute('aria-expanded')).toBe('true');
  });

  it('lists the views by name as links, reading them again each time it opens', async () => {
    const { views, fetchMock } = open(`${modelAt('viewing')}/elements/catalogue`, 'viewing', [
      reading(),
      lending(),
    ]);
    await waitFor(() => {
      expect(card('catalogue')).toBeTruthy();
    });
    let panel = await openPanel();
    const links = await panel.findAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Lending', 'Reading']);
    expect(links[0]?.getAttribute('href')).toBe(viewAt('viewing', 'v-lending'));
    expect(viewsHeader().getAttribute('aria-expanded')).toBe('true');

    // Esc no longer closes anything: it isn't a popup.
    fireEvent.keyDown(links[0] as HTMLElement, { key: 'Escape' });
    expect(viewsList()).toBeTruthy();
    fireEvent.click(viewsHeader());

    views.set('v-new', stored('v-new', 'Acquisitions', ['archive']));
    const listed = () =>
      fetchMock.mock.calls.filter(([url]) => url === `/api/models/${libraryId}/views`).length;
    const before = listed();
    panel = await openPanel();
    await panel.findByRole('link', { name: 'Acquisitions' });
    expect(listed()).toBeGreaterThan(before);
  });

  it('moves with the arrow keys, Home and End, and opens a view with its link', async () => {
    open(`${modelAt('viewing')}/elements/catalogue`, 'viewing', [
      reading(),
      lending(),
      stored('v-c', 'Cataloguing', ['catalogue']),
    ]);
    await waitFor(() => {
      expect(card('catalogue')).toBeTruthy();
    });
    const panel = await openPanel();
    const [first, second, third] = await panel.findAllByRole('link');
    fireEvent.keyDown(viewsHeader(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(first);
    // ↑ from the first goes back to the header.
    fireEvent.keyDown(first as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(viewsHeader());
    // Enter on a link follows it, as a click does.
    fireEvent.click(first as HTMLElement);
    await waitFor(() => {
      expect(currentLocation()).toBe(viewAt('viewing', 'v-c'));
    });
    // The section stays open, with the open view checked.
    expect(
      within(viewsList()).getByRole('link', { name: 'Cataloguing' }).getAttribute('aria-current'),
    ).toBe('page');
    await screen.findByRole('heading', { level: 2, name: 'View Cataloguing' });
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('view-name');
    });
  });

  it('has a filter with 9 or more views, matching as the element search does', async () => {
    const many = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Café'].map(
      (name, index) => stored(`v${index}`, name, ['reader']),
    );
    open(`${modelAt('viewing')}/elements/catalogue`, 'viewing', many);
    await waitFor(() => {
      expect(card('catalogue')).toBeTruthy();
    });
    const panel = await openPanel();
    const filter = await panel.findByRole('searchbox', { name: 'Filter views' });
    fireEvent.change(filter, { target: { value: 'cafe' } });
    expect(panel.getAllByRole('link').map((link) => link.textContent)).toEqual(['Café']);
    expect(panel.getByRole('status').textContent).toBe('1 view');
    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Café');
    fireEvent.change(filter, { target: { value: 'xyz' } });
    expect(panel.getByText('No views match “xyz”.')).toBeTruthy();
  });

  it.each([
    ['viewing', '/elements/catalogue', 'No views yet. Views are saved in Modelling.', false],
    ['modelling', '/elements/catalogue', 'No views yet.', true],
    ['modelling', '', 'No views yet. Focus an element, then use Save as view here.', false],
    [
      'modelling',
      '?view=catalog',
      'No views yet. Focus an element, then use Save as view here.',
      false,
    ],
  ] as const)('says so without views (%s%s)', async (space, rest, text, canSave) => {
    open(`${modelAt(space)}${rest}`, space);
    await waitFor(() => {
      expect(viewsHeader()).toBeTruthy();
    });
    const panel = await openPanel();
    await panel.findByText(text);
    expect(panel.queryByRole('button', { name: 'Save as view…' }) !== null).toBe(canSave);
  });
});

describe("the model's start page", () => {
  it('offers up to 5 views, and All views opens the list', async () => {
    const seven = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name) =>
      stored(`v-${name}`, `View ${name}`, ['reader']),
    );
    open(modelAt('viewing'), 'viewing', seven);
    await screen.findByText('Or open a view:');
    const offered = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href')?.includes('/views/'));
    expect(offered.map((link) => link.textContent)).toEqual([
      'View A',
      'View B',
      'View C',
      'View D',
      'View E',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'All views (7)' }));
    expect(await within(await findViewsList()).findAllByRole('link')).toHaveLength(7);
    await waitFor(() => {
      expect(document.activeElement).toBe(viewsHeader());
    });
  });

  it('All views shows the left panel when it was hidden', async () => {
    const seven = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name) =>
      stored(`v-${name}`, `View ${name}`, ['reader']),
    );
    open(modelAt('viewing'), 'viewing', seven);
    await screen.findByText('Or open a view:');
    fireEvent.click(screen.getByRole('button', { name: 'Hide the element list' }));
    expect(screen.queryByRole('complementary', { name: 'Elements and views' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All views (7)' }));
    expect(await within(await findViewsList()).findAllByRole('link')).toHaveLength(7);
    expect(viewsHeader().getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => {
      expect(document.activeElement).toBe(viewsHeader());
    });
  });

  it('adds nothing without views', async () => {
    const { fetchMock } = open(modelAt('viewing'), 'viewing');
    await screen.findByText('Choose an element to explore');
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === `/api/models/${libraryId}/views`)).toBe(
        true,
      );
    });
    expect(screen.queryByText('Or open a view:')).toBeNull();
  });
});

describe('Save as view', () => {
  it('saves exactly what the canvas draws, then opens the new view', async () => {
    const { calls } = open(`${modelAt('modelling')}/elements/catalogue?depth=1`, 'modelling');
    await shown(['catalogue', 'reader', 'loans', 'search']);
    const panel = await openPanel();
    fireEvent.click(await panel.findByRole('button', { name: 'Save as view…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save as view' });
    // Each relationship of the merged line counts; the one without an id can't be in a view.
    expect(
      within(dialog).getByText(/^Saves the 4 elements and 4 relationships on the canvas\./),
    ).toBeTruthy();
    const name = within(dialog).getByRole<HTMLInputElement>('textbox', { name: /Name/ });
    expect(name.value).toBe('Catalogue');
    expect(document.activeElement).toBe(name);
    expect([name.selectionStart, name.selectionEnd]).toEqual([0, 'Catalogue'.length]);
    fireEvent.change(name, { target: { value: '  Finding books ' } });
    fireEvent.submit(name);
    await waitFor(() => {
      expect(currentLocation()).toBe(viewAt('modelling', 'v-new-1'));
    });
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body?.name).toBe('Finding books');
    expect([...(post?.body?.elementIds as string[])].sort()).toEqual(
      ['catalogue', 'loans', 'reader', 'search'].sort(),
    );
    expect([...(post?.body?.relationshipIds as string[])].sort()).toEqual(['r1', 'r2', 'r3', 'r6']);
    await screen.findByRole('heading', { level: 2, name: 'View Finding books' });
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('view-name');
    });
    expect(
      screen.getByText('Saved the view “Finding books”: 4 elements, 4 relationships.'),
    ).toBeTruthy();
  });

  it('goes back to Save as view on Cancel, and lists the new view once saved', async () => {
    open(`${modelAt('modelling')}/elements/catalogue?depth=1`, 'modelling', [lending()]);
    await shown(['catalogue', 'reader', 'loans', 'search']);
    const panel = await openPanel();
    const save = await panel.findByRole('button', { name: 'Save as view…' });
    fireEvent.click(save);
    let dialog = await screen.findByRole('dialog', { name: 'Save as view' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(save);
    });
    fireEvent.click(save);
    dialog = await screen.findByRole('dialog', { name: 'Save as view' });
    const name = within(dialog).getByRole<HTMLInputElement>('textbox', { name: /Name/ });
    fireEvent.change(name, { target: { value: 'Finding books' } });
    fireEvent.submit(name);
    await screen.findByRole('heading', { level: 2, name: 'View Finding books' });
    // The open section reads the list again: the new view is there, checked.
    const link = await within(viewsSection()).findByRole('link', { name: 'Finding books' });
    expect(link.getAttribute('aria-current')).toBe('page');
  });

  it('checks the name: empty, too long and taken (from the server)', async () => {
    open(`${modelAt('modelling')}/elements/catalogue?depth=1`, 'modelling', [lending()]);
    await shown(['catalogue', 'reader', 'loans', 'search']);
    fireEvent.click(await (await openPanel()).findByRole('button', { name: 'Save as view…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save as view' });
    const name = within(dialog).getByRole<HTMLInputElement>('textbox', { name: /Name/ });
    for (const [value, message] of [
      ['   ', 'Enter a name.'],
      ['x'.repeat(201), 'The name has 201 characters. Use 200 or fewer.'],
      ['LENDING', 'This model already has a view called “Lending”. Choose another name.'],
    ]) {
      fireEvent.change(name, { target: { value } });
      fireEvent.submit(name);
      expect(await within(dialog).findByText(message as string)).toBeTruthy();
      expect(name.getAttribute('aria-invalid')).toBe('true');
    }
    expect(currentLocation()).toBe(`${modelAt('modelling')}/elements/catalogue?depth=1`);
  });

  it('is not offered in Viewing, in the catalog or in an open view', async () => {
    open(viewAt('modelling', 'v-lending'), 'modelling', [lending()]);
    await shown(['loans', 'server']);
    const panel = await openPanel();
    await panel.findByRole('link', { name: 'Lending' });
    expect(panel.queryByRole('button', { name: 'Save as view…' })).toBeNull();
    expect(panel.getByRole('link', { name: 'Lending' }).getAttribute('aria-current')).toBe('page');
  });
});

describe('an open view', () => {
  it('shows exactly its elements and relationships, with no focus, depth or containers', async () => {
    open(`${viewAt('viewing', 'v-lending')}?depth=2`, 'viewing', [lending()]);
    await shown(['loans', 'server']);
    // The building holds the server in the model, but isn't in the view: it isn't brought in.
    expect(card('building')).toBeNull();
    expect(edgeCount()).toBe(1);
    // The address drops what doesn't apply to a view.
    await waitFor(() => {
      expect(currentLocation()).toBe(viewAt('viewing', 'v-lending'));
    });
    expect(screen.getByRole('heading', { level: 2, name: 'View Lending' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Diagram: view Lending, 2 elements' })).toBeTruthy();
    expect(document.title).toBe('Lending · SimpleArchitecture');
    for (const name of ['Back', 'Rename', 'Delete', 'Remove from view', 'Remove from canvas']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('group', { name: 'Relationship depth' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Visited elements' })).toBeNull();
    expect(canvasEl().querySelector('.card.is-focus, .card[data-focused="true"]')).toBeNull();
    // No card is selected, so the details stay closed.
    expect(screen.queryByRole('complementary', { name: 'Details' })).toBeNull();
    // The depth keys do nothing.
    fireEvent.keyDown(card('loans')?.querySelector('.card-main') as HTMLElement, { key: '3' });
    expect(currentLocation()).toBe(viewAt('viewing', 'v-lending'));
  });

  it('draws only the relationships it holds', async () => {
    open(viewAt('viewing', 'v-reading'), 'viewing', [reading()]);
    await shown(['reader', 'catalogue', 'loans']);
    await waitFor(() => {
      expect(edgeCount()).toBe(2);
    });
    // Lends is in the view, Holds (between the same two) isn't: no merged "×2" line.
    expect(labels()).toContain('Lends');
    expect(labels()).not.toContain('×2');
  });

  it('leaves for the element on a double-click, and Back returns to the view', async () => {
    open(viewAt('viewing', 'v-lending'), 'viewing', [lending()]);
    await shown(['loans', 'server']);
    const main = card('loans')?.querySelector('.card-main') as HTMLElement;
    fireEvent.click(main, { detail: 1 });
    fireEvent.click(main, { detail: 2 });
    await waitFor(() => {
      expect(currentLocation()).toBe(`${modelAt('viewing')}/elements/loans?depth=1`);
    });
    expect(screen.queryByRole('heading', { level: 2, name: 'View Lending' })).toBeNull();
  });

  it('closes to the start page, with focus on the Views header', async () => {
    open(`${viewAt('viewing', 'v-lending')}?show=data`, 'viewing', [lending()]);
    await shown(['loans', 'server']);
    fireEvent.click(screen.getByRole('button', { name: 'Close view' }));
    await waitFor(() => {
      expect(currentLocation()).toBe(`${modelAt('viewing')}?show=data`);
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(viewsHeader());
    });
  });

  // A frame can come before the start page is drawn (the address changes in a transition), so
  // these run requestAnimationFrame at once: focus must still land on the start page's canvas.
  async function withFramesAtOnce(run: () => Promise<void>) {
    const frames = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(performance.now());
      return 0;
    });
    try {
      await run();
    } finally {
      frames.mockRestore();
    }
  }
  const startCanvasFocused = () => {
    const focused = document.activeElement as HTMLElement;
    expect(focused.id).toBe('canvas');
    expect(focused.isConnected).toBe(true);
    expect(within(focused).getByText('Choose an element to explore')).toBeTruthy();
  };

  it('closes to the canvas area when the left panel is hidden', async () => {
    open(viewAt('viewing', 'v-lending'), 'viewing', [lending()]);
    await shown(['loans', 'server']);
    fireEvent.click(screen.getByRole('button', { name: 'Hide the element list' }));
    await withFramesAtOnce(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close view' }));
      await waitFor(() => {
        expect(currentLocation()).toBe(modelAt('viewing'));
      });
      await screen.findByText('Choose an element to explore');
      await waitFor(startCanvasFocused);
    });
  });

  it('goes to the canvas area after Delete view when the left panel is hidden', async () => {
    open(viewAt('modelling', 'v-lending'), 'modelling', [lending()]);
    await shown(['loans', 'server']);
    fireEvent.click(screen.getByRole('button', { name: 'Hide the element list' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete the view “Lending”?' });
    await withFramesAtOnce(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete view' }));
      await waitFor(() => {
        expect(currentLocation()).toBe(modelAt('modelling'));
      });
      await screen.findByText('Choose an element to explore');
      await waitFor(startCanvasFocused);
    });
  });

  it('leaves for the whole model in the catalog', async () => {
    open(viewAt('viewing', 'v-lending'), 'viewing', [lending()]);
    await shown(['loans', 'server']);
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Show as' })).getByRole('button', {
        name: 'Catalog',
      }),
    );
    await waitFor(() => {
      expect(currentLocation()).toMatch(new RegExp(`^${modelAt('viewing')}\\?view=catalog`));
    });
  });

  it("says so when the view doesn't exist, with Close view", async () => {
    open(viewAt('viewing', 'gone'), 'viewing', [lending()]);
    await screen.findByRole('heading', { level: 2, name: "This view doesn't exist." });
    expect(screen.getByText('It may have been deleted, or the link is wrong.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /^View / })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close view' }));
    await waitFor(() => {
      expect(currentLocation()).toBe(modelAt('viewing'));
    });
  });

  it('says so when it is empty', async () => {
    open(viewAt('modelling', 'v-empty'), 'modelling', [stored('v-empty', 'Empty', [])]);
    await screen.findByRole('heading', { level: 2, name: 'This view is empty.' });
    expect(
      screen.getByText('Drag elements here from the list, or use Add to canvas.'),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'View Empty' })).toBeTruthy();
  });
});

describe('changing an open view (Modelling)', () => {
  it('adds a dropped element with its relationships to elements in the view, and saves', async () => {
    const { calls, views } = open(viewAt('modelling', 'v-lending'), 'modelling', [lending()]);
    await shown(['loans', 'server']);
    fireEvent.drop(canvasEl(), { dataTransfer: dragged('archive'), clientX: 200, clientY: 200 });
    await shown(['loans', 'server', 'archive']);
    await waitFor(() => {
      expect(contentsSaves(calls)).toHaveLength(1);
    });
    expect(contentsSaves(calls)[0]).toMatchObject({
      method: 'PUT',
      url: `/api/models/${libraryId}/views/v-lending/contents`,
      body: {
        version: 1,
        elementIds: ['loans', 'server', 'archive'],
        relationshipIds: ['r5', 'r7'],
      },
    });
    expect(screen.getByText('Added “Archive” to the view, with 1 relationship.')).toBeTruthy();
    await screen.findByText('Saved');
    // Then where its cards are, the new one included, with the version after.
    await waitFor(() => {
      expect(layoutSaves(calls)).toHaveLength(1);
    });
    expect(layoutSaves(calls)[0]?.body?.version).toBe(2);
    expect(
      (layoutSaves(calls)[0]?.body?.cards as { elementId: string }[])
        .map((c) => c.elementId)
        .sort(),
    ).toEqual(['archive', 'loans', 'server']);
    await waitFor(() => {
      expect(views.get('v-lending')?.version).toBe(3);
    });
    // No Save button for the view.
    expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull();
  });

  it('adds an element made on its canvas', async () => {
    const { calls } = open(viewAt('modelling', 'v-lending'), 'modelling', [lending()]);
    await shown(['loans', 'server']);
    // N: + Element left the toolbar.
    fireEvent.keyDown(document.body, { key: 'n' });
    const pop = await screen.findByRole('dialog', { name: 'New element' });
    fireEvent.change(within(pop).getByRole('textbox', { name: /^Name/ }), {
      target: { value: 'Shelf' },
    });
    fireEvent.click(within(pop).getByRole('button', { name: 'Create' }));
    await shown(['loans', 'server', 'shelf']);
    await waitFor(() => {
      expect(contentsSaves(calls)).toHaveLength(1);
    });
    expect(contentsSaves(calls)[0]?.body).toMatchObject({
      version: 1,
      elementIds: ['loans', 'server', 'shelf'],
      relationshipIds: ['r5'],
    });
    expect(currentLocation()).toBe(viewAt('modelling', 'v-lending'));
  });

  it('removes a card with its ×, with its relationships, and saves', async () => {
    const { calls } = open(viewAt('modelling', 'v-reading'), 'modelling', [reading()]);
    await shown(['reader', 'catalogue', 'loans']);
    expect(within(toolbar()).queryByRole('button', { name: /Remove/ })).toBeNull();
    // Every card in a view that can change has its ×.
    for (const id of ['reader', 'catalogue', 'loans']) {
      expect(
        within(card(id) as HTMLElement).getByRole('button', { name: /^Remove .* from view$/ })
          .title,
      ).toBe('Remove from view. The element stays in the model.');
    }
    // The card goes with its lines; the element stays in the model. It needn't be selected.
    fireEvent.click(
      within(card('reader') as HTMLElement).getByRole('button', {
        name: 'Remove Reader from view',
      }),
    );
    await shown(['catalogue', 'loans']);
    expect(screen.getByText('Removed “Reader” from the view. It stays in the model.')).toBeTruthy();
    expect(document.activeElement).toBe(canvasEl());
    await waitFor(() => {
      expect(contentsSaves(calls)).toHaveLength(1);
    });
    expect(contentsSaves(calls)[0]?.body).toMatchObject({
      version: 1,
      elementIds: ['catalogue', 'loans'],
      relationshipIds: ['r2'],
    });
    await waitFor(() => {
      expect(layoutSaves(calls)).toHaveLength(1);
    });
    expect(
      (layoutSaves(calls)[0]?.body?.cards as { elementId: string }[]).map((c) => c.elementId),
    ).toEqual(['catalogue', 'loans']);
  });

  it('offers no way to take one relationship out, on a line or a merged line', async () => {
    const both = stored('v-both', 'Both', ['catalogue', 'loans'], ['r2', 'r3']);
    const { calls } = open(viewAt('modelling', 'v-both'), 'modelling', [both]);
    await shown(['catalogue', 'loans']);
    await waitFor(() => {
      expect(labels()).toContain('×2');
    });
    const label = [...canvasEl().querySelectorAll<HTMLElement>('.edge-label')].find(
      (l) => l.textContent === '×2',
    ) as HTMLElement;
    fireEvent.pointerDown(label, { clientX: 100, clientY: 100 });
    fireEvent.click(label, { clientX: 101, clientY: 100 });
    const menu = await screen.findByRole('menu', { name: '2 relationships' });
    fireEvent.click(within(menu).getAllByRole('menuitem')[0] as HTMLElement);
    await screen.findByRole('form', { name: /^Relationship / });
    // The relationship is open; nothing on the canvas, toolbar or view bar removes it from the view.
    expect(screen.queryByRole('button', { name: /^Remove relationship/ })).toBeNull();
    const removeButtons = screen
      .getAllByRole('button', { name: /^Remove / })
      .map((button) => button.getAttribute('aria-label'));
    expect(removeButtons.every((name) => /^Remove .+ from view$/.test(name ?? ''))).toBe(true);
    expect(canvasEl().querySelectorAll('.cremove')).toHaveLength(2);
    expect(within(toolbar()).queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(changes(calls)).toEqual([]);
  });

  it('goes back when someone else changed the view, until Reload view', async () => {
    const { views, next } = open(viewAt('modelling', 'v-lending'), 'modelling', [lending()]);
    await shown(['loans', 'server']);
    // Someone else adds the reader meanwhile.
    const other = views.get('v-lending') as StoredView;
    views.set('v-lending', { ...other, version: 2, elementIds: ['loans', 'server', 'reader'] });
    fireEvent.drop(canvasEl(), { dataTransfer: dragged('archive'), clientX: 200, clientY: 200 });
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain(
      "Someone else changed this view. Your change wasn't saved.",
    );
    // Back to what was saved. No × on the cards, and N makes nothing, until Reload view.
    await shown(['loans', 'server']);
    await waitFor(() => {
      expect(canvasEl().querySelector('.cremove')).toBeNull();
    });
    fireEvent.keyDown(document.body, { key: 'n' });
    expect(screen.queryByRole('dialog', { name: 'New element' })).toBeNull();
    expect(next.failWith).toBeUndefined();
    fireEvent.click(within(notice).getByRole('button', { name: 'Reload view' }));
    await shown(['loans', 'server', 'reader']);
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('view-name');
    });
  });

  it('says when someone else deleted the view, with Close view', async () => {
    const { views } = open(viewAt('modelling', 'v-lending'), 'modelling', [lending()]);
    await shown(['loans', 'server']);
    views.delete('v-lending');
    fireEvent.drop(canvasEl(), { dataTransfer: dragged('archive'), clientX: 200, clientY: 200 });
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain(
      "Someone else deleted this view. Your change wasn't saved.",
    );
    await shown(['loans', 'server']);
    fireEvent.click(within(notice).getByRole('button', { name: 'Close view' }));
    await waitFor(() => {
      expect(currentLocation()).toBe(modelAt('modelling'));
    });
  });

  it('says when a change could not be saved, and goes back', async () => {
    const { next } = open(viewAt('modelling', 'v-lending'), 'modelling', [lending()]);
    await shown(['loans', 'server']);
    next.failWith = apiError(503, 'Unavailable');
    fireEvent.drop(canvasEl(), { dataTransfer: dragged('archive'), clientX: 200, clientY: 200 });
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain(
      "Your change to the view wasn't saved. Check your connection and try again.",
    );
    await shown(['loans', 'server']);
    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('saves one change at a time, each with the version before', async () => {
    const { calls } = open(viewAt('modelling', 'v-lending'), 'modelling', [lending()]);
    await shown(['loans', 'server']);
    fireEvent.drop(canvasEl(), { dataTransfer: dragged('archive'), clientX: 200, clientY: 200 });
    fireEvent.drop(canvasEl(), { dataTransfer: dragged('reader'), clientX: 300, clientY: 200 });
    await shown(['loans', 'server', 'archive', 'reader']);
    await waitFor(() => {
      expect(contentsSaves(calls).length).toBeGreaterThanOrEqual(2);
    });
    await screen.findByText('Saved');
    // Contents and layouts alike, each with the version the one before left.
    const versions = changes(calls).map((call) => call.body?.version);
    expect(versions).toEqual(versions.map((_, index) => index + 1));
    expect(contentsSaves(calls).at(-1)?.body?.elementIds).toEqual([
      'loans',
      'server',
      'archive',
      'reader',
    ]);
  });

  it('renames, checking the name as Save as view does', async () => {
    const { calls } = open(viewAt('modelling', 'v-lending'), 'modelling', [lending(), reading()]);
    await shown(['loans', 'server']);
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename view' });
    const name = within(dialog).getByRole<HTMLInputElement>('textbox', { name: /Name/ });
    expect(name.value).toBe('Lending');
    fireEvent.change(name, { target: { value: '' } });
    fireEvent.submit(name);
    await within(dialog).findByText('Enter a name.');
    fireEvent.change(name, { target: { value: 'Borrowing' } });
    fireEvent.submit(name);
    await screen.findByRole('heading', { level: 2, name: 'View Borrowing' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.title).toBe('Borrowing · SimpleArchitecture');
    expect(screen.getByText('Renamed to “Borrowing”.')).toBeTruthy();
    expect(changes(calls)).toEqual([
      {
        method: 'PATCH',
        url: `/api/models/${libraryId}/views/v-lending`,
        body: { version: 1, name: 'Borrowing' },
      },
    ]);
    // The next change uses the version the rename gave.
    fireEvent.drop(canvasEl(), { dataTransfer: dragged('archive'), clientX: 200, clientY: 200 });
    await waitFor(() => {
      expect(changes(calls)).toHaveLength(2);
    });
    expect(changes(calls)[1]?.body?.version).toBe(2);
  });

  it('never shows the list from before a rename while the list is read again', async () => {
    const fake = server([lending(), reading()]);
    // Holds the list's read while `held.until` is set, so what shows meanwhile can be checked.
    const held: { until?: Promise<void> } = {};
    const gated: Handler = (request) => {
      const { until } = held;
      if (until && request.method === 'GET' && request.url === `/api/models/${libraryId}/views`) {
        return until.then(() => fake.handler(request) ?? new Response(null, { status: 500 }));
      }
      return fake.handler(request);
    };
    stubApi(modeller, gated);
    renderAt(viewAt('modelling', 'v-lending'));
    await shown(['loans', 'server']);
    const panel = await openPanel();
    expect((await panel.findAllByRole('link')).map((link) => link.textContent)).toEqual([
      'Lending',
      'Reading',
    ]);

    // The section stays open: the rename reads the list again.
    let release = () => {};
    held.until = new Promise((resolve) => {
      release = resolve;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename view' });
    const name = within(dialog).getByRole<HTMLInputElement>('textbox', { name: /Name/ });
    fireEvent.change(name, { target: { value: 'Borrowing' } });
    fireEvent.submit(name);
    await screen.findByRole('heading', { level: 2, name: 'View Borrowing' });
    await panel.findByText('Loading views…');
    expect(panel.queryByRole('link', { name: 'Lending' })).toBeNull();
    release();
    expect((await panel.findAllByRole('link')).map((link) => link.textContent)).toEqual([
      'Borrowing',
      'Reading',
    ]);
  });

  it('deletes after asking, then shows the start page in place of the view', async () => {
    const { views } = open(viewAt('modelling', 'v-lending'), 'modelling', [lending()]);
    await shown(['loans', 'server']);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete the view “Lending”?' });
    expect(
      within(dialog).getByText(
        "This deletes the view for everyone. Its elements and relationships stay in the model. It can't be undone.",
      ),
    ).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete view' }));
    await waitFor(() => {
      expect(currentLocation()).toBe(modelAt('modelling'));
    });
    expect(views.has('v-lending')).toBe(false);
    expect(screen.getByText('Deleted the view “Lending”.')).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(viewsHeader());
    });
  });
});

describe('a view for a Viewer', () => {
  it('opens, and nothing can change it', async () => {
    const { calls } = open(viewAt('viewing', 'v-lending'), 'viewing', [lending()]);
    await shown(['loans', 'server']);
    for (const name of ['Rename', 'Delete', 'Remove from view', 'New element on the canvas']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    // No related pill, and no ×, on the cards.
    expect(canvasEl().querySelector('.cpill')).toBeNull();
    expect(canvasEl().querySelector('.cremove')).toBeNull();
    // The Views list is links only.
    const panel = await openPanel();
    await panel.findByRole('link', { name: 'Lending' });
    expect(panel.queryByRole('button', { name: 'Save as view…' })).toBeNull();
    fireEvent.drop(canvasEl(), { dataTransfer: dragged('archive'), clientX: 200, clientY: 200 });
    // Shift+Enter on a row says where views change.
    const tree = screen.getByRole('tree', { name: 'Elements by type' });
    const group = within(tree).getByRole('treeitem', { name: /^Other,/ });
    if (group.getAttribute('aria-expanded') === 'false') {
      fireEvent.click(group.querySelector('.trow') as HTMLElement);
    }
    const row = within(tree).getByRole('treeitem', { name: 'Archive' });
    fireEvent.click(row.querySelector('.trow') as HTMLElement);
    fireEvent.keyDown(row, { key: 'Enter', shiftKey: true });
    await screen.findByText('Views can be changed in Modelling.');
    expect(card('archive')).toBeNull();
    expect(changes(calls)).toEqual([]);
  });

  it('offers the same view in Modelling to someone who can change it', async () => {
    open(`${viewAt('viewing', 'v-lending')}?show=data`, 'modelling', [lending()]);
    await shown(['loans', 'server']);
    expect(screen.getByRole('link', { name: 'Open in Modelling' }).getAttribute('href')).toBe(
      `${viewAt('modelling', 'v-lending')}?show=data`,
    );
  });
});

describe('Show relationships in an open view', () => {
  const linesSwitch = () =>
    screen.getByRole<HTMLInputElement>('switch', { name: 'Show relationships' });
  const positions = () =>
    [...canvasEl().querySelectorAll<HTMLElement>('.react-flow__node')].map(
      (node) => `${node.getAttribute('data-id') ?? ''} ${node.style.transform}`,
    );

  it.each(['viewing', 'modelling'] as const)(
    'hides and shows its lines, moves no card and changes nothing in the view (%s)',
    async (space) => {
      const { calls } = open(viewAt(space, 'v-reading'), space, [reading()]);
      await shown(['reader', 'catalogue', 'loans']);
      await waitFor(() => {
        expect(edgeCount()).toBe(2);
      });
      const before = positions();
      fireEvent.click(linesSwitch());
      await waitFor(() => {
        expect(edgeCount()).toBe(0);
      });
      expect(labels()).toEqual([]);
      expect(positions()).toEqual(before);
      expect(localStorage.getItem('sa-show-lines')).toBe('false');
      fireEvent.click(linesSwitch());
      await waitFor(() => {
        expect(edgeCount()).toBe(2);
      });
      expect(labels()).toContain('Lends');
      expect(positions()).toEqual(before);
      // A choice of this browser, never stored in the view.
      expect(changes(calls)).toEqual([]);
    },
  );

  it('opens with the lines off when they were switched off before', async () => {
    localStorage.setItem('sa-show-lines', 'false');
    open(viewAt('viewing', 'v-reading'), 'viewing', [reading()]);
    await shown(['reader', 'catalogue', 'loans']);
    expect(linesSwitch().checked).toBe(false);
    expect(edgeCount()).toBe(0);
  });
});
