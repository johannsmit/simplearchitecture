import type { JgfDocument, ModelSummary } from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

const api: Handler = ({ url, method }) => {
  if (method !== 'GET') return undefined;
  if (url === '/api/models') return Response.json({ models: [summary], editable: true });
  if (url === `/api/models/${modelId}`) return Response.json(model);
  if (url === `/api/models/${modelId}/views`) return Response.json({ views: [] });
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

  it('let the list give way first, keeping 4 rows, and keep the legend at the bottom', () => {
    expect(rule('.tree')).toContain('flex: 0 100000 auto;');
    expect(rule('.tree')).toContain('min-height: min(120px, calc(var(--tree-rows, 4) * 30px));');
    expect(rule('.tree-panel > .psec.legend')).toContain('margin-top: auto;');
    expect(rule('.psec')).toContain('border-top: 1px solid var(--border);');
    expect(rule('.psec')).toContain('margin: 0 -12px;');
  });

  it('let Views show up to 6 rows and the legend scroll inside, down to 3 rows', () => {
    expect(rule('.psec-body > .vp-list')).toContain('max-height: 192px;');
    expect(rule('.psec-body > .vp-list')).toContain(
      'min-height: min(96px, calc(var(--vp-rows, 3) * 32px));',
    );
    expect(rule('.psec-body.legend-body')).toContain('min-height: 96px;');
    expect(rule('.psec-body.legend-body')).toContain('overflow-y: auto;');
  });

  it('let the sections shrink below their content, keeping a header and 3 rows', () => {
    // Without these, a flex item's minimum is its whole content: the panel scrolls as a whole.
    expect(rule('.tree-panel > .psec')).toContain('min-height: 0;');
    expect(rule('.psec-body')).toContain('min-height: 0;');
    expect(rule('.tree-panel > .psec.legend:has(> .psec-body)')).toContain(
      'min-height: calc(34px + 96px);',
    );
    expect(rule('.tree-panel > .views-sec')).toContain(
      'min-height: calc(34px + var(--vs-list) + var(--vs-filter) + var(--vs-save) + var(--vs-pad));',
    );
    expect(rule('.tree-panel > .views-sec:has(.vp-list > li:nth-child(3))')).toContain(
      '--vs-list: 96px;',
    );
  });

  it('no longer float the legend over the canvas', () => {
    expect(css).not.toMatch(/\.legend \{[^}]*position: absolute/);
    expect(css).not.toMatch(/\.views-pop|\.views-btn|\.vp-title/);
  });
});

describe('the README and the Views guide', () => {
  const readme = readFileSync(join(import.meta.dirname, '../../README.md'), 'utf8');
  const guide = readFileSync(join(import.meta.dirname, '../../guide/views.md'), 'utf8');

  it('say where Views, the legend and the × are, with no toolbar buttons left', () => {
    for (const text of [readme, guide]) {
      expect(text).not.toContain('next to Canvas | Catalog');
      expect(text).not.toContain('+ Element');
      expect(text).toContain('at the bottom of the element list');
    }
    expect(readme).toContain('The legend, at the bottom of the left panel');
    expect(readme).toContain('`Tab` from a card reaches its remove button (×)');
    expect(readme).toContain('small × at its top-left corner');
    expect(readme).not.toContain('focus returns to the Views button');
    // The switch is "Show relationships", and no relationship is taken out of a view on its own.
    for (const text of [readme, guide]) {
      expect(text).not.toContain('Show lines');
      expect(text).toContain('Show relationships');
      expect(text).not.toMatch(/selected line's label/);
    }
    expect(readme).toMatch(/from the filter or the Views header, `↓` goes to the first/);
  });
});
