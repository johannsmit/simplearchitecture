import {
  buildModelGraph,
  maxReferences,
  type ElementPropertyDefinition,
  referenceMessages,
  type JgfDocument,
  type JgfNode,
  type ModelGraph,
  type ModelSummary,
} from '@simplearchitecture/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { deleteSummary } from '../src/modelling/dialogs';
import { withoutElement } from '../src/modelling/document';
import {
  changesOf,
  clientErrors,
  draftOf,
  referenceGoneMessage,
  referenceRow,
  serverErrors,
  withType,
} from '../src/modelling/draft';
import { ReferenceField, referenceSearch } from '../src/modelling/ReferenceField';
import { DetailsPanel } from '../src/viewing/explorer/DetailsPanel';
import { ImportPanel } from '../src/viewing/models/ImportPanel';
import {
  apiError,
  currentLocation,
  modeller,
  renderAt,
  stubApi,
  viewer,
  type Handler,
} from './helpers';

// References from an element to other elements: an element property of the kind Reference.
// Made-up model and names only.

const ref = (...ids: string[]) => ({ 'simplearchitecture:reference': ids });

const modelId = '33333333-3333-4333-8333-333333333333';
const summary: ModelSummary = {
  id: modelId,
  name: 'Made-up insurer',
  createdAt: '2026-11-01T09:00:00.000Z',
  createdBy: { id: 'u1', name: 'Alex Morgan' },
  nodeCount: 7,
  edgeCount: 1,
};

const model: JgfDocument = {
  graph: {
    id: modelId,
    label: 'Made-up insurer',
    directed: true,
    nodes: {
      portal: {
        label: 'Customer portal',
        metadata: {
          type: 'Application',
          'Depends on': ref('hub', 'fraud'),
          'Shares data with': ref('hub'),
          'Cost centre': 'CC-410',
        },
      },
      hub: { label: 'Payment hub', metadata: { type: 'Application' } },
      fraud: {
        label: 'Fraud check',
        metadata: { type: 'Application', 'Depends on': ref('hub'), Mixed: 'as text' },
      },
      billing: {
        label: 'Billing and collections',
        metadata: { type: 'Application', Mixed: ref('hub') },
      },
      clerk: { label: 'Claims clerk', metadata: { type: 'Stakeholder', Kind: 'Human' } },
      archive: { label: 'Archive server', metadata: { type: 'Infrastructure', Rack: 'R-12' } },
      process: {
        label: 'Claims handling',
        metadata: { type: 'Business', functions: ref('clerk') },
      },
    },
    edges: [{ id: 'r1', source: 'portal', target: 'hub', relation: 'Relation' }],
  },
};

const graph = buildModelGraph(model);

const defined = (
  key: string,
  kind: ElementPropertyDefinition['kind'] = 'text',
): ElementPropertyDefinition => ({ key, name: key, kind, fromModels: true, version: 1 });
/** The model's element properties, as the upgrade defines them. */
const definitions = [
  defined('Cost centre'),
  defined('Depends on', 'reference'),
  defined('Kind'),
  defined('Mixed'),
  defined('Rack'),
  defined('Shares data with', 'reference'),
];
const definedGraph = buildModelGraph(model, [], definitions);
const elementOf = (g: ModelGraph, id: string) => {
  const found = g.elements.get(id);
  if (!found) throw new Error(id);
  return found;
};

