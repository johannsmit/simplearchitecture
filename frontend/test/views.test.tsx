import type { JgfDocument, ModelSummary, StoredView } from '@simplearchitecture/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
    folder: null,
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
    routes: [],
    groupBy: null,
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
  /** The element ids asked about, in order: where each is used. */
  const usedInReads: string[] = [];
  /** Answers the next change with this instead; and every read of where an element is used. */
  const next: { failWith?: Response; failUsedIn?: () => Response } = {};
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
    const usedIn = new RegExp(`^/api/models/${libraryId}/elements/([^/]+)/views$`).exec(url);
    if (method === 'GET' && usedIn) {
      const id = decodeURIComponent(usedIn[1] ?? '');
      usedInReads.push(id);
      if (next.failUsedIn) return next.failUsedIn();
      // In the order stored: the page puts them by name.
      const holding = [...views.values()].filter((view) => view.elementIds.includes(id));
      return Response.json({ views: holding.map(summaryOf) });
    }
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
    const sameFolder = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    const folderLike = (name: string, except?: string) =>
      [...views.values()].find(
        (one) =>
          one.folder !== null &&
          sameFolder(one.folder, name) &&
          (except === undefined || !sameFolder(one.folder, except)),
      )?.folder ?? undefined;
    const folderTaken = (existing: string) =>
      apiError(422, 'The change is not valid.', {
        fields: [{ field: 'folder', message: `There's already a folder called “${existing}”.` }],
      });
    if (method === 'PATCH' && url === `/api/models/${libraryId}/view-folders`) {
      const request = JSON.parse(String(body)) as { from: string; to: string };
      calls.push({ method, url, body: request });
      if (next.failWith) {
        const answer = next.failWith;
        delete next.failWith;
        return answer;
      }
      const members = [...views.values()].filter(
        (one) => one.folder !== null && sameFolder(one.folder, request.from),
      );
      if (members.length === 0)
        return apiError(404, 'No view is in this folder', { missing: 'folder' });
      const clash = folderLike(request.to, request.from);
      if (clash !== undefined) return folderTaken(clash);
      for (const member of members) member.folder = request.to.trim();
      return Response.json({ folder: request.to.trim(), views: members.map(summaryOf) });
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
      const folder = typeof parsed?.folder === 'string' ? parsed.folder.trim() : '';
      made.folder = folder === '' ? null : (folderLike(folder) ?? folder);
      views.set(made.id, made);
      return Response.json({ view: made }, { status: 201 });
    }
    if (!view) return apiError(404, 'This view does not exist.', { missing: 'view' });
    if (method === 'GET') return Response.json({ view });
    // Not version-checked, and the version stays.
    if (method === 'PUT' && part === 'folder') {
      const folder = parsed?.folder as string | null;
      const existing = folder === null ? undefined : folderLike(folder);
      if (parsed?.newFolder === true && existing !== undefined) return folderTaken(existing);
      view.folder = folder === null ? null : (existing ?? folder.trim());
      return Response.json({ view: summaryOf(view) });
    }
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
  return { views, calls, usedInReads, next, handler };
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

