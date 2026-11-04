import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

// Removing a card from the canvas: visual only, never a change to the model. Made-up data.

const api: Handler = ({ url, method }) => {
  if (method !== 'GET') return undefined;
  if (url === '/api/models') return Response.json({ models: [bakerySummary], editable: true });
  if (url === `/api/models/${bakeryId}`) return Response.json(bakeryModel);
  if (url.startsWith(`/api/models/${bakeryId}/elements/`)) {
    const id = decodeURIComponent(url.split('/elements/')[1]?.split('?')[0] ?? '');
    return Response.json({
      element: { id, version: 1, node: bakeryModel.graph.nodes?.[id] },
      warnings: [],
    });
  }
  return undefined;
};

const at = (space: 'viewing' | 'modelling') => `/${space}/models/${bakeryId}/elements/shop?depth=1`;
const canvasEl = () => document.getElementById('canvas') as HTMLElement;
const card = (id: string) =>
  canvasEl().querySelector<HTMLElement>(`.card[data-element-id="${CSS.escape(id)}"]`);
const removeButton = () =>
  screen.getByRole<HTMLButtonElement>('button', { name: 'Remove from canvas' });
const edges = () =>
  [...canvasEl().querySelectorAll('.react-flow__edge')].map((e) => e.getAttribute('aria-label'));
const tree = () => screen.getByRole('tree', { name: 'Elements by type' });
const dragType = 'application/x-simplearchitecture-element';
const dragged = (id: string) => ({
  types: [dragType],
  getData: (type: string) => (type === dragType ? id : ''),
});

async function open(space: 'viewing' | 'modelling') {
  const fetchMock = stubApi(space === 'viewing' ? viewer : modeller, api);
  renderAt(at(space));
  await waitFor(() => {
    expect(card('till')).toBeTruthy();
  });
  return fetchMock;
}

function select(id: string) {
  fireEvent.click(card(id)?.querySelector('.card-main') as HTMLElement);
}

async function removeTill() {
  select('till');
  await waitFor(() => {
    expect(removeButton().disabled).toBe(false);
  });
  fireEvent.click(removeButton());
  await waitFor(() => {
    expect(card('till')).toBeNull();
  });
}

describe.each(['viewing', 'modelling'] as const)('in %s', (space) => {
  it('takes the selected card and its lines off, with the element still in the list', async () => {
    const fetchMock = await open(space);
    await waitFor(() => {
      expect(edges().some((label) => label?.startsWith('Till '))).toBe(true);
    });
    await removeTill();
    expect(edges().some((label) => label?.startsWith('Till '))).toBe(false);
    expect(currentLocation()).toBe(at(space));
    expect(within(tree()).getAllByText('Till').length).toBeGreaterThan(0);
    expect(screen.getByText('Removed “Till” from the canvas. It stays in the model.')).toBeTruthy();
    // The selection goes back to the focus element, which can't be removed.
    expect(removeButton().disabled).toBe(true);
    expect(requests(fetchMock).filter((r) => !r.startsWith('GET '))).toEqual([]);
  });
});

describe('a removed card', () => {
  it('stays off through Tidy up and a change of depth', async () => {
    await open('viewing');
    await removeTill();
    // Another element dropped on the canvas is a moved card, so Tidy up can run.
    fireEvent.drop(canvasEl(), { dataTransfer: dragged('lonely'), clientX: 300, clientY: 200 });
    const tidy = screen.getByRole<HTMLButtonElement>('button', { name: 'Tidy up' });
    await waitFor(() => {
      expect(tidy.disabled).toBe(false);
    });
    fireEvent.click(tidy);
    await waitFor(() => {
      expect(tidy.disabled).toBe(true);
    });
    expect(card('till')).toBeNull();
    const depth = screen.getByRole('group', { name: 'Relationship depth' });
    fireEvent.click(within(depth).getByRole('button', { name: '2' }));
    await waitFor(() => {
      expect(within(depth).getByRole('button', { name: '2' }).getAttribute('aria-pressed')).toBe(
        'true',
      );
    });
    expect(card('lonely')).toBeTruthy();
    expect(card('till')).toBeNull();
  });

  it('comes back when dragged from the list onto the canvas', async () => {
    await open('viewing');
    await removeTill();
    fireEvent.drop(canvasEl(), { dataTransfer: dragged('till'), clientX: 200, clientY: 200 });
    await waitFor(() => {
      expect(card('till')).toBeTruthy();
    });
  });

  it('can never be the focus element', async () => {
    await open('viewing');
    select('shop');
    expect(removeButton().disabled).toBe(true);
  });
});
