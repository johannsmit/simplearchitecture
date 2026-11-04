import { buildModelGraph, type JgfNode } from '@simplearchitecture/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  changesOf,
  clientErrors,
  draftOf,
  elementOfNode,
  sameNameCount,
  sameNameNote,
  typeChangeNote,
  withType,
} from '../src/modelling/draft';
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

const graph = buildModelGraph(bakeryModel);
const element = (id: string) => {
  const found = graph.elements.get(id);
  if (!found) throw new Error(id);
  return found;
};

describe('editing draft', () => {
  it('sends nothing when nothing changed, and only what changed otherwise', () => {
    const initial = draftOf(element('shop'));
    expect(changesOf(initial, initial)).toBeUndefined();
    // Functions are a list; one per line in the form, a list again when saved.
    expect(initial.fields.functions).toBe('Order capture\nPayment');

    const custom = initial.custom.map((row) =>
      row.key === 'hostingModel' ? { ...row, key: 'hosting' } : row,
    );
    const changed = {
      ...initial,
      name: '  Web Shop 2 ',
      fields: { ...initial.fields, owningTeam: '', functions: 'Order capture\n\n Refunds ' },
      custom,
    };
    expect(changesOf(initial, changed)).toEqual({
      name: 'Web Shop 2',
      metadata: {
        owningTeam: null,
        functions: ['Order capture', 'Refunds'],
        hostingModel: null,
        hosting: 'SaaS',
      },
    });
  });

  it('keeps properties as custom metadata on a type change, and restores them on the way back', () => {
    const initial = draftOf(element('shop'));
    const business = withType(initial, 'Business');
    expect(Object.keys(business.fields)).toEqual(['owningTeam']);
    const moved = business.custom.filter((row) => row.wasProperty).map((row) => row.key);
    expect(moved.sort()).toEqual([
      'architectureState',
      'functions',
      'sourcing',
      'supplierHqCountry',
    ]);
    // Unchanged values are not sent: the server keeps them as custom metadata itself.
    expect(changesOf(initial, business)).toEqual({ type: 'Business' });
    expect(typeChangeNote(initial, element('shop'), 'Business')).toBe(
      "Business doesn't have Architecture state, Functions, Sourcing or Supplier HQ country. Their values are kept as custom metadata.",
    );

    const back = withType(business, 'Application');
    expect(back.fields).toEqual(initial.fields);
    expect(changesOf(initial, back)).toBeUndefined();
  });

  it('checks names and custom keys before saving', () => {
    const initial = draftOf(element('shop'));
    const draft = {
      ...initial,
      name: ' ',
      custom: [
        ...initial.custom,
        { id: 901, key: '', original: '', text: 'x', editable: true },
        { id: 902, key: 'hostingModel', original: '', text: 'y', editable: true },
        { id: 903, key: 'type', original: '', text: 'z', editable: true },
        { id: 904, key: 'owningTeam', original: '', text: 'w', editable: true },
        { id: 905, key: '', original: '', text: '', editable: true },
      ],
    };
    const errors = clientErrors(draft);
    expect(errors.get('name')).toBe('Enter a name.');
    expect(errors.get('row:901')).toBe('Enter a key.');
    expect(errors.get('row:902')).toBe('This key is used twice.');
    expect(errors.get('row:903')).toBe('“type” is reserved.');
    expect(errors.get('row:904')).toBe(
      '“owningTeam” is a property of Application. Use its field above.',
    );
    expect(errors.has('row:905')).toBe(false);
  });

  it('notes other elements of the same type with the same name', () => {
    expect(sameNameCount(graph, 'Application', ' web shop ')).toBe(1);
    expect(sameNameCount(graph, 'Application', 'Web Shop', 'shop')).toBe(0);
    expect(sameNameCount(graph, 'Business', 'Web Shop')).toBe(0);
    expect(sameNameNote(1, 'Application', 'Web Shop')).toBe(
      'Another Application is called “Web Shop”.',
    );
    expect(sameNameNote(2, 'Application', 'Web Shop')).toBe(
      '2 other Applications are called “Web Shop”.',
    );
  });
});

