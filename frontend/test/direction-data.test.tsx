import type { JgfDocument, JgfEdge } from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { modeller, renderAt, stubApi, type Handler } from './helpers';

// A Relation's two lists are named by direction (Source to target data, Target to source data), so
// reversing it on the form swaps them along with its ends. Made-up data.

const model = (opened: Record<string, unknown>): JgfDocument => ({
  graph: {
    ...bakeryModel.graph,
    edges: (bakeryModel.graph.edges ?? []).map((edge): JgfEdge =>
      edge.id === 'e7' ? { ...edge, metadata: opened } : edge,
    ),
  },
});

function api(opened: Record<string, unknown>) {
  const document = model(opened);
  const sent: Record<string, unknown>[] = [];
  const handler: Handler = (request) => {
    if (request.url === '/api/models') {
      return Response.json({ models: [bakerySummary] });
    }
    if (request.url === `/api/models/${bakeryId}`) return Response.json(document);
    const element = /\/elements\/([^/?]+)/.exec(request.url);
    if (element) {
      const id = decodeURIComponent(element[1] ?? '');
      return Response.json({
        element: { id, version: 1, node: document.graph.nodes?.[id] },
        warnings: [],
      });
    }
    const relationship = /\/relationships\/([^/?]+)/.exec(request.url);
    if (relationship) {
      const id = decodeURIComponent(relationship[1] ?? '');
      const edge = (document.graph.edges ?? []).find((candidate) => candidate.id === id);
      if (request.method === 'PATCH' && typeof request.body === 'string') {
        sent.push(JSON.parse(request.body) as Record<string, unknown>);
      }
      return Response.json({
        relationship: { id, version: 1, edge },
        warnings: [],
        nestingChanges: [],
      });
    }
    return undefined;
  };
  return { handler, sent };
}

const details = () => screen.getByRole('complementary', { name: 'Details' });

async function openForm(opened: Record<string, unknown>) {
  const { handler, sent } = api(opened);
  stubApi(modeller, handler);
  renderAt(`/modelling/models/${bakeryId}/elements/shop?depth=1`);
  await screen.findByRole('heading', { level: 2, name: 'Web Shop' });
  fireEvent.click(
    within(details()).getAllByRole('button', {
      name: /^Open relationship: Relates to Back Office Server/,
    })[0] as HTMLElement,
  );
  const form = await screen.findByRole('form', { name: /^Relationship / });
  return { form, sent };
}

// The fields by their stored key: their names follow the ends (data-by-direction.test.tsx).
const forward = 'sourceToTargetData';
const backward = 'targetToSourceData';

const fieldOf = (form: HTMLElement, key: string) =>
  form.querySelector(`#rf-${key}`)?.closest('.field') ?? null;
const texts = (form: HTMLElement, key: string) =>
  [...(fieldOf(form, key)?.querySelectorAll('.chip-text') ?? [])].map((chip) => chip.textContent);

describe('the relationship form', () => {
  it('swaps the two lists on Reverse, and back, and saves only the reverse', async () => {
    const { form, sent } = await openForm({
      sourceToTargetData: ['Orders'],
      targetToSourceData: ['Order ids'],
    });
    const reverse = within(details()).getByRole('button', { name: 'Reverse direction' });
    fireEvent.click(reverse);
    expect(texts(form, forward)).toEqual(['Order ids']);
    expect(texts(form, backward)).toEqual(['Orders']);
    fireEvent.click(reverse);
    expect(texts(form, forward)).toEqual(['Orders']);
    fireEvent.click(reverse);
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    // The server swaps the lists with the ends.
    expect(sent[0]).toEqual({ version: 1, reverse: true });
  });

  it('saves Reverse at once, and a list changed after it as the list after the swap', async () => {
    const { form, sent } = await openForm({ sourceToTargetData: ['Orders'] });
    fireEvent.click(within(details()).getByRole('button', { name: 'Reverse direction' }));
    expect(texts(form, forward)).toEqual([]);
    expect(texts(form, backward)).toEqual(['Orders']);
    const field = form.querySelector(`#rf-${forward}`) as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Stock' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    // The server swapped the lists with the ends; the list added to after it goes as it is.
    expect(sent).toEqual([
      { version: 1, reverse: true },
      { version: 1, sourceToTargetData: ['Stock'] },
    ]);
  });

  it('saves Reverse, then a new end of the reversed relationship, leaving the swapped lists', async () => {
    const { form, sent } = await openForm({
      sourceToTargetData: ['Orders'],
      targetToSourceData: ['Order ids'],
    });
    fireEvent.click(within(details()).getByRole('button', { name: 'Reverse direction' }));
    fireEvent.click(within(details()).getByRole('button', { name: /^To: Web Shop/ }));
    fireEvent.click(
      within(within(details()).getByRole('listbox')).getByRole('option', { name: /^Till/ }),
    );
    expect(texts(form, forward)).toEqual(['Order ids']);
    await waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(sent).toEqual([
      { version: 1, reverse: true },
      { version: 1, target: 'till' },
    ]);
    expect(texts(form, forward)).toEqual(['Order ids']);
  });

  it('swaps them back when the relationship becomes two-way, which drops Reverse', async () => {
    const { form } = await openForm({ sourceToTargetData: ['Orders'] });
    fireEvent.click(within(details()).getByRole('button', { name: 'Reverse direction' }));
    expect(texts(form, backward)).toEqual(['Orders']);
    fireEvent.click(within(details()).getByRole('radio', { name: /Both ways/ }));
    expect(texts(form, forward)).toEqual(['Orders']);
    expect(texts(form, backward)).toEqual([]);
  });
});
