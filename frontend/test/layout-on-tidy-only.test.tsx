import type { JgfDocument, JgfEdge, ModelSummary, StoredView } from '@simplearchitecture/shared';
import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { modeller, renderAt, stubApi, viewer, type Handler } from './helpers';

// The canvas is laid out only by Tidy up and for a new canvas: adding or taking off cards, and
// any change to relationships or elements, leaves every other card where it is. Made-up data.

const canvasEl = () => document.getElementById('canvas') as HTMLElement;
const card = (id: string) =>
  canvasEl().querySelector<HTMLElement>(`.card[data-element-id="${CSS.escape(id)}"]`);
const cardIds = () =>
  [...canvasEl().querySelectorAll('.card[data-element-id]')].map(
    (element) => element.getAttribute('data-element-id') ?? '',
  );
const nodeOf = (id: string) => card(id)?.closest<HTMLElement>('.react-flow__node');
const tidy = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Tidy up' });
const details = () => screen.getByRole('complementary', { name: 'Details' });
const live = () => canvasEl().querySelector('[aria-live="polite"]')?.textContent ?? '';
const dragType = 'application/x-simplearchitecture-element';
/** Drops an element row on the canvas at a point (jsdom's drop event has no pointer). */
function drop(id: string, clientX: number, clientY: number) {
  const event = createEvent.drop(canvasEl(), {
    dataTransfer: { types: [dragType], getData: (type: string) => (type === dragType ? id : '') },
  });
  Object.defineProperties(event, { clientX: { value: clientX }, clientY: { value: clientY } });
  fireEvent(canvasEl(), event);
}

/** Each card's place on the canvas (React Flow's transform), by element id. */
function positions(): Map<string, string> {
  return new Map(cardIds().map((id) => [id, nodeOf(id)?.style.transform ?? '']));
}

/** The card's box from React Flow's transform and size (top-level cards only). */
function boxOf(id: string) {
  const node = nodeOf(id) as HTMLElement;
  const match = /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(node.style.transform);
  return {
    x: Number(match?.[1]),
    y: Number(match?.[2]),
    width: parseFloat(node.style.width),
    height: parseFloat(node.style.height),
  };
}

/** Lets any layout that might have started finish (ELK runs in-process in the tests). */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
}

/** The cards that were there before are exactly where they were. */
function expectUnmoved(before: Map<string, string>, except: string[] = []) {
  const after = positions();
  for (const [id, place] of before) {
    if (except.includes(id) || !after.has(id)) continue;
    expect(after.get(id), id).toBe(place);
  }
}

function expectNoOverlapWith(id: string, others: Iterable<string>) {
  const a = boxOf(id);
  for (const other of others) {
    if (other === id || nodeOf(other)?.parentElement !== nodeOf(id)?.parentElement) continue;
    // Nested cards are placed relative to their container: only top-level ones compare.
    if (card(other)?.closest('.react-flow__node')?.getAttribute('data-parent') != null) continue;
    const b = boxOf(other);
    const apart =
      a.x + a.width <= b.x ||
      b.x + b.width <= a.x ||
      a.y + a.height <= b.y ||
      b.y + b.height <= a.y;
    expect(apart, `${id} covers ${other}`).toBe(true);
  }
}

