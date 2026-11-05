import type { JgfDocument } from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, onTestFinished } from 'vitest';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import {
  currentLocation,
  modeller,
  renderAt,
  requests,
  stubApi,
  viewer,
  type Handler,
} from './helpers';

// "Show lines" in the legend: hides every relationship line and leaves the cards alone.
// Made-up data (the bakery fixture, with a Target line and a Contains).

const model: JgfDocument = structuredClone(bakeryModel);
for (const edge of model.graph.edges ?? []) {
  if (edge.id === 'e2') edge.metadata = { ...edge.metadata, architectureState: 'Target' };
}
model.graph.edges?.push({ id: 'c1', source: 'server', target: 'till', relation: 'Contains' });

function api(editable = false): Handler {
  return ({ url, method }) => {
    if (method !== 'GET') return undefined;
    if (url === '/api/models') return Response.json({ models: [bakerySummary], editable });
    if (url === `/api/models/${bakeryId}`) return Response.json(model);
    if (url.startsWith(`/api/models/${bakeryId}/elements/`)) {
      const id = decodeURIComponent(url.split('/elements/')[1]?.split('?')[0] ?? '');
      return Response.json({
        element: { id, version: 1, node: model.graph.nodes?.[id] },
        warnings: [],
      });
    }
    if (url.startsWith(`/api/models/${bakeryId}/relationships/`)) {
      const id = decodeURIComponent(url.split('/relationships/')[1] ?? '');
      const edge = model.graph.edges?.find((candidate) => candidate.id === id);
      return Response.json({
        relationship: { id, version: 1, edge },
        warnings: [],
        nestingChanges: [],
      });
    }
    return undefined;
  };
}

type Space = 'viewing' | 'modelling';
const at = (space: Space, id = 'shop', search = '') =>
  `/${space}/models/${bakeryId}/elements/${encodeURIComponent(id)}?depth=1${search}`;

const canvas = () => screen.getByRole('region', { name: /^Diagram:/ });
/** React Flow's own part of the canvas: the legend (with its own samples) is outside it. */
const flow = () => canvas().querySelector('.react-flow') as HTMLElement;
const card = (id: string) =>
  canvas().querySelector<HTMLElement>(`.card[data-element-id="${CSS.escape(id)}"]`);
const lines = () => [...flow().querySelectorAll('.react-flow__edge')];
const line = (name: string) => lines().find((edge) => edge.getAttribute('aria-label') === name);
const labels = () => [...flow().querySelectorAll('.edge-label')].map((label) => label.textContent);
const linesSwitch = () => screen.getByRole<HTMLInputElement>('switch', { name: 'Show lines' });
const nestSwitch = () =>
  screen.getByRole<HTMLInputElement>('switch', { name: 'Nest contained elements' });
const positions = () =>
  [...flow().querySelectorAll<HTMLElement>('.react-flow__node')].map(
    (node) => `${node.getAttribute('data-id') ?? ''} ${node.style.transform}`,
  );
const details = () => screen.getByRole('complementary', { name: 'Details' });

async function open(space: Space, path = at(space)) {
  stubApi(space === 'viewing' ? viewer : modeller, api(space === 'modelling'));
  renderAt(path);
  await waitFor(() => {
    expect(card('shop')).toBeTruthy();
  });
}

async function linesDrawn() {
  await waitFor(() => {
    expect(lines().length).toBeGreaterThan(0);
  });
}