describe('Used in views, in the details panel', () => {
  const details = () => screen.getByRole('complementary', { name: 'Details' });
  const findDetails = () => screen.findByRole('complementary', { name: 'Details' });
  const usedIn = () => within(details()).getByRole('region', { name: 'Used in views' });
  const usedInNames = () =>
    within(usedIn())
      .queryAllByRole('link')
      .map((link) => link.textContent);
  const archiving = () => stored('v-archiving', 'archiving', ['archive', 'loans']);
  /** Selects an element with a click on its row in the element list. */
  const pick = (name: string, group: string) => {
    const tree = screen.getByRole('tree', { name: 'Elements by type' });
    const type = within(tree).getByRole('treeitem', { name: new RegExp(`^${group},`) });
    if (type.getAttribute('aria-expanded') === 'false') {
      fireEvent.click(type.querySelector('.trow') as HTMLElement);
    }
    const row = within(tree).getByRole('treeitem', { name });
    fireEvent.click(row.querySelector('.trow') as HTMLElement);
  };

  // In Viewing as a Viewer, in Modelling as a Modeller.
  it.each(['viewing', 'modelling'] as const)(
    'lists every view holding the element, by name, as links that open them (%s)',
    async (space) => {
      open(`${modelAt(space)}/elements/loans?show=data`, space, [
        reading(),
        archiving(),
        lending(),
        stored('v-front', 'Front desk', ['reader', 'catalogue']),
      ]);
      await waitFor(() => {
        expect(usedInNames()).toEqual(['archiving', 'Lending', 'Reading']);
      });
      expect(within(usedIn()).getByRole('heading', { level: 3 }).textContent).toBe(
        'Used in views 3',
      );
      const link = within(usedIn()).getByRole('link', { name: 'Lending' });
      // The relationship properties shown go along, as in the Views list.
      expect(link.getAttribute('href')).toBe(`${viewAt(space, 'v-lending')}?show=data`);
      fireEvent.click(link);
      await waitFor(() => {
        expect(currentLocation()).toBe(`${viewAt(space, 'v-lending')}?show=data`);
      });
      await shown(['loans', 'server']);
    },
  );

  it('says "In no views" when no view holds the element', async () => {
    open(`${modelAt('viewing')}/elements/search`, 'viewing', [lending(), reading()]);
    await within(await findDetails()).findByText('In no views');
    expect(usedInNames()).toEqual([]);
    expect(within(usedIn()).getByRole('heading', { level: 3 }).textContent).toBe('Used in views 0');
  });

  it('marks the open view in the list', async () => {
    open(viewAt('viewing', 'v-reading'), 'viewing', [reading(), archiving()]);
    await shown(['reader', 'catalogue', 'loans']);
    fireEvent.click(card('loans')?.querySelector('.card-main') as HTMLElement);
    await waitFor(() => {
      expect(usedInNames()).toEqual(['archiving', 'Reading']);
    });
    expect(
      within(usedIn()).getByRole('link', { name: 'Reading' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(
      within(usedIn()).getByRole('link', { name: 'archiving' }).hasAttribute('aria-current'),
    ).toBe(false);
  });

  it('is current after the element is added to the open view and taken out again', async () => {
    const { usedInReads } = open(viewAt('modelling', 'v-lending'), 'modelling', [
      lending(),
      reading(),
    ]);
    await shown(['loans', 'server']);
    pick('Archive', 'Other');
    await within(details()).findByText('In no views');
    fireEvent.drop(canvasEl(), { dataTransfer: dragged('archive'), clientX: 200, clientY: 200 });
    await shown(['loans', 'server', 'archive']);
    await waitFor(() => {
      expect(usedInNames()).toEqual(['Lending']);
    });
    fireEvent.click(
      within(card('archive') as HTMLElement).getByRole('button', {
        name: 'Remove Archive from view',
      }),
    );
    await shown(['loans', 'server']);
    // Taking the card out closes its details; picked again, they say it is in no view.
    pick('Archive', 'Other');
    await within(details()).findByText('In no views');
    expect(usedInReads.every((id) => id === 'archive')).toBe(true);
  });

  it("shows a view's new name after Rename", async () => {
    open(viewAt('modelling', 'v-reading'), 'modelling', [reading()]);
    await shown(['reader', 'catalogue', 'loans']);
    fireEvent.click(card('loans')?.querySelector('.card-main') as HTMLElement);
    await waitFor(() => {
      expect(usedInNames()).toEqual(['Reading']);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Borrowing' } });
    fireEvent.submit(within(dialog).getByRole('textbox').closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(usedInNames()).toEqual(['Borrowing']);
    });
  });

  it('says when the list could not be read, with Try again', async () => {
    const { next } = open(`${modelAt('viewing')}/elements/loans`, 'viewing', [lending()]);
    next.failUsedIn = () => apiError(500, 'Something went wrong.');
    const alert = await within(await findDetails()).findByRole('alert');
    expect(alert.textContent).toContain("The views couldn't be loaded.");
    delete next.failUsedIn;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(usedInNames()).toEqual(['Lending']);
    });
  });

  it('says that views need a database when the server has none', async () => {
    const { next } = open(`${modelAt('viewing')}/elements/loans`, 'viewing', [lending()]);
    next.failUsedIn = () => apiError(501, 'Editing needs a database.');
    const alert = await within(await findDetails()).findByRole('alert');
    expect(alert.textContent).toBe('Editing needs a database. ');
    expect(within(alert).queryByRole('button')).toBeNull();
  });
});

describe('View folders', () => {
  const inFolder = (view: StoredView, folder: string | null) => ({ ...view, folder });
  /** Two folders and two views without one (made up). */
  const shelves = () => [
    inFolder(stored('v-shelving', 'Shelving', ['catalogue']), 'Stock'),
    inFolder(stored('v-orders', 'Ordering', ['loans']), 'Stock'),
    inFolder(stored('v-desk', 'Desk', ['reader']), 'Front of house'),
    reading(),
    lending(),
  ];
  const at = (space: Space) => `${modelAt(space)}/elements/catalogue`;
  const header = (name: string) =>
    within(viewsList()).getByRole('button', { name: new RegExp(`^${name}, folder,`) });
  const folderList = (name: string) => within(viewsList()).getByRole('list', { name });
  const link = (name: string) => within(viewsList()).getByRole('link', { name });
  const names = (element: HTMLElement) =>
    [...element.querySelectorAll('.vf-toggle .n, a .n')].map((each) => each.textContent);
  async function openFolders(space: Space, views = shelves(), path = at(space)) {
    const fake = open(path, space, views);
    await waitFor(() => {
      expect(viewsHeader()).toBeTruthy();
    });
    await openPanel();
    await within(await findViewsList()).findAllByRole('link');
    return fake;
  }
  /** Drags with the mouse from one element to another, past the 4px threshold. */
  const dragTo = (from: HTMLElement, to: HTMLElement, release = true) => {
    fireEvent.pointerDown(from, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(from, { clientX: 22, clientY: 21 });
    fireEvent.pointerMove(to, { clientX: 40, clientY: 80 });
    if (release) fireEvent.pointerUp(to, { clientX: 40, clientY: 80 });
  };
  const folderCalls = (calls: Call[]) =>
    calls.filter((call) => call.url.endsWith('/folder') || call.url.endsWith('/view-folders'));

  it('lists the folders by name with their views, then the views without a folder', async () => {
    await openFolders('viewing');
    expect(names(viewsList())).toEqual([
      'Front of house',
      'Desk',
      'Stock',
      'Ordering',
      'Shelving',
      'Lending',
      'Reading',
    ]);
    expect(header('Stock').textContent).toContain('2 views');
    expect(header('Stock').getAttribute('aria-expanded')).toBe('true');
    expect(header('Stock').getAttribute('aria-controls')).toBe(folderList('Stock').id);
    expect(
      within(folderList('Stock'))
        .getAllByRole('link')
        .map((one) => one.textContent),
    ).toEqual(['Ordering', 'Shelving']);
    // A Viewer gets no rename, no New folder… and no dragging.
    expect(within(viewsList()).queryByRole('button', { name: /^Rename folder/ })).toBeNull();
    expect(viewsSection().querySelector('.vf-new')).toBeNull();
  });

  it('collapses a folder by click and with ← →, remembered per browser and model by a hash', async () => {
    await openFolders('viewing');
    fireEvent.click(header('Stock'));
    expect(header('Stock').getAttribute('aria-expanded')).toBe('false');
    expect(within(viewsList()).queryByRole('list', { name: 'Stock' })).toBeNull();
    const stored = localStorage.getItem(`sa-view-folders-closed-${libraryId}`) ?? '';
    expect(stored).toMatch(/^[0-9a-z]+$/);
    expect(stored.toLowerCase()).not.toContain('stock');
    // → opens, → again goes to its first view, ← there goes back to the folder, ← closes.
    header('Stock').focus();
    fireEvent.keyDown(header('Stock'), { key: 'ArrowRight' });
    expect(header('Stock').getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(header('Stock'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(link('Ordering'));
    fireEvent.keyDown(link('Ordering'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(header('Stock'));
    fireEvent.keyDown(header('Stock'), { key: 'ArrowLeft' });
    expect(header('Stock').getAttribute('aria-expanded')).toBe('false');
    // After a reload it is as left; another folder starts open.
    cleanup();
    await openFolders('viewing');
    expect(header('Stock').getAttribute('aria-expanded')).toBe('false');
    expect(header('Front of house').getAttribute('aria-expanded')).toBe('true');
  });

  it('goes through folder headers and the views shown with ↓ ↑ Home End', async () => {
    await openFolders('viewing');
    fireEvent.click(header('Stock'));
    fireEvent.keyDown(viewsHeader(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(header('Front of house'));
    fireEvent.keyDown(header('Front of house'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(link('Desk'));
    fireEvent.keyDown(link('Desk'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(header('Stock'));
    // Stock is closed: its views are skipped.
    fireEvent.keyDown(header('Stock'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(link('Lending'));
    fireEvent.keyDown(link('Lending'), { key: 'End' });
    expect(document.activeElement).toBe(link('Reading'));
    fireEvent.keyDown(link('Reading'), { key: 'Home' });
    expect(document.activeElement).toBe(header('Front of house'));
    fireEvent.keyDown(header('Front of house'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(viewsHeader());
  });

  it('marks a closed folder that holds the open view', async () => {
    await openFolders('viewing', shelves(), viewAt('viewing', 'v-orders'));
    fireEvent.click(header('Stock'));
    expect(header('Stock').textContent).toContain('2 views, has the open view');
    expect(header('Stock').querySelector('.chk .ico')).toBeTruthy();
    expect(header('Front of house').textContent).not.toContain('has the open view');
    // The view bar says the folder.
    await screen.findByRole('heading', { level: 2, name: 'View Ordering, in folder Stock' });
  });

  it('filters by view and folder names, showing matching folders open without changing what is remembered', async () => {
    const many = [
      ...shelves(),
      ...['Alpha', 'Beta', 'Gamma', 'Delta'].map((name) => stored(`v-${name}`, name, ['reader'])),
    ];
    await openFolders('viewing', many);
    fireEvent.click(header('Stock'));
    const filter = within(viewsSection()).getByRole('searchbox', { name: 'Filter views' });
    fireEvent.change(filter, { target: { value: 'stock' } });
    expect(names(viewsList())).toEqual(['Stock', 'Ordering', 'Shelving']);
    expect(header('Stock').getAttribute('aria-expanded')).toBe('true');
    fireEvent.change(filter, { target: { value: 'desk' } });
    expect(names(viewsList())).toEqual(['Front of house', 'Desk']);
    fireEvent.change(filter, { target: { value: '' } });
    expect(header('Stock').getAttribute('aria-expanded')).toBe('false');
  });

  it('Save as view puts the view in a folder picked or typed, joining one in any case', async () => {
    const { calls } = open(
      `${modelAt('modelling')}/elements/catalogue?depth=1`,
      'modelling',
      shelves(),
    );
    await shown(['catalogue', 'reader', 'loans', 'search']);
    const panel = await openPanel();
    fireEvent.click(await panel.findByRole('button', { name: 'Save as view…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save as view' });
    const folder = await within(dialog).findByRole('combobox', { name: 'Folder' });
    // The model's folders, by name.
    fireEvent.keyDown(folder, { key: 'ArrowDown' });
    expect(
      within(within(dialog).getByRole('listbox'))
        .getAllByRole('option')
        .map((one) => one.textContent),
    ).toEqual(['Front of house', 'Stock']);
    fireEvent.keyDown(folder, { key: 'Escape' });
    // Too long first.
    fireEvent.change(folder, { target: { value: 'f'.repeat(101) } });
    const name = within(dialog).getByRole<HTMLInputElement>('textbox', { name: /Name/ });
    fireEvent.change(name, { target: { value: 'Finding books' } });
    fireEvent.submit(name);
    expect(
      await within(dialog).findByText('The folder name has 101 characters. Use 100 or fewer.'),
    ).toBeTruthy();
    expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
    fireEvent.change(folder, { target: { value: ' stock ' } });
    fireEvent.submit(name);
    await waitFor(() => {
      expect(currentLocation()).toBe(viewAt('modelling', 'v-new-1'));
    });
    expect(calls.find((call) => call.method === 'POST')?.body?.folder).toBe('Stock');
    expect(
      screen.getByText('Saved the view “Finding books” in “Stock”: 4 elements, 4 relationships.'),
    ).toBeTruthy();
    await screen.findByRole('heading', { level: 2, name: 'View Finding books, in folder Stock' });
  });

  it('Save as view without a folder sends none', async () => {
    const { calls } = open(
      `${modelAt('modelling')}/elements/catalogue?depth=1`,
      'modelling',
      shelves(),
    );
    await shown(['catalogue', 'reader', 'loans', 'search']);
    fireEvent.click(await (await openPanel()).findByRole('button', { name: 'Save as view…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save as view' });
    await within(dialog).findByRole('combobox', { name: 'Folder' });
    const name = within(dialog).getByRole<HTMLInputElement>('textbox', { name: /Name/ });
    fireEvent.change(name, { target: { value: 'Loose' } });
    fireEvent.submit(name);
    await screen.findByRole('heading', { level: 2, name: 'View Loose' });
    expect(calls.find((call) => call.method === 'POST')?.body).not.toHaveProperty('folder');
  });

  it('moves a view by dragging it onto another folder, without opening it or raising its version', async () => {
    const { calls, views } = await openFolders('modelling');
    const before = currentLocation();
    dragTo(link('Desk'), header('Stock'));
    // At once, by name, in its new folder; Front of house had only it, so it's gone.
    expect(names(viewsList())).toEqual([
      'Stock',
      'Desk',
      'Ordering',
      'Shelving',
      'Lending',
      'Reading',
    ]);
    await screen.findByText('Moved “Desk” to “Stock”.');
    expect(folderCalls(calls)).toEqual([
      {
        method: 'PUT',
        url: `/api/models/${libraryId}/views/v-desk/folder`,
        body: { folder: 'Stock' },
      },
    ]);
    expect(views.get('v-desk')).toMatchObject({ folder: 'Stock', version: 1 });
    expect(currentLocation()).toBe(before);
  });

  it('takes a view out of its folder by dropping it on a view without one, and lights one target at a time', async () => {
    const { calls } = await openFolders('modelling');
    dragTo(link('Shelving'), link('Lending'), false);
    // The loose views light up as one target; the view's own folder never does.
    expect(link('Lending').closest('li')?.className).toContain('is-drop-loose');
    expect(viewsList().querySelector('.vf.is-drop')).toBeNull();
    fireEvent.pointerMove(link('Ordering'), { clientX: 40, clientY: 90 });
    expect(viewsList().querySelector('.is-drop, .is-drop-loose')).toBeNull();
    fireEvent.pointerMove(header('Front of house'), { clientX: 40, clientY: 100 });
    expect(header('Front of house').closest('li')?.className).toContain('is-drop');
    fireEvent.pointerMove(link('Reading'), { clientX: 40, clientY: 110 });
    fireEvent.pointerUp(link('Reading'), { clientX: 40, clientY: 110 });
    await screen.findByText('Took “Shelving” out of its folder.');
    expect(folderCalls(calls).map((call) => call.body)).toEqual([{ folder: null }]);
    expect(names(viewsList())).toEqual([
      'Front of house',
      'Desk',
      'Stock',
      'Ordering',
      'Lending',
      'Reading',
      'Shelving',
    ]);
  });

  it('sends nothing for a drop on its own folder, off any target, or after Esc, and a click still opens', async () => {
    const { calls } = await openFolders('modelling');
    dragTo(link('Shelving'), link('Ordering'));
    dragTo(link('Shelving'), viewsHeader());
    dragTo(link('Shelving'), header('Front of house'), false);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(viewsList().querySelector('.is-drop')).toBeNull();
    fireEvent.pointerUp(header('Front of house'), { clientX: 40, clientY: 80 });
    // A press with no move is a click (a moment later: the clicks that end a drag are ignored).
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.pointerDown(link('Shelving'), { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(link('Shelving'), { button: 0, clientX: 21, clientY: 20 });
    fireEvent.click(link('Shelving'));
    await waitFor(() => {
      expect(currentLocation()).toBe(viewAt('modelling', 'v-shelving'));
    });
    expect(folderCalls(calls)).toEqual([]);
    expect(within(folderList('Stock')).getAllByRole('link')).toHaveLength(2);
  });

  it('keeps a collapsed folder collapsed when a view is dropped on it, with its count up', async () => {
    await openFolders('modelling');
    fireEvent.click(header('Stock'));
    dragTo(link('Lending'), header('Stock'));
    await screen.findByText('Moved “Lending” to “Stock”.');
    expect(header('Stock').getAttribute('aria-expanded')).toBe('false');
    expect(header('Stock').textContent).toContain('3 views');
  });

  it('shows a No folder target while dragging when no view is without a folder', async () => {
    const { calls } = await openFolders('modelling', [
      inFolder(lending(), 'Stock'),
      inFolder(reading(), 'Front of house'),
    ]);
    expect(viewsList().querySelector('.vf-none')).toBeNull();
    dragTo(link('Lending'), header('Front of house'), false);
    const none = viewsList().querySelector<HTMLElement>('.vf-none');
    expect(none?.textContent).toBe('No folder');
    fireEvent.pointerMove(none as HTMLElement, { clientX: 40, clientY: 120 });
    fireEvent.pointerUp(none as HTMLElement, { clientX: 40, clientY: 120 });
    await screen.findByText('Took “Lending” out of its folder.');
    expect(folderCalls(calls).map((call) => call.body)).toEqual([{ folder: null }]);
  });

  it('puts the row back and says so when a move fails', async () => {
    const { next } = await openFolders('modelling');
    next.failWith = apiError(503, 'Unavailable');
    dragTo(link('Desk'), header('Stock'));
    const alert = await within(viewsSection()).findByRole('alert');
    expect(alert.textContent).toContain(
      "The view wasn't moved. Check your connection and try again.",
    );
    expect(within(folderList('Front of house')).getByRole('link', { name: 'Desk' })).toBeTruthy();
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(within(viewsSection()).queryByRole('alert')).toBeNull();
    next.failWith = apiError(404, 'This view does not exist.', { missing: 'view' });
    dragTo(link('Desk'), header('Stock'));
    expect((await within(viewsSection()).findByRole('alert')).textContent).toContain(
      'Someone else deleted this view.',
    );
  });

  it('updates the view bar when the open view moves', async () => {
    await openFolders('modelling', shelves(), viewAt('modelling', 'v-desk'));
    await screen.findByRole('heading', { level: 2, name: 'View Desk, in folder Front of house' });
    dragTo(link('Desk'), header('Stock'));
    await screen.findByRole('heading', { level: 2, name: 'View Desk, in folder Stock' });
    dragTo(link('Desk'), link('Reading'));
    await screen.findByRole('heading', { level: 2, name: 'View Desk' });
  });

  it('makes a new folder from a drop on New folder…, refusing a name that exists in any case', async () => {
    const { calls } = await openFolders('modelling');
    const target = viewsSection().querySelector<HTMLElement>('.vf-new');
    expect(target?.getAttribute('aria-hidden')).toBe('true');
    dragTo(link('Lending'), target as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'New folder' });
    expect(within(dialog).getByText('Puts “Lending” in a new folder.')).toBeTruthy();
    const name = within(dialog).getByRole<HTMLInputElement>('textbox', { name: /Name/ });
    const create = within(dialog).getByRole('button', { name: 'Create folder' });
    fireEvent.change(name, { target: { value: ' STOCK ' } });
    expect(within(dialog).getByText("There's already a folder called “Stock”.")).toBeTruthy();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(create.getAttribute('aria-disabled')).toBe('true');
    fireEvent.submit(name);
    fireEvent.change(name, { target: { value: '' } });
    fireEvent.submit(name);
    expect(within(dialog).getByText('Enter a name.')).toBeTruthy();
    fireEvent.change(name, { target: { value: 'q'.repeat(101) } });
    fireEvent.submit(name);
    expect(
      within(dialog).getByText('The folder name has 101 characters. Use 100 or fewer.'),
    ).toBeTruthy();
    expect(folderCalls(calls)).toEqual([]);
    fireEvent.change(name, { target: { value: ' Returns ' } });
    expect(create.hasAttribute('aria-disabled')).toBe(false);
    fireEvent.submit(name);
    await screen.findByText('Made the folder “Returns” with “Lending”.');
    expect(folderCalls(calls).map((call) => call.body)).toEqual([
      { folder: 'Returns', newFolder: true },
    ]);
    await waitFor(() => {
      expect(document.activeElement).toBe(header('Returns'));
    });
    expect(within(folderList('Returns')).getByRole('link', { name: 'Lending' })).toBeTruthy();
  });

  it('leaves the view where it was when New folder is cancelled, or refused by the server', async () => {
    const { calls, views } = await openFolders('modelling');
    dragTo(link('Lending'), viewsSection().querySelector<HTMLElement>('.vf-new') as HTMLElement);
    let dialog = await screen.findByRole('dialog', { name: 'New folder' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(link('Lending'));
    });
    expect(folderCalls(calls)).toEqual([]);
    // Someone made the folder meanwhile: the server refuses, with the same words.
    views.set('v-other', inFolder(stored('v-other', 'Other', ['reader']), 'Returns'));
    dragTo(link('Lending'), viewsSection().querySelector<HTMLElement>('.vf-new') as HTMLElement);
    dialog = await screen.findByRole('dialog', { name: 'New folder' });
    const name = within(dialog).getByRole<HTMLInputElement>('textbox', { name: /Name/ });
    fireEvent.change(name, { target: { value: 'returns' } });
    fireEvent.submit(name);
    expect(
      await within(dialog).findByText("There's already a folder called “Returns”."),
    ).toBeTruthy();
    expect(views.get('v-lending')?.folder).toBeNull();
  });

  it('renames a folder from its pencil or F2, keeping its collapsed state, and refuses a name that exists', async () => {
    const { calls, views } = await openFolders('modelling');
    fireEvent.click(header('Stock'));
    const pencil = within(viewsList()).getByRole('button', { name: 'Rename folder Stock' });
    fireEvent.click(pencil);
    let dialog = await screen.findByRole('dialog', { name: 'Rename folder' });
    expect(
      within(dialog).getByText('Renames the folder on its 2 views, for everyone.'),
    ).toBeTruthy();
    const name = within(dialog).getByRole<HTMLInputElement>('textbox', { name: /Name/ });
    expect(name.value).toBe('Stock');
    fireEvent.change(name, { target: { value: 'front OF house' } });
    expect(
      within(dialog).getByText("There's already a folder called “Front of house”."),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole('button', { name: 'Rename' }).getAttribute('aria-disabled'),
    ).toBe('true');
    fireEvent.submit(name);
    expect(folderCalls(calls)).toEqual([]);
    // Only the case: allowed.
    fireEvent.change(name, { target: { value: 'STOCK' } });
    fireEvent.submit(name);
    await screen.findByText('Renamed the folder to “STOCK” on 2 views.');
    expect(header('STOCK').getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => {
      expect(document.activeElement).toBe(header('STOCK'));
    });
    // F2 on the header, to a new name.
    fireEvent.keyDown(header('STOCK'), { key: 'F2' });
    dialog = await screen.findByRole('dialog', { name: 'Rename folder' });
    const again = within(dialog).getByRole<HTMLInputElement>('textbox', { name: /Name/ });
    fireEvent.change(again, { target: { value: 'Back room' } });
    fireEvent.submit(again);
    await screen.findByText('Renamed the folder to “Back room” on 2 views.');
    expect(header('Back room').getAttribute('aria-expanded')).toBe('false');
    expect(folderCalls(calls).map((call) => call.body)).toEqual([
      { from: 'Stock', to: 'STOCK' },
      { from: 'STOCK', to: 'Back room' },
    ]);
    expect(views.get('v-orders')).toMatchObject({ folder: 'Back room', version: 1 });
  });

  it('counts all of a folder’s views when renaming it while the list is filtered', async () => {
    const many = [
      ...shelves(),
      ...['Alpha', 'Beta', 'Gamma', 'Delta'].map((name) => stored(`v-${name}`, name, ['reader'])),
    ];
    await openFolders('modelling', many);
    fireEvent.click(header('Stock'));
    const filter = within(viewsSection()).getByRole('searchbox', { name: 'Filter views' });
    fireEvent.change(filter, { target: { value: 'order' } });
    expect(names(viewsList())).toEqual(['Stock', 'Ordering']);
    const text = 'Renames the folder on its 2 views, for everyone.';
    // From the pencil.
    fireEvent.click(within(viewsList()).getByRole('button', { name: 'Rename folder Stock' }));
    let dialog = await screen.findByRole('dialog', { name: 'Rename folder' });
    expect(within(dialog).getByText(text)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // From F2 on the header.
    fireEvent.keyDown(header('Stock'), { key: 'F2' });
    dialog = await screen.findByRole('dialog', { name: 'Rename folder' });
    expect(within(dialog).getByText(text)).toBeTruthy();
  });

  it('says when a folder to rename has no views any more', async () => {
    const { views } = await openFolders('modelling');
    for (const id of ['v-desk']) {
      const view = views.get(id);
      if (view) view.folder = null;
    }
    fireEvent.click(
      within(viewsList()).getByRole('button', { name: 'Rename folder Front of house' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Rename folder' });
    const name = within(dialog).getByRole<HTMLInputElement>('textbox', { name: /Name/ });
    fireEvent.change(name, { target: { value: 'Lobby' } });
    fireEvent.submit(name);
    expect(await within(dialog).findByText('This folder has no views any more.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(
        within(viewsList()).queryByRole('button', { name: /^Front of house, folder/ }),
      ).toBeNull();
    });
  });

  it('gives a Viewer, and Modelling without editing, no way to change folders', async () => {
    const { calls } = await openFolders('viewing');
    dragTo(link('Desk'), header('Stock'));
    fireEvent.keyDown(header('Stock'), { key: 'F2' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(folderCalls(calls)).toEqual([]);
    expect(within(folderList('Front of house')).getByRole('link', { name: 'Desk' })).toBeTruthy();
    // Collapsing still works: it is the browser's, not the model's.
    fireEvent.click(header('Stock'));
    expect(header('Stock').getAttribute('aria-expanded')).toBe('false');
  });
});
