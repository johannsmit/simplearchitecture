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
        metadata: { ...bakeryModel.graph.nodes?.shop?.metadata, ...metadata },
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
      return Response.json({ models: [bakerySummary], editable: true });
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

function addRow(form: HTMLElement, key: string, value: string) {
  fireEvent.click(within(form).getByRole('button', { name: 'Add field' }));
  const keys = within(form).getAllByLabelText('Key');
  fireEvent.change(keys.at(-1) as HTMLElement, { target: { value: key } });
  const name = `Value of ${key}`;
  const field =
    within(form).queryByRole('textbox', { name }) ?? within(form).getByRole('combobox', { name });
  fireEvent.change(field, { target: { value } });
}

const save = (form: HTMLElement) => {
  fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
};

describe.each(['element', 'relationship'] as const)('on the %s form', (kind) => {
  it('keeps a stored number and true or false when a row equal to them is taken', async () => {
    const { form, sent } = await openForm(kind);
    typeAndTake(form, 'port', '80', '8080');
    typeAndTake(form, 'flag', 'tr', 'true');
    expect(valueOf(form, 'port').value).toBe('8080');
    // Nothing differs from what is stored, so there is nothing to save.
    expect(within(form).queryByRole('button', { name: 'Save' })).toBeNull();

    addRow(form, 'zone', 'North');
    save(form);
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.metadata).toEqual({ zone: 'North' });
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

  // A known gap, so expected to fail: assigning `__proto__` on a plain object does nothing, so the
  // typed value is never sent, and nothing says so.
  it.fails('says something about a value typed under the key __proto__', async () => {
    const { form } = await openForm(kind);
    addRow(form, '__proto__', 'Made-up');
    const save = within(form).queryByRole('button', { name: 'Save' });
    if (save) fireEvent.click(save);
    expect(await within(form).findByText(/reserved/, {}, { timeout: 300 })).toBeDefined();
  });
});

describe('odd values', () => {
  it('shows HTML in a value as text, in the row and its title', async () => {
    const { form } = await openForm('element');
    addRow(form, 'html', '<');
    const option = screen.getByRole('option', { name: html });
    expect(option.textContent).toBe(html);
    expect(option.getAttribute('title')).toBe(html);
    expect(option.querySelector('img, b')).toBeNull();
  });
});
