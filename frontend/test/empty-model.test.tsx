import type { ModelSummary } from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { currentLocation, modeller, renderAt, stubApi, type Handler } from './helpers';

// An empty model opens in the normal explorer, in Viewing and Modelling.
// Made-up data only.

const emptyId = '55555555-5555-4555-8555-555555555555';
const summary: ModelSummary = {
  id: emptyId,
  name: 'Made-up empty model',
  createdAt: '2026-10-30T09:00:00.000Z',
  createdBy: { id: 'u1', name: 'Alex Morgan' },
  nodeCount: 0,
  edgeCount: 0,
};

function api(editable: boolean): Handler {
  return ({ url, method, body }) => {
    if (url === '/api/models' && method === 'GET') {
      return Response.json({ models: [summary], editable });
    }
    if (url === `/api/models/${emptyId}` && method === 'GET') {
      return Response.json({
        graph: { id: emptyId, label: summary.name, directed: true, nodes: {}, edges: [] },
      });
    }
    if (url === `/api/models/${emptyId}/elements` && method === 'POST') {
      const { name, type } = JSON.parse(body as string) as { name: string; type: string };
      return Response.json(
        {
          element: { id: 'first', version: 1, node: { label: name, metadata: { type } } },
          warnings: [],
        },
        { status: 201 },
      );
    }
    if (url === `/api/models/${emptyId}/elements/first` && method === 'GET') {
      return Response.json({
        element: {
          id: 'first',
          version: 1,
          node: { label: 'First app', metadata: { type: 'Application' } },
        },
        warnings: [],
      });
    }
    return undefined;
  };
}

const list = () => screen.getByRole('complementary', { name: 'Elements and views' });

describe('an empty model', () => {
  it('opens in Modelling with the empty states, and New element adds the first element', async () => {
    stubApi(modeller, api(true));
    renderAt(`/modelling/models/${emptyId}`);

    expect(
      await screen.findByRole('heading', { name: 'This model has no elements yet' }),
    ).toBeTruthy();
    expect(screen.getByText('Add the first one with New element.')).toBeTruthy();
    expect(
      within(list()).getByText('No elements yet. Add the first one with New element.'),
    ).toBeTruthy();
    expect(within(list()).getByRole('button', { name: 'New element' })).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryByRole('searchbox', { name: 'Search elements' })).toBeNull();
    expect(document.querySelector('.suggestions')).toBeNull();

    fireEvent.click(within(list()).getByRole('button', { name: 'New element' }));
    const pop = screen.getByRole('dialog', { name: 'New element' });
    fireEvent.change(within(pop).getByRole('textbox', { name: /^Name/ }), {
      target: { value: 'First app' },
    });
    fireEvent.click(within(pop).getByRole('radio', { name: 'Application' }));
    fireEvent.submit(pop.querySelector('form') as HTMLFormElement);

    await waitFor(() => {
      expect(currentLocation()).toContain('/elements/first');
    });
    const tree = await screen.findByRole('tree', { name: 'Elements by type' });
    expect(within(tree).getByRole('treeitem', { name: 'First app', selected: true })).toBeTruthy();
    expect(screen.queryByText(/No elements yet/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'This model has no elements yet' })).toBeNull();
  });

  it('opens in Modelling with editing off, read-only', async () => {
    stubApi(modeller, api(false));
    renderAt(`/modelling/models/${emptyId}`);

    expect(
      await screen.findByRole('heading', { name: 'This model has no elements yet' }),
    ).toBeTruthy();
    expect(screen.getByText('Elements added in Modelling show here.')).toBeTruthy();
    expect(within(list()).getByText('Editing is off: it needs a database.')).toBeTruthy();
    expect(within(list()).getByText('No elements yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New element' })).toBeNull();
  });

  it('asks to show the list first when it is hidden', async () => {
    stubApi(modeller, api(true));
    renderAt(`/modelling/models/${emptyId}`);
    await screen.findByRole('heading', { name: 'This model has no elements yet' });

    fireEvent.click(screen.getByRole('button', { name: /^Hide (the )?element list/i }));
    expect(await screen.findByText('Show the element list, then use New element.')).toBeTruthy();
  });
});

// The empty states also come back after the last element is deleted.
describe('a model whose last element is deleted', () => {
  const onlyId = '66666666-6666-4666-8666-666666666666';
  const onlySummary: ModelSummary = { ...summary, id: onlyId, nodeCount: 1 };
  const onlyNode = { label: 'Only app', metadata: { type: 'Application' } };

  it('shows the empty states at once in Modelling', async () => {
    const deleted: string[] = [];
    stubApi(modeller, ({ url, method }) => {
      if (url === '/api/models' && method === 'GET') {
        return Response.json({ models: [onlySummary], editable: true });
      }
      if (url === `/api/models/${onlyId}` && method === 'GET') {
        return Response.json({
          graph: {
            id: onlyId,
            label: onlySummary.name,
            directed: true,
            nodes: { only: onlyNode },
            edges: [],
          },
        });
      }
      if (url === `/api/models/${onlyId}/elements/only` && method === 'GET') {
        return Response.json({ element: { id: 'only', version: 1, node: onlyNode }, warnings: [] });
      }
      if (url.startsWith(`/api/models/${onlyId}/elements/only?`) && method === 'DELETE') {
        deleted.push(url);
        return Response.json({
          id: 'only',
          deletedRelationshipCount: 0,
          deletedRelationshipIds: [],
          unnestedElementIds: [],
        });
      }
      return undefined;
    });
    renderAt(`/modelling/models/${onlyId}/elements/only`);

    const details = await screen.findByRole('complementary', { name: 'Details' });
    await screen.findByRole('form', { name: 'Edit Only app' });
    fireEvent.click(within(details).getByRole('button', { name: 'Delete element' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete “Only app”?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete element' }));

    expect(
      await screen.findByRole('heading', { name: 'This model has no elements yet' }),
    ).toBeTruthy();
    expect(deleted).toEqual([`/api/models/${onlyId}/elements/only?version=1`]);
    expect(
      within(list()).getByText('No elements yet. Add the first one with New element.'),
    ).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryByRole('searchbox', { name: 'Search elements' })).toBeNull();
    expect(within(list()).getByRole('button', { name: 'New element' })).toBeTruthy();
  });
});
