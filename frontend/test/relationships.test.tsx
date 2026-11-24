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
import { settle } from './settle';

/** A list of data's box on the form, by its stored key (its name follows the ends). */
const dataField = (form: HTMLElement, key: string): HTMLInputElement | null =>
  form.querySelector<HTMLInputElement>(`#rf-${key}`);

/** The values a list of data's field shows as chips. */
const chipTexts = (form: HTMLElement, key: string): (string | null)[] =>
  [...(dataField(form, key)?.closest('.field')?.querySelectorAll('.chip-text') ?? [])].map(
    (chip) => chip.textContent,
  );

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
      text: 'Web Shop is nested in Back Office Server when the canvas is opened again.',
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
      return Response.json({ models: [bakerySummary] });
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
      if (typeof change.source === 'string') next.source = change.source;
      if (typeof change.target === 'string') next.target = change.target;
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
    expect(chipTexts(form, 'sourceToTargetData')).toEqual(['Orders']);
    expect(chipTexts(form, 'targetToSourceData')).toEqual([]);
    expect((dataField(form, 'sourceToTargetData') as HTMLInputElement).value).toBe('');

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
    await waitFor(() => {
      expect(document.querySelector('.save-status')?.textContent).toBe('Saved');
    });
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
    expect(within(details()).getByRole('button', { name: /^From: Web Shop/ })).toBeDefined();

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
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
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
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
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

  it('goes back from a relationship with its change saved, without asking', async () => {
    const { sent } = await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Back Office Server/);
    fireEvent.click(within(form).getByRole('radio', { name: /Target/ }));
    fireEvent.click(within(details()).getByRole('button', { name: 'Back to Web Shop' }));
    await screen.findByRole('form', { name: /^Edit / });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sent.filter((r) => r.method === 'PATCH').map((r) => r.body)).toEqual([
      { version: 1, architectureState: 'Target' },
    ]);
  });
});

