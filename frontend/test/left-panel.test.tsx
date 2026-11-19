import type { JgfDocument, ModelSummary, ViewSummary } from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { modeller, renderAt, stubApi, viewer, type Handler } from './helpers';

// The left panel: New element, search, the element list, Views, and the legend at the bottom.
// Made-up data: a small garden centre.

const modelId = '55555555-5555-4555-8555-555555555555';
const model: JgfDocument = {
  graph: {
    id: modelId,
    label: 'Made-up garden centre',
    directed: true,
    nodes: {
      till: { label: 'Till', metadata: { type: 'Application' } },
      stock: { label: 'Stock', metadata: { type: 'Application' } },
      shed: { label: 'Shed server', metadata: { type: 'Infrastructure' } },
    },
    edges: [
      { id: 'g1', source: 'till', target: 'stock', relation: 'Relation', label: 'Sells' },
      { id: 'g2', source: 'till', target: 'stock', relation: 'Relation', label: 'Counts' },
      { id: 'g3', source: 'stock', target: 'shed', relation: 'Relation' },
    ],
  },
};
const summary: ModelSummary = {
  id: modelId,
  name: 'Made-up garden centre',
  createdAt: '2026-11-01T10:00:00.000Z',
  createdBy: { id: 'u1', name: 'Alex Morgan' },
  nodeCount: 3,
  edgeCount: 3,
};

const author = { id: 'u1', name: 'Alex Morgan' };
/** Views for the list: none unless a test puts some here. */
let views: ViewSummary[] = [];
const view = (index: number, folder: string | null): ViewSummary => ({
  id: `66666666-6666-4666-8666-66666666660${index}`,
  name: `Planting plan ${index}`,
  folder,
  version: 1,
  elementCount: 1,
  relationshipCount: 0,
  createdAt: '2026-11-05T09:00:00.000Z',
  createdBy: author,
  updatedAt: '2026-11-05T09:00:00.000Z',
  updatedBy: author,
});

const api: Handler = ({ url, method }) => {
  if (method !== 'GET') return undefined;
  if (url === '/api/models') return Response.json({ models: [summary], editable: true });
  if (url === `/api/models/${modelId}`) return Response.json(model);
  if (url === `/api/models/${modelId}/views`) return Response.json({ views });
  if (url.startsWith(`/api/models/${modelId}/elements/`)) {
    const id = decodeURIComponent(url.split('/elements/')[1]?.split('?')[0] ?? '');
    return Response.json({
      element: { id, version: 1, node: model.graph.nodes?.[id] },
      warnings: [],
    });
  }
  return undefined;
};

const base = (space: 'viewing' | 'modelling') => `/${space}/models/${modelId}`;
const panel = () => screen.getByRole('complementary', { name: 'Elements and views' });
const legendHeader = () => within(panel()).queryByRole('button', { name: 'Legend' });
const canvasEl = () => document.getElementById('canvas') as HTMLElement;
const card = (id: string) => canvasEl().querySelector(`.card[data-element-id="${id}"]`);

async function openTill(space: 'viewing' | 'modelling' = 'viewing') {
  stubApi(space === 'viewing' ? viewer : modeller, api);
  renderAt(`${base(space)}/elements/till?depth=1`);
  await waitFor(() => {
    expect(card('stock')).toBeTruthy();
  });
}