describe('reference rows in the draft', () => {
  it('reads a Reference as a row of ids and sends only a changed one, in the stored shape', () => {
    const initial = draftOf(elementOf(graph, 'portal'));
    const row = initial.custom.find((r) => r.key === 'Depends on');
    expect(row?.refs).toEqual(['hub', 'fraud']);
    expect(changesOf(initial, initial)).toBeUndefined();

    const custom = initial.custom.map((r) =>
      r.key === 'Depends on' ? { ...r, refs: ['fraud', 'billing'] } : r,
    );
    expect(changesOf(initial, { ...initial, custom })).toEqual({
      metadata: { 'Depends on': ref('fraud', 'billing') },
    });
    // The same elements again: nothing to send.
    const back = custom.map((r) => (r.key === 'Depends on' ? { ...r, refs: ['hub', 'fraud'] } : r));
    expect(changesOf(initial, { ...initial, custom: back })).toBeUndefined();
  });

  it('checks a changed Reference with the server’s rules, at the field', () => {
    const initial = draftOf(elementOf(graph, 'portal'));
    const scope = { ownId: 'portal', isElement: (id: string) => graph.elements.has(id) };
    const empty = referenceRow('Owners');
    const itself = referenceRow('Self', ['portal']);
    const gone = referenceRow('Gone', ['deleted-one']);
    const unchanged = initial.custom.find((r) => r.key === 'Depends on');
    const draft = { ...initial, custom: [...initial.custom, empty, itself, gone] };
    const errors = clientErrors(draft, {}, scope);
    expect(errors.get(`ref:${empty.id}`)).toBe(referenceMessages.empty);
    expect(errors.get(`ref:${itself.id}`)).toBe(referenceMessages.itself);
    expect(errors.get(`ref:${gone.id}`)).toBe(referenceGoneMessage);
    expect(errors.has(`ref:${unchanged?.id ?? 0}`)).toBe(false);
    // A row with no key and no element is ignored, as an empty Text row is.
    const blank = referenceRow('');
    expect(clientErrors({ ...initial, custom: [blank] }, {}, scope).size).toBe(0);
  });

  it('keeps a Reference out of a standard field on a type change, and refuses it at Type', () => {
    const initial = draftOf(elementOf(graph, 'process'));
    const application = withType(initial, 'Application');
    expect(application.fields.functions).toBe('');
    expect(application.custom.find((r) => r.key === 'functions')?.refs).toEqual(['clerk']);
    expect(clientErrors(application).get('type')).toBe(
      "“functions” holds references, which a Application can't keep under that name. Remove that field first.",
    );
    // Removed in the same change: no refusal.
    const removed = {
      ...application,
      custom: application.custom.filter((r) => r.refs === undefined),
    };
    expect(clientErrors(removed).has('type')).toBe(false);
  });

  it('puts the server’s reference refusals at the field, and other ones at the key', () => {
    const initial = draftOf(elementOf(graph, 'portal'));
    const row = initial.custom.find((r) => r.key === 'Depends on');
    const errors = serverErrors(initial, [
      { field: 'metadata.Depends on', message: referenceMessages.missing },
      { field: 'metadata.Shares data with', message: 'Some other refusal.' },
    ]);
    expect(errors.get(`ref:${row?.id ?? 0}`)).toBe(referenceGoneMessage);
    const shares = initial.custom.find((r) => r.key === 'Shares data with');
    expect(errors.get(`row:${shares?.id ?? 0}`)).toBe('Some other refusal.');
  });
});

describe('the Reference field’s search', () => {
  it('searches with one leading @ dropped', () => {
    expect(referenceSearch('  @')).toBe('');
    expect(referenceSearch('@cla')).toBe('cla');
    expect(referenceSearch(' cla ')).toBe('cla');
    expect(referenceSearch('@@x')).toBe('@x');
  });
});

describe('deleting a referenced element', () => {
  it('takes it out of every Reference in the explorer’s copy, as the server does', () => {
    const after = withoutElement(model, 'hub');
    const nodes = after.graph.nodes ?? {};
    expect(nodes.portal?.metadata?.['Depends on']).toEqual(ref('fraud'));
    // A field left with none is removed.
    expect(nodes.portal?.metadata).not.toHaveProperty('Shares data with');
    expect(nodes.fraud?.metadata).not.toHaveProperty('Depends on');
    expect(nodes.archive).toBe(model.graph.nodes?.archive);
  });

  it('counts the elements that refer to it for the dialog', () => {
    expect(deleteSummary(graph, elementOf(graph, 'hub')).referring).toBe(3);
    expect(deleteSummary(graph, elementOf(graph, 'archive')).referring).toBe(0);
  });
});