const modellingBase = `/modelling/models/${bakeryId}`;
const at = (id: string) => `${modellingBase}/elements/${encodeURIComponent(id)}`;

interface Server {
  versions: Map<string, number>;
  nodes: Map<string, JgfNode>;
  bodies: { method: string; url: string; body: unknown }[];
}

/** A small stand-in for the editing API, with versions. `answer` can override any request. */
function api(
  options: {
    editable?: boolean;
    answer?: (request: Parameters<Handler>[0]) => Response | undefined;
  } = {},
): {
  handler: Handler;
  server: Server;
} {
  const nodes = new Map(Object.entries(bakeryModel.graph.nodes ?? {}));
  const server: Server = { versions: new Map(), nodes, bodies: [] };
  const elementsUrl = `/api/models/${bakeryId}/elements`;
  const handler: Handler = (request) => {
    const body: unknown = typeof request.body === 'string' ? JSON.parse(request.body) : undefined;
    if (request.method !== 'GET')
      server.bodies.push({ method: request.method, url: request.url, body });
    const custom = options.answer?.(request);
    if (custom) return custom;
    if (request.method === 'GET' && request.url === '/api/models') {
      return Response.json({ models: [bakerySummary], editable: options.editable ?? true });
    }
    if (request.method === 'GET' && request.url === `/api/models/${bakeryId}`) {
      return Response.json(bakeryModel);
    }
    if (!request.url.startsWith(elementsUrl)) return undefined;
    const [path = '', query = ''] = request.url.slice(elementsUrl.length).split('?');
    const id = decodeURIComponent(path.slice(1));
    const version = server.versions.get(id) ?? 1;
    const result = (nodeId: string, status = 200) =>
      Response.json(
        {
          element: {
            id: nodeId,
            version: server.versions.get(nodeId) ?? 1,
            node: server.nodes.get(nodeId),
          },
          warnings: [],
        },
        { status },
      );
    if (request.method === 'GET') return result(id);
    if (request.method === 'POST') {
      const { name, type } = body as { name: string; type: string };
      server.nodes.set('new-1', { label: name, metadata: { type } });
      return result('new-1', 201);
    }
    if (request.method === 'PATCH') {
      const change = body as { version: number; name?: string; metadata?: Record<string, unknown> };
      if (change.version !== version) return apiError(409, 'Changed', { currentVersion: version });
      const node = server.nodes.get(id) ?? {};
      const metadata = Object.fromEntries(
        Object.entries({ ...node.metadata, ...change.metadata }).filter(([, v]) => v !== null),
      );
      server.nodes.set(id, { label: change.name ?? node.label ?? '', metadata });
      server.versions.set(id, version + 1);
      return result(id);
    }
    if (request.method === 'DELETE') {
      expect(query).toBe(`version=${version}`);
      const edges = (bakeryModel.graph.edges ?? []).filter(
        (e) => e.source === id || e.target === id,
      );
      return Response.json({
        id,
        deletedRelationshipCount: edges.length,
        deletedRelationshipIds: edges.map((e) => e.id),
        unnestedElementIds: [],
      });
    }
    return undefined;
  };
  return { handler, server };
}

const details = () => screen.getByRole('complementary', { name: 'Details' });
const tree = () => screen.getByRole('tree', { name: 'Elements by type' });

async function openForm(path: string, options: Parameters<typeof api>[0] = {}) {
  const { handler, server } = api(options);
  const fetchMock = stubApi(modeller, handler);
  renderAt(path);
  const form = await screen.findByRole('form', { name: /^Edit / });
  // The version is read for the next save.
  await waitFor(() => {
    expect(
      requests(fetchMock).some((r) => r.startsWith(`GET /api/models/${bakeryId}/elements/`)),
    ).toBe(true);
  });
  return { form, server, fetchMock };
}