describe('the left panel', () => {
  beforeEach(() => {
    views = [];
  });

  it('holds New element, search, the list, Views and the legend, in that order (Modelling)', async () => {
    await openTill('modelling');
    const parts = [
      within(panel()).getByRole('button', { name: /New element/ }),
      within(panel()).getByRole('searchbox', { name: 'Search elements' }),
      within(panel()).getByRole('tree', { name: 'Elements by type' }),
      within(panel()).getByRole('button', { name: 'Views' }),
      legendHeader() as HTMLElement,
    ];
    for (let index = 1; index < parts.length; index++) {
      const before = parts[index - 1] as HTMLElement;
      expect(
        before.compareDocumentPosition(parts[index] as HTMLElement) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
  });

  it('holds Views and the legend in one part that shares the space, with or without the legend', async () => {
    await openTill('modelling');
    const shared = panel().querySelector(':scope > .psecs') as HTMLElement;
    expect(shared).toBeTruthy();
    expect([...shared.children].map((part) => part.className)).toEqual([
      'psec views-sec',
      'psec legend',
    ]);
    expect(within(shared).getByRole('button', { name: 'Views' })).toBeTruthy();
    expect(within(shared).getByRole('button', { name: 'Legend' })).toBeTruthy();
    // The catalog has no legend: Views is alone in it.
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Show as' })).getByRole('button', {
        name: 'Catalog',
      }),
    );
    await screen.findByRole('grid');
    expect(
      [...(panel().querySelector(':scope > .psecs')?.children ?? [])].map((part) => part.className),
    ).toEqual(['psec views-sec']);
  });

  it('counts the views of an open folder as rows of the Views list, for its floor', async () => {
    // The floor's selectors read a folder's views as `li li`, there only while the folder is open.
    views = [1, 2, 3, 4, 5, 6].map((index) => view(index, 'Beds'));
    localStorage.setItem('sa-views-open', 'true');
    await openTill('modelling');
    const list = await within(panel()).findByRole('list', { name: 'Views in this model' });
    expect(list.querySelectorAll(':scope > li')).toHaveLength(1);
    expect(list.querySelectorAll('li li')).toHaveLength(6);
    expect(list.querySelector('li li:nth-child(2)')).toBeTruthy();
    expect(list.style.getPropertyValue('--vp-rows')).toBe('7');
    // New folder… follows the list.
    expect(list.nextElementSibling?.textContent).toBe('New folder…');
    fireEvent.click(within(list).getByRole('button', { name: /^Beds, folder/ }));
    expect(list.querySelectorAll('li li')).toHaveLength(0);
    expect(list.style.getPropertyValue('--vp-rows')).toBe('1');
  });

  it('has the legend, with its contents, in the panel and nothing of it on the canvas', async () => {
    await openTill();
    expect(canvasEl().querySelector('.legend')).toBeNull();
    const header = legendHeader() as HTMLElement;
    expect(header.getAttribute('aria-expanded')).toBe('true');
    const body = document.getElementById(header.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(
      within(body)
        .getAllByRole('heading')
        .map((h) => h.textContent),
    ).toEqual(['Elements', 'Relationship state']);
    expect(within(body).getByText('Application')).toBeTruthy();
    expect(within(body).getByRole('switch', { name: 'Nest contained elements' })).toBeTruthy();
    expect(within(body).getByRole('switch', { name: 'Show relationships' })).toBeTruthy();
  });

  it('opens and closes the legend with its header, remembered in this browser', async () => {
    await openTill();
    fireEvent.click(legendHeader() as HTMLElement);
    expect(legendHeader()?.getAttribute('aria-expanded')).toBe('false');
    expect(within(panel()).queryByRole('switch', { name: 'Show relationships' })).toBeNull();
    expect(localStorage.getItem('sa-legend-open')).toBe('false');
    fireEvent.click(legendHeader() as HTMLElement);
    expect(within(panel()).getByRole('switch', { name: 'Show relationships' })).toBeTruthy();
    expect(localStorage.getItem('sa-legend-open')).toBe('true');
  });

  it('shows no legend on the start page or in the catalog', async () => {
    stubApi(viewer, api);
    renderAt(base('viewing'));
    await screen.findByText('Choose an element to explore');
    expect(within(panel()).getByRole('button', { name: 'Views' })).toBeTruthy();
    expect(legendHeader()).toBeNull();
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Show as' })).getByRole('button', {
        name: 'Catalog',
      }),
    );
    await screen.findByRole('grid');
    expect(within(panel()).getByRole('button', { name: 'Views' })).toBeTruthy();
    expect(legendHeader()).toBeNull();
  });

  it('works the switches from the panel: Show relationships closes a line chooser', async () => {
    await openTill();
    await waitFor(() => {
      expect([...canvasEl().querySelectorAll('.edge-label')].map((l) => l.textContent)).toContain(
        '×2',
      );
    });
    const label = [...canvasEl().querySelectorAll<HTMLElement>('.edge-label')].find(
      (l) => l.textContent === '×2',
    ) as HTMLElement;
    fireEvent.click(label);
    await screen.findByRole('menu', { name: '2 relationships' });
    fireEvent.click(within(panel()).getByRole('switch', { name: 'Show relationships' }));
    await waitFor(() => {
      expect(canvasEl().querySelectorAll('.react-flow__edge')).toHaveLength(0);
    });
    expect(screen.queryByRole('menu', { name: '2 relationships' })).toBeNull();
  });

  it('hides Views and the legend with the panel, and the switches keep their state', async () => {
    await openTill();
    fireEvent.click(within(panel()).getByRole('switch', { name: 'Show relationships' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide the element list' }));
    expect(screen.queryByRole('complementary', { name: 'Elements and views' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Views' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Legend' })).toBeNull();
    expect(canvasEl().querySelectorAll('.react-flow__edge')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Show the element list' }));
    expect(
      within(panel()).getByRole<HTMLInputElement>('switch', { name: 'Show relationships' }).checked,
    ).toBe(false);
  });
});

describe('the panel styles', () => {
  const css = readFileSync(join(import.meta.dirname, '../src/styles/explorer.css'), 'utf8');
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  };

  it('let the list give way first, keeping 4 rows', () => {
    expect(rule('.tree')).toContain('flex: 0 100000 auto;');
    expect(rule('.tree')).toContain('min-height: min(120px, calc(var(--tree-rows, 4) * 30px));');
    expect(rule('.psec')).toContain('border-top: 1px solid var(--border);');
    expect(rule('.psec')).toContain('margin: 0 -12px;');
  });

  it('let Views and the legend take the rest of the panel and share it, the legend at the bottom', () => {
    const shared = rule('.tree-panel > .psecs');
    // It grows into the panel's free height and gives way after the element list.
    expect(shared).toContain('flex: 1 1 auto;');
    expect(shared).toContain('min-height: 0;');
    // Grid rows start at each section's floor and grow alike, each only up to its content, so
    // two long sections split the space evenly; what is left goes between them.
    expect(shared).toContain('display: grid;');
    expect(shared).toContain('align-content: space-between;');
    expect(shared).toContain('row-gap: 8px;');
    expect(shared).not.toContain('grid-template-rows');
    // An auto margin would keep the legend from stretching to its row, so it couldn't scroll.
    expect(css).not.toMatch(/\.psec\.legend \{[^}]*margin-top: auto/);
  });

  it('let the Views list grow with its rows, scrolling only when they do not fit, down to 3', () => {
    const list = rule('.psec-body > .vp-list');
    expect(list).not.toContain('max-height');
    expect(list).toContain('flex: 0 1 auto;');
    expect(list).toContain('overflow-y: auto;');
    expect(list).toContain('min-height: min(96px, calc(var(--vp-rows, 3) * 32px));');
    expect(rule('.psec-body.legend-body')).toContain('min-height: 96px;');
    expect(rule('.psec-body.legend-body')).toContain('overflow-y: auto;');
  });

  it('let the sections shrink below their content, keeping a header and 3 rows', () => {
    expect(rule('.psec-body')).toContain('min-height: 0;');
    expect(rule('.psecs > .psec.legend')).toContain('min-height: 34px;');
    expect(rule('.psecs > .psec.legend:has(> .psec-body)')).toContain(
      'min-height: calc(34px + 96px);',
    );
    // New folder… (Modelling) keeps its row too.
    expect(rule('.psecs > .views-sec').replace(/\s+/g, ' ')).toContain(
      'min-height: calc( 34px + var(--vs-list) + var(--vs-filter) + var(--vs-save) + var(--vs-new) + var(--vs-pad) );',
    );
    expect(rule('.psecs > .views-sec:has(.vf-new)')).toContain('--vs-new: 38px;');
    // Rows count across folders: a folder's header and the views of an open folder.
    const floor = (rows: number) =>
      new RegExp(`\\{\\s*--vs-list: ${String(rows * 32)}px;`).exec(css)?.index ?? -1;
    const selectorsOf = (rows: number) => {
      const end = floor(rows);
      return css
        .slice(css.lastIndexOf('}', end) + 1, end)
        .replace(/\s+/g, ' ')
        .trim();
    };
    expect(selectorsOf(2)).toBe(
      '.psecs > .views-sec:has(.vp-list > li:nth-child(2)), .psecs > .views-sec:has(.vp-list li li)',
    );
    expect(selectorsOf(3)).toBe(
      '.psecs > .views-sec:has(.vp-list > li:nth-child(3)), .psecs > .views-sec:has(.vp-list li li:nth-child(2)), .psecs > .views-sec:has(.vp-list > li:nth-child(2)):has(.vp-list li li)',
    );
  });

  it('drop the hover grey on view rows and folder headers while a view is dragged', () => {
    // Otherwise it covers the lit drop target's fill and part of its accent border.
    expect(css).toMatch(
      /\.psec-body\.is-dragging \.vp-list a:not\(\[aria-current='page'\]\):hover,\s*\.psec-body\.is-dragging \.vp-list \.vf-head:hover \{\s*background: none;/,
    );
  });
});
