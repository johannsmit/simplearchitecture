import {
  prototypeKeyMessage,
  type JgfDocument,
  type JgfEdge,
  type RelationshipPropertyDefinition,
} from '@simplearchitecture/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ImportPanel } from '../src/viewing/models/ImportPanel';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { addField, admin, modeller, renderAt, stubApi, type Handler } from './helpers';

// Property keys no property should have: blank, over 100 characters, or `__proto__`. Made-up
// data only.

const longKey = 'madeUpSupplierContractReference'.repeat(4);

const definitions: RelationshipPropertyDefinition[] = [
  { key: longKey, name: 'Made-up long', kind: 'text', fromModels: true, version: 1 },
  { key: '   ', name: 'Made-up blank', kind: 'text', fromModels: true, version: 1 },
];

/** The bakery, with e7 holding `metadata`; the PATCH bodies sent; the definitions above. */
function api(metadata: Record<string, unknown>) {
  const document: JgfDocument = {
    graph: {
      ...bakeryModel.graph,
      edges: (bakeryModel.graph.edges ?? []).map((edge): JgfEdge =>
        edge.id === 'e7' ? { ...edge, metadata } : edge,
      ),
    },
  };
  const sent: Record<string, unknown>[] = [];
  const handler: Handler = (request) => {
    if (request.url === '/api/models') {
      return Response.json({ models: [bakerySummary], editable: true });
    }
    if (request.url === '/api/properties') return Response.json({ properties: definitions });
    if (request.url === `/api/models/${bakeryId}`) return Response.json(document);
    const element = /\/elements\/([^/?]+)/.exec(request.url);
    if (element) {
      const id = decodeURIComponent(element[1] ?? '');
      if (request.method === 'PATCH' && typeof request.body === 'string') {
        sent.push(JSON.parse(request.body) as Record<string, unknown>);
      }
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

async function openRelationship(metadata: Record<string, unknown>) {
  const { handler, sent } = api(metadata);
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

describe('a blank or long property key on the relationship form', () => {
  it('changes and removes the values of defined properties with such keys, as stored', async () => {
    const { form, sent } = await openRelationship({
      [longKey]: 'Long value',
      '   ': 'Blank value',
    });
    const long = await within(form).findByRole<HTMLInputElement>('combobox', {
      name: 'Made-up long',
    });
    const blank = within(form).getByRole<HTMLInputElement>('combobox', { name: 'Made-up blank' });
    expect(long.value).toBe('Long value');
    expect(blank.value).toBe('Blank value');
    fireEvent.change(long, { target: { value: 'Changed' } });
    fireEvent.change(blank, { target: { value: '' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual({ version: 1, metadata: { [longKey]: 'Changed', '   ': null } });
  });

  it('never lets a blank key an import left block a save, and removes it', async () => {
    const { form, sent } = await openRelationship({ '': 'Empty key value', owner: 'Made-up' });
    expect(within(form).getByRole('group', { name: 'Custom metadata' })).toBeDefined();
    fireEvent.click(within(form).getByRole('button', { name: 'Remove the blank key' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual({ version: 1, metadata: { '': null } });
  });
});

describe('a custom key __proto__ on the element form', () => {
  it('is refused under its row with the server’s message, and nothing is sent', async () => {
    const { handler, sent } = api({});
    stubApi(modeller, handler);
    renderAt(`/modelling/models/${bakeryId}/elements/till`);
    const form = await screen.findByRole('form', { name: /^Edit / });
    addField(form, ' __proto__ ');
    fireEvent.change(within(form).getByRole('textbox', { name: 'Value of __proto__' }), {
      target: { value: 'Made-up' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(prototypeKeyMessage)).toBeDefined();
    expect(sent).toEqual([]);
  });
});

/** The bakery, with the till holding `metadata` besides its type; the PATCH bodies sent. */
function elementApi(metadata: Record<string, unknown>) {
  const nodes = bakeryModel.graph.nodes ?? {};
  const till = nodes.till;
  const document: JgfDocument = {
    graph: {
      ...bakeryModel.graph,
      nodes: {
        ...nodes,
        till: { ...till, metadata: { ...till?.metadata, ...metadata } },
      },
    },
  };
  const sent: Record<string, unknown>[] = [];
  const handler: Handler = (request) => {
    if (request.url === '/api/models') {
      return Response.json({ models: [bakerySummary], editable: true });
    }
    if (request.url === '/api/properties') return Response.json({ properties: [] });
    if (request.url === `/api/models/${bakeryId}`) return Response.json(document);
    const element = /\/elements\/([^/?]+)/.exec(request.url);
    if (element) {
      const id = decodeURIComponent(element[1] ?? '');
      if (request.method === 'PATCH' && typeof request.body === 'string') {
        sent.push(JSON.parse(request.body) as Record<string, unknown>);
      }
      return Response.json({
        element: { id, version: 1, node: document.graph.nodes?.[id] },
        warnings: [],
      });
    }
    return undefined;
  };
  return { handler, sent };
}

async function openElement(metadata: Record<string, unknown>) {
  const { handler, sent } = elementApi(metadata);
  stubApi(modeller, handler);
  renderAt(`/modelling/models/${bakeryId}/elements/till`);
  const form = await screen.findByRole('form', { name: /^Edit / });
  return { form, sent };
}

describe('a blank or long custom name on the element form', () => {
  it('changes and removes their values, sent under the names exactly as stored', async () => {
    const { form, sent } = await openElement({
      [longKey]: 'Long value',
      '   ': 'Blank value',
      ' padded ': 'Padded value',
    });
    const long = within(form).getByRole<HTMLInputElement>('combobox', {
      name: `Value of ${longKey}`,
    });
    expect(long.value).toBe('Long value');
    fireEvent.change(long, { target: { value: 'Changed' } });
    fireEvent.change(within(form).getByLabelText('Value of padded'), {
      target: { value: 'Changed padded' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Remove the blank key' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual({
      version: 1,
      metadata: { [longKey]: 'Changed', ' padded ': 'Changed padded', '   ': null },
    });
  });

  it('never lets a blank name an import left block a save', async () => {
    const { form, sent } = await openElement({ '': 'Empty name value' });
    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'Made-up till' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual({ version: 1, name: 'Made-up till' });
  });

  it('renames one: the stored name is removed and the typed one set', async () => {
    const { form, sent } = await openElement({ [longKey]: 'Long value' });
    const key = within(form)
      .getAllByLabelText('Key')
      .find((input) => (input as HTMLInputElement).value === longKey) as HTMLInputElement;
    fireEvent.change(key, { target: { value: ' warranty ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual({ version: 1, metadata: { warranty: 'Long value', [longKey]: null } });
  });
});

describe('the import result', () => {
  it('lists the keys it shortened or left out', () => {
    render(
      <MemoryRouter>
        <ImportPanel
          state={{
            kind: 'done',
            fileName: 'made-up.json',
            result: {
              model: bakerySummary,
              validation: {
                valid: true,
                errorCount: 0,
                warningCount: 0,
                errors: [],
                warnings: [],
                truncated: false,
                summary: {},
              },
              changedKeys: [
                { key: '  ', values: 3 },
                { key: `${longKey.slice(0, 100)}…`, storedAs: longKey.slice(0, 100), values: 2 },
              ],
            } as never,
          }}
          onDismiss={() => undefined}
          onChooseFile={() => undefined}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '2 property keys changed' }));
    const section = document.getElementById('import-section-changed-keys') as HTMLElement;
    expect(section.hasAttribute('open')).toBe(true);
    const rows = within(section)
      .getAllByRole('row')
      .map((row) => row.textContent);
    expect(rows).toEqual([
      'KeyWhat happenedValues',
      'BlankLeft out, with its values3',
      `${longKey.slice(0, 100)}…Shortened to ${longKey.slice(0, 100)}2`,
    ]);
  });

  it('lists the element names apart from the relationship keys', () => {
    render(
      <MemoryRouter>
        <ImportPanel
          state={{
            kind: 'done',
            fileName: 'made-up.json',
            result: {
              model: bakerySummary,
              validation: {
                valid: true,
                errorCount: 0,
                warningCount: 0,
                errors: [],
                warnings: [],
                truncated: false,
                summary: {},
              },
              changedKeys: [{ key: '  ', values: 3 }],
              changedElementKeys: [
                { key: '', values: 1 },
                { key: `${longKey.slice(0, 100)}…`, storedAs: longKey.slice(0, 100), values: 4 },
              ],
            } as never,
          }}
          onDismiss={() => undefined}
          onChooseFile={() => undefined}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '3 property keys changed' }));
    const section = document.getElementById('import-section-changed-keys') as HTMLElement;
    expect(section.hasAttribute('open')).toBe(true);
    const table = (caption: string) =>
      Array.from(
        within(section).getByRole('table', { name: caption }).querySelectorAll('tr'),
        (row) => row.textContent,
      );
    expect(table('On elements')).toEqual([
      'KeyWhat happenedValues',
      'BlankLeft out, with its values1',
      `${longKey.slice(0, 100)}…Shortened to ${longKey.slice(0, 100)}4`,
    ]);
    expect(table('On relationships')).toEqual([
      'KeyWhat happenedValues',
      'BlankLeft out, with its values3',
    ]);
  });
});

describe('Admin → Properties', () => {
  it('saves a property whose key is only spaces without sending a key change', async () => {
    const sent: { url: string; body: unknown }[] = [];
    stubApi(admin, (request) => {
      if (request.url === '/api/properties' && request.method === 'GET') {
        return Response.json({ properties: definitions });
      }
      if (request.url === '/api/properties/usage') {
        return Response.json({
          usage: definitions.map(({ key }) => ({
            key,
            // No values: the key could change, so the dialog checks it when it changed.
            relations: 0,
            contains: 0,
            models: 0,
            values: [],
            labels: 0,
          })),
        });
      }
      if (request.method === 'PATCH') {
        const body: unknown = JSON.parse(request.body as string);
        sent.push({ url: request.url, body });
        return Response.json({
          property: { ...definitions[1], name: 'Made-up spaces', fromModels: false, version: 2 },
        });
      }
      return undefined;
    });
    renderAt('/admin/properties');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Made-up blank' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Name/), {
      target: { value: 'Made-up spaces' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual({
      url: '/api/properties?key=%20%20%20',
      body: { version: 1, name: 'Made-up spaces', kind: 'text' },
    });
  });
});