describe('changing a relationship’s ends', () => {
  const canvasEl = () => document.getElementById('canvas') as HTMLElement;
  const onCanvas = (id: string) =>
    canvasEl().querySelector(`.card[data-element-id="${CSS.escape(id)}"]`) !== null;
  const ends = () => within(details()).getByRole('region', { name: 'Ends' });

  it('picks a new end from a search, and saves it at once', async () => {
    const { sent } = await openShop();
    // Till relates to Web Shop; only that relationship brings the till onto the canvas.
    await waitFor(() => {
      expect(onCanvas('till')).toBe(true);
    });
    expect(onCanvas('lonely')).toBe(false);
    const form = await openRelationship(/^Open relationship: .*Till/);
    const change = within(ends()).getByRole('button', { name: 'From: Till, Application' });
    expect(change.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(change);
    expect(change.getAttribute('aria-expanded')).toBe('true');
    const search = within(ends()).getByRole('combobox', { name: 'New element for From' });
    expect(document.activeElement).toBe(search);
    // The whole model, with each element's type; the current end and the other one are marked.
    const list = within(ends()).getByRole('listbox', { name: 'Elements' });
    expect(within(list).getAllByRole('option')).toHaveLength(7);
    expect(within(list).getByRole('option', { name: /Till.*Now/ })).toBeDefined();
    expect(within(list).getByRole('option', { name: /Web Shop.*Other end/ })).toBeDefined();
    fireEvent.change(search, { target: { value: 'recipe' } });
    // No row starts highlighted: Enter picks nothing yet.
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(within(ends()).getByRole('combobox')).toBe(search);
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const option = within(list).getByRole('option', { name: /Recipe Archive/ });
    expect(option.getAttribute('aria-selected')).toBe('true');
    expect(search.getAttribute('aria-activedescendant')).toBe(option.id);
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(within(ends()).queryByRole('combobox')).toBeNull();
    // Shown as changed until it is saved, then as it is stored.
    await waitFor(() => {
      expect(document.activeElement).toBe(
        within(ends()).getByRole('button', { name: /^From: Recipe Archive, Other/ }),
      );
    });
    expect(within(form).getByRole('radio', { name: 'Relation' })).toBeDefined();
    await waitFor(() => {
      expect(sent.find((r) => r.method === 'PATCH')).toEqual({
        method: 'PATCH',
        url: `${relationshipsUrl}/e5`,
        body: { version: 1, source: 'lonely' },
      });
    });
    expect(
      await within(details()).findByRole('heading', { name: 'Recipe Archive relates to Web Shop' }),
    ).toBeDefined();
    // The new end joins the canvas, and the old one stays.
    await waitFor(() => {
      expect(onCanvas('lonely')).toBe(true);
    });
    expect(onCanvas('till')).toBe(true);
  });

  it('saves with Ctrl+Enter or ⌘+Enter from Ends too; Enter alone never saves', async () => {
    const { sent } = await openShop();
    await openRelationship(/^Open relationship: Relates to Back Office Server/);
    const patches = () => sent.filter((r) => r.method === 'PATCH');
    const change = within(ends()).getByRole('button', {
      name: 'To: Back Office Server, Infrastructure',
    });
    fireEvent.click(change);
    const search = within(ends()).getByRole('combobox');
    fireEvent.change(search, { target: { value: 'till' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    // Focus is back on the field; Enter there, and on Reverse direction, doesn't save.
    const changed = within(ends()).getByRole('button', { name: /^To: Till, Application/ });
    fireEvent.keyDown(changed, { key: 'Enter' });
    fireEvent.keyDown(within(ends()).getByRole('button', { name: 'Reverse direction' }), {
      key: 'Enter',
    });
    expect(patches()).toEqual([]);
    fireEvent.keyDown(changed, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(patches().map((r) => r.body)).toEqual([{ version: 1, target: 'till' }]);
    });
    await within(details()).findByRole('heading', { name: 'Web Shop relates to Till' });

    // ⌘+Enter on Reverse direction, and in an end's search.
    const reverse = within(ends()).getByRole('button', { name: 'Reverse direction' });
    fireEvent.click(reverse);
    fireEvent.keyDown(reverse, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(patches()).toHaveLength(2);
    });
    expect(patches()[1]?.body).toEqual({ version: 2, reverse: true });
    await within(details()).findByRole('heading', { name: 'Till relates to Web Shop' });
    fireEvent.click(within(ends()).getByRole('button', { name: /^To: Web Shop/ }));
    const again = within(ends()).getByRole('combobox');
    fireEvent.change(again, { target: { value: 'recipe' } });
    fireEvent.keyDown(again, { key: 'ArrowDown' });
    fireEvent.keyDown(again, { key: 'Enter' });
    fireEvent.click(within(ends()).getByRole('button', { name: /^From: Till/ }));
    fireEvent.keyDown(within(ends()).getByRole('combobox'), { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(patches()).toHaveLength(3);
    });
    expect(patches()[2]?.body).toEqual({ version: 3, target: 'lonely' });
  });

  it('closes the search on Esc with nothing changed and no question, focus back on the field', async () => {
    await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Back Office Server/);
    const change = within(ends()).getByRole('button', {
      name: 'To: Back Office Server, Infrastructure',
    });
    fireEvent.click(change);
    const search = within(ends()).getByRole('combobox');
    fireEvent.change(search, { target: { value: 'till' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(within(ends()).queryByRole('combobox')).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(change);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(form).queryByText('Unsaved changes')).toBeNull();
    // A click opens it again, and a second click closes it.
    fireEvent.click(change);
    expect(within(ends()).getByRole('combobox')).toBeDefined();
    fireEvent.click(change);
    expect(within(ends()).queryByRole('combobox')).toBeNull();
  });

  it('refuses both ends on the same element, at the ends, before anything is sent', async () => {
    const { sent } = await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Back Office Server/);
    fireEvent.click(
      within(ends()).getByRole('button', { name: 'To: Back Office Server, Infrastructure' }),
    );
    fireEvent.click(
      within(within(ends()).getByRole('listbox')).getByRole('option', { name: /Web Shop/ }),
    );
    const problem = within(ends()).getByText('Both ends are the same element.');
    expect(problem.closest('.field-error')?.id).toBe('rf-ends-error');
    expect(
      within(ends()).getByRole<HTMLButtonElement>('button', { name: 'Reverse direction' }).disabled,
    ).toBe(true);
    // No type is refused for it: the problem is the ends.
    for (const radio of within(form).getAllByRole<HTMLInputElement>('radio', {
      name: /Relation|Contains/,
    })) {
      expect(radio.disabled).toBe(false);
    }
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(details().querySelector('.save-status')?.textContent).toBe(
        "Couldn't save: 1 field needs a fix",
      );
    });
    expect(sent.some((r) => r.method === 'PATCH')).toBe(false);
    // Picking the server again undoes it.
    fireEvent.click(within(ends()).getByRole('button', { name: /^To: Web Shop/ }));
    fireEvent.click(
      within(within(ends()).getByRole('listbox')).getByRole('option', {
        name: /Back Office Server/,
      }),
    );
    expect(within(ends()).queryByText('Both ends are the same element.')).toBeNull();
    await waitFor(() => {
      expect(details().querySelector('.save-status')?.textContent).toBe('');
    });
    expect(sent.some((r) => r.method === 'PATCH')).toBe(false);
  });

  it('saves a Reverse, then a new end as the reversed relationship’s target', async () => {
    const { sent } = await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Back Office Server/);
    fireEvent.click(within(ends()).getByRole('button', { name: 'Reverse direction' }));
    // Reversed: the server is now From and Web Shop To; the To end becomes the till.
    fireEvent.click(within(ends()).getByRole('button', { name: /^To: Web Shop/ }));
    fireEvent.click(
      within(within(ends()).getByRole('listbox')).getByRole('option', { name: /^Till/ }),
    );
    expect(
      within(ends()).getByRole('button', { name: /^From: Back Office Server, Infrastructure$/ }),
    ).toBeDefined();
    expect(
      within(ends()).getByRole('button', { name: /^To: Till, Application, changed/ }),
    ).toBeDefined();
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(sent.filter((r) => r.method === 'PATCH').map((r) => r.body)).toEqual([
        { version: 1, reverse: true },
        { version: 2, target: 'till' },
      ]);
    });
    expect(
      await within(details()).findByRole('heading', { name: 'Back Office Server relates to Till' }),
    ).toBeDefined();
  });

  it('shows a refusal from the server at the ends', async () => {
    await openShop((method) =>
      method === 'PATCH'
        ? apiError(422, 'The change is not valid. Nothing was saved.', {
            fields: [{ field: 'target', message: 'Not possible: Till contains Web Shop.' }],
          })
        : undefined,
    );
    const form = await openRelationship(/^Open relationship: Relates to Back Office Server/);
    fireEvent.click(
      within(ends()).getByRole('button', { name: 'To: Back Office Server, Infrastructure' }),
    );
    fireEvent.click(
      within(within(ends()).getByRole('listbox')).getByRole('option', { name: /^Till/ }),
    );
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
    const error = await within(ends()).findByText('Not possible: Till contains Web Shop.');
    expect(error.closest('.field-error')?.id).toBe('rf-ends-error');
    expect(
      within(ends())
        .getByRole('button', { name: /^To: Till, Application, changed/ })
        .getAttribute('aria-describedby'),
    ).toBe('rf-ends-error');
  });

  it('moves the nesting of a Contains: the element list follows after the save', async () => {
    const nested = {
      graph: {
        ...bakeryModel.graph,
        edges: [
          ...(bakeryModel.graph.edges ?? []),
          { id: 'c1', source: 'shop', target: 'till', relation: 'Contains' },
        ],
      },
    };
    const contains = (source: string, version: number) =>
      Response.json({
        relationship: {
          id: 'c1',
          version,
          edge: { id: 'c1', source, target: 'till', relation: 'Contains' },
        },
        warnings: [],
        nestingChanges: [],
      });
    await openShop((method, url, body) => {
      if (url === `/api/models/${bakeryId}`) return Response.json(nested);
      if (!url.startsWith(`${relationshipsUrl}/c1`)) return undefined;
      return method === 'PATCH'
        ? contains((body as { source: string }).source, 2)
        : contains('shop', 1);
    });
    const tree = () => screen.getByRole('tree');
    const row = (name: string) => within(tree()).getByRole('treeitem', { name });
    await waitFor(() => {
      expect(row('Web Shop').getAttribute('aria-expanded')).not.toBeNull();
    });
    expect(row('Oven Planner').getAttribute('aria-expanded')).toBeNull();
    const form = await openRelationship(/^Open relationship: Contains Till/);
    fireEvent.click(within(ends()).getByRole('button', { name: /^From: Web Shop/ }));
    const search = within(ends()).getByRole('combobox');
    fireEvent.change(search, { target: { value: 'oven' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
    await within(details()).findByRole('heading', { name: 'Oven Planner contains Till' });
    await waitFor(() => {
      expect(row('Oven Planner').getAttribute('aria-expanded')).not.toBeNull();
    });
    expect(row('Web Shop').getAttribute('aria-expanded')).toBeNull();
  });

  it('has no Change in Viewing', async () => {
    const { handler } = api();
    stubApi(modeller, handler);
    renderAt(`/viewing/models/${bakeryId}/elements/shop`);
    const panel = await screen.findByRole('complementary', { name: 'Details' });
    await within(panel).findByRole('heading', { name: 'Web Shop' });
    fireEvent.click(
      within(panel).getAllByRole('button', {
        name: /^Open relationship: Relates to Back Office Server/,
      })[0] as HTMLElement,
    );
    await within(panel).findByRole('heading', { name: 'Web Shop relates to Back Office Server' });
    expect(within(panel).queryByRole('button', { name: /^Change/ })).toBeNull();
    expect(within(panel).queryByRole('combobox')).toBeNull();
  });
});

describe('the From and To fields', () => {
  const ends = () => within(details()).getByRole('region', { name: 'Ends' });
  const field = (name: string | RegExp) => within(ends()).getByRole('button', { name });
  const search = () => within(ends()).getByRole('combobox');

  it('shows each end as a labelled field, with no Change, no Go to element and no visible Ends heading', async () => {
    await openShop();
    await openRelationship(/^Open relationship: .*Till/);
    const from = field('From: Till, Application');
    expect(from.id).toBe('rf-from');
    expect(from.getAttribute('aria-haspopup')).toBe('listbox');
    expect(from.getAttribute('aria-expanded')).toBe('false');
    expect(from.getAttribute('title')).toBe('Till · Application');
    // The type mark and the name only: the type is in the name and the tooltip.
    expect(from.textContent).toBe('Till');
    expect(field('To: Web Shop, Application').id).toBe('rf-to');
    expect(document.getElementById('rf-from-label')?.textContent).toBe('From');
    expect(document.getElementById('rf-to-label')?.textContent).toBe('To');
    expect(within(ends()).queryByRole('button', { name: /^Change/ })).toBeNull();
    expect(within(ends()).queryByRole('button', { name: /Go to element/ })).toBeNull();
    expect(within(ends()).queryByRole('heading')).toBeNull();
    expect(ends().textContent).not.toContain('Ends');
  });

  it('captions a two-way relationship From and To too, and announces with those words', async () => {
    await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Back Office Server/);
    fireEvent.click(within(form).getByRole('radio', { name: /Both ways/ }));
    expect(field('From: Web Shop, Application').id).toBe('rf-from');
    expect(field('To: Back Office Server, Infrastructure').id).toBe('rf-to');
    expect(details().textContent).not.toMatch(/Between|\bAnd\b/);
    fireEvent.click(field(/^To:/));
    fireEvent.change(search(), { target: { value: 'till' } });
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(screen.getByText('To: Till.')).toBeDefined();
    fireEvent.click(field(/^From:/));
    fireEvent.click(
      within(within(ends()).getByRole('listbox')).getByRole('option', { name: /^Web Shop/ }),
    );
    expect(screen.getByText('From stays Web Shop.')).toBeDefined();
  });

  it('opens on ↓ with no row highlighted, and a letter opens it with that letter typed', async () => {
    await openShop();
    await openRelationship(/^Open relationship: Relates to Back Office Server/);
    const to = field(/^To:/);
    fireEvent.keyDown(to, { key: 'ArrowDown' });
    expect(to.getAttribute('aria-expanded')).toBe('true');
    const box = within(ends()).getByRole('combobox', { name: 'New element for To' });
    expect(document.activeElement).toBe(box);
    expect((box as HTMLInputElement).value).toBe('');
    expect(box.getAttribute('aria-activedescendant')).toBeNull();
    expect(to.getAttribute('aria-controls')).toBe(
      within(ends()).getByRole('listbox', { name: 'Elements' }).id,
    );
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(within(ends()).queryByRole('combobox')).toBeNull();

    const from = field(/^From:/);
    fireEvent.keyDown(from, { key: 'r' });
    const typed = within(ends()).getByRole<HTMLInputElement>('combobox', {
      name: 'New element for From',
    });
    expect(typed.value).toBe('r');
    expect(document.activeElement).toBe(typed);
    expect(typed.selectionStart).toBe(1);
    // Space is the button's own key (it opens with a click), never a typed character.
    fireEvent.keyDown(typed, { key: 'Escape' });
    fireEvent.keyDown(from, { key: ' ' });
    expect(within(ends()).queryByRole('combobox')).toBeNull();
  });

  it('closes when focus tabs out of the search, without taking the highlighted row', async () => {
    await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Back Office Server/);
    fireEvent.click(field(/^From:/));
    fireEvent.change(search(), { target: { value: 'till' } });
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    const to = field(/^To:/);
    fireEvent.blur(search(), { relatedTarget: to });
    expect(within(ends()).queryByRole('combobox')).toBeNull();
    expect(field('From: Web Shop, Application')).toBeDefined();
    expect(within(form).queryByText('Unsaved changes')).toBeNull();
  });

  it('a click on the caption focuses the field without opening it', async () => {
    await openShop();
    await openRelationship(/^Open relationship: Relates to Back Office Server/);
    fireEvent.click(document.getElementById('rf-to-label') as HTMLElement);
    expect(document.activeElement?.id).toBe('rf-to');
    expect(within(ends()).queryByRole('combobox')).toBeNull();
  });

  it('puts the ends error under To, before Reverse, and marks the picked field', async () => {
    await openShop();
    await openRelationship(/^Open relationship: Relates to Back Office Server/);
    fireEvent.click(field(/^To:/));
    fireEvent.click(
      within(within(ends()).getByRole('listbox')).getByRole('option', { name: /Web Shop/ }),
    );
    const error = document.getElementById('rf-ends-error') as HTMLElement;
    const to = field(/^To: Web Shop, Application, changed/);
    const from = field(/^From:/);
    const reverse = within(ends()).getByRole('button', { name: 'Reverse direction' });
    // Fields, then the error, then Reverse.
    expect(to.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(error.compareDocumentPosition(reverse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(to.getAttribute('aria-invalid')).toBe('true');
    expect(from.getAttribute('aria-invalid')).toBeNull();
    for (const control of [from, to, reverse]) {
      expect(control.getAttribute('aria-describedby')).toBe('rf-ends-error');
    }
    // The tag sits with the caption, above the field.
    const label = document.getElementById('rf-to-label')?.parentElement;
    expect(label?.querySelector('.tag')?.textContent).toBe('Changed');
  });

  it('shows the ends of a relationship with no id as links to the elements, with no fields', async () => {
    const noId: JgfEdge = { source: 'shop', target: 'lonely', relation: 'Relation' };
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
    expect(field('From: Web Shop, Application. Go to element')).toBeDefined();
    fireEvent.click(field('To: Recipe Archive, Other. Go to element'));
    await within(details()).findByRole('heading', { name: 'Recipe Archive' });
    expect(document.getElementById('rf-from')).toBeNull();
  });

  it('wraps long names at spaces in the fields, the list and the panel’s rows', () => {
    const css = readFileSync(join(import.meta.dirname, '../src/styles/explorer.css'), 'utf8');
    const rule = (selector: string) => {
      const start = css.indexOf(`\n${selector} {`);
      expect(start, selector).toBeGreaterThan(-1);
      return css.slice(start, css.indexOf('}', start));
    };
    expect(rule('.end-field .end-name')).toMatch(/overflow-wrap: break-word;/);
    expect(rule('.end-field .end-name')).toMatch(/word-break: normal;/);
    expect(rule('.end-pop .pick-list .pname')).toMatch(/overflow-wrap: break-word;/);
    expect(rule('.end-pop .pick-list .pname')).toMatch(/white-space: normal;/);
    expect(rule('.rel.rel-endrow .rname')).toMatch(/overflow-wrap: break-word;/);
  });

  it('keeps both fields usable while saving', async () => {
    let answer: (response: Response) => void = () => undefined;
    const { handler } = api();
    const held: Handler = (request) =>
      request.method === 'PATCH'
        ? new Promise<Response>((resolve) => {
            answer = resolve;
          })
        : undefined;
    stubApi(modeller, held, handler);
    renderAt(at('shop'));
    await screen.findByRole('form', { name: /^Edit / });
    const form = await openRelationship(/^Open relationship: .*Till/);
    fireEvent.click(field(/^To:/));
    fireEvent.change(search(), { target: { value: 'recipe' } });
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    fireEvent.keyDown(search(), { key: 'Enter' });
    await waitFor(() => {
      expect(details().querySelector('.save-status')?.textContent).toBe('Saving…');
    });
    expect(field(/^To:/)).toHaveProperty('disabled', false);
    fireEvent.click(field(/^From:/));
    expect(within(ends()).getByRole('combobox')).toBeDefined();
    expect(field(/^From:/).getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(search(), { key: 'Escape' });
    answer(apiError(503, 'The server is busy.'));
    await waitFor(() => {
      expect(details().querySelector('.save-status')?.textContent).toBe(
        "Couldn't save: check your connection",
      );
    });
    expect(field(/^To: Recipe Archive/)).toHaveProperty('disabled', false);
    expect(within(form).getByRole('button', { name: 'Try again' })).toBeDefined();
  });

  // The section must not share a class with New relationship's "source → target" line, whose rule
  // makes it one wrapping row: in a browser the fields would shrink to their names, To and Reverse
  // would share a row, and a list as narrow as a short field would break names inside words.
  it('stacks From, To and Reverse at full width: no rule lays their section out as a row', async () => {
    await openShop();
    await openRelationship(/^Open relationship: .*Till/);
    const css = readFileSync(
      join(import.meta.dirname, '../src/styles/explorer.css'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    // Every rule whose selector list holds one of the section's classes on its own.
    const classes = [...ends().classList];
    const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selectors]) =>
        (selectors ?? '').split(',').some((selector) => classes.includes(selector.trim().slice(1))),
      )
      .map(([, , body]) => body ?? '');
    for (const body of bodies) {
      expect(body).not.toMatch(/(^|[;\s])display:\s*(inline-)?(flex|grid)\b/);
      expect(body).not.toMatch(/overflow-wrap:\s*anywhere/);
    }
  });

  it('keeps the accent border on an open field under the pointer', () => {
    const css = readFileSync(join(import.meta.dirname, '../src/styles/explorer.css'), 'utf8');
    // The hover border leaves an open field alone, so its open border wins under the pointer too.
    const hover = /\n(\.end-field:hover[^{]*)\{/.exec(css)?.[1] ?? '';
    expect(hover).toContain("[aria-expanded='true']");
    expect(css).toMatch(
      /\n\.end-field\[aria-expanded='true'\] \{\s*border-color: var\(--accent\);/,
    );
  });

  it('keeps the list out of the Tab order, so Tab from the search leaves it', async () => {
    await openShop();
    await openRelationship(/^Open relationship: Relates to Back Office Server/);
    fireEvent.click(field(/^From:/));
    const list = within(ends()).getByRole('listbox', { name: 'Elements' });
    // A list that scrolls is a Tab stop of its own in some browsers, unless it says otherwise.
    expect(list.getAttribute('tabindex')).toBe('-1');
    // A press on the list (its scroll bar, its caption) keeps focus in the search.
    expect(fireEvent.mouseDown(list)).toBe(false);
    expect(document.activeElement).toBe(search());
  });

  it('shows a 60-character name whole in the field, with its type in the tooltip', async () => {
    const long = 'Customer contact and complaints handling for every bakery shop';
    const renamed = structuredClone(bakeryModel);
    Object.assign(renamed.graph.nodes?.server ?? {}, { label: long });
    await openShop((_method, url) =>
      url === `/api/models/${bakeryId}` ? Response.json(renamed) : undefined,
    );
    await openRelationship(/^Open relationship: Relates to Customer contact/);
    const to = field(`To: ${long}, Infrastructure`);
    expect(to.querySelector('.end-name')?.textContent).toBe(long);
    expect(to.getAttribute('title')).toBe(`${long} · Infrastructure`);
  });
});

describe('the label line is gone', () => {
  it('shows no “from the import” line on the form, and keeps the Label field', async () => {
    await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Back Office Server/);
    expect(details().textContent).not.toContain('from the import');
    expect(details().querySelector('.rel-label')).toBeNull();
    expect(within(form).getByRole<HTMLInputElement>('combobox', { name: /^Label/ }).value).toBe(
      'Hosted on',
    );
  });

  it('shows no “from the import” line in the details panel in Viewing', async () => {
    const { handler } = api();
    stubApi(modeller, handler);
    renderAt(`/viewing/models/${bakeryId}/elements/shop`);
    const panel = await screen.findByRole('complementary', { name: 'Details' });
    await within(panel).findByRole('heading', { name: 'Web Shop' });
    fireEvent.click(
      within(panel).getAllByRole('button', {
        name: /^Open relationship: Relates to Back Office Server/,
      })[0] as HTMLElement,
    );
    await within(panel).findByRole('heading', { name: 'Web Shop relates to Back Office Server' });
    expect(panel.textContent).not.toContain('from the import');
    expect(panel.querySelector('.rel-label')).toBeNull();
    // The section keeps its name for screen readers only.
    const ends = within(panel).getByRole('region', { name: 'Ends' });
    expect(within(ends).queryByRole('heading')).toBeNull();
    expect(within(ends).getByRole('button', { name: /^From: Web Shop/ })).toBeDefined();
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
    // N is the keyboard's way: the toolbar has no + Element button.
    const toolbar = document.querySelector('.toolbar') as HTMLElement;
    expect(within(toolbar).queryByRole('button', { name: /Element/ })).toBeNull();
    expect(document.getElementById('canvas-new-element')).toBeNull();
  });

  it('goes back on Esc to where focus was when N was pressed, else to the canvas', async () => {
    await openShop();
    const canvasEl = document.getElementById('canvas') as HTMLElement;
    await waitFor(() => {
      expect(canvasEl.querySelector('.card[data-element-id="till"] .card-main')).toBeTruthy();
    });
    const till = canvasEl.querySelector<HTMLElement>(
      '.card[data-element-id="till"] .card-main',
    ) as HTMLElement;
    till.focus();
    act(() => {
      fireEvent.keyDown(till, { key: 'n' });
    });
    let pop = await screen.findByRole('dialog', { name: 'New element' });
    await waitFor(() => {
      expect(pop.contains(document.activeElement)).toBe(true);
    });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'New element' })).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(till);
    });

    // From nowhere in particular: back on the canvas.
    (document.activeElement as HTMLElement).blur();
    act(() => {
      fireEvent.keyDown(document.body, { key: 'n' });
    });
    pop = await screen.findByRole('dialog', { name: 'New element' });
    await waitFor(() => {
      expect(pop.contains(document.activeElement)).toBe(true);
    });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    await waitFor(() => {
      expect(document.activeElement).toBe(canvasEl);
    });
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
    // Well below the laid-out cards, so the spot is free.
    fireEvent.doubleClick(pane, { clientX: 400, clientY: 1300 });
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
    expect(node?.style.transform).toBe('translate(340px,1278px)');
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
  it('offers only Relation and Contains, starting as a Relation', async () => {
    const { sent } = await openShop();
    const box = await addTo('Recipe Archive', 'recipe');
    expect(within(box).getAllByRole('radio', { name: /^(Relation|Contains)$/ })).toHaveLength(2);
    expect(within(box).getByRole('radio', { name: 'Relation' })).toHaveProperty('checked', true);
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
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
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
    fireEvent.change(within(form).getByRole('combobox', { name: 'Label' }), {
      target: { value: 'Made-up label' },
    });
    const fields = [
      within(form).getByRole('combobox', { name: 'Label' }),
      within(form).getByLabelText('Identity'),
      dataField(form, 'sourceToTargetData') as HTMLInputElement,
      dataField(form, 'targetToSourceData') as HTMLInputElement,
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
    await waitFor(() => {
      expect(document.querySelector('.save-status')?.textContent).toBe('Saved');
    });
    fireEvent.change(within(form).getByRole('combobox', { name: 'Label' }), {
      target: { value: 'Second label' },
    });
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({ version: 2, label: 'Second label' });
    });
  });

  it('saves a change to Contains at once, and says the data went with it', async () => {
    const { sent } = await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Oven Planner/);
    const data = () => dataField(form, 'sourceToTargetData');
    expect(chipTexts(form, 'sourceToTargetData')).toEqual(['Orders']);
    fireEvent.click(within(form).getByRole('radio', { name: 'Contains' }));
    expect(data()).toBeNull();
    expect(dataField(form, 'targetToSourceData')).toBeNull();
    await waitFor(() => {
      expect(sent.filter((r) => r.method === 'PATCH').map((r) => r.body)).toEqual([
        { version: 1, type: 'Contains', sourceToTargetData: null },
      ]);
    });
    // Still said once saved, while the form shows the type.
    await settle();
    expect(
      within(form).getByText(
        'Identity, Identity Context and the data in both directions were removed.',
      ),
    ).toBeDefined();
    // Back to Relation: the data list is empty.
    fireEvent.click(within(form).getByRole('radio', { name: 'Relation' }));
    expect(chipTexts(form, 'sourceToTargetData')).toEqual([]);
    expect(
      within(form).queryByText(
        'Identity, Identity Context and the data in both directions were removed.',
      ),
    ).toBeNull();
    await waitFor(() => {
      expect(sent.filter((r) => r.method === 'PATCH').at(-1)?.body).toEqual({
        version: 2,
        type: 'Relation',
      });
    });
  });

  it('never lists the old key as a custom row, and has no Add field to type it in', async () => {
    await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Order to bake/);
    expect(within(form).queryByRole('textbox', { name: 'Value of informationFlow' })).toBeNull();
    expect(within(form).queryByRole('button', { name: 'Add field' })).toBeNull();
  });

  it('shows the server’s refusal of Target to source data under its field', async () => {
    await openShop((method) =>
      method === 'PATCH'
        ? apiError(422, 'Refused', {
            fields: [
              {
                field: 'targetToSourceData',
                message: 'Each value must be at most 200 characters.',
              },
            ],
          })
        : undefined,
    );
    const form = await openRelationship(/^Open relationship: Relates to Oven Planner/, 1);
    fireEvent.change(dataField(form, 'targetToSourceData') as HTMLInputElement, {
      target: { value: 'Made-up' },
    });
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
    const message = await within(form).findByText('Each value must be at most 200 characters.');
    expect(
      (dataField(form, 'targetToSourceData') as HTMLInputElement).getAttribute('aria-describedby'),
    ).toContain(message.closest('.field-error')?.id ?? 'missing');
  });

  it('words a two-way Relation on the type line in Modelling too', async () => {
    const { sent } = await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Oven Planner/, 1);
    fireEvent.click(within(form).getByRole('radio', { name: /Both ways/ }));
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({ version: 1, twoWay: true });
    });
    expect(await within(details()).findByText('Relation · Both ways')).toBeDefined();
  });
});

