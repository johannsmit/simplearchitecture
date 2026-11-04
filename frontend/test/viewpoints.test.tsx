import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JgfDocument } from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Labels from '../src/viewing/explorer/canvas/labels';
import { elementPath, withoutOldViewpoint } from '../src/viewing/paths';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { currentLocation, renderAt, stubApi, viewer, type Handler } from './helpers';

// Every relationship on the canvas, old viewpoint links, and labels at rest. Made-up data
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
const button = () => screen.getByRole('button', { name: /^Show Viewpoints/ });
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
    expect(lines()).toContain('Web Shop sends information to Oven Planner');
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

  it('never reads the old shown types setting', async () => {
    localStorage.setItem('sa-hidden-relationship-types', 'Information flow|Contains');
    stubApi(viewer, api());
    renderAt(shop);
    await cardCount(6);
    expect(lines()).toContain('Web Shop sends information to Oven Planner');
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

describe('links and memory from older versions', () => {
  it('translates the old viewpoints, keeping what else is there', () => {
    const search = (text: string) => withoutOldViewpoint(new URLSearchParams(text));
    expect(search('depth=2')).toBeUndefined();
    expect(search('viewpoint=integration')).toBe('');
    expect(search('depth=2&viewpoint=integration&show=a')).toBe('?depth=2&show=a');
    expect(search('viewpoint=information-flow')).toBe('?show=informationFlow');
    expect(search('viewpoint=Information-Flow&show=a')).toBe('?show=a&show=informationFlow');
    expect(search('viewpoint=information-flow&show=informationFlow')).toBe('?show=informationFlow');
    expect(search('viewpoint=everything')).toBe('');
  });

  it('opens ?viewpoint=information-flow with Information flow selected', async () => {
    stubApi(viewer, api());
    renderAt(`${shop}&viewpoint=information-flow`);
    await cardCount(6);
    await waitFor(() => {
      expect(currentLocation()).toBe(`${shop}&show=informationFlow`);
    });
    expect(button().textContent).toBe('Show Viewpoints: 1 selected');
    await waitFor(() => {
      expect(restingLabels()).toContain('Information flow');
    });
  });

  it('opens ?viewpoint=integration with nothing selected, and every Relation', async () => {
    stubApi(viewer, api());
    renderAt(`${shop}&viewpoint=integration`);
    await cardCount(6);
    await waitFor(() => {
      expect(currentLocation()).toBe(shop);
    });
    expect(button().textContent).toBe('Show Viewpoints');
  });

  it('drops the stored preference', async () => {
    localStorage.setItem('sa-viewpoint', 'integration');
    stubApi(viewer, api());
    renderAt(shop);
    await cardCount(6);
    expect(localStorage.getItem('sa-viewpoint')).toBeNull();
    expect(lines()).toContain('Web Shop sends information to Oven Planner');
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
    const legend = canvas().querySelector('.legend') as HTMLElement;
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
    expect(headings).toEqual(['Sends information to', 'Receives information from', 'Relates to']);
    expect(within(details()).queryByRole('button', { name: /viewpoint/i })).toBeNull();
  });
});

describe('labels on the canvas', () => {
  it('shows a label and "×N" at rest, and nothing for a line without a label', async () => {
    stubApi(viewer, api());
    renderAt(shop);
    await cardCount(6);
    await waitFor(() => {
      expect(restingLabels()).toEqual(['Hosted on', 'Places orders', 'REST API', '×2']);
    });
  });

  it('shows nothing on a line with no label while lit, fades the other labels, and keeps the full text as a tooltip', async () => {
    stubApi(viewer, api());
    renderAt(shop);
    await cardCount(6);
    await waitFor(() => {
      expect(restingLabels()).toHaveLength(4);
    });
    const edge = [...canvas().querySelectorAll('.react-flow__edge')].find(
      (e) => e.getAttribute('aria-label') === 'Till sends information to Web Shop',
    ) as HTMLElement;
    fireEvent.mouseEnter(edge);
    // A line with no label shows nothing while lit either.
    await waitFor(() => {
      expect(edge.classList.contains('is-lit')).toBe(true);
    });
    expect(document.querySelector('.edge-label.is-lit')).toBeNull();
    expect(edge.getAttribute('aria-label')).toBe('Till sends information to Web Shop');
    expect(document.querySelectorAll('.edge-label.is-dim')).toHaveLength(4);
    const places = [...document.querySelectorAll('.edge-label')].find(
      (label) => label.textContent === 'Places orders',
    );
    expect(places?.getAttribute('title')).toBe('Places orders');
    fireEvent.mouseLeave(edge);
    await waitFor(() => {
      expect(restingLabels()).toEqual(['Hosted on', 'Places orders', 'REST API', '×2']);
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
    const heading = { name: 'Customer sends information to Web Shop' };
    fireEvent.pointerDown(label, { clientX: 100, clientY: 100 });
    fireEvent.click(label, { clientX: 140, clientY: 100 });
    expect(within(details()).queryByRole('heading', heading)).toBeNull();

    fireEvent.pointerDown(label, { clientX: 100, clientY: 100 });
    fireEvent.click(label, { clientX: 101, clientY: 100 });
    expect(await within(details()).findByRole('heading', heading)).toBeTruthy();
  });
});

describe('what a line looks like', () => {
  it('draws no line dashed, a flow included', async () => {
    stubApi(viewer, api());
    renderAt(shop);
    await cardCount(6);
    expect(canvas().querySelectorAll('.react-flow__edge').length).toBeGreaterThan(0);
    expect(canvas().querySelector('[stroke-dasharray], [style*="stroke-dasharray"]')).toBeNull();
    expect(document.querySelector('.edge-sample [stroke-dasharray]')).toBeNull();
  });

  it('draws a relationship being made as a solid line too', () => {
    const css = readFileSync(join(import.meta.dirname, '../src/styles/explorer.css'), 'utf8');
    const rule = /\.connection-line \{[^}]*\}/.exec(css)?.[0];
    expect(rule).toBeDefined();
    expect(rule).not.toContain('dash');
  });
});