describe('the details panel', () => {
  const panel = (g: ModelGraph, id: string, edit = false) => {
    const went: string[] = [];
    render(
      <DetailsPanel
        graph={g}
        element={elementOf(g, id)}
        link={`/x/${id}`}
        onFocusElement={(to) => went.push(to)}
        {...(edit ? { edit: { headActions: null, form: <form aria-label="Form" /> } } : {})}
      />,
    );
    return went;
  };

  it('shows a Reference property’s elements as links under Properties, and goes to one on a click', () => {
    const went = panel(definedGraph, 'portal');
    // Every value is a property's: no Custom metadata.
    expect(document.querySelector('details.meta')).toBeNull();
    const properties = screen.getByRole('heading', { name: 'Properties' }).closest('section');
    expect(
      within(properties as HTMLElement).getByRole('list', { name: 'Depends on: 2 elements' }),
    ).toBeTruthy();
    const links = within(screen.getByRole('list', { name: 'Depends on: 2 elements' }))
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'));
    expect(links).toEqual([
      'Payment hub, Application. Go to element',
      'Fraud check, Application. Go to element',
    ]);
    fireEvent.click(
      screen.getByRole('button', { name: 'Fraud check, Application. Go to element' }),
    );
    expect(went).toEqual(['fraud']);
    expect(screen.getByText('CC-410')).toBeTruthy();
  });

  it('keeps Custom metadata closed, for Was a property values only, and leaves out an empty Referenced by', () => {
    panel(definedGraph, 'process');
    const fold = document.querySelector('details.meta') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    // Functions isn't a Business's property: kept, under its label, tagged.
    expect(within(fold).getByText('Functions').textContent).toContain('Was a property');
    expect(screen.queryByRole('heading', { name: /^Referenced by/ })).toBeNull();
  });

  it('lists who refers to an element after Relationships, one row each, with the fields', () => {
    const went = panel(graph, 'hub', true);
    const section = screen.getByRole('region', { name: /^Referenced by/ });
    expect(within(section).getByRole('heading').textContent).toBe('Referenced by 3');
    const rows = within(section)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'));
    expect(rows).toEqual([
      'Billing and collections, Application, in Mixed. Go to element',
      'Customer portal, Application, in Depends on, Shares data with. Go to element',
      'Fraud check, Application, in Depends on. Go to element',
    ]);
    // Right after Relationships (in Modelling too).
    const headings = [...document.querySelectorAll('h3')].map((h) => h.textContent);
    const at = headings.findIndex((text) => text.startsWith('Relationships'));
    expect(headings[at + 1]).toBe('Referenced by 3');
    fireEvent.click(within(section).getAllByRole('button')[1] as HTMLElement);
    expect(went).toEqual(['portal']);
  });

  it('shows 10, then Show all, and says Not set and Element not found', () => {
    const many = Array.from({ length: 12 }, (_, index) => `e${String(index).padStart(2, '0')}`);
    const big = buildModelGraph({
      graph: {
        nodes: {
          ...Object.fromEntries(
            many.map((id): [string, JgfNode] => [
              id,
              { label: `Element ${id}`, metadata: { type: 'Other' } },
            ]),
          ),
          owner: {
            label: 'Owner',
            metadata: {
              type: 'Other',
              Many: ref(...many),
              Empty: ref(),
              Stale: ref('nowhere'),
            },
          },
        },
      },
    });
    panel(big, 'owner');
    const list = screen.getByRole('list', { name: 'Many: 12 elements' });
    expect(within(list).getAllByRole('button')).toHaveLength(10);
    const more = screen.getByRole('button', { name: 'Show all 12' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(within(list).getAllByRole('button')).toHaveLength(12);
    expect(screen.getByRole('button', { name: 'Show fewer' })).toBeTruthy();
    expect(screen.getByText('Not set')).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Stale: 1 element' })).getByText('Element not found'),
    ).toBeTruthy();
  });
});

/** A ReferenceField with its own state, as the form holds it. */
function Field(props: { ids?: string[]; g?: ModelGraph; ownId?: string }) {
  const [ids, setIds] = useState(props.ids ?? []);
  return (
    <ReferenceField
      id="box"
      name="Depends on"
      ids={ids}
      ownId={props.ownId ?? 'portal'}
      graph={props.g ?? graph}
      readOnly={false}
      onChange={setIds}
    />
  );
}

describe('the Reference field', () => {
  const box = () => screen.getByRole('combobox', { name: 'Add element to Depends on' });
  const listbox = () => screen.queryByRole('listbox', { name: 'Elements for Depends on' });
  const options = () =>
    within(listbox() as HTMLElement)
      .queryAllByRole('option')
      .map((option) => option.textContent);
  const chips = () =>
    [...document.querySelectorAll('.ref-chips .chip-text')].map((chip) => chip.textContent);
  const type = (text: string) => {
    fireEvent.change(box(), { target: { value: text } });
  };
  const key = (name: string, init: object = {}) => {
    fireEvent.keyDown(box(), { key: name, ...init });
  };

  it('lists every other element on @, by name, with nothing highlighted', () => {
    render(<Field ids={['hub']} />);
    act(() => {
      box().focus();
    });
    expect(listbox()).toBeNull();
    type('@');
    expect(box().getAttribute('aria-expanded')).toBe('true');
    expect(box().getAttribute('aria-controls')).toBe(listbox()?.id);
    expect(box().hasAttribute('aria-activedescendant')).toBe(false);
    // Not the element itself, nor one already in the field.
    expect(options()).toEqual([
      'Archive server Infrastructure',
      'Billing and collections Application',
      'Claims clerk Stakeholder',
      'Claims handling Business',
      'Fraud check Application',
    ]);
    expect(within(listbox() as HTMLElement).getByText('All elements')).toBeTruthy();
  });

  it('highlights the first match of a search, and Enter adds it as the last chip', async () => {
    render(<Field ids={['hub']} />);
    act(() => {
      box().focus();
    });
    type('@cla');
    expect(options()).toEqual(['Claims clerk Stakeholder', 'Claims handling Business']);
    expect(within(listbox() as HTMLElement).getByText('2 matches')).toBeTruthy();
    const first = within(listbox() as HTMLElement).getAllByRole('option')[0] as HTMLElement;
    expect(box().getAttribute('aria-activedescendant')).toBe(first.id);
    key('Enter');
    expect(chips()).toEqual(['Payment hub', 'Claims clerk']);
    expect((box() as HTMLInputElement).value).toBe('');
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(box());
    expect(screen.getByRole('status').textContent).toBe('Added Claims clerk.');
    expect(screen.getByRole('button', { name: 'Remove Claims clerk, Stakeholder' })).toBeTruthy();
    // The same without @, and by a click.
    type('arch');
    fireEvent.click(screen.getByRole('option', { name: 'Archive server Infrastructure' }));
    expect(chips()).toEqual(['Payment hub', 'Claims clerk', 'Archive server']);
    await waitFor(() => {
      expect(document.activeElement).toBe(box());
    });
  });

  it('goes through the list with the arrows, and Enter with nothing highlighted adds nothing', () => {
    render(<Field />);
    act(() => {
      box().focus();
    });
    key('ArrowDown');
    const rows = within(listbox() as HTMLElement).getAllByRole('option');
    expect(box().getAttribute('aria-activedescendant')).toBe(rows[0]?.id);
    key('ArrowDown');
    expect(box().getAttribute('aria-activedescendant')).toBe(rows[1]?.id);
    key('ArrowUp');
    key('ArrowUp');
    expect(box().hasAttribute('aria-activedescendant')).toBe(false);
    key('Enter');
    expect(chips()).toEqual([]);
  });

  it('says when nothing matches, and Enter adds nothing', () => {
    render(<Field />);
    type('zzz');
    expect(within(listbox() as HTMLElement).getByText('No elements match “zzz”.')).toBeTruthy();
    expect(within(listbox() as HTMLElement).getByText('0 matches')).toBeTruthy();
    key('Enter');
    expect(chips()).toEqual([]);
  });

  it('says when no other element is left to add', () => {
    const two = buildModelGraph({
      graph: {
        nodes: {
          a: { label: 'A', metadata: { type: 'Other' } },
          b: { label: 'B', metadata: { type: 'Other' } },
        },
      },
    });
    render(<Field g={two} ownId="a" ids={['b']} />);
    type('@');
    expect(within(listbox() as HTMLElement).getByText('No other elements to add.')).toBeTruthy();
  });

  it('removes the last chip with a fresh Backspace in the empty box only', () => {
    render(<Field ids={['hub', 'fraud']} />);
    act(() => {
      box().focus();
    });
    type('x');
    key('Backspace');
    expect(chips()).toEqual(['Payment hub', 'Fraud check']);
    type('');
    // Held down after clearing the text: it stops at the text.
    key('Backspace', { repeat: true });
    expect(chips()).toEqual(['Payment hub', 'Fraud check']);
    key('Backspace');
    expect(chips()).toEqual(['Payment hub']);
    expect(document.activeElement).toBe(box());
    expect(screen.getByRole('status').textContent).toBe('Removed Fraud check.');
  });

  it('moves focus to the next ×, the one before, or the box when a chip is removed', async () => {
    render(<Field ids={['hub', 'fraud', 'billing']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Payment hub, Application' }));
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        'Remove Fraud check, Application',
      );
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove Billing and collections, Application' }),
    );
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        'Remove Fraud check, Application',
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Fraud check, Application' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(box());
    });
    expect(screen.queryByRole('list', { name: /^Depends on:/ })).toBeNull();
  });

  it('closes the list and clears the search on Esc and when focus leaves, adding nothing', () => {
    render(<Field />);
    act(() => {
      box().focus();
    });
    type('@fra');
    const escape = fireEvent.keyDown(box(), { key: 'Escape' });
    // Handled here: the form's Discard dialog never sees it.
    expect(escape).toBe(false);
    expect(listbox()).toBeNull();
    expect((box() as HTMLInputElement).value).toBe('');
    type('@fra');
    key('Tab');
    fireEvent.blur(box());
    expect(listbox()).toBeNull();
    expect((box() as HTMLInputElement).value).toBe('');
    expect(chips()).toEqual([]);
  });

  it('names its parts for screen readers, and shows a missing element', () => {
    render(<Field ids={['hub', 'nowhere']} />);
    expect(screen.getByRole('group', { name: 'Depends on, Reference' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Depends on: 2 elements' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove element not found' })).toBeTruthy();
    expect(chips()).toEqual(['Payment hub', 'Element not found']);
    const hint = document.getElementById(
      (box().getAttribute('aria-describedby') ?? '').split(' ')[0] ?? '',
    );
    expect(hint?.textContent).toContain('press Enter to add one');
  });

  it(`doesn't open with ${maxReferences} elements, and says why`, () => {
    const ids = Array.from({ length: maxReferences }, (_, index) => `n${String(index)}`);
    const full = buildModelGraph({
      graph: {
        nodes: Object.fromEntries(
          [...ids, 'own', 'spare'].map((id): [string, JgfNode] => [
            id,
            { label: id, metadata: { type: 'Other' } },
          ]),
        ),
      },
    });
    render(<Field g={full} ownId="own" ids={ids} />);
    type('@');
    key('ArrowDown');
    expect(listbox()).toBeNull();
    const limit = screen.getByText(`A field can hold at most ${maxReferences} elements.`);
    expect(box().getAttribute('aria-describedby')).toContain(limit.id);
  });
});

