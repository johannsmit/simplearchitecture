import { buildModelGraph, type JgfEdge } from '@simplearchitecture/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { containsNote, problemsByType, relationshipSentence } from '../src/modelling/relationships';
import { nameMatches } from '../src/modelling/NewElement';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import {
  apiError,
  currentLocation,
  modeller,
  renderAt,
  requests,
  stubApi,
  type Handler,
} from './helpers';

// Relationships in the Modelling explorer. Made-up data (the bakery fixture).

const graph = buildModelGraph(bakeryModel);

describe('relationship rules in the UI', () => {
  it('refuses a duplicate per type and words the sentence', () => {
    const problems = problemsByType(graph, 'shop', 'oven/planner #1');
    expect(problems.get('Relation')).toBeUndefined();
    expect(problems.get('Contains')).toBeUndefined();
    expect(problemsByType(graph, 'shop', 'shop').get('Contains')?.kind).toBe('self');
    expect(
      relationshipSentence(graph, { source: 'shop', target: 'server', type: 'Relation' }),
    ).toBe('Web Shop relates to Back Office Server');
    expect(containsNote(graph, 'server', 'shop', true)).toEqual({
      kind: 'info',
      text: 'The canvas tidies up to nest Web Shop in Back Office Server.',
    });
  });
});

const at = (id: string) => `/modelling/models/${bakeryId}/elements/${encodeURIComponent(id)}`;
const relationshipsUrl = `/api/models/${bakeryId}/relationships`;

interface Sent {
  method: string;
  url: string;
  body: unknown;
}

/** The model and element routes, plus a small relationship API with versions. */
function api(answer?: (method: string, url: string, body: unknown) => Response | undefined) {
  const edges = new Map(
    (bakeryModel.graph.edges ?? []).map((edge) => [
      edge.id as string,
      edge as JgfEdge & { id: string },
    ]),
  );
  const versions = new Map<string, number>();
  const sent: Sent[] = [];
  const handler: Handler = (request) => {
    const body: unknown = typeof request.body === 'string' ? JSON.parse(request.body) : undefined;
    if (request.method !== 'GET') sent.push({ method: request.method, url: request.url, body });
    const custom = answer?.(request.method, request.url, body);
    if (custom) return custom;
    if (request.url === '/api/models') {
      return Response.json({ models: [bakerySummary], editable: true });
    }
    if (request.url === `/api/models/${bakeryId}`) return Response.json(bakeryModel);
    if (request.url.startsWith(`/api/models/${bakeryId}/elements`)) {
      const id = decodeURIComponent(request.url.split('/elements/')[1]?.split('?')[0] ?? '');
      if (request.method === 'POST') {
        const { name, type } = body as { name: string; type: string };
        return Response.json(
          {
            element: { id: 'new-1', version: 1, node: { label: name, metadata: { type } } },
            warnings: [],
          },
          { status: 201 },
        );
      }
      return Response.json({
        element: { id, version: 1, node: bakeryModel.graph.nodes?.[id] },
        warnings: [],
      });
    }
    if (!request.url.startsWith(relationshipsUrl)) return undefined;
    const [path = '', query = ''] = request.url.slice(relationshipsUrl.length).split('?');
    const id = decodeURIComponent(path.slice(1));
    const result = (edge: JgfEdge & { id: string }, status = 200) =>
      Response.json(
        {
          relationship: { id: edge.id, version: versions.get(edge.id) ?? 1, edge },
          warnings: [],
          nestingChanges: [],
        },
        { status },
      );
    if (request.method === 'POST') {
      const { source, target, type, architectureState } = body as Record<string, string>;
      const edge = {
        id: 'r-new',
        source: source ?? '',
        target: target ?? '',
        relation: type ?? '',
        metadata: { architectureState: architectureState ?? 'Current' },
      };
      edges.set(edge.id, edge);
      return result(edge, 201);
    }
    const edge = edges.get(id);
    if (!edge) return apiError(404, 'Not found', { missing: 'relationship' });
    const version = versions.get(id) ?? 1;
    if (request.method === 'GET') return result(edge);
    if (request.method === 'PATCH') {
      const change = body as Record<string, unknown>;
      if (change.version !== version) return apiError(409, 'Changed', { currentVersion: version });
      const next = { ...edge, metadata: { ...edge.metadata } };
      if (typeof change.architectureState === 'string') {
        next.metadata.architectureState = change.architectureState;
      }
      if (typeof change.type === 'string') next.relation = change.type;
      if (change.informationFlow === true) {
        (next.metadata as Record<string, unknown>).informationFlow = true;
      } else if (change.informationFlow === false) {
        Reflect.deleteProperty(next.metadata, 'informationFlow');
      }
      if (change.reverse === true) [next.source, next.target] = [edge.target, edge.source];
      if (typeof change.twoWay === 'boolean') next.directed = !change.twoWay;
      for (const [key, value] of Object.entries(change.metadata ?? {})) {
        if (value === null) Reflect.deleteProperty(next.metadata, key);
        else (next.metadata as Record<string, unknown>)[key] = value;
      }
      if (change.label === null) delete next.label;
      else if (typeof change.label === 'string') next.label = change.label;
      edges.set(id, next);
      versions.set(id, version + 1);
      return result(next);
    }
    if (request.method === 'DELETE') {
      expect(query).toBe(`version=${version}`);
      edges.delete(id);
      return Response.json({ id, nestingChanges: [] });
    }
    return undefined;
  };
  return { handler, sent };
}

const details = () => screen.getByRole('complementary', { name: 'Details' });

async function openShop(answer?: Parameters<typeof api>[0]) {
  const { handler, sent } = api(answer);
  const fetchMock = stubApi(modeller, handler);
  renderAt(at('shop'));
  await screen.findByRole('form', { name: /^Edit / });
  return { sent, fetchMock };
}

async function openRelationship(name: RegExp, index = 0) {
  // Parallel relationships each have their own button, in model order: e3, e4 and e8 to the
  // planner, e7 and e9 to the server.
  fireEvent.click(within(details()).getAllByRole('button', { name })[index] as HTMLElement);
  return screen.findByRole('form', { name: /^Relationship / });
}

