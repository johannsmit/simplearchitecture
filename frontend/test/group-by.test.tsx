import type { JgfDocument, ModelSummary } from '@simplearchitecture/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { groupBox } from '../src/viewing/explorer/canvas/layoutGeometry';
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
import { settle } from './settle';

// Group by on the explorer canvas: the panel, the boxes, the layout with containers and lines,
// moving cards and boxes, and changed values. Made-up data: a small harbour.

const modelId = '61616161-6161-4161-8161-616161616161';

const harbour: JgfDocument = {
  graph: {
    id: modelId,
    label: 'Made-up harbour',
    directed: true,
    nodes: {
      clerk: { label: 'Clerk', metadata: { type: 'Stakeholder' } },
      ledger: {
        label: 'Ledger',
        metadata: {
          type: 'Application',
          owningTeam: 'Billing',
          costCentre: 'CC-2',
          tags: ['a', 'b'],
          description: 'Books every call',
          functions: ['Invoice'],
          archimateType: 'ApplicationComponent',
          supplierHqCountry: 'NL',
        },
      },
      portal: {
        label: 'Portal',
        metadata: { type: 'Application', owningTeam: 'Billing', costCentre: 'CC-1' },
      },
      crane: { label: 'Crane', metadata: { type: 'Infrastructure', owningTeam: 'Quay team' } },
      yard: { label: 'Yard', metadata: { type: 'Business', owningTeam: 'Quay team' } },
      gate: { label: 'Gate', metadata: { type: 'Infrastructure', owningTeam: 'Billing' } },
      archive: { label: 'Archive', metadata: { type: 'Other' } },
    },
    edges: [
      { id: 'r1', source: 'clerk', target: 'ledger', relation: 'Relation' },
      { id: 'r2', source: 'portal', target: 'ledger', relation: 'Relation' },
      { id: 'r3', source: 'ledger', target: 'crane', relation: 'Relation' },
      { id: 'r4', source: 'crane', target: 'gate', relation: 'Relation' },
      { id: 'r5', source: 'archive', target: 'portal', relation: 'Relation' },
      { id: 'c1', source: 'yard', target: 'gate', relation: 'Contains' },
    ],
  },
};

const summary: ModelSummary = {
  id: modelId,
  name: 'Made-up harbour',
  createdAt: '2026-11-01T10:00:00.000Z',
  createdBy: { id: 'u1', name: 'Sam Taylor' },
  nodeCount: 7,
  edgeCount: 6,
};

/** The model, with element changes kept (and versions), as the API does. */
function api(document: JgfDocument = harbour) {
  const nodes = new Map(Object.entries(document.graph.nodes ?? {}));
  const versions = new Map<string, number>();
  const patches: { id: string; body: unknown }[] = [];
  const elementsUrl = `/api/models/${modelId}/elements/`;
  const handler: Handler = ({ url, method, body }) => {
    if (url === '/api/models') return Response.json({ models: [summary] });
    if (url === `/api/models/${modelId}`) return Response.json(document);
    if (url === `/api/models/${modelId}/views`) return Response.json({ views: [] });
    if (!url.startsWith(elementsUrl)) return undefined;
    const id = decodeURIComponent(url.slice(elementsUrl.length).split('?')[0] ?? '');
    if (id.endsWith('/views')) return Response.json({ views: [] });
    const version = versions.get(id) ?? 1;
    if (method === 'PATCH') {
      const change = JSON.parse(body as string) as {
        version: number;
        metadata?: Record<string, unknown>;
      };
      patches.push({ id, body: change });
      if (change.version !== version) return apiError(409, 'Changed', { currentVersion: version });
      const node = nodes.get(id) ?? {};
      const metadata = Object.fromEntries(
        Object.entries({ ...node.metadata, ...change.metadata }).filter(([, v]) => v !== null),
      );
      nodes.set(id, { ...node, metadata });
      versions.set(id, version + 1);
    }
    return Response.json({
      element: { id, version: versions.get(id) ?? 1, node: nodes.get(id) },
      warnings: [],
    });
  };
  return { handler, patches };
}

const at = (space: 'viewing' | 'modelling', id: string, query = '') =>
  `/${space}/models/${modelId}/elements/${id}?depth=2${query}`;

const canvasEl = () => document.getElementById('canvas') as HTMLElement;
const card = (id: string) =>
  canvasEl().querySelector<HTMLElement>(`.card[data-element-id="${CSS.escape(id)}"]`);
