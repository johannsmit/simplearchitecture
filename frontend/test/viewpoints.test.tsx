import type { JgfDocument } from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Labels from '../src/viewing/explorer/canvas/labels';
import { elementPath } from '../src/viewing/paths';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { currentLocation, renderAt, stubApi, viewer, type Handler } from './helpers';

// Every relationship on the canvas, and labels at rest. Made-up data
// (the bakery fixture). A viewpoint is now a selection of properties: see line-views.test.tsx.

// jsdom has no layout, so no spot is ever free for a type: place it at the origin.
vi.mock('../src/viewing/explorer/canvas/labels', async (importOriginal) => ({
  ...(await importOriginal<typeof Labels>()),
  placeLabel: () => ({ x: 0, y: 0 }),
}));

const base = `/viewing/models/${bakeryId}/elements`;
const shop = `${base}/shop?depth=1`;

function api(model: JgfDocument = bakeryModel): Handler {
  return ({ url, method }) => {
    if (method !== 'GET') return undefined;
    if (url === '/api/models') return Response.json({ models: [bakerySummary] });
    if (url === `/api/models/${bakeryId}`) return Response.json(model);
    return undefined;
  };
}

const canvas = () => screen.getByRole('region', { name: /^Diagram:/ });
const details = () => screen.getByRole('complementary', { name: 'Details' });
const lines = () =>
  [...canvas().querySelectorAll('.react-flow__edge')].map((edge) =>
    edge.getAttribute('aria-label'),
  );
const cardCount = (count: number) =>
  waitFor(() => {
    expect(canvas().querySelectorAll('.card')).toHaveLength(count);
  });
const restingLabels = () =>
  [...document.querySelectorAll('.edge-label')].map((label) => label.textContent).sort();

beforeEach(() => {
  localStorage.clear();
});

describe('the canvas without fixed viewpoints', () => {
  it('draws every Relation, a flow and a plain one between the same cards apart', async () => {
    stubApi(viewer, api());
    renderAt(shop);
    await cardCount(6);
    expect(lines()).toContain('Web Shop relates to Oven Planner');
    expect(lines()).toContain('Web Shop relates to Oven Planner');
    expect(screen.queryByRole('group', { name: 'Viewpoint' })).toBeNull();
  });

  it('keeps Contains as nesting', async () => {
    const edges = [
      ...(bakeryModel.graph.edges ?? []),
      { id: 'c1', source: 'server', target: 'shop', relation: 'Contains' },
    ];
    stubApi(viewer, api({ graph: { ...bakeryModel.graph, edges } }));
    renderAt(shop);
    await waitFor(() => {
      expect(canvas().querySelector('.card[data-element-id="server"].is-container')).not.toBeNull();
    });
  });

  it('says so when an element has no relationships', async () => {
    stubApi(viewer, api());
    renderAt(`${base}/lonely?depth=1`);
    expect(await screen.findAllByText('No relationships. This element stands alone.')).toBeTruthy();
  });

  it('writes no viewpoint in the links between elements', async () => {
    stubApi(viewer, api());
    renderAt(shop);
    await cardCount(6);
    fireEvent.click(
      within(details()).getAllByRole('button', { name: /Back Office Server/ })[0] as HTMLElement,
    );
    await waitFor(() => {
      expect(currentLocation()).toBe(`${base}/server?depth=1`);
    });
    expect(elementPath('m', 'e', 2, 'viewing', ['a&b'])).toBe(
      '/viewing/models/m/elements/e?depth=2&show=a%26b',
    );
  });
});

describe('a card added by hand', () => {
  const edges = [
    { id: 'e1', source: 'customer', target: 'shop', relation: 'Relation' },
    { id: 'e2', source: 'shop', target: 'ordering', relation: 'Relation' },
    { id: 'c1', source: 'ordering', target: 'till', relation: 'Contains' },
    { id: 'c2', source: 'till', target: 'server', relation: 'Contains' },
    { id: 'i1', source: 'lonely', target: 'till', relation: 'Relation' },
  ];
  const model = { graph: { ...bakeryModel.graph, edges } };
  const has = (id: string) => canvas().querySelector(`.card[data-element-id="${id}"]`) !== null;

  it.each([true, false])(
    'brings its contents down to the depth, also when the depth changes (nesting %s)',
    async (nesting) => {
      localStorage.setItem('sa-nest-contained', String(nesting));
      stubApi(viewer, api(model));
      renderAt(`${base}/customer?depth=1`);
      await cardCount(2);
      fireEvent.click(canvas().querySelector('.cpill') as HTMLElement);
      fireEvent.click(screen.getByRole('menuitem', { name: /^Order to bake/ }));
      // Depth 1: its child, and not a neighbour through a Relation.
      await cardCount(4);
      expect(has('till')).toBe(true);
      expect(has('server')).toBe(false);
      expect(has('lonely')).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: '2' }));
      await waitFor(() => {
        expect(has('server')).toBe(true);
      });
      fireEvent.click(screen.getByRole('button', { name: '1' }));
      await waitFor(() => {
        expect(has('server')).toBe(false);
      });
      expect(has('ordering')).toBe(true);
      expect(has('till')).toBe(true);
    },
  );
});