const nameField = (form: HTMLElement) => within(form).getByRole('textbox', { name: /^Name/ });

describe('Modelling explorer', () => {
  it('shows no Editing pill, New element and the form with the type fields, no footer', async () => {
    const { form } = await openForm(at('till'));

    expect(screen.getByRole('region', { name: 'Explorer, editing' })).toBeTruthy();
    // Modelling is editing mode, so there is no Editing pill (only Read-only has one).
    expect(document.querySelector('.mode-pill')).toBeNull();
    expect(screen.getByRole('button', { name: 'New element' })).toBeTruthy();
    expect(nameField(form)).toHaveProperty('value', 'Till');
    const labels = [...form.querySelectorAll('label')].map((l) => l.textContent);
    expect(labels).toEqual([
      'Name Required',
      'Type',
      'Description',
      'Architecture state',
      'Owning team',
      'Supplier HQ country',
      'Sourcing',
      'Functions',
    ]);
    expect(form.querySelector('.d-form-foot')).toBeNull();
    expect(within(details()).getByRole('button', { name: 'Delete element' })).toBeTruthy();
    expect(within(details()).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('saves a change with the version and updates the list without a reload', async () => {
    const { form, server, fetchMock } = await openForm(at('till'));

    fireEvent.change(nameField(form), { target: { value: 'Till 2' } });
    expect(within(form).getByRole('status').textContent).toBe('Unsaved changes');
    fireEvent.keyDown(nameField(form), { key: 'Enter', ctrlKey: true });

    await waitFor(() => {
      expect(within(tree()).getByRole('treeitem', { name: 'Till 2' })).toBeTruthy();
    });
    expect(server.bodies).toEqual([
      {
        method: 'PATCH',
        url: `/api/models/${bakeryId}/elements/till`,
        body: { version: 1, name: 'Till 2' },
      },
    ]);
    expect(within(details()).getByRole('heading', { level: 2 }).textContent).toBe('Till 2');
    expect(form.querySelector('.d-form-foot.is-saved')?.textContent).toContain('Saved');
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('ef-heading');
    });
    // The model isn't loaded again.
    expect(requests(fetchMock).filter((r) => r === `GET /api/models/${bakeryId}`)).toHaveLength(1);

    // The next save sends the new version.
    fireEvent.change(nameField(form), { target: { value: 'Till 3' } });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(server.bodies[1]?.body).toEqual({ version: 2, name: 'Till 3' });
    });
  });

  it('shows a blank name at the field, with focus on it, and sends nothing', async () => {
    const { form, server } = await openForm(at('till'));

    fireEvent.change(nameField(form), { target: { value: '  ' } });
    fireEvent.submit(form);

    const field = nameField(form);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(within(form).getByText('Enter a name.')).toBeTruthy();
    expect(document.activeElement).toBe(field);
    expect(within(form).getByRole('status').textContent).toBe('Not saved. 1 field needs a fix.');
    expect(server.bodies).toEqual([]);
  });

  it('puts server messages at their field', async () => {
    const { form } = await openForm(at('till'), {
      answer: ({ method }) =>
        method === 'PATCH'
          ? apiError(422, 'Invalid', {
              fields: [
                { field: 'metadata.owningTeam', message: 'Owning team is too long.' },
                { field: '', message: 'The model has an error.' },
              ],
            })
          : undefined,
    });
    const team = within(form).getByRole('combobox', { name: 'Owning team' });
    fireEvent.change(team, { target: { value: 'x'.repeat(30) } });
    fireEvent.submit(form);

    expect(await within(form).findByText('Owning team is too long.')).toBeTruthy();
    expect(team.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(team);
    expect(within(form).getByRole('alert').textContent).toContain('The model has an error.');
  });

  it('keeps what was typed on a conflict until Reload', async () => {
    const { form, server } = await openForm(at('till'));
    server.versions.set('till', 5);
    server.nodes.set('till', { label: 'Till (theirs)', metadata: { type: 'Application' } });

    fireEvent.change(nameField(form), { target: { value: 'Till (mine)' } });
    fireEvent.submit(form);

    const title = await within(form).findByRole('heading', {
      name: 'Someone else changed this element',
    });
    expect(document.activeElement).toBe(title);
    expect(nameField(form)).toHaveProperty('value', 'Till (mine)');
    expect(within(form).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);

    fireEvent.click(within(form).getByRole('button', { name: 'Reload' }));
    await waitFor(() => {
      expect(nameField(form)).toHaveProperty('value', 'Till (theirs)');
    });
    expect(within(form).queryByText('Someone else changed this element')).toBeNull();
  });

  it('says when someone else deleted the element', async () => {
    const { form } = await openForm(at('till'), {
      answer: ({ method }) =>
        method === 'PATCH' ? apiError(404, 'Not found', { missing: 'element' }) : undefined,
    });
    fireEvent.change(nameField(form), { target: { value: 'Till 2' } });
    fireEvent.submit(form);

    expect(await within(form).findByText('Someone else deleted this element')).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: 'Close form' }));
    await waitFor(() => {
      expect(within(tree()).queryByRole('treeitem', { name: 'Till' })).toBeNull();
    });
  });

  it('asks before discarding with Esc, and only when there are changes', async () => {
    const { form } = await openForm(at('till'));
    fireEvent.keyDown(nameField(form), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.change(nameField(form), { target: { value: 'Till 2' } });
    fireEvent.keyDown(nameField(form), { key: 'Escape' });
    const dialog = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }));

    expect(nameField(form)).toHaveProperty('value', 'Till');
    expect(form.querySelector('.d-form-foot')).toBeNull();
  });

  it('asks before switching element with unsaved changes', async () => {
    const { form } = await openForm(at('till'));
    fireEvent.change(nameField(form), { target: { value: 'Till 2' } });

    fireEvent.click(within(tree()).getByText('Web Shop'));
    let dialog = await screen.findByRole('dialog', { name: 'Save changes to “Till”?' });
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Keep editing' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => {
      expect(currentLocation()).toContain('/elements/till');
    });
    expect(nameField(form)).toHaveProperty('value', 'Till 2');

    fireEvent.click(within(tree()).getByText('Web Shop'));
    dialog = await screen.findByRole('dialog', { name: 'Save changes to “Till”?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await waitFor(() => {
      expect(within(details()).getByRole('heading', { level: 2 }).textContent).toBe('Web Shop');
    });
  });

  it('asks before following a link out of the explorer with unsaved changes', async () => {
    const { form } = await openForm(at('till'));
    fireEvent.change(nameField(form), { target: { value: 'Till 2' } });

    const nav = screen.getByRole('navigation', { name: 'Spaces' });
    fireEvent.click(within(nav).getByRole('link', { name: 'Viewing' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save changes to “Till”?' });
    expect(currentLocation()).toContain('/modelling/');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await waitFor(() => {
      expect(currentLocation()).toBe('/viewing');
    });
  });

  it('creates an element from New element and opens its form', async () => {
    const { server } = await openForm(at('till'));

    fireEvent.click(screen.getByRole('button', { name: 'New element' }));
    const pop = screen.getByRole('dialog', { name: 'New element' });
    const name = within(pop).getByRole('textbox', { name: /^Name/ });
    expect(document.activeElement).toBe(name);
    // The focused element's type is the default.
    expect(within(pop).getByRole('radio', { name: 'Application' })).toHaveProperty('checked', true);

    fireEvent.keyDown(pop, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'New element' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New element' }));

    fireEvent.click(screen.getByRole('button', { name: 'New element' }));
    const again = screen.getByRole('dialog', { name: 'New element' });
    fireEvent.submit(again.querySelector('form') as HTMLFormElement);
    expect(within(again).getByText('Enter a name.')).toBeTruthy();

    fireEvent.change(within(again).getByRole('textbox', { name: /^Name/ }), {
      target: { value: 'Flour Stock' },
    });
    fireEvent.click(within(again).getByRole('radio', { name: 'Infrastructure' }));
    fireEvent.submit(again.querySelector('form') as HTMLFormElement);

    await waitFor(() => {
      expect(currentLocation()).toContain('/elements/new-1');
    });
    expect(server.bodies[0]?.body).toEqual({ type: 'Infrastructure', name: 'Flour Stock' });
    const form = await screen.findByRole('form', { name: 'Edit Flour Stock' });
    await waitFor(() => {
      expect(document.activeElement).toBe(nameField(form));
    });
    expect(
      within(tree()).getByRole('treeitem', { name: 'Flour Stock', selected: true }),
    ).toBeTruthy();
  });

  it('deletes an element after naming its relationships, then goes back in the trail', async () => {
    const { handler, server } = api();
    stubApi(modeller, handler);
    renderAt(at('till'));
    await screen.findByRole('form', { name: 'Edit Till' });
    // A double click focuses Web Shop (a single click only selects it).
    fireEvent.click(within(tree()).getByText('Web Shop'), { detail: 2 });
    await screen.findByRole('form', { name: 'Edit Web Shop' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    fireEvent.click(within(details()).getByRole('button', { name: 'Delete element' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete “Web Shop”?' });
    expect(dialog.textContent).toContain('This deletes the element and its 8 relationships');
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(5);
    expect(dialog.textContent).toContain('and 3 more');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete element' }));
    await waitFor(() => {
      expect(currentLocation()).toContain('/elements/till');
    });
    expect(server.bodies.at(-1)?.method).toBe('DELETE');
    expect(within(tree()).queryByRole('treeitem', { name: 'Web Shop' })).toBeNull();
    expect(within(details()).getByRole('heading', { level: 2 }).textContent).toBe('Till');
  });

  it('keeps the viewpoint in the address when deleting the only element in the trail', async () => {
    const { handler } = api();
    stubApi(modeller, handler);
    renderAt(`${at('till')}?depth=2&show=protocol`);
    await screen.findByRole('form', { name: 'Edit Till' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(within(details()).getByRole('button', { name: 'Delete element' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete element' }));
    await waitFor(() => {
      expect(currentLocation()).not.toContain('/elements/');
    });
    expect(currentLocation()).toContain('depth=2');
    expect(currentLocation()).toContain('show=protocol');
  });
});

describe('Modelling without a database', () => {
  it('says editing is off and opens models read-only', async () => {
    const { handler } = api({ editable: false });
    stubApi(modeller, handler);
    renderAt('/modelling');
    expect(
      await screen.findByText(/Editing is off on this server\. It needs a database/),
    ).toBeTruthy();
  });

  it('shows the Read-only pill and the Viewing panel', async () => {
    const { handler } = api({ editable: false });
    stubApi(modeller, handler);
    renderAt(at('till'));

    expect(await screen.findByText('Read-only', { selector: '.mode-pill' })).toBeTruthy();
    // The list can answer before the model does: the pill may come before the panel.
    expect(await screen.findByText('Editing is off: it needs a database.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New element' })).toBeNull();
    await within(details()).findByRole('heading', { level: 2, name: 'Till' });
    expect(screen.queryByRole('form')).toBeNull();
    expect(within(details()).queryByRole('button', { name: 'Delete element' })).toBeNull();
  });
});

describe('Viewing', () => {
  it('links Modellers to the same element in Modelling, and not Viewers', async () => {
    const { handler } = api();
    stubApi(modeller, handler);
    const view = renderAt(`/viewing/models/${bakeryId}/elements/till?depth=2`);
    const link = await screen.findByRole('link', { name: 'Open in Modelling' });
    expect(link.getAttribute('href')).toBe(`${at('till')}?depth=2`);
    expect(screen.queryByRole('form')).toBeNull();
    view.unmount();

    stubApi(viewer, handler);
    renderAt(`/viewing/models/${bakeryId}/elements/till`);
    await within(await screen.findByRole('complementary', { name: 'Details' })).findByRole(
      'heading',
      { level: 2, name: 'Till' },
    );
    expect(screen.queryByRole('link', { name: 'Open in Modelling' })).toBeNull();
  });
});

describe('element of a node', () => {
  it('reads a node as the explorer does', () => {
    expect(elementOfNode('x', { label: 'X', metadata: { type: 'Nope' } })).toEqual({
      id: 'x',
      name: 'X',
      type: 'Other',
      metadata: { type: 'Nope' },
    });
  });
});

// The rows in CustomMetadataFields, shared with the relationship form.
describe('custom metadata rows on the element form', () => {
  const add = (form: HTMLElement, key: string, value: string) => {
    fireEvent.click(within(form).getByRole('button', { name: 'Add field' }));
    const keys = within(form).getAllByRole('textbox', { name: 'Key' });
    fireEvent.change(keys.at(-1) as HTMLElement, { target: { value: key } });
    const name = `Value of ${key.trim()}`;
    fireEvent.change(within(form).getByRole('textbox', { name }), { target: { value } });
  };
  const save = (form: HTMLElement) => {
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
  };
  const patches = (fetchMock: ReturnType<typeof stubApi>) =>
    fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'PATCH')
      .map(([, init]) => JSON.parse(init?.body as string) as { metadata: Record<string, unknown> });
  /** The form, with the effects of its first renders done. */
  const opened = async (id: string) => {
    const result = await openForm(at(id));
    await act(async () => {
      await Promise.resolve();
    });
    return result;
  };

  it('adds a row with focus on its key, and sends only that row', async () => {
    const { form, fetchMock } = await opened('till');
    fireEvent.click(within(form).getByRole('button', { name: 'Add field' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(within(form).getByRole('textbox', { name: 'Key' }));
    });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Key' }), {
      target: { value: ' protocol ' },
    });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Value of protocol' }), {
      target: { value: 'Made-up' },
    });
    save(form);
    await waitFor(() => {
      expect(patches(fetchMock)).toHaveLength(1);
    });
    expect(patches(fetchMock)[0]?.metadata).toEqual({ protocol: 'Made-up' });
  });

  it('moves focus to the next row, or to Add field, when a row is removed', async () => {
    const { form } = await opened('till');
    add(form, 'alpha', 'x');
    add(form, 'beta', 'y');
    fireEvent.click(within(form).getByRole('button', { name: 'Remove alpha' }));
    await waitFor(() => {
      expect((document.activeElement as HTMLInputElement).value).toBe('beta');
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Remove beta' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(within(form).getByRole('button', { name: 'Add field' }));
    });
  });

  it('refuses a reserved key under its row, linked from its input, with nothing sent', async () => {
    const { form, fetchMock } = await opened('till');
    add(form, 'type', 'x');
    save(form);
    const message = await within(form).findByText('“type” is reserved.');
    const key = within(form).getByRole('textbox', { name: 'Key' });
    expect(key.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(key.getAttribute('aria-describedby') ?? '')).toBe(
      message.closest('.field-error'),
    );
    expect(message.closest('.meta-row')).not.toBeNull();
    expect(patches(fetchMock)).toHaveLength(0);
  });

  it('shows a list as kept as is, and sends a removal as null', async () => {
    const { form, fetchMock } = await opened('shop');
    const group = within(form).queryByRole('group', { name: /kept as is$/ });
    const removable = within(form).getAllByRole('button', { name: /^Remove / })[0] as HTMLElement;
    const key = (removable.getAttribute('aria-label') ?? '').replace('Remove ', '');
    fireEvent.click(removable);
    save(form);
    await waitFor(() => {
      expect(patches(fetchMock)).toHaveLength(1);
    });
    expect(patches(fetchMock)[0]?.metadata).toEqual({ [key]: null });
    expect(group === null || group.querySelector('pre') !== null).toBe(true);
  });
});