const mainOf = (id: string) => card(id)?.querySelector<HTMLElement>('.card-main') as HTMLElement;
const panel = () => screen.getByRole('radiogroup', { name: 'Group by' });
const radio = (name: string) => within(panel()).getByRole<HTMLInputElement>('radio', { name });
const status = () => canvasEl().querySelector('p.vh[aria-live="polite"]')?.textContent ?? '';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A node's box on the canvas (React Flow draws every node at its place on the canvas). */
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

/** The group boxes as drawn: header value, count, and box. */
function groups() {
  return [...canvasEl().querySelectorAll<HTMLElement>('.react-flow__node-groupBox')].map(
    (node) => ({
      value: node.querySelector('.group-value')?.textContent ?? '',
      count: node.querySelector('.group-count')?.textContent ?? '',
      notSet: node.querySelector('.group-box')?.classList.contains('is-notset') === true,
      node,
      box: boxOfNode(node),
    }),
  );
}
const groupNamed = (value: string) => groups().find((group) => group.value === value);
const headers = () =>
  groups()
    .map((group) => `${group.value} ${group.count}`)
    .sort();

/** Whether a card lies inside a group box, clear of its padding. */
function within16(inner: Box, outer: Box): boolean {
  const { padding } = groupBox;
  return (
    inner.x >= outer.x + padding.left - 0.5 &&
    inner.y >= outer.y + padding.top - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width - padding.right + 0.5 &&
    inner.y + inner.height <= outer.y + outer.height - padding.bottom + 0.5
  );
}

const apart = (a: Box, b: Box) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

async function open(path: string, me = viewer, document: JgfDocument = harbour) {
  const fake = api(document);
  const fetchMock = stubApi(me, fake.handler);
  renderAt(path);
  await waitFor(() => {
    expect(card('ledger')).not.toBeNull();
  });
  await settle();
  return { ...fake, fetchMock };
}

async function choose(name: string) {
  fireEvent.click(radio(name));
  await settle();
}

describe('the Group by panel', () => {
  it('sits under Show Viewpoints in one column, with Type, the standard properties, then custom keys', async () => {
    await open(at('viewing', 'ledger'));
    const column = panel().parentElement as HTMLElement;
    expect(column.classList.contains('canvas-panels')).toBe(true);
    expect(column.firstElementChild).toBe(screen.getByRole('group', { name: 'Show Viewpoints' }));
    expect(column.lastElementChild).toBe(panel());
    const labels = [...panel().querySelectorAll('label')].map((label) => label.textContent);
    expect(labels).toEqual(['Type', 'Owning team', 'Supplier HQ country', 'costCentre']);
    // Description, Functions, archimateType and a key holding a list never show.
    expect(panel().querySelector('.gb-custom')?.textContent).toBe('Custom');
    expect(panel().querySelector('.gb-custom')?.getAttribute('aria-hidden')).toBe('true');
    // None checked at first, so no Clear.
    expect(
      within(panel())
        .getAllByRole('radio')
        .some((each) => (each as HTMLInputElement).checked),
    ).toBe(false);
    expect(within(panel()).queryByRole('button', { name: 'Clear' })).toBeNull();
    expect(groups()).toEqual([]);
  });

  it('groups by a choice, says so, and Clear lays the canvas out as one never grouped', async () => {
    await open(at('viewing', 'ledger'));
    const before = new Map(
      ['clerk', 'ledger', 'portal', 'crane', 'yard', 'gate', 'archive'].map((id) => [
        id,
        cardBox(id),
      ]),
    );
    await choose('Owning team');
    expect(currentLocation()).toContain('group=owningTeam');
    expect(radio('Owning team').checked).toBe(true);
    expect(headers()).toEqual(['Billing · 2', 'Not set · 2', 'Quay team · 2']);
    expect(groupNamed('Not set')?.notSet).toBe(true);
    expect(status()).toBe('Grouped by Owning team, 3 groups.');
    // Each card's name says its group.
    expect(mainOf('portal').getAttribute('aria-label')).toBe('Portal, Application, group Billing');
    expect(mainOf('archive').getAttribute('aria-label')).toBe('Archive, Other, group Not set');

    const clear = within(panel()).getByRole('button', { name: 'Clear' });
    fireEvent.click(clear);
    await settle();
    expect(groups()).toEqual([]);
    expect(currentLocation()).not.toContain('group=');
    expect(document.activeElement).toBe(radio('Type'));
    expect(radio('Type').checked).toBe(false);
    expect(status()).toBe('Not grouped.');
    for (const [id, box] of before) expect(cardBox(id), id).toEqual(box);
    expect(mainOf('portal').getAttribute('aria-label')).toBe('Portal, Application');
  });

  it('ends grouped by the last of a quick run of choices', async () => {
    await open(at('viewing', 'ledger'));
    // The arrow keys change a radio group's choice: each is a change, one right after another.
    for (const name of ['Type', 'Owning team', 'Supplier HQ country', 'costCentre']) {
      fireEvent.click(radio(name));
    }
    await settle();
    expect(currentLocation()).toContain('group=costCentre');
    expect(headers()).toEqual(['CC-1 · 1', 'CC-2 · 1', 'Not set · 4']);
  });

  it('keeps the canvas keys out of it, and Esc goes back to the canvas', async () => {
    await open(at('viewing', 'ledger'));
    radio('Type').focus();
    for (const key of ['1', '3', 'ArrowRight', 'm', 't', '0'])
      fireEvent.keyDown(radio('Type'), { key });
    expect(currentLocation()).toContain('depth=2');
    expect(document.activeElement).toBe(radio('Type'));
    fireEvent.keyDown(radio('Type'), { key: 'Escape' });
    expect(document.activeElement).toBe(canvasEl());
  });

  it("keeps an address's key the model lacks: checked, last, with every card in Not set", async () => {
    await open(at('viewing', 'ledger', '&group=Hosting'));
    const labels = [...panel().querySelectorAll('label')].map((label) => label.textContent);
    expect(labels.at(-1)).toBe('Hosting');
    expect(radio('Hosting').checked).toBe(true);
    expect(headers()).toEqual(['Not set · 6']);
  });
});

