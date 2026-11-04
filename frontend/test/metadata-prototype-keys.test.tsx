import type { JgfDocument } from '@simplearchitecture/shared';
import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { forgetElementFilters } from '../src/viewing/explorer/ElementTree';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { renderAt, stubApi, viewer } from './helpers';

// Custom metadata keys named like Object.prototype members. Made-up data only.

beforeEach(() => {
  forgetElementFilters();
});

describe('custom metadata keys named like Object.prototype members', () => {
  // `filters[field.key]` in ElementFilter.tsx read inherited members when the key was e.g.
  // "constructor" or "toString": picked.includes was not a function and the popover crashed.
  it('opens the value step of a custom field named "constructor"', async () => {
    const nodes = { ...bakeryModel.graph.nodes };
    const firstId = Object.keys(nodes)[0] ?? '';
    const first = nodes[firstId];
    if (first) nodes[firstId] = { ...first, metadata: { ...first.metadata, constructor: 'x' } };
    const model: JgfDocument = { ...bakeryModel, graph: { ...bakeryModel.graph, nodes } };
    stubApi(viewer, ({ url, method }) => {
      if (method !== 'GET') return undefined;
      if (url === '/api/models') return Response.json({ models: [bakerySummary] });
      if (url === `/api/models/${bakeryId}`) return Response.json(model);
      return undefined;
    });
    renderAt(`/viewing/models/${bakeryId}`);
    fireEvent.click(await screen.findByRole('button', { name: /^Filter elements/ }));
    const pop = screen.getByRole('dialog', { name: 'Filter elements' });
    fireEvent.click(within(pop).getByRole('button', { name: /^constructor/ }));
    expect(within(pop).getByRole('checkbox', { name: /^x,/ })).toBeTruthy();
  });
});
