import { buildModelGraph, type JgfDocument } from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mergeRelationships } from '../src/viewing/explorer/canvas/view';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { renderAt, stubApi, viewer, type Handler } from './helpers';

// Two-way relationships on show. Made-up data: the bakery with "Hosted on"
// (e7, Web Shop – Back Office Server) made two-way.

const twoWayModel: JgfDocument = {
  graph: {
    ...bakeryModel.graph,
    edges: (bakeryModel.graph.edges ?? []).map((edge) =>
      edge.id === 'e7' ? { ...edge, directed: false } : edge,
    ),
  },
};

const api: Handler = ({ url, method }) => {
  if (method !== 'GET') return undefined;
  if (url === '/api/models') return Response.json({ models: [bakerySummary] });
  if (url === `/api/models/${bakeryId}`) return Response.json(twoWayModel);
  return undefined;
};

const details = () => screen.getByRole('complementary', { name: 'Details' });
const canvas = () => screen.getByRole('region', { name: /^Diagram:/ });

describe('two-way relationships on the canvas', () => {
  it('never merges a one-way and a two-way relationship into one line', () => {
    const graph = buildModelGraph({
      graph: {
        nodes: { a: { metadata: { type: 'Other' } }, b: { metadata: { type: 'Other' } } },
        edges: [
          { id: 'one', source: 'a', target: 'b', relation: 'Relation' },
          { id: 'two', source: 'a', target: 'b', relation: 'Relation', directed: false },
          { id: 'three', source: 'a', target: 'b', relation: 'Relation', directed: false },
        ],
      },
    });
    expect(
      mergeRelationships(graph.relationships).map((link) => [
        link.relationshipIds,
        link.twoWay,
        link.count,
      ]),
    ).toEqual([
      [['one'], false, 1],
      [['two', 'three'], true, 2],
    ]);
  });

  it('draws an arrow at both ends and says "both ways"; the legend no longer lists direction', async () => {
    stubApi(viewer, api);
    renderAt(`/viewing/models/${bakeryId}/elements/shop?depth=1`);
    await waitFor(() => {
      expect(canvas().querySelectorAll('.react-flow__edge').length).toBeGreaterThan(0);
    });
    const edge = [...canvas().querySelectorAll('.react-flow__edge')].find(
      (e) => e.getAttribute('aria-label') === 'Web Shop relates both ways to Back Office Server',
    );
    const path = edge?.querySelector('path.react-flow__edge-path');
    expect(path?.getAttribute('marker-start')).toBe('url(#sa-arrow)');
    expect(path?.getAttribute('marker-end')).toBe('url(#sa-arrow)');
    // A one-way line has an arrow at its target only.
    const oneWay = [...canvas().querySelectorAll('.react-flow__edge')].find(
      (e) => e.getAttribute('aria-label') === 'Web Shop relates to Oven Planner',
    );
    expect(oneWay?.querySelector('path.react-flow__edge-path')?.hasAttribute('marker-start')).toBe(
      false,
    );
    const legend = document.querySelector('.tree-panel .legend') as HTMLElement;
    expect(within(legend).queryByRole('heading', { name: 'Direction' })).toBeNull();
    expect(within(legend).queryByText('Both ways')).toBeNull();
  });
});

describe('two-way relationships in the details panel', () => {
  it('lists them under "both ways" with ↔, from either end', async () => {
    stubApi(viewer, api);
    renderAt(`/viewing/models/${bakeryId}/elements/server?depth=1`);
    await screen.findByRole('complementary', { name: 'Details' });
    const heading = await within(details()).findByRole('heading', {
      name: /^Relates both ways to/,
    });
    const group = heading.closest('.rgroup') as HTMLElement;
    expect(within(group).getByText('Web Shop')).toBeDefined();
    expect(group.querySelector('.rboth')?.textContent.trim()).toBe('↔');
    expect(
      within(group).getByRole('button', {
        name: /^Relates both ways to Web Shop, Application/,
      }),
    ).toBeDefined();
  });

  it('shows the relationship as both ways, between its two ends', async () => {
    stubApi(viewer, api);
    renderAt(`/viewing/models/${bakeryId}/elements/shop?depth=1`);
    await screen.findByRole('complementary', { name: 'Details' });
    fireEvent.click(
      await within(details()).findByRole('button', {
        name: /^Open relationship: Relates both ways to Back Office Server/,
      }),
    );
    expect(
      await within(details()).findByRole('heading', {
        name: 'Web Shop relates both ways to Back Office Server',
      }),
    ).toBeDefined();
    expect(within(details()).getByRole('button', { name: /^Between: Web Shop/ })).toBeDefined();
    expect(
      within(details()).getByRole('button', { name: /^And: Back Office Server/ }),
    ).toBeDefined();
    expect(within(details()).getByText('↔ Both ways')).toBeDefined();
  });
});