describe('the address', () => {
  it('survives a reload and keeps the grouping on a new focus and a depth change', async () => {
    await open(at('viewing', 'ledger', '&group=type'));
    expect(radio('Type').checked).toBe(true);
    expect(headers()).toEqual([
      'Application · 2',
      'Business · 1',
      'Infrastructure · 1',
      'Other · 1',
      'Stakeholder · 1',
    ]);
    // Enter on a card focuses its element.
    mainOf('crane').focus();
    fireEvent.keyDown(mainOf('crane'), { key: 'Enter' });
    await settle();
    expect(currentLocation()).toContain('/elements/crane?');
    expect(currentLocation()).toContain('group=type');
    expect(groups().length).toBeGreaterThan(0);
    mainOf('crane').focus();
    fireEvent.keyDown(mainOf('crane'), { key: '1' });
    await settle();
    expect(currentLocation()).toContain('depth=1');
    expect(currentLocation()).toContain('group=type');
    expect(radio('Type').checked).toBe(true);
  });
});

describe('group boxes', () => {
  it('hold every card of their value, clear of their padding, and never overlap', async () => {
    await open(at('viewing', 'ledger', '&group=owningTeam'));
    const members: Record<string, string[]> = {
      Billing: ['ledger', 'portal'],
      'Quay team': ['crane', 'yard', 'gate'],
      'Not set': ['clerk', 'archive'],
    };
    for (const [value, ids] of Object.entries(members)) {
      const group = groupNamed(value);
      expect(group, value).toBeDefined();
      for (const id of ids) expect(within16(cardBox(id), group?.box as Box), id).toBe(true);
    }
    const all = groups();
    for (const a of all) {
      for (const b of all) if (a !== b) expect(apart(a.box, b.box)).toBe(true);
    }
    // Hidden from screen readers; their header is the drag handle, and only it takes the pointer
    // (the body lets presses through to the canvas, which pans).
    for (const group of all) {
      expect(group.node.style.pointerEvents).toBe('none');
      expect(group.node.querySelector('.group-box')?.getAttribute('aria-hidden')).toBe('true');
      expect(group.node.querySelector('.group-head')?.getAttribute('title')).toBe(group.value);
    }
  });

  it("nest on: a container goes in its own value's box with what it holds, counted once", async () => {
    await open(at('viewing', 'ledger', '&group=owningTeam'));
    // The gate (Billing) is drawn in the yard (Quay team): in the yard's box, not counted.
    expect(groupNamed('Quay team')?.count).toBe('· 2');
    expect(groupNamed('Billing')?.count).toBe('· 2');
    const gate = cardBox('gate');
    const yard = cardBox('yard');
    expect(gate.x).toBeGreaterThan(yard.x);
    expect(gate.y).toBeGreaterThan(yard.y);
    expect(mainOf('gate').getAttribute('aria-label')).toBe('Gate, Infrastructure, group Quay team');
  });

  it("nest off: each card in its own value's box", async () => {
    await open(at('viewing', 'ledger', '&group=owningTeam'));
    fireEvent.click(screen.getByRole('switch', { name: /Nest contained elements/ }));
    await settle();
    // The yard isn't brought in without nesting (it is three steps from the ledger).
    expect(headers()).toEqual(['Billing · 3', 'Not set · 2', 'Quay team · 1']);
    expect(within16(cardBox('gate'), groupNamed('Billing')?.box as Box)).toBe(true);
  });

  it('show a country as its name, and put a Stakeholder circle on the box', async () => {
    await open(at('viewing', 'ledger', '&group=supplierHqCountry'));
    expect(headers()).toContain('Netherlands (NL) · 1');
    expect(card('clerk')?.classList.contains('is-grouped')).toBe(true);
  });
});