describe('the legend', () => {
  it('keeps Elements and the nest option, without Relationships and Direction', async () => {
    stubApi(viewer, api());
    renderAt(shop);
    await cardCount(6);
    // In the left panel, out of the canvas.
    expect(canvas().querySelector('.legend')).toBeNull();
    const legend = document.querySelector('.tree-panel .legend') as HTMLElement;
    const headings = within(legend)
      .getAllByRole('heading')
      .map((heading) => heading.textContent);
    expect(headings).toEqual(['Elements', 'Relationship state']);
    expect(within(legend).queryByRole('checkbox')).toBeNull();
    const nest = within(legend).getByRole('switch', { name: 'Nest contained elements' });
    expect((nest as HTMLInputElement).disabled).toBe(false);
  });
});

describe('the details panel', () => {
  it('groups by wording, with no viewpoint links', async () => {
    stubApi(viewer, api());
    renderAt(shop);
    await cardCount(6);
    const headings = within(details())
      .getAllByRole('heading', { level: 4 })
      .map((heading) => heading.textContent.replace(/\s*\d+$/, ''));
    expect(headings).toEqual(['Relates to', 'Is related to']);
    expect(within(details()).queryByRole('button', { name: /viewpoint/i })).toBeNull();
  });
});

describe('labels on the canvas', () => {
  it('shows a label and "×N" at rest, and nothing for a line without a label', async () => {
    stubApi(viewer, api());
    renderAt(shop);
    await cardCount(6);
    await waitFor(() => {
      expect(restingLabels()).toEqual(['Places orders', '×2', '×3']);
    });
  });

  it('shows nothing on a line with no label while lit, fades the other labels, and keeps the full text as a tooltip', async () => {
    stubApi(viewer, api());
    renderAt(shop);
    await cardCount(6);
    await waitFor(() => {
      expect(restingLabels()).toHaveLength(3);
    });
    const edge = [...canvas().querySelectorAll('.react-flow__edge')].find(
      (e) => e.getAttribute('aria-label') === 'Till relates to Web Shop',
    ) as HTMLElement;
    fireEvent.mouseEnter(edge);
    // A line with no label shows nothing while lit either.
    await waitFor(() => {
      expect(edge.classList.contains('is-lit')).toBe(true);
    });
    expect(document.querySelector('.edge-label.is-lit')).toBeNull();
    expect(edge.getAttribute('aria-label')).toBe('Till relates to Web Shop');
    expect(document.querySelectorAll('.edge-label.is-dim')).toHaveLength(3);
    const places = [...document.querySelectorAll('.edge-label')].find(
      (label) => label.textContent === 'Places orders',
    );
    expect(places?.getAttribute('title')).toBe('Places orders');
    fireEvent.mouseLeave(edge);
    await waitFor(() => {
      expect(restingLabels()).toEqual(['Places orders', '×2', '×3']);
    });
  });

  it('opens the relationship with a click on a resting label, not after a press that moved', async () => {
    stubApi(viewer, api());
    renderAt(shop);
    await cardCount(6);
    const label = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('.edge-label')].find(
        (l) => l.textContent === 'Places orders',
      );
      expect(found).toBeDefined();
      return found as HTMLElement;
    });
    const heading = { name: 'Customer relates to Web Shop' };
    fireEvent.pointerDown(label, { clientX: 100, clientY: 100 });
    fireEvent.click(label, { clientX: 140, clientY: 100 });
    expect(within(details()).queryByRole('heading', heading)).toBeNull();

    fireEvent.pointerDown(label, { clientX: 100, clientY: 100 });
    fireEvent.click(label, { clientX: 101, clientY: 100 });
    expect(await within(details()).findByRole('heading', heading)).toBeTruthy();
  });
});
