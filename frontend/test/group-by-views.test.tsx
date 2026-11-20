import type {
  JgfDocument,
  ModelSummary,
  StoredView,
  ViewCardLayout,
} from '@simplearchitecture/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { groupBox } from '../src/viewing/explorer/canvas/layoutGeometry';
import {
  apiError,
  currentLocation,
  modeller,
  renderAt,
  stubApi,
  viewer,
  type Handler,
} from './helpers';
import { settle } from './settle';

// Group by in views: saved with the view in Modelling, for the page only in Viewing, kept by Save as
// view, and read back when values changed. Made-up data: a small orchard.

const modelId = '62626262-6262-4262-8262-626262626262';

const orchard: JgfDocument = {
  graph: {
    id: modelId,
    label: 'Made-up orchard',
    directed: true,
    nodes: {
      picker: { label: 'Picker', metadata: { type: 'Stakeholder' } },
      scale: { label: 'Scale', metadata: { type: 'Application', owningTeam: 'Yard' } },
      press: { label: 'Press', metadata: { type: 'Application', owningTeam: 'Cellar' } },
      store: { label: 'Cold store', metadata: { type: 'Infrastructure', owningTeam: 'Yard' } },
      shop: { label: 'Farm shop', metadata: { type: 'Business', owningTeam: 'Sales' } },
    },
    edges: [
      { id: 'o1', source: 'picker', target: 'scale', relation: 'Relation' },
      { id: 'o2', source: 'scale', target: 'press', relation: 'Relation' },
      { id: 'o3', source: 'press', target: 'store', relation: 'Relation' },
      { id: 'o4', source: 'store', target: 'shop', relation: 'Relation' },
    ],
  },
};

const summary: ModelSummary = {
  id: modelId,
  name: 'Made-up orchard',
  createdAt: '2026-11-01T10:00:00.000Z',
  createdBy: { id: 'u1', name: 'Sam Taylor' },
  nodeCount: 5,
  edgeCount: 4,
};

const allIds = ['picker', 'scale', 'press', 'store', 'shop'];