describe('properties defined by an Admin on the form', () => {
  const open = () => openRelationship(/^Open relationship: Relates to Back Office Server/, 1);
  const save = (form: HTMLElement) => {
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
  };
  const definitions = [
    { key: 'protocol', name: 'Protocol', kind: 'text', fromModels: false, version: 1 },
    {
      key: 'criticality',
      name: 'Criticality',
      kind: 'choice',
      options: ['Low', 'High'],
      fromModels: false,
      version: 1,
    },
  ];
  const defined =
    (more?: Parameters<typeof api>[0]): Parameters<typeof api>[0] =>
    (method, url, body) =>
      method === 'GET' && url === '/api/properties'
        ? Response.json({ properties: definitions })
        : more?.(method, url, body);

  it('shows them after Target to source data, in name order, always, with no Add field', async () => {
    await openShop(defined());
    const form = await open();
    const protocol = await within(form).findByLabelText('Protocol');
    const criticality = within(form).getByRole<HTMLSelectElement>('combobox', {
      name: 'Criticality',
    });
    const response = dataField(form, 'targetToSourceData') as HTMLInputElement;
    // After Target to source data and before Type, Criticality before Protocol.
    expect(
      response.compareDocumentPosition(criticality) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      criticality.compareDocumentPosition(protocol) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect([...criticality.options].map((option) => option.text)).toEqual([
      'Not set',
      'Low',
      'High',
    ]);
    expect(within(form).queryByRole('button', { name: 'Add field' })).toBeNull();
    expect(
      within(form).getByText('New properties are added by an Admin, in Admin → Properties.'),
    ).toBeDefined();
    expect(within(form).queryByRole('group', { name: 'Custom metadata' })).toBeNull();
  });

  it('saves a trimmed text and a choice as metadata, and Not set or empty removes them', async () => {
    const { sent } = await openShop(defined());
    const form = await open();
    fireEvent.change(await within(form).findByLabelText('Protocol'), {
      target: { value: ' REST ' },
    });
    fireEvent.change(within(form).getByRole('combobox', { name: 'Criticality' }), {
      target: { value: 'High' },
    });
    save(form);
    await waitFor(() => {
      expect(sent.at(-1)).toMatchObject({
        method: 'PATCH',
        body: { version: 1, metadata: { protocol: 'REST', criticality: 'High' } },
      });
    });
    await waitFor(() => {
      expect(within(form).queryByRole('button', { name: 'Save' })).toBeNull();
    });
    fireEvent.change(within(form).getByLabelText('Protocol'), {
      target: { value: '  ' },
    });
    fireEvent.change(within(form).getByRole('combobox', { name: 'Criticality' }), {
      target: { value: '' },
    });
    save(form);
    await waitFor(() => {
      expect(sent.at(-1)).toMatchObject({
        method: 'PATCH',
        body: { version: 2, metadata: { protocol: null, criticality: null } },
      });
    });
  });

  it('puts the server’s message under the field', async () => {
    await openShop(
      defined((method) =>
        method === 'PATCH'
          ? apiError(422, 'The change is not valid.', {
              fields: [{ field: 'metadata.protocol', message: 'Must be at most 2000 characters.' }],
            })
          : undefined,
      ),
    );
    const form = await open();
    const protocol = await within(form).findByLabelText('Protocol');
    fireEvent.change(protocol, { target: { value: 'x' } });
    save(form);
    const message = await within(form).findByText('Must be at most 2000 characters.');
    expect(document.getElementById(protocol.getAttribute('aria-describedby') ?? '')).toBe(
      message.closest('.field-error'),
    );
  });

  it('says so when an Admin deleted a property meanwhile, reads them again, and saves the rest', async () => {
    let gone = false;
    const { sent } = await openShop((method, url, body) => {
      if (method === 'GET' && url === '/api/properties') {
        return Response.json({ properties: gone ? definitions.slice(1) : definitions });
      }
      if (method === 'PATCH' && !gone) {
        gone = true;
        return apiError(422, 'The change is not valid.', {
          fields: [
            {
              field: 'metadata.protocol',
              message:
                "“protocol” isn't a property here. An Admin can add it in Admin → Properties.",
            },
          ],
        });
      }
      return method === 'PATCH' && body !== undefined ? undefined : undefined;
    });
    const form = await open();
    fireEvent.change(await within(form).findByLabelText('Protocol'), {
      target: { value: 'REST' },
    });
    fireEvent.change(within(form).getByRole('combobox', { name: 'Label' }), {
      target: { value: 'Made-up label' },
    });
    save(form);
    expect(
      await within(form).findByText(
        /An Admin deleted Protocol, so its value wasn.t saved\. Your other changes are saved\./,
      ),
    ).toBeDefined();
    await waitFor(() => {
      expect(within(form).queryByLabelText('Protocol')).toBeNull();
    });
    // The rest goes again at once.
    await waitFor(() => {
      expect(sent.at(-1)).toMatchObject({
        method: 'PATCH',
        body: { version: 1, label: 'Made-up label' },
      });
    });
    expect((sent.at(-1)?.body as Record<string, unknown>).metadata).toBeUndefined();
  });

  it('keeps a choice value outside the list until it is changed', async () => {
    const { sent } = await openShop(
      defined((method, url) => {
        if (url === `/api/models/${bakeryId}`) {
          return Response.json({
            graph: {
              ...bakeryModel.graph,
              edges: (bakeryModel.graph.edges ?? []).map((edge) =>
                edge.id === 'e9' ? { ...edge, metadata: { criticality: 'Gold' } } : edge,
              ),
            },
          });
        }
        if (method === 'GET' && url === `${relationshipsUrl}/e9`) {
          const edge = bakeryModel.graph.edges?.find((each) => each.id === 'e9');
          return Response.json({
            relationship: {
              id: 'e9',
              version: 1,
              edge: { ...edge, metadata: { criticality: 'Gold' } },
            },
            warnings: [],
            nestingChanges: [],
          });
        }
        return undefined;
      }),
    );
    const form = await open();
    const select = await within(form).findByRole<HTMLSelectElement>('combobox', {
      name: 'Criticality',
    });
    expect(select.value).toBe('Gold');
    expect([...select.options].map((option) => option.text)).toEqual([
      '“Gold” (not in the list)',
      'Not set',
      'Low',
      'High',
    ]);
    // Saving another field keeps it.
    fireEvent.change(within(form).getByRole('combobox', { name: 'Label' }), {
      target: { value: 'Made-up label' },
    });
    save(form);
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({ version: 1, label: 'Made-up label' });
    });
  });

  it('keeps defined values as custom metadata on a change to Contains, and says so', async () => {
    const { sent } = await openShop(defined());
    const form = await open();
    fireEvent.change(await within(form).findByLabelText('Protocol'), {
      target: { value: 'REST' },
    });
    save(form);
    await waitFor(() => {
      expect(document.querySelector('.save-status')?.textContent).toBe('Saved');
    });
    fireEvent.click(within(form).getByRole('radio', { name: 'Contains' }));
    expect(within(form).queryByLabelText('Protocol')).toBeNull();
    expect(within(form).getByText('Protocol is kept as custom metadata.')).toBeDefined();
    expect(within(form).getByLabelText('Value of protocol')).toBeDefined();
    fireEvent.click(within(form).getByRole('radio', { name: 'Relation' }));
    expect(within(form).getByLabelText<HTMLInputElement>('Protocol').value).toBe('REST');
    fireEvent.click(within(form).getByRole('radio', { name: 'Contains' }));
    save(form);
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({ version: 2, type: 'Contains' });
    });
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
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
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

  it('moves focus to the next row, or to the note on new properties, when a row is removed', async () => {
    await openShop(stored({ alpha: 'x', beta: 'y' }));
    const form = await open();
    // Stored keys can't be renamed: they show as text.
    expect(within(form).queryByLabelText('Key')).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'Remove alpha' }));
    await waitFor(() => {
      expect((document.activeElement as HTMLInputElement).value).toBe('y');
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Remove beta' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(
        within(form).getByText('New properties are added by an Admin, in Admin → Properties.'),
      );
    });
  });

  it('has a working error link from a row the server refused', async () => {
    await openShop((method, url) => {
      const own = stored({ alpha: 'x' })?.(method, url, undefined);
      if (own) return own;
      return method === 'PATCH'
        ? apiError(422, 'The change is not valid.', {
            fields: [{ field: 'metadata.alpha', message: 'Must be at most 2000 characters.' }],
          })
        : undefined;
    });
    const form = await open();
    const value = await within(form).findByLabelText('Value of alpha');
    fireEvent.change(value, { target: { value: 'changed' } });
    save(form);
    const message = await within(form).findByText('Must be at most 2000 characters.');
    const described = (value.getAttribute('aria-describedby') ?? '').split(' ');
    expect(described.some((id) => document.getElementById(id)?.contains(message))).toBe(true);
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
      expect(within(form).getByRole<HTMLInputElement>('combobox', { name: 'Label' }).value).toBe(
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
    const label = within(form).getByRole<HTMLInputElement>('combobox', { name: 'Label' });
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

  it('saves only what was typed when the server’s copy arrives after it, keeping the rest', async () => {
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
    fireEvent.change(within(form).getByRole('combobox', { name: 'Label' }), {
      target: { value: 'Typed first' },
    });
    await act(async () => {
      arrive();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(within(form).queryByRole('combobox', { name: 'Value of addedElsewhere' })).toBeNull();
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(sent.at(-1)?.method).toBe('PATCH');
    });
    // The value added elsewhere isn't sent, so it stays.
    expect(sent.at(-1)?.body).toEqual({ version: 1, label: 'Typed first' });
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
    fireEvent.change(within(form).getByRole('combobox', { name: 'Label' }), {
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
    fireEvent.change(within(form).getByRole('combobox', { name: /Label/ }), {
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
    fireEvent.change(within(form).getByRole('combobox', { name: /Label/ }), {
      target: { value: 'Made-up label' },
    });
    save(form);
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({ version: 1, label: 'Made-up label' });
    });
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
    within(form).getByRole<HTMLInputElement>('combobox', { name: 'Label' });

  it('saves a trimmed label, and leaves the field as typed', async () => {
    const { sent } = await openShop();
    const form = await open();
    expect(label(form).value).toBe('');
    expect(within(form).queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.change(label(form), { target: { value: '  Nightly  ' } });
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(sent.at(-1)).toMatchObject({
        method: 'PATCH',
        body: { version: 1, label: 'Nightly' },
      });
    });
    await waitFor(() => {
      expect(details().querySelector('.save-status')?.textContent).toBe('Saved');
    });
    // Not trimmed under the cursor: typing on keeps the space.
    expect(label(form).value).toBe('  Nightly  ');
  });

  it('removes the label when emptied', async () => {
    const { sent } = await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Oven Planner/);
    expect(label(form).value).toBe('Orders');
    fireEvent.change(label(form), { target: { value: '   ' } });
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
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
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
    expect(await within(form).findByText('Must be at most 200 characters.')).toBeDefined();
    expect(label(form).getAttribute('aria-invalid')).toBe('true');
  });
});

describe('unsaved changes and the links', () => {
  it('saves a change waiting in the panel before its link leaves a catalog with no focus', async () => {
    const { handler, sent } = api();
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
    await waitFor(() => {
      expect(sent.some((r) => r.method === 'PATCH')).toBe(true);
    });
    // Saved, then followed without asking.
    await waitFor(() => {
      expect(currentLocation()).toContain('/elements/server');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sent.filter((r) => r.method === 'PATCH').map((r) => r.body)).toEqual([
      { version: 1, name: 'Typed name' },
    ]);
  });
});

describe('The relationship form layout', () => {
  it('starts with Label, in the same field style as Name on the element form', async () => {
    await openShop();
    const form = await openRelationship(/^Open relationship: Relates to Back Office Server/);
    const label = within(form).getByRole('combobox', { name: 'Label' });
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