describe('moving cards and boxes', () => {
  it('moves a card within its box: the box grows right and down, and stops it at the top left', async () => {
    const { fetchMock } = await open(at('viewing', 'ledger', '&group=owningTeam'));
    const box = () => groupNamed('Not set')?.box as Box;
    const before = box();
    // Far right and down: the box grows to hold it.
    const main = mainOf('archive');
    main.focus();
    fireEvent.keyDown(main, { key: 'm' });
    for (let i = 0; i < 6; i++) fireEvent.keyDown(main, { key: 'ArrowRight', shiftKey: true });
    for (let i = 0; i < 4; i++) fireEvent.keyDown(main, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(main, { key: 'Enter' });
    await settle();
    expect(box().x).toBe(before.x);
    expect(box().y).toBe(before.y);
    expect(box().width).toBeGreaterThan(before.width);
    expect(box().height).toBeGreaterThan(before.height);
    expect(within16(cardBox('archive'), box())).toBe(true);
    // Far left and up: it stops at the padding, and the corner stays.
    mainOf('archive').focus();
    fireEvent.keyDown(mainOf('archive'), { key: 'm' });
    for (let i = 0; i < 30; i++) {
      fireEvent.keyDown(mainOf('archive'), { key: 'ArrowLeft', shiftKey: true });
      fireEvent.keyDown(mainOf('archive'), { key: 'ArrowUp', shiftKey: true });
    }
    fireEvent.keyDown(mainOf('archive'), { key: 'Enter' });
    await settle();
    expect(cardBox('archive').x).toBe(box().x + groupBox.padding.left);
    expect(cardBox('archive').y).toBe(box().y + groupBox.padding.top);
    expect(within16(cardBox('clerk'), box())).toBe(true);
    // No move ever changes a value.
    expect(requests(fetchMock).filter((each) => !each.startsWith('GET'))).toEqual([]);
  });

  it('pushes the cards in its box down when a card lands on them', async () => {
    await open(at('viewing', 'ledger', '&group=owningTeam'));
    const portal = cardBox('portal');
    const ledger = cardBox('ledger');
    // Move the ledger onto the portal, with the keyboard, in 8px steps.
    const main = mainOf('ledger');
    main.focus();
    fireEvent.keyDown(main, { key: 'm' });
    const steps = (from: number, to: number) => Math.round((to - from) / 8);
    const dx = steps(ledger.x, portal.x);
    const dy = steps(ledger.y, portal.y);
    for (let i = 0; i < Math.abs(dx); i++) {
      fireEvent.keyDown(main, { key: dx > 0 ? 'ArrowRight' : 'ArrowLeft' });
    }
    for (let i = 0; i < Math.abs(dy); i++) {
      fireEvent.keyDown(main, { key: dy > 0 ? 'ArrowDown' : 'ArrowUp' });
    }
    fireEvent.keyDown(main, { key: 'Enter' });
    await settle();
    expect(apart(cardBox('ledger'), cardBox('portal'))).toBe(true);
    expect(cardBox('portal').y).toBeGreaterThan(cardBox('ledger').y);
    expect(within16(cardBox('portal'), groupNamed('Billing')?.box as Box)).toBe(true);
  });

  it('drags a box by its header with its cards; a click on it selects nothing', async () => {
    await open(at('viewing', 'ledger', '&group=owningTeam'));
    const group = groupNamed('Quay team');
    const before = { box: group?.box as Box, crane: cardBox('crane'), gate: cardBox('gate') };
    const head = group?.node.querySelector('.group-head') as HTMLElement;
    const mouse = (target: EventTarget, type: string, x: number, y: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      });
      Object.defineProperty(event, 'view', { value: window });
      act(() => {
        target.dispatchEvent(event);
      });
    };
    mouse(head, 'mousedown', 100, 100);
    mouse(window, 'mousemove', 140, 160);
    mouse(window, 'mousemove', 180, 220);
    mouse(window, 'mouseup', 180, 220);
    await settle();
    const after = groupNamed('Quay team')?.box as Box;
    const dx = after.x - before.box.x;
    const dy = after.y - before.box.y;
    expect(dx).not.toBe(0);
    expect(cardBox('crane')).toEqual({
      ...before.crane,
      x: before.crane.x + dx,
      y: before.crane.y + dy,
    });
    expect(cardBox('gate')).toEqual({
      ...before.gate,
      x: before.gate.x + dx,
      y: before.gate.y + dy,
    });
    for (const other of groups()) {
      if (other.value !== 'Quay team') expect(apart(other.box, after)).toBe(true);
    }
    // A click on the header selects nothing (the details panel still shows the focused element).
    fireEvent.click(head);
    expect(
      screen.getByRole('complementary', { name: 'Details' }).querySelector('h2')?.textContent,
    ).toBe('Ledger');
  });

  it('Tidy relations moves no card and no box', async () => {
    await open(at('viewing', 'ledger', '&group=owningTeam'));
    await settle();
    const laid = groups().map((group) => group.box);
    const cards = ['clerk', 'ledger', 'crane'].map(cardBox);
    mainOf('ledger').focus();
    fireEvent.keyDown(mainOf('ledger'), { key: 't' });
    await settle();
    expect(groups().map((group) => group.box)).toEqual(laid);
    expect(['clerk', 'ledger', 'crane'].map(cardBox)).toEqual(cards);
  });
});

