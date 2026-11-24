import type { JgfDocument, JgfEdge } from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { modeller, renderAt, stubApi, type Handler } from './helpers';

// A typed value is never changed or lost, and a stored number stays one. Made-up data.

const shopEdge = 'e9';
const metadata = { port: 8080, flag: true };
const html = '<img src=x onerror="window.madeUp=1"><b>bold</b>';

const model = (): JgfDocument => ({
  graph: {
    ...bakeryModel.graph,
    nodes: {
      ...bakeryModel.graph.nodes,
      shop: {
        ...bakeryModel.graph.nodes?.shop,
        metadata: { ...bakeryModel.graph.nodes?.shop?.metadata, ...metadata, html: 'plain' },
      },
      till: {
        ...bakeryModel.graph.nodes?.till,
        metadata: { ...bakeryModel.graph.nodes?.till?.metadata, port: 443, flag: false, html },
      },
    },
    edges: (bakeryModel.graph.edges ?? []).map((edge): JgfEdge => {
      if (edge.id === shopEdge) {
        return { ...edge, metadata: { ...edge.metadata, port: 8080, flag: true } };
      }
      if (edge.id === 'e7')
        return { ...edge, metadata: { ...edge.metadata, port: 443, flag: false } };
      return edge;
    }),
  },
});

function api() {
  const document = model();
  const sent: Record<string, unknown>[] = [];
  const handler: Handler = (request) => {
    const body = (typeof request.body === 'string' ? JSON.parse(request.body) : {}) as Record<
      string,
      unknown
    >;
    if (request.url === '/api/models') {
      return Response.json({ models: [bakerySummary] });
    }
    if (request.url === `/api/models/${bakeryId}`) return Response.json(document);
    if (request.method === 'PATCH') sent.push(body);
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

const at = `/modelling/models/${bakeryId}/elements/shop?depth=1`;

async function openForm(kind: 'element' | 'relationship') {
  const { handler, sent } = api();
  stubApi(modeller, handler);
  renderAt(at);
  const elementForm = await screen.findByRole('form', { name: /^Edit / });
  if (kind === 'element') return { form: elementForm, sent };
  const details = screen.getByRole('complementary', { name: 'Details' });
  // e7 and then e9 relate the shop to the server: e9 is the one under test.
  fireEvent.click(
    within(details).getAllByRole('button', {
      name: /^Open relationship: Relates to Back Office Server/,
    })[1] as HTMLElement,
  );
  return { form: await screen.findByRole('form', { name: /^Relationship / }), sent };
}

const valueOf = (form: HTMLElement, key: string) =>
  within(form).getByRole<HTMLInputElement>('combobox', { name: `Value of ${key}` });

/** Types the start of a value, then takes the row with this text, as a person would. */
function typeAndTake(form: HTMLElement, key: string, typed: string, row: string) {
  const field = valueOf(form, key);
  fireEvent.change(field, { target: { value: typed } });
  fireEvent.click(screen.getByRole('option', { name: row }));
}

const save = (form: HTMLElement) => {
  fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
};

describe.each(['element', 'relationship'] as const)('on the %s form', (kind) => {
  it('keeps a stored number and true or false when a row equal to them is taken', async () => {
    const { form, sent } = await openForm(kind);
    typeAndTake(form, 'port', '80', '8080');
    typeAndTake(form, 'flag', 'tr', 'true');
    expect(valueOf(form, 'port').value).toBe('8080');
    // Nothing differs from what is stored, so there is nothing to save.
    expect(within(form).queryByRole('button', { name: 'Save' })).toBeNull();

    // Only the row that changes is sent. Neither form takes new keys: a stored row changes.
    fireEvent.change(valueOf(form, 'flag'), { target: { value: 'North' } });
    save(form);
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.metadata).toEqual({ flag: 'North' });
  });

  it('stores another row as text, exactly as typing it would', async () => {
    const { form, sent } = await openForm(kind);
    typeAndTake(form, 'port', '4', '443');
    save(form);
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.metadata).toEqual({ port: '443' });
  });

  // Assigning `__proto__` on a plain object does nothing, so a typed value was never sent, and
  // nothing said so. Neither form takes typed keys now (an Admin defines them, and Admin →
  // Properties refuses this one with the server's message).
  it('takes no typed key, so no value can go under __proto__', async () => {
    const { form } = await openForm(kind);
    expect(within(form).queryByRole('button', { name: 'Add field' })).toBeNull();
    expect(within(form).queryByLabelText('Key')).toBeNull();
  });
});

describe('odd values', () => {
  it('shows HTML in a value as text, in the row and its title', async () => {
    const { form } = await openForm('element');
    fireEvent.change(valueOf(form, 'html'), { target: { value: '<' } });
    const option = screen.getByRole('option', { name: html });
    expect(option.textContent).toBe(html);
    expect(option.getAttribute('title')).toBe(html);
    expect(option.querySelector('img, b')).toBeNull();
  });
});