/** The bakery model with editable elements and relationships, as the API answers them. */
function bakeryApi(): Handler {
  const nodes = new Map(Object.entries(bakeryModel.graph.nodes ?? {}));
  const edges = new Map(
    (bakeryModel.graph.edges ?? []).map((edge): [string, JgfEdge] => [edge.id ?? '', { ...edge }]),
  );
  const elementsUrl = `/api/models/${bakeryId}/elements`;
  const relationshipsUrl = `/api/models/${bakeryId}/relationships`;
  const versions = new Map<string, number>();
  const element = (id: string, status = 200) =>
    Response.json(
      { element: { id, version: versions.get(id) ?? 1, node: nodes.get(id) }, warnings: [] },
      { status },
    );
  const relationship = (edge: JgfEdge, status = 200) =>
    Response.json(
      {
        relationship: { id: edge.id, version: versions.get(edge.id ?? '') ?? 1, edge },
        warnings: [],
        nestingChanges: [],
      },
      { status },
    );
  return ({ url, method, body }) => {
    const parsed = typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : {};
    if (url === '/api/models') return Response.json({ models: [bakerySummary], editable: true });
    if (url === `/api/models/${bakeryId}`) return Response.json(bakeryModel);
    if (url.startsWith(elementsUrl)) {
      const id = decodeURIComponent(url.slice(elementsUrl.length + 1).split('?')[0] ?? '');
      if (method === 'POST') {
        nodes.set('flour', { label: String(parsed.name), metadata: { type: parsed.type } });
        return element('flour', 201);
      }
      if (method === 'PATCH') {
        const node = nodes.get(id) ?? {};
        nodes.set(id, {
          ...node,
          label: typeof parsed.name === 'string' ? parsed.name : (node.label ?? ''),
        });
        versions.set(id, (versions.get(id) ?? 1) + 1);
      }
      return element(id);
    }
    if (url.startsWith(relationshipsUrl)) {
      const id = decodeURIComponent(url.slice(relationshipsUrl.length + 1).split('?')[0] ?? '');
      if (method === 'POST') {
        const edge: JgfEdge = {
          id: 'r-new',
          source: String(parsed.source),
          target: String(parsed.target),
          relation: String(parsed.type),
          metadata: {
            architectureState:
              typeof parsed.architectureState === 'string' ? parsed.architectureState : 'Current',
          },
        };
        edges.set('r-new', edge);
        return relationship(edge, 201);
      }
      const edge = edges.get(id);
      if (!edge) return undefined;
      if (method === 'PATCH') {
        const next = { ...edge };
        if (parsed.reverse === true) [next.source, next.target] = [edge.target, edge.source];
        edges.set(id, next);
        versions.set(id, (versions.get(id) ?? 1) + 1);
        return relationship(next);
      }
      if (method === 'DELETE') {
        edges.delete(id);
        return Response.json({ id, nestingChanges: [] });
      }
      return relationship(edge);
    }
    return undefined;
  };
}

const elementAt = (space: 'viewing' | 'modelling', id: string) =>
  `/${space}/models/${bakeryId}/elements/${encodeURIComponent(id)}?depth=1`;

async function openBakery(space: 'viewing' | 'modelling', id: string, ids: string[]) {
  stubApi(space === 'viewing' ? viewer : modeller, bakeryApi());
  renderAt(elementAt(space, id));
  await waitFor(() => {
    expect(cardIds().sort()).toEqual([...ids].sort());
  });
  await settle();
  return positions();
}

const aroundShop = ['shop', 'customer', 'ordering', 'oven/planner #1', 'till', 'server'];

describe.each(['viewing', 'modelling'] as const)('on a focus canvas in %s', (space) => {
  it('adds a related element next to its card, moving no other card', async () => {
    const before = await openBakery(space, 'customer', ['customer', 'shop']);
    expect(tidy().disabled).toBe(true);
    fireEvent.click(
      within(card('shop') as HTMLElement).getByRole('button', {
        name: '4 related elements not on the canvas, show them',
      }),
    );
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Back Office Server, Infrastructure, add to canvas' }),
    );
    await waitFor(() => {
      expect(card('server')).not.toBeNull();
    });
    await settle();
    expectUnmoved(before);
    expectNoOverlapWith('server', ['customer', 'shop']);
    // Tidy up has something to do now.
    expect(tidy().disabled).toBe(false);
  });

  it('takes a card off with its ×, moving no other card', async () => {
    const before = await openBakery(space, 'shop', aroundShop);
    fireEvent.click(
      within(card('till') as HTMLElement).getByRole('button', { name: 'Remove Till from canvas' }),
    );
    await waitFor(() => {
      expect(card('till')).toBeNull();
    });
    await settle();
    expectUnmoved(before);
    expect(positions().size).toBe(5);
  });

  it('lands a row dragged from the list where it was dropped, moving no other card', async () => {
    const before = await openBakery(space, 'shop', aroundShop);
    drop('lonely', 1500, 900);
    await waitFor(() => {
      expect(card('lonely')).not.toBeNull();
    });
    await settle();
    expectUnmoved(before);
    // The jsdom canvas has no size, so its view is unscaled at first: flow position = pointer,
    // less the card's grip offset, when nothing is there.
    expect(boxOf('lonely')).toMatchObject({ x: 1440, y: 878 });
    expectNoOverlapWith('lonely', aroundShop);
  });

  it('lays everything out again on Tidy up only', async () => {
    const before = await openBakery(space, 'shop', aroundShop);
    fireEvent.click(
      within(card('till') as HTMLElement).getByRole('button', { name: 'Remove Till from canvas' }),
    );
    await waitFor(() => {
      expect(card('till')).toBeNull();
    });
    await settle();
    expectUnmoved(before);
    expect(tidy().disabled).toBe(false);
    fireEvent.click(tidy());
    await waitFor(() => {
      expect(live()).toBe('Layout tidied up.');
    });
    expect(tidy().disabled).toBe(true);
    expect(cardIds().sort()).toEqual(aroundShop.filter((id) => id !== 'till').sort());
  });
});