describe('changes to the cards', () => {
  it('moves a card whose value changed to its new box at once; the old box fits, an empty one goes', async () => {
    const { patches } = await open(at('modelling', 'ledger', '&group=owningTeam'), modeller);
    const quay = groupNamed('Quay team')?.box as Box;
    const clerk = cardBox('clerk');
    // The portal's Owning team: Billing → Quay team, in the details panel.
    fireEvent.click(mainOf('portal'));
    const form = await screen.findByRole('form', { name: 'Edit Portal' });
    fireEvent.change(within(form).getByRole('combobox', { name: 'Owning team' }), {
      target: { value: 'Quay team' },
    });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(groupNamed('Quay team')?.count).toBe('· 3');
    });
    await settle();
    expect(patches).toHaveLength(1);
    expect(groupNamed('Billing')?.count).toBe('· 1');
    expect(within16(cardBox('portal'), groupNamed('Quay team')?.box as Box)).toBe(true);
    // Nothing else moved: the clerk stays, and the Quay team's corner stays.
    expect(cardBox('clerk')).toEqual(clerk);
    expect(groupNamed('Quay team')?.box.x).toBe(quay.x);
    expect(groupNamed('Quay team')?.box.y).toBe(quay.y);

    // The ledger too: Billing is left empty and goes; a new value gets a new box.
    fireEvent.click(mainOf('ledger'));
    const ledgerForm = await screen.findByRole('form', { name: 'Edit Ledger' });
    fireEvent.change(within(ledgerForm).getByRole('combobox', { name: 'Owning team' }), {
      target: { value: 'Ledgers' },
    });
    fireEvent.submit(ledgerForm);
    await waitFor(() => {
      expect(groupNamed('Billing')).toBeUndefined();
    });
    await settle();
    expect(headers()).toEqual(['Ledgers · 1', 'Not set · 2', 'Quay team · 3']);
    expect(within16(cardBox('ledger'), groupNamed('Ledgers')?.box as Box)).toBe(true);
    expect(cardBox('clerk')).toEqual(clerk);
    const all = groups();
    for (const a of all) for (const b of all) if (a !== b) expect(apart(a.box, b.box)).toBe(true);
  });

  it("puts an added card in its value's box, and a box goes with its last card", async () => {
    await open(at('modelling', 'ledger', '&group=owningTeam'), modeller);
    // Remove the archive and the clerk: Not set goes.
    for (const id of ['archive', 'clerk']) {
      fireEvent.click(within(card(id) as HTMLElement).getByRole('button', { name: /^Remove / }));
      await settle();
    }
    expect(groupNamed('Not set')).toBeUndefined();
    expect(headers()).toEqual(['Billing · 2', 'Quay team · 2']);
    // The portal's related pill brings the archive back: into a new Not set box.
    fireEvent.click(
      within(card('portal') as HTMLElement).getByRole('button', { name: /related element/ }),
    );
    fireEvent.click(await screen.findByRole('menuitem', { name: /Archive/ }));
    await settle();
    expect(headers()).toEqual(['Billing · 2', 'Not set · 1', 'Quay team · 2']);
    expect(within16(cardBox('archive'), groupNamed('Not set')?.box as Box)).toBe(true);
    const all = groups();
    for (const a of all) for (const b of all) if (a !== b) expect(apart(a.box, b.box)).toBe(true);
  });
});