describe('Show lines', () => {
  it.each(['viewing', 'modelling'] as const)(
    'is on by default, right after Nest contained elements (%s)',
    async (space) => {
      await open(space);
      await linesDrawn();
      expect(linesSwitch().checked).toBe(true);
      expect(linesSwitch().type).toBe('checkbox');
      expect(linesSwitch().closest('label')?.previousElementSibling).toBe(
        nestSwitch().closest('label'),
      );
    },
  );

  it('hides every line, label, arrow, diamond, state mark and ×N, and moves no card', async () => {
    await open('viewing');
    await waitFor(() => {
      expect(labels()).toContain('×3');
    });
    expect(labels()).toContain('Places orders');
    expect(flow().querySelector('.smark')).not.toBeNull();
    const cards = canvas().querySelectorAll('.card').length;
    const before = positions();

    linesSwitch().focus();
    fireEvent.click(linesSwitch());
    await waitFor(() => {
      expect(lines()).toHaveLength(0);
    });
    expect(
      flow().querySelectorAll('.edge-label, .smark, .lmark, .react-flow__edge-path'),
    ).toHaveLength(0);
    expect(canvas().querySelectorAll('.card')).toHaveLength(cards);
    expect(positions()).toEqual(before);
    // Like the nesting switch: remembered, and keyboard focus stays on it.
    expect(linesSwitch().checked).toBe(false);
    expect(localStorage.getItem('sa-show-lines')).toBe('false');
    expect(document.activeElement).toBe(linesSwitch());
    // Nesting is its own choice.
    expect(nestSwitch().checked).toBe(true);
    expect(localStorage.getItem('sa-nest-contained')).toBeNull();
    // Nothing goes in the address.
    expect(currentLocation()).not.toMatch(/lines/);

    fireEvent.click(linesSwitch());
    await waitFor(() => {
      expect(labels()).toContain('×3');
    });
    expect(linesSwitch().checked).toBe(true);
    expect(localStorage.getItem('sa-show-lines')).toBe('true');
    expect(positions()).toEqual(before);
  });

  it('hides the diamonds of Contains lines too', async () => {
    localStorage.setItem('sa-nest-contained', 'false');
    await open('viewing', at('viewing', 'server'));
    await waitFor(() => {
      expect(line('Back Office Server contains Till')).toBeTruthy();
    });
    const path = line('Back Office Server contains Till')?.querySelector('.react-flow__edge-path');
    expect(path?.getAttribute('marker-start')).toBe('url(#sa-diamond)');
    const before = positions();
    fireEvent.click(linesSwitch());
    await waitFor(() => {
      expect(lines()).toHaveLength(0);
    });
    expect(flow().querySelector('[marker-start], [marker-end]')).toBeNull();
    expect(positions()).toEqual(before);
  });

  it('keeps nested cards in their containers', async () => {
    await open('viewing', at('viewing', 'server'));
    await waitFor(() => {
      expect(card('server')?.classList.contains('is-container')).toBe(true);
    });
    const before = positions();
    fireEvent.click(linesSwitch());
    await waitFor(() => {
      expect(lines()).toHaveLength(0);
    });
    expect(card('server')?.classList.contains('is-container')).toBe(true);
    expect(card('till')).toBeTruthy();
    expect(positions()).toEqual(before);
  });

  it('is remembered in this browser, also on the next element', async () => {
    localStorage.setItem('sa-show-lines', 'false');
    await open('viewing');
    expect(linesSwitch().checked).toBe(false);
    // Give the canvas time to draw: still no line.
    await waitFor(() => {
      expect(card('customer')).toBeTruthy();
    });
    expect(lines()).toHaveLength(0);
    fireEvent.click(card('customer')?.querySelector('.card-main') as HTMLElement, { detail: 2 });
    await waitFor(() => {
      expect(currentLocation()).toContain('/elements/customer');
    });
    expect(linesSwitch().checked).toBe(false);
    expect(lines()).toHaveLength(0);
  });

  it('keeps lines outside Show Viewpoints grayed out when they come back', async () => {
    await open('viewing', at('viewing', 'shop', '&show=data'));
    await waitFor(() => {
      expect(line('Till relates to Web Shop')?.classList.contains('is-grayed')).toBe(true);
    });
    expect(line('Customer relates to Web Shop')?.classList.contains('is-grayed')).toBe(false);
    fireEvent.click(linesSwitch());
    await waitFor(() => {
      expect(lines()).toHaveLength(0);
    });
    fireEvent.click(linesSwitch());
    await waitFor(() => {
      expect(line('Till relates to Web Shop')?.classList.contains('is-grayed')).toBe(true);
    });
    expect(line('Customer relates to Web Shop')?.classList.contains('is-grayed')).toBe(false);
    expect(labels()).toContain('Places orders');
  });

  it('still opens a relationship from the details panel, with the lines left off', async () => {
    localStorage.setItem('sa-show-lines', 'false');
    await open('modelling');
    await screen.findByRole('form', { name: /^Edit / });
    fireEvent.click(
      within(details()).getAllByRole('button', {
        name: /^Open relationship: Relates to Oven Planner/,
      })[0] as HTMLElement,
    );
    await screen.findByRole('form', { name: /^Relationship / });
    expect(linesSwitch().checked).toBe(false);
    expect(lines()).toHaveLength(0);
  });
});

describe('Show lines in Modelling', () => {
  it('Add relationship in the details panel turns the lines back on', async () => {
    localStorage.setItem('sa-show-lines', 'false');
    await open('modelling');
    await screen.findByRole('form', { name: /^Edit / });
    expect(lines()).toHaveLength(0);
    fireEvent.click(within(details()).getByRole('button', { name: 'Add relationship' }));
    await screen.findByRole('group', { name: 'Add relationship' });
    expect(linesSwitch().checked).toBe(true);
    expect(localStorage.getItem('sa-show-lines')).toBe('true');
    await linesDrawn();
  });

  it('R on a card turns the lines back on', async () => {
    localStorage.setItem('sa-show-lines', 'false');
    await open('modelling');
    await screen.findByRole('form', { name: /^Edit / });
    fireEvent.keyDown(card('customer')?.querySelector('.card-main') as HTMLElement, { key: 'r' });
    await screen.findByRole('group', { name: 'Add relationship' });
    expect(linesSwitch().checked).toBe(true);
    await linesDrawn();
  });

  it('drawing a relationship turns the lines back on', async () => {
    localStorage.setItem('sa-show-lines', 'false');
    await open('modelling');
    // jsdom has no hit testing; React Flow asks for it while a line is drawn (nothing is hit).
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
    onTestFinished(() => {
      Reflect.deleteProperty(document, 'elementFromPoint');
    });
    const handle = await waitFor(
      () => {
        const found = card('shop')?.querySelector<HTMLElement>('.connect-handle');
        if (!found) throw new Error('no handle yet');
        return found;
      },
      { timeout: 4000 },
    );
    expect(lines()).toHaveLength(0);
    fireEvent.mouseDown(handle, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 40, clientY: 40 });
    await waitFor(() => {
      expect(linesSwitch().checked).toBe(true);
    });
    fireEvent.mouseUp(document, { clientX: 0, clientY: 0 });
    await linesDrawn();
    expect(localStorage.getItem('sa-show-lines')).toBe('true');
  });

  it('is not offered as a change to the model: switching it sends nothing', async () => {
    const fetchMock = stubApi(modeller, api(true));
    renderAt(at('modelling'));
    await linesDrawn();
    fireEvent.click(linesSwitch());
    fireEvent.click(linesSwitch());
    await linesDrawn();
    expect(requests(fetchMock).filter((request) => !request.startsWith('GET '))).toEqual([]);
  });
});