describe('editing on the canvas (Modelling)', () => {
  it('puts a new element (N) at the centre of the view, moving no other card', async () => {
    const before = await openBakery('modelling', 'shop', aroundShop);
    act(() => {
      fireEvent.keyDown(document.body, { key: 'n' });
    });
    const pop = await screen.findByRole('dialog', { name: 'New element' });
    fireEvent.change(within(pop).getByRole('textbox', { name: /^Name/ }), {
      target: { value: 'Flour Store' },
    });
    fireEvent.click(within(pop).getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(card('flour')).not.toBeNull();
    });
    await settle();
    expectUnmoved(before);
    expectNoOverlapWith('flour', aroundShop);
  });

  it('adds a relationship that brings a card, moving no other card', async () => {
    const before = await openBakery('modelling', 'shop', aroundShop);
    fireEvent.click(within(details()).getByRole('button', { name: 'Add relationship' }));
    const box = await screen.findByRole('group', { name: 'Add relationship' });
    fireEvent.click(within(box).getByRole('radio', { name: 'Relation' }));
    const search = within(box).getByRole('combobox', { name: 'Other element' });
    fireEvent.change(search, { target: { value: 'recipe' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    fireEvent.click(within(box).getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(card('lonely')).not.toBeNull();
    });
    await settle();
    expectUnmoved(before);
    expectNoOverlapWith('lonely', aroundShop);
  });

  it('reverses and deletes a relationship, moving no card', async () => {
    const before = await openBakery('modelling', 'shop', aroundShop);
    const lines = () => canvasEl().querySelectorAll('.react-flow__edge').length;
    const count = lines();
    fireEvent.click(
      within(details()).getAllByRole('button', {
        name: /^Open relationship: Relates to Back Office Server/,
      })[0] as HTMLElement,
    );
    const form = await screen.findByRole('form', { name: /^Relationship / });
    fireEvent.click(within(details()).getByRole('button', { name: 'Reverse direction' }));
    fireEvent.click(within(form).getByRole('button', { name: /^Save/ }));
    // The reversed relationship is drawn as its own line.
    await waitFor(() => {
      expect(lines()).toBe(count + 1);
    });
    await settle();
    expectUnmoved(before);

    fireEvent.click(within(details()).getByRole('button', { name: 'Delete relationship' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this relationship?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete relationship' }));
    await waitFor(() => {
      expect(lines()).toBe(count);
    });
    await settle();
    expectUnmoved(before);
  });

  it('renames an element, moving no other card', async () => {
    const before = await openBakery('modelling', 'till', ['till', 'shop']);
    const form = await screen.findByRole('form', { name: /^Edit / });
    fireEvent.change(within(form).getByRole('textbox', { name: /^Name/ }), {
      target: { value: 'Till with a much longer name than before' },
    });
    fireEvent.keyDown(within(form).getByRole('textbox', { name: /^Name/ }), {
      key: 'Enter',
      ctrlKey: true,
    });
    await waitFor(() => {
      expect(card('till')?.textContent).toContain('Till with a much longer name than before');
    });
    await settle();
    expectUnmoved(before);
  });
});

// A view: a small made-up library.
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
      server: { label: 'Book server', metadata: { type: 'Infrastructure' } },
      archive: { label: 'Archive', metadata: { type: 'Other' } },
    },
    edges: [
      { id: 'r1', source: 'reader', target: 'catalogue', relation: 'Relation' },
      { id: 'r2', source: 'catalogue', target: 'loans', relation: 'Relation' },
      { id: 'r5', source: 'loans', target: 'server', relation: 'Relation' },
      { id: 'r7', source: 'archive', target: 'loans', relation: 'Relation' },
    ],
  },
};
const librarySummary: ModelSummary = {
  id: libraryId,
  name: 'Made-up library',
  createdAt: '2026-11-01T10:00:00.000Z',
  createdBy: { id: 'u1', name: 'Alex Morgan' },
  nodeCount: 5,
  edgeCount: 4,
};

function libraryApi(view: StoredView): Handler {
  return ({ url, method, body }) => {
    if (url === '/api/models') return Response.json({ models: [librarySummary], editable: true });
    if (url === `/api/models/${libraryId}`) return Response.json(library);
    if (url.startsWith(`/api/models/${libraryId}/elements/`)) {
      const id = decodeURIComponent(url.split('/elements/')[1] ?? '');
      return Response.json({
        element: { id, version: 1, node: library.graph.nodes?.[id] },
        warnings: [],
      });
    }
    if (url === `/api/models/${libraryId}/views`) {
      return Response.json({ views: [{ ...view, elementIds: undefined }] });
    }
    if (url === `/api/models/${libraryId}/views/${view.id}`) return Response.json({ view });
    if (url === `/api/models/${libraryId}/views/${view.id}/contents` && method === 'PUT') {
      const parsed = JSON.parse(String(body)) as Partial<StoredView>;
      view.version += 1;
      view.elementIds = parsed.elementIds ?? view.elementIds;
      view.relationshipIds = parsed.relationshipIds ?? view.relationshipIds;
      return Response.json({ view });
    }
    if (url === `/api/models/${libraryId}/views/${view.id}/layout` && method === 'PUT') {
      const parsed = JSON.parse(String(body)) as { cards: StoredView['layout'] };
      view.version += 1;
      view.layout = parsed.cards;
      return Response.json({ view });
    }
    return undefined;
  };
}

function reading(): StoredView {
  const author = { id: 'u1', name: 'Alex Morgan' };
  return {
    id: 'v-reading',
    name: 'Reading',
    version: 1,
    elementCount: 4,
    relationshipCount: 3,
    createdAt: '2026-11-05T09:00:00.000Z',
    createdBy: author,
    updatedAt: '2026-11-05T09:00:00.000Z',
    updatedBy: author,
    elementIds: ['reader', 'catalogue', 'loans', 'server'],
    relationshipIds: ['r1', 'r2', 'r5'],
    layout: [],
  };
}

describe('in an open view (Modelling)', () => {
  async function openView() {
    stubApi(modeller, libraryApi(reading()));
    renderAt(`/modelling/models/${libraryId}/views/v-reading`);
    await waitFor(() => {
      expect(cardIds().sort()).toEqual(['catalogue', 'loans', 'reader', 'server']);
    });
    await settle();
    return positions();
  }

  it('adds a dropped element to the view, moving no other card', async () => {
    const before = await openView();
    drop('archive', 900, 700);
    await waitFor(() => {
      expect(card('archive')).not.toBeNull();
    });
    await settle();
    expectUnmoved(before);
    expectNoOverlapWith('archive', before.keys());
  });

  it('takes a card out of the view, moving no other card', async () => {
    const before = await openView();
    fireEvent.click(
      within(card('reader') as HTMLElement).getByRole('button', {
        name: 'Remove Reader from view',
      }),
    );
    await waitFor(() => {
      expect(card('reader')).toBeNull();
    });
    await settle();
    expectUnmoved(before);
  });
});
