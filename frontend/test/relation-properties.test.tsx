import type { JgfDocument, JgfEdge } from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { modeller, renderAt, stubApi, viewer, type Handler } from './helpers';

// Identity, Identity Context, Request Data and Response Data on the relationship form and in the
// details panel. Made-up data.

const model = (): JgfDocument => ({
  graph: {
    ...bakeryModel.graph,
    edges: (bakeryModel.graph.edges ?? []).map((edge): JgfEdge => {
      if (edge.id === 'e7') return { ...edge, metadata: { identity: 'svc-shop' } };
      if (edge.id === 'e8' || edge.id === 'e9') {
        return { ...edge, metadata: { ...edge.metadata, requestData: 'Orders' } };
      }
      return edge;
    }),
  },
});

function api() {
  const document = model();
  const sent: Record<string, unknown>[] = [];
  const handler: Handler = (request) => {
    if (request.url === '/api/models') {
      return Response.json({ models: [bakerySummary], editable: true });
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

const at = (space: string) => `/${space}/models/${bakeryId}/elements/shop?depth=1`;
const details = () => screen.getByRole('complementary', { name: 'Details' });

async function openHostedOn(space: 'modelling' | 'viewing') {
  const { handler, sent } = api();
  stubApi(space === 'modelling' ? modeller : viewer, handler);
  renderAt(at(space));
  await screen.findByRole('heading', { level: 2, name: 'Web Shop' });
  fireEvent.click(
    within(details()).getAllByRole('button', {
      name: /^Open relationship: Relates to Back Office Server/,
    })[0] as HTMLElement,
  );
  return { sent };
}

describe('on the relationship form', () => {
  it('shows the four under the label, with suggestions, and saves only what changed', async () => {
    const { sent } = await openHostedOn('modelling');
    const form = await screen.findByRole('form', { name: /^Relationship / });
    const labels = [...form.querySelectorAll('label')].map((label) => label.textContent);
    expect(labels.slice(0, 5)).toEqual([
      'Label',
      'Identity',
      'Identity Context',
      'Request Data',
      'Response Data',
    ]);
    expect(labels).not.toContain('Data');
    const identity = within(form).getByRole<HTMLInputElement>('combobox', { name: 'Identity' });
    expect(identity.value).toBe('svc-shop');
    // Both offer the values either has in the model: the values Data had.
    for (const name of ['Request Data', 'Response Data']) {
      fireEvent.click(within(form).getByRole('combobox', { name }));
      expect(
        within(screen.getByRole('listbox', { name: `Suggestions for ${name}` }))
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['Orders', 'Places orders']);
      fireEvent.click(screen.getByRole('option', { name: 'Orders' }));
    }
    fireEvent.change(identity, { target: { value: '  ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual({
      version: 1,
      identity: null,
      requestData: 'Orders',
      responseData: 'Orders',
    });
  });

  it('has none of them on a Contains, and says they go when the type changes', async () => {
    await openHostedOn('modelling');
    const form = await screen.findByRole('form', { name: /^Relationship / });
    fireEvent.click(within(form).getByRole('radio', { name: /^Contains/ }));
    expect(within(form).queryByRole('combobox', { name: 'Identity' })).toBeNull();
    expect(within(form).queryByRole('combobox', { name: 'Request Data' })).toBeNull();
    expect(within(form).queryByRole('combobox', { name: 'Response Data' })).toBeNull();
    expect(
      within(form).getByText(
        'Identity, Identity Context, Request Data and Response Data are removed when you save.',
      ),
    ).toBeTruthy();
  });

  it.each([
    ['identityContext', '“identityContext” is a standard property of a Relation.'],
    ['requestData', '“requestData” is a standard property of a Relation.'],
    ['responseData', '“responseData” is a standard property of a Relation.'],
    ['data', '“data” is reserved: Data is now Request Data and Response Data.'],
  ])('refuses a custom row with the key %s', async (key, message) => {
    const { sent } = await openHostedOn('modelling');
    const form = await screen.findByRole('form', { name: /^Relationship / });
    fireEvent.click(within(form).getByRole('button', { name: 'Add field' }));
    fireEvent.change(within(form).getAllByLabelText('Key').at(-1) as HTMLElement, {
      target: { value: key },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(message)).toBeTruthy();
    expect(sent).toEqual([]);
  });
});

describe('in the details panel', () => {
  it('lists them with the properties of a Relation, not as custom metadata', async () => {
    await openHostedOn('viewing');
    const panel = await waitFor(() => {
      const heading = within(details()).getByRole('heading', { name: 'Properties' });
      return heading.closest('section') as HTMLElement;
    });
    const terms = [...panel.querySelectorAll('dt')].map((dt) => dt.textContent);
    expect(terms).toEqual(
      expect.arrayContaining(['Identity', 'Identity Context', 'Request Data', 'Response Data']),
    );
    const value = (term: string) =>
      [...panel.querySelectorAll('dt')].find((dt) => dt.textContent === term)?.nextElementSibling
        ?.textContent;
    expect(value('Identity')).toBe('svc-shop');
    expect(value('Request Data')).toBe('Not set');
    expect(value('Response Data')).toBe('Not set');
    expect(terms).not.toContain('Data');
    expect(within(details()).queryByRole('heading', { name: /^Custom metadata/ })).toBeNull();
  });
});