function harvest(changes: Partial<StoredView> = {}): StoredView {
  return {
    id: 'v-harvest',
    name: 'Harvest',
    folder: null,
    version: 1,
    elementCount: 5,
    relationshipCount: 4,
    createdAt: '2026-11-02T10:00:00.000Z',
    createdBy: { id: 'u1', name: 'Sam Taylor' },
    updatedAt: '2026-11-02T10:00:00.000Z',
    updatedBy: { id: 'u1', name: 'Sam Taylor' },
    elementIds: allIds,
    relationshipIds: ['o1', 'o2', 'o3', 'o4'],
    layout: [],
    routes: [],
    groupBy: null,
    ...changes,
  };
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

/** The model and its views, kept by a made-up server with versions, as the API does. */
function server(initial: StoredView, document: JgfDocument = orchard) {
  let view = structuredClone(initial);
  const calls: Call[] = [];
  const next: { failWith?: Response } = {};
  const base = `/api/models/${modelId}/views/${initial.id}`;
  const handler: Handler = ({ url, method, body }) => {
    const parsed =
      typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : undefined;
    if (url === '/api/models') return Response.json({ models: [summary], editable: true });
    if (url === `/api/models/${modelId}`) return Response.json(document);
    if (url.startsWith(`/api/models/${modelId}/elements/`)) {
      const id = decodeURIComponent(url.split('/elements/')[1] ?? '');
      if (id.endsWith('/views')) return Response.json({ views: [] });
      return Response.json({
        element: { id, version: 1, node: document.graph.nodes?.[id] },
        warnings: [],
      });
    }
    if (url === `/api/models/${modelId}/views`) {
      if (method === 'POST') {
        calls.push({ method, url, body: parsed });
        const made = harvest({
          id: 'v-new',
          name: parsed?.name as string,
          elementIds: parsed?.elementIds as string[],
          relationshipIds: parsed?.relationshipIds as string[],
          groupBy: (parsed?.groupBy as string | undefined) ?? null,
        });
        return Response.json({ view: made }, { status: 201 });
      }
      return Response.json({ views: [{ ...view, elementIds: undefined, layout: undefined }] });
    }
    if (url.startsWith(`/api/models/${modelId}/views/v-new`)) {
      return Response.json({ view: harvest({ id: 'v-new', groupBy: 'owningTeam' }) });
    }
    if (!url.startsWith(base)) return undefined;
    calls.push({ method, url, body: parsed });
    if (method === 'GET') return Response.json({ view });
    if (next.failWith) {
      const answer = next.failWith;
      delete next.failWith;
      return answer;
    }
    if (parsed?.version !== view.version) {
      return apiError(409, 'Someone else changed this view.', { currentVersion: view.version });
    }
    if (url === `${base}/layout`) {
      view = {
        ...view,
        version: view.version + 1,
        layout: parsed.cards as ViewCardLayout[],
        ...(parsed.groupBy === undefined ? {} : { groupBy: parsed.groupBy as string | null }),
      };
      return Response.json({ view });
    }
    return undefined;
  };
  return {
    handler,
    calls,
    next,
    view: () => view,
    set: (changed: StoredView) => {
      view = changed;
    },
  };
}

const canvasEl = () => document.getElementById('canvas') as HTMLElement;
const card = (id: string) =>
  canvasEl().querySelector<HTMLElement>(`.card[data-element-id="${CSS.escape(id)}"]`);
const panel = () => screen.getByRole('radiogroup', { name: 'Group by' });
const radio = (name: string) => within(panel()).getByRole<HTMLInputElement>('radio', { name });
const layoutSaves = (calls: Call[]) => calls.filter((call) => call.url.endsWith('/layout'));
const changes = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
function boxOfNode(node: HTMLElement): Box {
  const match = /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(node.style.transform);
  return {
    x: Number(match?.[1]),
    y: Number(match?.[2]),
    width: parseFloat(node.style.width),
    height: parseFloat(node.style.height),
  };
}
const cardBox = (id: string) => boxOfNode(card(id)?.closest('.react-flow__node') as HTMLElement);
function groups() {
  return [...canvasEl().querySelectorAll<HTMLElement>('.react-flow__node-groupBox')].map(
    (node) => ({
      value: node.querySelector('.group-value')?.textContent ?? '',
      count: node.querySelector('.group-count')?.textContent ?? '',
      box: boxOfNode(node),
    }),
  );
}
const headers = () =>
  groups()
    .map((group) => `${group.value} ${group.count}`)
    .sort();
const groupNamed = (value: string) => groups().find((group) => group.value === value);
const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x + groupBox.padding.left - 0.5 &&
  inner.y >= outer.y + groupBox.padding.top - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width - groupBox.padding.right + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height - groupBox.padding.bottom + 0.5;

async function open(space: 'viewing' | 'modelling', view: StoredView, document = orchard) {
  const fake = server(view, document);
  stubApi(space === 'viewing' ? viewer : modeller, fake.handler);
  const rendered = renderAt(`/${space}/models/${modelId}/views/${view.id}`);
  await waitFor(() => {
    expect(card(view.elementIds[0] ?? '')).not.toBeNull();
  });
  await settle();
  return { ...fake, rendered };
}

describe('a view without Group by', () => {
  it('opens ungrouped, as views saved before this version do', async () => {
    const { calls } = await open('viewing', harvest());
    expect(groups()).toEqual([]);
    expect(
      within(panel())
        .getAllByRole<HTMLInputElement>('radio')
        .some((each) => each.checked),
    ).toBe(false);
    expect(changes(calls)).toEqual([]);
  });
});

describe('Group by in a view, in Modelling', () => {
  it('lays the view out again and saves the setting with the cards and their groups', async () => {
    const { calls, view } = await open('modelling', harvest());
    fireEvent.click(radio('Owning team'));
    await settle();
    expect(headers()).toEqual(['Cellar · 1', 'Not set · 1', 'Sales · 1', 'Yard · 2']);
    const saves = layoutSaves(calls);
    expect(saves).toHaveLength(1);
    expect(saves[0]?.body).toMatchObject({ version: 1, groupBy: 'owningTeam' });
    const groupsSaved = new Map(
      (saves[0]?.body?.cards as ViewCardLayout[]).map((each) => [each.elementId, each.group]),
    );
    expect(Object.fromEntries(groupsSaved)).toEqual({
      picker: null,
      scale: 'Yard',
      press: 'Cellar',
      store: 'Yard',
      shop: 'Sales',
    });
    expect(view().groupBy).toBe('owningTeam');
    await screen.findByText('Saved');
    // The address doesn't carry it: the view does.
    expect(currentLocation()).not.toContain('group=');
    // A later move saves the layout without sending the setting again.
    const main = card('shop')?.querySelector<HTMLElement>('.card-main') as HTMLElement;
    main.focus();
    fireEvent.keyDown(main, { key: 'm' });
    fireEvent.keyDown(main, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(main, { key: 'Enter' });
    await settle();
    expect(layoutSaves(calls)).toHaveLength(2);
    expect(layoutSaves(calls)[1]?.body).not.toHaveProperty('groupBy');
    expect(layoutSaves(calls)[1]?.body?.version).toBe(2);

    // Opened again, by anyone: grouped, with every card where it was left.
    const left = new Map(allIds.map((id) => [id, cardBox(id)]));
    const saved = view();
    cleanup();
    await open('viewing', saved);
    expect(radio('Owning team').checked).toBe(true);
    expect(headers()).toEqual(['Cellar · 1', 'Not set · 1', 'Sales · 1', 'Yard · 2']);
    for (const id of allIds) expect(cardBox(id), id).toEqual(left.get(id));
  });

  it('Clear saves no grouping, and the cards without groups', async () => {
    const { calls } = await open('modelling', harvest({ groupBy: 'type' }));
    expect(radio('Type').checked).toBe(true);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Clear' }));
    await settle();
    expect(groups()).toEqual([]);
    const save = layoutSaves(calls)[0];
    expect(save?.body?.groupBy).toBeNull();
    expect((save?.body?.cards as ViewCardLayout[]).every((each) => !('group' in each))).toBe(true);
  });

  it('shows Reload view when someone else changed the view, and saves nothing', async () => {
    const { calls, view, set } = await open('modelling', harvest());
    set({ ...view(), version: 3, groupBy: 'type' });
    fireEvent.click(radio('Owning team'));
    await settle();
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain(
      "Someone else changed this view. Your change wasn't saved.",
    );
    expect(layoutSaves(calls).at(-1)?.body?.groupBy).toBe('owningTeam');
    expect(view().groupBy).toBe('type');
    fireEvent.click(within(notice).getByRole('button', { name: 'Reload view' }));
    await settle();
    // Read again: the view's own grouping.
    expect(radio('Type').checked).toBe(true);
    expect(headers().map((header) => header.split(' ·')[0])).toContain('Application');
  });
});

describe('Group by in a view, in Viewing', () => {
  it('regroups the page only: nothing is saved, the address stays, and reopening shows the saved one', async () => {
    const { calls, view } = await open('viewing', harvest({ groupBy: 'type' }));
    expect(radio('Type').checked).toBe(true);
    const address = currentLocation();
    fireEvent.click(radio('Owning team'));
    await settle();
    expect(headers()).toEqual(['Cellar · 1', 'Not set · 1', 'Sales · 1', 'Yard · 2']);
    expect(currentLocation()).toBe(address);
    expect(changes(calls)).toEqual([]);
    cleanup();
    await open('viewing', view());
    expect(radio('Type').checked).toBe(true);
  });
});

describe('Group by in a view, back to its own', () => {
  it('shows the cards where they were left again, not laid out afresh', async () => {
    // Saved grouped by Type, with the farm shop moved by hand.
    const first = await open('modelling', harvest());
    fireEvent.click(radio('Type'));
    await settle();
    const main = card('shop')?.querySelector<HTMLElement>('.card-main') as HTMLElement;
    main.focus();
    fireEvent.keyDown(main, { key: 'm' });
    for (let i = 0; i < 3; i++) fireEvent.keyDown(main, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(main, { key: 'Enter' });
    await settle();
    const saved = first.view();
    const left = new Map(allIds.map((id) => [id, cardBox(id)]));
    cleanup();

    await open('viewing', saved);
    for (const id of allIds) expect(cardBox(id), id).toEqual(left.get(id));
    fireEvent.click(radio('Owning team'));
    await settle();
    fireEvent.click(radio('Type'));
    await settle();
    for (const id of allIds) expect(cardBox(id), id).toEqual(left.get(id));
    const status = document.querySelector('#canvas p.vh[aria-live="polite"]')?.textContent;
    expect(status).toBe('Grouped by Type, 4 groups.');
  });
});

describe('a grouped view read back', () => {
  it('shows every card in Not set for a property none of its elements has, without an error', async () => {
    await open('viewing', harvest({ groupBy: 'Harvest season' }));
    expect(radio('Harvest season').checked).toBe(true);
    expect(headers()).toEqual(['Not set · 5']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('puts a card whose value changed since in its new box; the others stay where they were left', async () => {
    const first = await open('modelling', harvest());
    fireEvent.click(radio('Owning team'));
    await settle();
    const saved = first.view();
    const left = new Map(allIds.map((id) => [id, cardBox(id)]));
    cleanup();
    // Meanwhile, the press moved to the Yard team.
    const changed: JgfDocument = structuredClone(orchard);
    const press = changed.graph.nodes?.press;
    if (press?.metadata) press.metadata.owningTeam = 'Yard';
    const { calls } = await open('viewing', saved, changed);
    expect(headers()).toEqual(['Not set · 1', 'Sales · 1', 'Yard · 3']);
    expect(inside(cardBox('press'), groupNamed('Yard')?.box as Box)).toBe(true);
    for (const id of ['picker', 'scale', 'store', 'shop']) {
      expect(cardBox(id), id).toEqual(left.get(id));
    }
    expect(changes(calls)).toEqual([]);
  });

  it("keeps unrelated boxes in the property's order", async () => {
    const loose: JgfDocument = { graph: { ...orchard.graph, edges: [] } };
    await open('viewing', harvest({ groupBy: 'type', relationshipIds: [] }), loose);
    const order = groups()
      .sort((a, b) => {
        const sameRow = a.box.y < b.box.y + b.box.height && b.box.y < a.box.y + a.box.height;
        return sameRow ? a.box.x - b.box.x : a.box.y - b.box.y;
      })
      .map((group) => group.value);
    expect(order).toEqual(['Stakeholder', 'Business', 'Application', 'Infrastructure']);
  });
});

describe('Save as view', () => {
  it('keeps the canvas’s Group by', async () => {
    const fake = server(harvest());
    stubApi(modeller, fake.handler);
    renderAt(`/modelling/models/${modelId}/elements/scale?depth=2&group=owningTeam`);
    await waitFor(() => {
      expect(card('scale')).not.toBeNull();
    });
    await settle();
    expect(groups().length).toBeGreaterThan(0);
    // The views section of the left panel, opened.
    const header = await screen.findByRole('button', { name: /^Views/ });
    if (header.getAttribute('aria-expanded') !== 'true') fireEvent.click(header);
    fireEvent.click(await screen.findByRole('button', { name: 'Save as view…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save as view' });
    fireEvent.submit(within(dialog).getByRole('textbox', { name: /Name/ }));
    await waitFor(() => {
      expect(fake.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    expect(fake.calls.find((call) => call.method === 'POST')?.body?.groupBy).toBe('owningTeam');
  });
});