describe('Add relationship (details panel)', () => {
  it('finds any element, adds the relationship, keeps the box open and lists the new row', async () => {
    const { sent } = await openShop();
    fireEvent.click(within(details()).getByRole('button', { name: 'Add relationship' }));
    const box = await screen.findByRole('group', { name: 'Add relationship' });
    fireEvent.click(within(box).getByRole('radio', { name: 'Relation' }));
    const search = within(box).getByRole('combobox', { name: 'Other element' });
    // Not on the canvas at depth 1, but found by the search over the whole model.
    fireEvent.change(search, { target: { value: 'recipe' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(within(box).getByText('Recipe Archive')).toBeDefined();
    fireEvent.click(within(box).getByRole('radio', { name: /Target/ }));
    fireEvent.click(within(box).getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(sent).toContainEqual({
        method: 'POST',
        url: relationshipsUrl,
        body: {
          source: 'shop',
          target: 'lonely',
          type: 'Relation',
          architectureState: 'Target',
        },
      });
    });
    // The box stays open for the next one, with the search back; the row is in the list.
    await screen.findByRole('combobox', { name: 'Other element' });
    expect(within(box).getByRole('button', { name: 'Close' })).toBeDefined();
    expect(
      within(details()).getByRole('button', { name: /^Relates to Recipe Archive, Target/ }),
    ).toBeDefined();
  });

  it('shows a duplicate at the picked element and sends nothing; the element itself is not pickable', async () => {
    const contains = {
      graph: {
        ...bakeryModel.graph,
        edges: [
          ...(bakeryModel.graph.edges ?? []),
          { id: 'c9', source: 'shop', target: 'ordering', relation: 'Contains' },
        ],
      },
    };
    const { sent } = await openShop((_method, url) =>
      url === `/api/models/${bakeryId}` ? Response.json(contains) : undefined,
    );

    fireEvent.click(within(details()).getByRole('button', { name: 'Add relationship' }));
    const box = await screen.findByRole('group', { name: 'Add relationship' });
    fireEvent.click(within(box).getByRole('radio', { name: 'Contains' }));
    const search = within(box).getByRole('combobox', { name: 'Other element' });
    fireEvent.change(search, { target: { value: 'web shop' } });
    const self = within(box).getByRole('option', { name: /Web Shop/ });
    expect(self.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(self);
    expect(within(box).queryByRole('button', { name: 'Change other element' })).toBeNull();

    fireEvent.change(search, { target: { value: 'order to' } });
    fireEvent.click(within(box).getByRole('option', { name: /Order to bake/ }));
    expect(within(box).getByText(/Web Shop already contains Order to bake\./)).toBeDefined();
    fireEvent.click(within(box).getByRole('button', { name: 'Add' }));
    expect(sent.filter((r) => r.url === relationshipsUrl)).toEqual([]);

    // Esc closes it, focus back on the button.
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Add relationship' })).toBeNull();
    });
  });
});

describe('The relationship form', () => {
  it('opens from the row, refuses a duplicate type, and saves the state with the version', async () => {
    const { sent } = await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Oven Planner/);
    expect(
      within(details()).getByRole('heading', {
        name: 'Web Shop relates to Oven Planner',
      }),
    ).toBeDefined();
    // e4 is a plain Relation between the same ends: fine, as several may link them.
    expect(within(form).getByRole('radio', { name: 'Relation' })).toHaveProperty('disabled', false);
    expect(within(form).queryByRole('button', { name: 'Show it' })).toBeNull();
    expect(within(form).getByLabelText<HTMLInputElement>('Data').value).toBe('Orders');

    // No footer until something changes.
    expect(within(form).queryByRole('button', { name: /^Save/ })).toBeNull();

    fireEvent.click(within(form).getByRole('radio', { name: /Deprecate/ }));
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(sent.find((r) => r.method === 'PATCH')?.body).toEqual({
        version: 1,
        architectureState: 'Deprecate',
      });
    });
    await within(form).findByText('Saved');
  });

  it('saves Direction: Both ways, hides Reverse for it, and Contains is one way', async () => {
    const { sent } = await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Back Office Server/);
    const direction = within(form).getByRole('group', { name: 'Direction' });
    expect(within(direction).getByRole('radio', { name: /One way/ })).toHaveProperty(
      'checked',
      true,
    );
    fireEvent.click(within(direction).getByRole('radio', { name: /Both ways/ }));
    expect(within(details()).queryByRole('button', { name: 'Reverse direction' })).toBeNull();
    expect(within(details()).getByRole('button', { name: /^Between: Web Shop/ })).toBeDefined();

    // Contains is always one way: the choice goes, and comes back as One way.
    fireEvent.click(within(form).getByRole('radio', { name: 'Contains' }));
    expect(within(form).queryByRole('group', { name: 'Direction' })).toBeNull();
    fireEvent.click(within(form).getByRole('radio', { name: 'Relation' }));
    expect(
      within(within(form).getByRole('group', { name: 'Direction' })).getByRole('radio', {
        name: /One way/,
      }),
    ).toHaveProperty('checked', true);

    fireEvent.click(within(form).getByRole('radio', { name: /Both ways/ }));
    fireEvent.click(within(form).getByRole('button', { name: /^Save/ }));
    await waitFor(() => {
      expect(sent.find((r) => r.method === 'PATCH')?.body).toEqual({ version: 1, twoWay: true });
    });
    expect(
      await within(details()).findByRole('heading', {
        name: 'Web Shop relates both ways to Back Office Server',
      }),
    ).toBeDefined();
  });

  it('reverses with Save, and shows a conflict with Reload on a stale version', async () => {
    let stale = true;
    const { sent } = await openShop((method) =>
      method === 'PATCH' && stale ? apiError(409, 'Changed', { currentVersion: 2 }) : undefined,
    );
    const form = await openRelationship(/^Open relationship: Relates to Back Office Server/);
    const reverse = within(details()).getByRole('button', { name: 'Reverse direction' });
    fireEvent.click(reverse);
    expect(reverse.getAttribute('aria-pressed')).toBe('true');
    expect(within(details()).getByText('Reversed')).toBeDefined();
    fireEvent.click(within(form).getByRole('button', { name: /^Save/ }));
    await within(form).findByText('Someone else changed this relationship');
    expect(sent.find((r) => r.method === 'PATCH')?.body).toEqual({ version: 1, reverse: true });

    stale = false;
    fireEvent.click(within(form).getByRole('button', { name: 'Reload' }));
    await waitFor(() => {
      expect(within(form).queryByText('Someone else changed this relationship')).toBeNull();
    });
  });

  it('deletes after confirming and goes back to the focused element', async () => {
    const { sent } = await openShop();
    await openRelationship(/^Open relationship: Relates to Back Office Server/);
    fireEvent.click(within(details()).getByRole('button', { name: 'Delete relationship' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this relationship?' });
    expect(within(dialog).getByText(/Web Shop relates to Back Office Server\./)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete relationship' }));
    await waitFor(() => {
      expect(sent).toContainEqual({
        method: 'DELETE',
        url: `${relationshipsUrl}/e7?version=1`,
        body: undefined,
      });
    });
    await screen.findByRole('form', { name: /^Edit / });
    // e9 still relates Web Shop to the server.
    expect(
      within(details()).queryAllByRole('button', {
        name: /^Open relationship: Relates to Back Office Server/,
      }),
    ).toHaveLength(1);
  });

  it('asks before leaving a relationship with changes, in its own words', async () => {
    await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Back Office Server/);
    fireEvent.click(within(form).getByRole('radio', { name: /Target/ }));
    fireEvent.click(within(details()).getByRole('button', { name: 'Back to Web Shop' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Save changes to this relationship?',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await screen.findByRole('form', { name: /^Edit / });
  });
});

describe('New element on the canvas', () => {
  it('opens with N (not while typing) and keeps the focused element', async () => {
    const { sent } = await openShop();
    // Typing in a field doesn't open it.
    const name = within(details()).getByRole('textbox', { name: /^Name/ });
    fireEvent.keyDown(name, { key: 'n' });
    expect(screen.queryByRole('dialog', { name: 'New element' })).toBeNull();

    act(() => {
      fireEvent.keyDown(document.body, { key: 'n' });
    });
    const pop = await screen.findByRole('dialog', { name: 'New element' });
    fireEvent.change(within(pop).getByRole('textbox', { name: /^Name/ }), {
      target: { value: 'Flour Store' },
    });
    fireEvent.click(within(pop).getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(sent.some((r) => r.method === 'POST' && r.url.endsWith('/elements'))).toBe(true);
    });
    // The new card goes on the canvas; the focused element stays the same.
    expect(currentLocation()).toBe(at('shop'));
    expect(screen.getByRole('button', { name: 'New element on the canvas' })).toBeDefined();
  });

  it('has no canvas editing in Viewing', async () => {
    const { handler } = api();
    const fetchMock = stubApi(modeller, handler);
    renderAt(`/viewing/models/${bakeryId}/elements/shop`);
    await within(await screen.findByRole('complementary', { name: 'Details' })).findByRole(
      'heading',
      { name: 'Web Shop' },
    );
    expect(screen.queryByRole('button', { name: 'New element on the canvas' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add relationship' })).toBeNull();
    // Relationships open read-only in Viewing too (no server call, no edit actions).
    expect(screen.getAllByRole('button', { name: /^Open relationship/ }).length).toBeGreaterThan(0);
    expect(requests(fetchMock).some((r) => r.includes('/relationships'))).toBe(false);
  });
});

describe('New element: use an existing element instead', () => {
  const canvasEl = () => document.getElementById('canvas') as HTMLElement;
  const card = (id: string) =>
    canvasEl().querySelector<HTMLElement>(`.card[data-element-id="${id}"]`);
  const elementPosts = (sent: Sent[]) =>
    sent.filter((r) => r.method === 'POST' && r.url.endsWith('/elements'));
  const typeName = (pop: HTMLElement, value: string) => {
    fireEvent.change(within(pop).getByRole('textbox', { name: /^Name/ }), { target: { value } });
  };

  it('matches names ignoring case and spaces, across types, at most 5', () => {
    const many = buildModelGraph({
      graph: {
        nodes: Object.fromEntries(
          ['Stakeholder', 'Business', 'Application', 'Infrastructure', 'Other', 'Other'].map(
            (type, index) => [
              `n${index}`,
              { label: index === 0 ? ' Ledger ' : 'ledger', metadata: { type } },
            ],
          ),
        ),
      },
    });
    const found = nameMatches(many, '  LEDGER ');
    expect(found).toHaveLength(5);
    expect(found.map((e) => e.type)).toEqual([
      'Stakeholder',
      'Business',
      'Application',
      'Infrastructure',
      'Other',
    ]);
    expect(nameMatches(many, 'ledge')).toEqual([]);
    expect(nameMatches(graph, 'web shop').map((e) => e.id)).toEqual(['shop']);
  });

  it('from the list: Add to canvas brings the element on without creating one; Show on canvas for one already there', async () => {
    const { sent } = await openShop();
    await waitFor(
      () => {
        expect(card('shop')).not.toBeNull();
      },
      { timeout: 4000 },
    );
    fireEvent.click(screen.getByRole('button', { name: 'New element' }));
    const pop = await screen.findByRole('dialog', { name: 'New element' }, { timeout: 4000 });
    typeName(pop, '  WEB shop ');
    expect(within(pop).getByText(/An element is already called “WEB shop”/)).toBeDefined();
    expect(
      within(pop).getByRole('button', { name: 'Show on canvas: Web Shop, Application' }),
    ).toBeDefined();

    typeName(pop, 'recipe archive');
    expect(card('lonely')).toBeNull();
    fireEvent.click(
      within(pop).getByRole('button', { name: 'Add to canvas: Recipe Archive, Other' }),
    );
    await waitFor(
      () => {
        expect(card('lonely')).not.toBeNull();
      },
      { timeout: 4000 },
    );
    expect(screen.queryByRole('dialog', { name: 'New element' })).toBeNull();
    expect(elementPosts(sent)).toEqual([]);
    expect(currentLocation()).toBe(at('shop'));
  });

  it('from a double-click: places the existing element at the pointer', async () => {
    const { sent } = await openShop();
    await waitFor(
      () => {
        expect(card('shop')).not.toBeNull();
      },
      { timeout: 4000 },
    );
    const pane = canvasEl().querySelector('.react-flow__pane') as HTMLElement;
    fireEvent.doubleClick(pane, { clientX: 400, clientY: 300 });
    const pop = await screen.findByRole('dialog', { name: 'New element' }, { timeout: 4000 });
    typeName(pop, 'Recipe Archive');
    fireEvent.click(within(pop).getByRole('button', { name: /^Add to canvas: Recipe Archive/ }));
    await waitFor(
      () => {
        expect(card('lonely')).not.toBeNull();
      },
      { timeout: 4000 },
    );
    const node = card('lonely')?.closest<HTMLElement>('.react-flow__node');
    // The jsdom canvas has no size, so its view is unscaled: flow position = pointer.
    expect(node?.style.transform).toBe('translate(340px,278px)');
    expect(elementPosts(sent)).toEqual([]);
  });

  it('after a line dropped on empty canvas: the rules show before anything is sent', async () => {
    const { sent } = await openShop();
    // jsdom has no hit testing; React Flow asks for it while a line is drawn (nothing is hit).
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
    onTestFinished(() => {
      Reflect.deleteProperty(document, 'elementFromPoint');
    });
    const dropLine = async () => {
      const handle = await waitFor(
        () => {
          const found = card('shop')?.querySelector<HTMLElement>('.connect-handle');
          if (!found) throw new Error('no handle yet');
          return found;
        },
        { timeout: 4000 },
      );
      fireEvent.mouseDown(handle, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.mouseMove(document, { clientX: 40, clientY: 40 });
      fireEvent.mouseUp(document, { clientX: 0, clientY: 0 });
    };
    await dropLine();
    const pop = await screen.findByRole('dialog', { name: 'New element' }, { timeout: 4000 });
    expect(within(pop).getByText('Then choose the relationship from Web Shop.')).toBeDefined();
    // The source itself: the popover shows why before anything is sent.
    typeName(pop, 'web shop');
    fireEvent.click(within(pop).getByRole('button', { name: /^Show on canvas: Web Shop/ }));
    const rel = await screen.findByRole('dialog', { name: 'New relationship' }, { timeout: 4000 });
    expect(within(rel).getByRole('radio', { name: 'Relation' })).toHaveProperty('disabled', true);
    expect(within(rel).getAllByText("Can't connect an element to itself.")).toHaveLength(2);
    expect(sent.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('after a line dropped on empty canvas: an existing element becomes the other end and is added', async () => {
    const { sent } = await openShop();
    // jsdom has no hit testing; React Flow asks for it while a line is drawn (nothing is hit).
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
    onTestFinished(() => {
      Reflect.deleteProperty(document, 'elementFromPoint');
    });
    const dropLine = async () => {
      const handle = await waitFor(
        () => {
          const found = card('shop')?.querySelector<HTMLElement>('.connect-handle');
          if (!found) throw new Error('no handle yet');
          return found;
        },
        { timeout: 4000 },
      );
      fireEvent.mouseDown(handle, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.mouseMove(document, { clientX: 40, clientY: 40 });
      fireEvent.mouseUp(document, { clientX: 0, clientY: 0 });
    };
    await dropLine();
    const again = await screen.findByRole('dialog', { name: 'New element' }, { timeout: 4000 });
    typeName(again, 'Order to bake');
    fireEvent.click(within(again).getByRole('button', { name: /^Show on canvas: Order to bake/ }));
    const rel = await screen.findByRole('dialog', { name: 'New relationship' }, { timeout: 4000 });
    expect(within(rel).getByText('Order to bake')).toBeDefined();
    // e2 already sends information from the shop to it: a second Relation is fine.
    expect(within(rel).getByRole('radio', { name: 'Relation' })).toHaveProperty('disabled', false);

    fireEvent.click(within(rel).getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(sent).toContainEqual({
        method: 'POST',
        url: relationshipsUrl,
        body: {
          source: 'shop',
          target: 'ordering',
          type: 'Relation',
          architectureState: 'Current',
        },
      });
    });
    expect(elementPosts(sent)).toEqual([]);
  });
});

describe('Relation properties on the forms', () => {
  const addTo = async (name: string, query: string) => {
    fireEvent.click(within(details()).getByRole('button', { name: 'Add relationship' }));
    const box = await screen.findByRole('group', { name: 'Add relationship' });
    const search = within(box).getByRole('combobox', { name: 'Other element' });
    fireEvent.change(search, { target: { value: query } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(within(box).getByText(name)).toBeDefined();
    return box;
  };
  const noFlowBox = (where: HTMLElement) =>
    within(where).queryByRole('checkbox', { name: 'Information flow' });

  it('offers only Relation and Contains, starting as a Relation, with no Information flow', async () => {
    const { sent } = await openShop();
    const box = await addTo('Recipe Archive', 'recipe');
    expect(within(box).getAllByRole('radio', { name: /^(Relation|Contains)$/ })).toHaveLength(2);
    expect(within(box).queryByRole('radio', { name: 'Integration' })).toBeNull();
    expect(within(box).getByRole('radio', { name: 'Relation' })).toHaveProperty('checked', true);
    expect(noFlowBox(box)).toBeNull();
    fireEvent.click(within(box).getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({
        source: 'shop',
        target: 'lonely',
        type: 'Relation',
        architectureState: 'Current',
      });
    });
    expect(
      await within(details()).findByRole('button', { name: /^Relates to Recipe Archive/ }),
    ).toBeDefined();
  });

  it('has no Information flow box on the form either, for any type', async () => {
    await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Order to bake/);
    expect(noFlowBox(form)).toBeNull();
    fireEvent.click(within(form).getByRole('radio', { name: 'Contains' }));
    expect(noFlowBox(form)).toBeNull();
    expect(within(details()).queryByText(/Information flow/)).toBeNull();
  });

  it('allows a second Relation between the same two elements, with no refusal', async () => {
    const { sent } = await openShop();
    const box = await addTo('Oven Planner', 'oven');
    fireEvent.click(within(box).getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(sent.at(-1)?.body).toMatchObject({ target: 'oven/planner #1', type: 'Relation' });
    });
    expect(within(box).queryByRole('button', { name: 'Show it' })).toBeNull();
  });

  it('moves no card when a line splits from its twin', async () => {
    const { sent } = await openShop();
    const positions = () =>
      [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map(
        (node) => `${node.dataset.id ?? ''} ${node.style.transform}`,
      );
    const lines = () => document.querySelectorAll('.react-flow__edge').length;
    await waitFor(() => {
      expect(lines()).toBeGreaterThan(0);
    });
    const before = positions();
    const count = lines();
    // e7 and e9 run the same way between the same two cards: one line, until e9 is two-way.
    const form = await openRelationship(/^Open relationship: Relates to Back Office Server/, 1);
    fireEvent.click(within(form).getByRole('radio', { name: /Both ways/ }));
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({ version: 1, twoWay: true });
    });
    await waitFor(() => {
      expect(lines()).toBe(count + 1);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(positions()).toEqual(before);
  });

  // A browser submits a form on Enter in a one-line field unless keydown is prevented, which
  // is what `fireEvent.keyDown` returns false for. jsdom doesn't submit by itself.
  it('never saves on Enter in a field of the form, with changes to save', async () => {
    const { sent } = await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Order to bake/);
    fireEvent.change(within(form).getByRole('textbox', { name: 'Label' }), {
      target: { value: 'Made-up label' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Add field' }));
    const fields = [
      within(form).getByRole('textbox', { name: 'Label' }),
      within(form).getByLabelText('Identity'),
      within(form).getByLabelText('Data'),
      within(form).getByLabelText('Key'),
      within(form).getByRole('textbox', { name: 'Value of the new field' }),
      within(form).getByRole('radio', { name: 'Relation' }),
    ];
    for (const field of fields) {
      expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(false);
    }
    // A textarea keeps its line break.
    expect(
      fireEvent.keyDown(within(form).getByRole('textbox', { name: 'Description' }), {
        key: 'Enter',
      }),
    ).toBe(true);
    expect(sent.filter((request) => request.method === 'PATCH')).toHaveLength(0);

    // Ctrl or Cmd + Enter still saves, from a field too, and so does the button.
    fireEvent.keyDown(fields[0] as HTMLElement, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({ version: 1, label: 'Made-up label' });
    });
    await within(form).findByText('Saved');
    fireEvent.change(within(form).getByRole('textbox', { name: 'Label' }), {
      target: { value: 'Second label' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({ version: 2, label: 'Second label' });
    });
  });

  it('warns before saving Data away as Contains, and Discard restores it', async () => {
    const { sent } = await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Oven Planner/);
    const data = () => within(form).queryByLabelText<HTMLInputElement>('Data');
    expect(data()?.value).toBe('Orders');
    fireEvent.click(within(form).getByRole('radio', { name: 'Contains' }));
    expect(data()).toBeNull();
    expect(
      within(form).getByText('Identity, Identity Context and Data are removed when you save.'),
    ).toBeDefined();
    // Back to Relation: Data is empty, so it still counts as a change.
    fireEvent.click(within(form).getByRole('radio', { name: 'Relation' }));
    expect(data()?.value).toBe('');
    expect(within(form).getByRole('button', { name: 'Save' })).toBeDefined();
    fireEvent.click(within(form).getByRole('button', { name: 'Discard changes' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Discard/ }));
    expect(data()?.value).toBe('Orders');

    fireEvent.click(within(form).getByRole('radio', { name: 'Contains' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({ version: 1, type: 'Contains', data: null });
    });
  });

  it('never lists the old key as a custom row, and refuses it as a new one', async () => {
    const { sent } = await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Order to bake/);
    expect(within(form).queryByRole('textbox', { name: 'Value of informationFlow' })).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'Add field' }));
    fireEvent.change(within(form).getByLabelText('Key'), {
      target: { value: 'informationFlow' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('“informationFlow” is reserved.')).toBeDefined();
    expect(sent.filter((request) => request.method === 'PATCH')).toHaveLength(0);
  });

  it('shows the server’s refusal of Data under its field', async () => {
    await openShop((method) =>
      method === 'PATCH'
        ? apiError(422, 'Refused', {
            fields: [{ field: 'data', message: 'Must be at most 2000 characters.' }],
          })
        : undefined,
    );
    const form = await openRelationship(/^Open relationship: Relates to Oven Planner/, 1);
    fireEvent.change(within(form).getByLabelText('Data'), { target: { value: 'Made-up' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    const message = await within(form).findByText('Must be at most 2000 characters.');
    expect(within(form).getByLabelText('Data').getAttribute('aria-describedby')).toContain(
      message.closest('.field-error')?.id ?? 'missing',
    );
  });

  it('words a two-way Relation on the type line in Modelling too', async () => {
    const { sent } = await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Oven Planner/, 1);
    fireEvent.click(within(form).getByRole('radio', { name: /Both ways/ }));
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({ version: 1, twoWay: true });
    });
    expect(await within(details()).findByText('Relation · Both ways')).toBeDefined();
  });
});

describe('the relationship’s custom metadata', () => {
  const open = () => openRelationship(/^Open relationship: Relates to Back Office Server/, 1);
  const save = (form: HTMLElement) => {
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
  };

  it('adds a row, saves only that change, and removes it again', async () => {
    const { sent } = await openShop();
    const form = await open();
    expect(within(form).getByText('No custom metadata.')).toBeDefined();
    expect(within(form).queryByRole('button', { name: 'Save' })).toBeNull();

    fireEvent.click(within(form).getByRole('button', { name: 'Add field' }));
    // Focus goes to the new row's key.
    await waitFor(() => {
      expect(document.activeElement).toBe(within(form).getByLabelText('Key'));
    });
    fireEvent.change(within(form).getByLabelText('Key'), {
      target: { value: ' protocol ' },
    });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Value of protocol' }), {
      target: { value: 'REST' },
    });
    save(form);
    await waitFor(() => {
      expect(sent.at(-1)).toMatchObject({
        method: 'PATCH',
        body: { version: 1, metadata: { protocol: 'REST' } },
      });
    });
    await waitFor(() => {
      expect(within(form).queryByRole('button', { name: 'Save' })).toBeNull();
    });

    fireEvent.click(within(form).getByRole('button', { name: 'Remove protocol' }));
    save(form);
    await waitFor(() => {
      expect(sent.at(-1)).toMatchObject({
        method: 'PATCH',
        body: { version: 2, metadata: { protocol: null } },
      });
    });
  });

  it('checks the rows before anything is sent', async () => {
    const { sent } = await openShop();
    const form = await open();
    const add = (key: string) => {
      fireEvent.click(within(form).getByRole('button', { name: 'Add field' }));
      const keys = within(form).getAllByLabelText('Key');
      fireEvent.change(keys[keys.length - 1] as HTMLElement, { target: { value: key } });
    };
    add('architectureState');
    save(form);
    expect(await within(form).findByText(/has its own field above/)).toBeDefined();
    fireEvent.click(within(form).getByRole('button', { name: 'Remove architectureState' }));
    add('protocol');
    add('protocol');
    save(form);
    expect(await within(form).findByText('This key is used twice.')).toBeDefined();
    expect(sent.filter((r) => r.method === 'PATCH')).toHaveLength(0);
  });

  it('puts the server’s message under the row', async () => {
    const { sent } = await openShop((method) =>
      method === 'PATCH'
        ? apiError(422, 'The change is not valid.', {
            fields: [{ field: 'metadata.protocol', message: 'Must be at most 2000 characters.' }],
          })
        : undefined,
    );
    const form = await open();
    fireEvent.click(within(form).getByRole('button', { name: 'Add field' }));
    fireEvent.change(within(form).getByLabelText('Key'), {
      target: { value: 'protocol' },
    });
    save(form);
    const message = await within(form).findByText('Must be at most 2000 characters.');
    expect(message.closest('.meta-row')).not.toBeNull();
    expect(sent.some((r) => r.method === 'PATCH')).toBe(true);
  });
});

describe('the form and what is stored', () => {
  const edgeOf = (metadata: Record<string, unknown>) => ({
    id: 'e9',
    source: 'shop',
    target: 'server',
    relation: 'Relation',
    metadata,
  });
  const relationshipReply = (metadata: Record<string, unknown>) =>
    Response.json({
      relationship: { id: 'e9', version: 1, edge: edgeOf(metadata) },
      warnings: [],
      nestingChanges: [],
    });
  const withEdge = (edge: JgfEdge) => ({
    graph: {
      ...bakeryModel.graph,
      edges: (bakeryModel.graph.edges ?? []).map((other) => (other.id === 'e9' ? edge : other)),
    },
  });
  /** The model's copy of e9 and the server's copy, which may differ. */
  const stored = (inModel: Record<string, unknown>, onServer = inModel) =>
    ((method: string, url: string) => {
      if (url === `/api/models/${bakeryId}`) return Response.json(withEdge(edgeOf(inModel)));
      if (method === 'GET' && url === `${relationshipsUrl}/e9`) return relationshipReply(onServer);
      return undefined;
    }) as Parameters<typeof api>[0];
  const open = () => openRelationship(/^Open relationship: Relates to Back Office Server/, 1);
  const save = (form: HTMLElement) => {
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
  };

  it('shows stored text, numbers, true/false and lists, and sends only what changed', async () => {
    const { sent } = await openShop(
      stored({ owner: 'Made-up', count: 3, on: false, list: ['a'], constructor: 'odd' }),
    );
    const form = await open();
    expect(within(form).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(
      within(form).getByRole<HTMLInputElement>('combobox', { name: 'Value of count' }).value,
    ).toBe('3');
    expect(within(form).getByRole('group', { name: 'Value of list, kept as is' })).toBeDefined();
    fireEvent.change(within(form).getByRole('combobox', { name: 'Value of constructor' }), {
      target: { value: 'changed' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Remove owner' }));
    save(form);
    await waitFor(() => {
      expect(sent.at(-1)).toMatchObject({
        method: 'PATCH',
        body: { version: 1, metadata: { constructor: 'changed', owner: null } },
      });
    });
    const body = sent.at(-1)?.body as { metadata: Record<string, unknown> };
    expect(Object.keys(body.metadata).sort()).toEqual(['constructor', 'owner']);
  });

  it('moves focus to the next row, or to Add field, when a row is removed', async () => {
    await openShop(stored({ alpha: 'x', beta: 'y' }));
    const form = await open();
    fireEvent.click(within(form).getByRole('button', { name: 'Remove alpha' }));
    await waitFor(() => {
      expect((document.activeElement as HTMLInputElement).value).toBe('beta');
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Remove beta' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(within(form).getByRole('button', { name: 'Add field' }));
    });
  });

  it('has a working error link from a refused row', async () => {
    await openShop();
    const form = await open();
    fireEvent.click(within(form).getByRole('button', { name: 'Add field' }));
    const key = within(form).getByLabelText('Key');
    fireEvent.change(key, { target: { value: 'description' } });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Value of description' }), {
      target: { value: 'x' },
    });
    save(form);
    const message = await within(form).findByText(/has its own field above/);
    const described = key.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(described)?.contains(message)).toBe(true);
    expect(document.activeElement).toBe(key);
  });

  // The form's draft wasn't reset when the server's copy arrived, so a key added elsewhere read
  // as removed here, and Save deleted it. The version is fresh, so no conflict stopped it.
  it('does not count a key added elsewhere as a change of mine', async () => {
    const { sent } = await openShop(stored({}, { addedElsewhere: 'Made-up' }));
    const form = await open();
    await within(form).findByRole('combobox', { name: 'Value of addedElsewhere' });
    expect(within(form).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(sent.filter((request) => request.method === 'PATCH')).toHaveLength(0);
  });

  it('follows a state, description and label changed elsewhere, with nothing to save', async () => {
    const { sent } = await openShop((method, url) => {
      if (url === `/api/models/${bakeryId}`) return Response.json(withEdge(edgeOf({})));
      if (method === 'GET' && url === `${relationshipsUrl}/e9`) {
        return Response.json({
          relationship: {
            id: 'e9',
            version: 1,
            edge: {
              ...edgeOf({ architectureState: 'Target', description: 'Made-up words' }),
              label: 'Made-up label',
            },
          },
          warnings: [],
          nestingChanges: [],
        });
      }
      return undefined;
    });
    const form = await open();
    await waitFor(() => {
      expect(within(form).getByRole<HTMLInputElement>('textbox', { name: 'Label' }).value).toBe(
        'Made-up label',
      );
    });
    expect(
      within(form).getByRole<HTMLTextAreaElement>('textbox', { name: 'Description' }).value,
    ).toBe('Made-up words');
    expect(within(form).getByRole<HTMLInputElement>('radio', { name: /Target/ }).checked).toBe(
      true,
    );
    expect(within(form).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(sent.filter((request) => request.method === 'PATCH')).toHaveLength(0);
  });

  it('keeps what the user typed when the server’s copy arrives, and sends only that', async () => {
    let arrive = () => {};
    const held = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const reply = stored({}, { addedElsewhere: 'Made-up' });
    const { sent } = await openShop((method, url, body) => {
      if (method === 'GET' && url === `${relationshipsUrl}/e9`) {
        return held.then(() => reply?.(method, url, body)) as unknown as Response;
      }
      return reply?.(method, url, body);
    });
    const form = await open();
    const label = within(form).getByRole<HTMLInputElement>('textbox', { name: 'Label' });
    fireEvent.change(label, { target: { value: 'Typed first' } });
    await act(async () => {
      arrive();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(label.value).toBe('Typed first');
    save(form);
    await waitFor(() => {
      expect(sent.at(-1)?.method).toBe('PATCH');
    });
    expect(sent.at(-1)?.body).toEqual({ version: 1, label: 'Typed first' });
  });

  it('discarding shows the copy from the server, not the old one', async () => {
    let arrive = () => {};
    const held = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const reply = stored({}, { addedElsewhere: 'Made-up' });
    await openShop((method, url, body) => {
      if (method === 'GET' && url === `${relationshipsUrl}/e9`) {
        return held.then(() => reply?.(method, url, body)) as unknown as Response;
      }
      return reply?.(method, url, body);
    });
    const form = await open();
    fireEvent.change(within(form).getByRole('textbox', { name: 'Label' }), {
      target: { value: 'Typed first' },
    });
    await act(async () => {
      arrive();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(within(form).queryByRole('combobox', { name: 'Value of addedElsewhere' })).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'Discard changes' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Discard/ }));
    expect(
      await within(form).findByRole('combobox', { name: 'Value of addedElsewhere' }),
    ).toBeDefined();
    expect(within(form).queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('a change found only on Save, after the first read failed, is a conflict', async () => {
    let down = true;
    const reply = stored({}, { addedElsewhere: 'Made-up' });
    const { sent } = await openShop((method, url, body) => {
      if (method === 'GET' && url === `${relationshipsUrl}/e9` && down) {
        return apiError(500, 'Down');
      }
      return reply?.(method, url, body);
    });
    const form = await open();
    fireEvent.change(within(form).getByRole('textbox', { name: 'Label' }), {
      target: { value: 'Typed' },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    down = false;
    save(form);
    expect(await within(form).findByText('Someone else changed this relationship')).toBeDefined();
    expect(sent.filter((request) => request.method === 'PATCH')).toHaveLength(0);
  });

  // A stored key `type` (any JGF may hold one on an edge) blocked every save on the form, and
  // the server refuses to remove it, so the relationship couldn't be edited here at all.
  it('saves a label on a relationship that holds a stored `type` key', async () => {
    const { sent } = await openShop(stored({ type: 'Made-up' }));
    const form = await open();
    fireEvent.change(within(form).getByRole('textbox', { name: /Label/ }), {
      target: { value: 'Made-up label' },
    });
    save(form);
    await waitFor(() => {
      expect(sent.at(-1)?.method).toBe('PATCH');
    });
    expect(sent.at(-1)?.body).toEqual({ version: 1, label: 'Made-up label' });
  });

  it('does the same for a stored key with spaces around a reserved name', async () => {
    const { sent } = await openShop(stored({ ' description ': 'Made-up' }));
    const form = await open();
    fireEvent.change(within(form).getByRole('textbox', { name: /Label/ }), {
      target: { value: 'Made-up label' },
    });
    save(form);
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({ version: 1, label: 'Made-up label' });
    });
  });

  it('still refuses a reserved key typed as a new row', async () => {
    const { sent } = await openShop(stored({}));
    const form = await open();
    fireEvent.click(within(form).getByRole('button', { name: 'Add field' }));
    fireEvent.change(within(form).getByLabelText('Key'), {
      target: { value: 'type' },
    });
    save(form);
    expect(await within(form).findByText('“type” is reserved.')).toBeDefined();
    expect(sent.filter((request) => request.method === 'PATCH')).toHaveLength(0);
  });

  // The read-only section looked the metadata up on `edge`, which a relationship with no id
  // never has, so it never showed.
  it('lists the custom metadata of a relationship with no id', async () => {
    const noId: JgfEdge = {
      source: 'shop',
      target: 'lonely',
      relation: 'Relation',
      metadata: { informationFlow: true, owner: 'Made-up team' },
    };
    await openShop((_method, url) =>
      url === `/api/models/${bakeryId}`
        ? Response.json({
            graph: { ...bakeryModel.graph, edges: [...(bakeryModel.graph.edges ?? []), noId] },
          })
        : undefined,
    );
    fireEvent.click(
      within(details()).getAllByRole('button', {
        name: /^Open relationship: Relates to Recipe Archive/,
      })[0] as HTMLElement,
    );
    await screen.findByText(/has no id/);
    expect(screen.getByText('Made-up team')).toBeDefined();
  });

  // Rows kept their first `original` after a save, unlike the element form, which resets. A
  // number edited and then typed back was sent as the number, and the server refused it.
  it('sends text when a stored number is changed and typed back', async () => {
    const { sent } = await openShop(stored({ count: 3 }));
    const form = await open();
    const input = () => within(form).getByRole('combobox', { name: 'Value of count' });
    fireEvent.change(input(), { target: { value: '4' } });
    save(form);
    await waitFor(() => {
      expect(sent.at(-1)?.method).toBe('PATCH');
    });
    await waitFor(() => {
      expect(within(form).queryByRole('button', { name: 'Save' })).toBeNull();
    });
    fireEvent.change(input(), { target: { value: '3' } });
    save(form);
    await waitFor(() => {
      expect(sent.filter((request) => request.method === 'PATCH')).toHaveLength(2);
    });
    expect((sent.at(-1)?.body as { metadata: unknown }).metadata).toEqual({ count: '3' });
  });
});

describe('the relationship’s label', () => {
  const open = () => openRelationship(/^Open relationship: Relates to Back Office Server/, 1);
  const label = (form: HTMLElement) =>
    within(form).getByRole<HTMLInputElement>('textbox', { name: 'Label' });

  it('saves a trimmed label, with Save only for a change', async () => {
    const { sent } = await openShop();
    const form = await open();
    expect(label(form).value).toBe('');
    expect(within(form).queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.change(label(form), { target: { value: '  Nightly  ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent.at(-1)).toMatchObject({
        method: 'PATCH',
        body: { version: 1, label: 'Nightly' },
      });
    });
    await waitFor(() => {
      expect(label(form).value).toBe('Nightly');
    });
    expect(within(form).queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('removes the label when emptied', async () => {
    const { sent } = await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Oven Planner/);
    expect(label(form).value).toBe('Orders');
    fireEvent.change(label(form), { target: { value: '   ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent.at(-1)).toMatchObject({ method: 'PATCH', body: { label: null } });
    });
  });

  it('shows the server’s refusal at the field', async () => {
    await openShop((method) =>
      method === 'PATCH'
        ? apiError(422, 'Refused', {
            fields: [{ field: 'label', message: 'Must be at most 200 characters.' }],
          })
        : undefined,
    );
    const form = await open();
    fireEvent.change(label(form), { target: { value: 'x'.repeat(201) } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Must be at most 200 characters.')).toBeDefined();
    expect(label(form).getAttribute('aria-invalid')).toBe('true');
  });
});

describe('unsaved changes and the links', () => {
  it('asks before the link in the panel leaves a catalog with no focus and unsaved changes', async () => {
    const { handler } = api();
    stubApi(modeller, handler);
    renderAt(`/modelling/models/${bakeryId}?view=catalog&type=Application`);
    const row = await screen.findByRole('row', { name: /Web Shop/ });
    fireEvent.click(row.children[0] as HTMLElement);
    const form = await screen.findByRole('form', { name: /^Edit / });
    fireEvent.change(within(form).getByRole('textbox', { name: /^Name/ }), {
      target: { value: 'Typed name' },
    });

    fireEvent.click(
      (await within(details()).findAllByRole('button', { name: /^Relates to / }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole('dialog');
    expect(screen.getByRole('form', { name: /^Edit / })).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: /Keep editing/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      within(screen.getByRole('form', { name: /^Edit / })).getByRole('textbox', { name: /^Name/ }),
    ).toHaveProperty('value', 'Typed name');
    expect(currentLocation()).toContain('view=catalog');
  });
});

describe('The relationship form layout', () => {
  it('starts with Label, in the same field style as Name on the element form', async () => {
    await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Back Office Server/);
    const label = within(form).getByRole('textbox', { name: 'Label' });
    // The first field, so the first stop in the tab order too.
    expect(form.querySelector('input, select, textarea')).toBe(label);
    const firstField = form.querySelector('.form-block > .field');
    expect(firstField?.contains(label)).toBe(true);
    const type = within(form).getByRole('group', { name: 'Type' });
    expect(label.compareDocumentPosition(type) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the type as a two-part radio group that still brings its notes', async () => {
    await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Order to bake/);
    const type = within(form).getByRole('group', { name: 'Type' });
    const radios = within(type).getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('name'))).toEqual(['rf-type', 'rf-type']);
    expect(within(type).getByRole('radio', { name: 'Relation' })).toHaveProperty('checked', true);
    expect(type.querySelectorAll('.seg-radios > label')).toHaveLength(2);

    fireEvent.click(within(type).getByRole('radio', { name: 'Contains' }));
    expect(within(type).getByRole('radio', { name: 'Contains' })).toHaveProperty('checked', true);
    expect(within(type).getByRole('radio', { name: 'Relation' })).toHaveProperty('checked', false);
  });

  it('refuses a type under the two parts, with its reason and the link to the one that exists', async () => {
    const contains = {
      ...bakeryModel,
      graph: {
        ...bakeryModel.graph,
        edges: [
          ...(bakeryModel.graph.edges ?? []),
          { id: 'c9', source: 'shop', target: 'ordering', relation: 'Contains' },
        ],
      },
    };
    await openShop((_method, url) =>
      url === `/api/models/${bakeryId}` ? Response.json(contains) : undefined,
    );
    const form = await openRelationship(/^Open relationship: Relates to Order to bake/);
    const refused = within(form).getByRole('radio', { name: 'Contains' });
    expect(refused).toHaveProperty('disabled', true);
    const reason = document.getElementById(refused.getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toMatch(/^Web Shop already contains Order to bake\./);
    expect(within(form).getByRole('button', { name: 'Show it' })).toBeDefined();
  });

  it('gives each segmented control one equal column per option', async () => {
    await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Back Office Server/);
    const options = (name: string) =>
      within(form).getByRole('group', { name }).querySelectorAll('.seg-radios > label').length;
    expect(options('Type')).toBe(2);
    expect(options('Direction')).toBe(2);
    expect(options('Architecture state')).toBe(3);
    // The grid makes a column per label, so no count is fixed in the stylesheet.
    const css = readFileSync(join(import.meta.dirname, '../src/styles/explorer.css'), 'utf8');
    const rule = /\.seg-radios \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('grid-auto-flow: column;');
    expect(rule).toContain('grid-auto-columns: minmax(0, 1fr);');
    expect(rule).not.toContain('grid-template-columns');
  });
});