// The element form in Modelling, with a small stand-in for the editing API.

const elementsUrl = `/api/models/${modelId}/elements`;
const at = (id: string) => `/modelling/models/${modelId}/elements/${encodeURIComponent(id)}`;

function api() {
  const nodes = new Map(Object.entries(model.graph.nodes ?? {}));
  const versions = new Map<string, number>();
  const bodies: { method: string; url: string; body: unknown }[] = [];
  const handler: Handler = (request) => {
    const body: unknown = typeof request.body === 'string' ? JSON.parse(request.body) : undefined;
    if (request.method !== 'GET') bodies.push({ method: request.method, url: request.url, body });
    if (request.method === 'GET' && request.url === '/api/models') {
      return Response.json({ models: [summary], editable: true });
    }
    if (request.method === 'GET' && request.url === `/api/models/${modelId}`) {
      return Response.json(model);
    }
    if (request.method === 'GET' && /\/views(\?|$)/.test(request.url)) {
      return Response.json({ views: [] });
    }
    if (request.method === 'GET' && request.url === '/api/properties') {
      return Response.json({ properties: [], elementProperties: definitions });
    }
    if (!request.url.startsWith(elementsUrl)) return undefined;
    const [path = ''] = request.url.slice(elementsUrl.length).split('?');
    const id = decodeURIComponent(path.slice(1));
    const version = versions.get(id) ?? 1;
    const result = (nodeId: string) =>
      Response.json({
        element: { id: nodeId, version: versions.get(nodeId) ?? 1, node: nodes.get(nodeId) },
        warnings: [],
      });
    if (request.method === 'GET') return result(id);
    if (request.method === 'PATCH') {
      const change = body as { version: number; metadata?: Record<string, unknown> };
      if (change.version !== version) return apiError(409, 'Changed', { currentVersion: version });
      const node = nodes.get(id) ?? {};
      const metadata = Object.fromEntries(
        Object.entries({ ...node.metadata, ...change.metadata }).filter(([, v]) => v !== null),
      );
      nodes.set(id, { ...node, metadata });
      versions.set(id, version + 1);
      return result(id);
    }
    if (request.method === 'DELETE') {
      // As the server: out of every Reference, each referring element with a new version.
      const after = withoutElement({ graph: { nodes: Object.fromEntries(nodes) } }, id);
      const changed: string[] = [];
      for (const [nodeId, node] of Object.entries(after.graph.nodes ?? {})) {
        if (node !== nodes.get(nodeId)) {
          changed.push(nodeId);
          nodes.set(nodeId, node);
          versions.set(nodeId, (versions.get(nodeId) ?? 1) + 1);
        }
      }
      nodes.delete(id);
      return Response.json({
        id,
        deletedRelationshipCount: 0,
        deletedRelationshipIds: [],
        unnestedElementIds: [],
        referencesRemovedFrom: changed,
      });
    }
    return undefined;
  };
  return { handler, bodies, versions };
}

async function openForm(id: string) {
  const server = api();
  stubApi(modeller, server.handler);
  renderAt(at(id));
  const form = await screen.findByRole('form', { name: /^Edit / });
  await act(async () => {
    await Promise.resolve();
  });
  return { form, ...server };
}

const patches = (bodies: { method: string; body: unknown }[]) =>
  bodies.filter((b) => b.method === 'PATCH').map((b) => b.body);

describe('a Reference field on the element form', () => {
  const field = (form: HTMLElement, name: string) =>
    within(within(form).getByRole('group', { name: `${name}, Reference` })).getByRole('combobox', {
      name: `Add element to ${name}`,
    });

  it('saves the chips, never on Enter, and Esc on the list keeps the form', async () => {
    const { form, bodies } = await openForm('portal');
    const box = field(form, 'Depends on');
    act(() => {
      box.focus();
    });
    fireEvent.change(box, { target: { value: '@bill' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(patches(bodies)).toEqual([]);
    fireEvent.change(box, { target: { value: '@arch' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // With the list closed, Esc asks as anywhere in the form.
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(await screen.findByRole('dialog', { name: 'Discard changes?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(patches(bodies)).toHaveLength(1);
    });
    expect(patches(bodies)[0]).toEqual({
      version: 1,
      metadata: { 'Depends on': ref('hub', 'fraud', 'billing') },
    });
  });

  it('saves a Reference property left with no element as not set, refusing nothing', async () => {
    const { form, bodies } = await openForm('portal');
    const shares = within(form).getByRole('group', { name: 'Shares data with, Reference' });
    fireEvent.click(
      within(shares).getByRole('button', { name: 'Remove Payment hub, Application' }),
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(patches(bodies)).toHaveLength(1);
    });
    expect(patches(bodies)[0]).toEqual({ version: 1, metadata: { 'Shares data with': null } });
  });

  it('shows the server’s refusal of an element no longer in the model at the field', async () => {
    const server = api();
    const refuse: Handler = ({ method }) =>
      method === 'PATCH'
        ? apiError(422, 'Invalid', {
            fields: [{ field: 'metadata.Depends on', message: referenceMessages.missing }],
          })
        : undefined;
    stubApi(modeller, refuse, server.handler);
    renderAt(at('portal'));
    const form = await screen.findByRole('form', { name: /^Edit / });
    fireEvent.click(within(form).getByRole('button', { name: 'Remove Fraud check, Application' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(referenceGoneMessage)).toBeTruthy();
    expect(field(form, 'Depends on').getAttribute('aria-invalid')).toBe('true');
  });
});

describe('references in the explorer', () => {
  it('goes to a referenced element from Viewing, and back by Referenced by', async () => {
    stubApi(viewer, api().handler);
    renderAt(`/viewing/models/${modelId}/elements/portal`);
    const details = await screen.findByRole('complementary', { name: 'Details' });
    fireEvent.click(
      await within(details).findByRole('button', {
        name: 'Fraud check, Application. Go to element',
      }),
    );
    await waitFor(() => {
      expect(currentLocation()).toContain('/elements/fraud');
    });
    const section = await within(details).findByRole('region', { name: /^Referenced by/ });
    fireEvent.click(
      within(section).getByRole('button', {
        name: 'Customer portal, Application, in Depends on. Go to element',
      }),
    );
    await waitFor(() => {
      expect(currentLocation()).toContain('/elements/portal');
    });
  });

  it('notes the referring elements on delete, then shows them without it, saving without a conflict', async () => {
    const { form, bodies, versions } = await openForm('hub');
    fireEvent.click(
      within(screen.getByRole('complementary', { name: 'Details' })).getByRole('button', {
        name: 'Delete element',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Delete “Payment hub”?' });
    expect(dialog.textContent).toContain(
      '3 elements refer to it in a Reference property. It is taken out of those properties.',
    );
    expect(dialog.getAttribute('aria-describedby')).toContain('delete-refs');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete element' }));
    await waitFor(() => {
      expect(form.isConnected).toBe(false);
    });
    expect(versions.get('portal')).toBe(2);

    fireEvent.click(
      within(screen.getByRole('tree', { name: 'Elements by type' })).getByText('Customer portal'),
    );
    const portal = await screen.findByRole('form', { name: 'Edit Customer portal' });
    // Out of Depends on; Shares data with, left with none, is gone.
    expect(within(portal).queryByRole('button', { name: /^Remove Payment hub/ })).toBeNull();
    expect(within(portal).queryByRole('list', { name: /^Shares data with: / })).toBeNull();
    fireEvent.change(within(portal).getByRole('textbox', { name: /^Name/ }), {
      target: { value: 'Customer portal 2' },
    });
    fireEvent.click(within(portal).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(patches(bodies)).toHaveLength(1);
    });
    expect(patches(bodies)[0]).toEqual({ version: 2, name: 'Customer portal 2' });
  });
});

describe('the import report', () => {
  const show = (leftOutReferences: unknown) =>
    render(
      <MemoryRouter>
        <ImportPanel
          state={{
            kind: 'done',
            fileName: 'made-up.json',
            result: {
              model: summary,
              validation: {
                valid: true,
                errorCount: 0,
                warningCount: 0,
                errors: [],
                warnings: [],
                truncated: false,
                summary: {},
              },
              ...(leftOutReferences === undefined ? {} : { leftOutReferences }),
            } as never,
          }}
          onDismiss={() => undefined}
          onChooseFile={() => undefined}
        />
      </MemoryRouter>,
    );

  it('lists the references an import left out, per field', () => {
    show([
      {
        key: 'Depends on',
        elements: 2,
        notInModel: 3,
        itself: 1,
        repeated: 0,
        overLimit: 0,
        removed: 1,
      },
      {
        key: 'Owned by',
        elements: 1,
        notInModel: 0,
        itself: 0,
        repeated: 2,
        overLimit: 5,
        removed: 0,
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: '11 references left out' }));
    const section = document.getElementById('import-section-references') as HTMLDetailsElement;
    expect(section.open).toBe(true);
    expect(section.textContent).toContain('11 references were left out.');
    const rows = within(section)
      .getAllByRole('row')
      .slice(1)
      .map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent));
    expect(rows).toEqual([
      [
        'Depends on',
        '3 not in this model, 1 the element itself. 1 field left with none was removed',
        '2',
      ],
      ['Owned by', '2 repeated, 5 past the first 200', '1'],
    ]);
  });

  it('says so when the only change is a field removed, left with no element', () => {
    show([
      {
        key: 'Owned by',
        elements: 1,
        notInModel: 0,
        itself: 0,
        repeated: 0,
        overLimit: 0,
        removed: 1,
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: '1 empty Reference field removed' }));
    const section = document.getElementById('import-section-references') as HTMLDetailsElement;
    expect(section.open).toBe(true);
    expect(section.textContent).toContain('1 Reference field left with no element was removed.');
    expect(section.textContent).not.toContain('left out.');
    const cells = [
      ...(within(section).getAllByRole('row')[1] as HTMLElement).querySelectorAll('td'),
    ].map((cell) => cell.textContent);
    expect(cells).toEqual(['Owned by', '1 field left with none was removed', '1']);
  });

  it('shows nothing when no reference was left out', () => {
    show(undefined);
    expect(document.getElementById('import-section-references')).toBeNull();
    expect(screen.queryByRole('button', { name: /references? left out/ })).toBeNull();
  });
});
