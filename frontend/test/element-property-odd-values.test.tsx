import {
  buildModelGraph,
  catalogTable,
  type ElementPropertyDefinition,
  type JgfDocument,
  type ModelSummary,
} from '@simplearchitecture/shared';
import { act, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DetailsPanel } from '../src/viewing/explorer/DetailsPanel';
import { forgetCatalogState } from '../src/viewing/explorer/catalog/Catalog';
import { catalogCsv } from '../src/viewing/explorer/catalog/csv';
import { modeller, renderAt, stubApi, type Handler } from './helpers';

// Values that don't fit their element property (objects, lists, numbers, true or false, a
// Reference under a choice, text under a Reference), and properties keyed like object members:
// every screen shows them as stored or as names, never as "[object Object]". Made-up data only.

const ref = (...ids: string[]) => ({ 'simplearchitecture:reference': ids });
const define = (
  key: string,
  name: string,
  kind: ElementPropertyDefinition['kind'],
  options?: string[],
): ElementPropertyDefinition => ({
  key,
  name,
  kind,
  ...(options === undefined ? {} : { options }),
  fromModels: true,
  version: 1,
});

const definitions = [
  define('settings', 'Settings', 'text'),
  define('ports', 'Ports', 'text'),
  define('owners', 'Owners', 'text'),
  define('rack', 'Rack', 'text'),
  define('active', 'Active', 'text'),
  define('tier', 'Tier', 'choice', ['Gold', 'Silver']),
  define('linked', 'Linked', 'reference'),
  define('constructor', 'Builder', 'text'),
  define('toString', 'Shown as', 'choice', ['Card']),
];

const modelId = '55555555-5555-4555-8555-555555555555';
const summary: ModelSummary = {
  id: modelId,
  name: 'Made-up lab',
  createdAt: '2026-11-01T09:00:00.000Z',
  createdBy: { id: 'u1', name: 'Made-up Person' },
  nodeCount: 2,
  edgeCount: 0,
};

const model: JgfDocument = {
  graph: {
    id: modelId,
    label: 'Made-up lab',
    nodes: {
      rig: {
        label: 'Test rig',
        metadata: {
          type: 'Infrastructure',
          settings: { mode: 'fast', level: 3 },
          ports: [{ port: 80 }, { port: 443 }],
          owners: ['Lab team', 'Night shift'],
          rack: 42,
          active: true,
          tier: ref('bench'),
          linked: 'Bench by name',
        },
      },
      bench: { label: 'Bench', metadata: { type: 'Other' } },
    },
  },
};

const objectText = /\[object Object\]|\[object /;

function handler(): Handler {
  return (request) => {
    if (request.url === '/api/models') {
      return Response.json({ models: [summary] });
    }
    if (request.url === `/api/models/${modelId}`) return Response.json(model);
    if (/\/views(\?|$)/.test(request.url)) return Response.json({ views: [] });
    if (request.url === '/api/properties') {
      return Response.json({ properties: [], elementProperties: definitions });
    }
    return undefined;
  };
}

describe('element property values that don’t fit', () => {
  beforeEach(() => {
    forgetCatalogState();
  });

  it('read as stored in the details panel, with object-member keys only where set', () => {
    const graph = buildModelGraph(model, [], definitions);
    const rig = graph.elements.get('rig');
    if (!rig) throw new Error('rig');
    render(<DetailsPanel graph={graph} element={rig} link="/x" onFocusElement={() => undefined} />);
    const text = document.body.textContent;
    expect(text).not.toMatch(objectText);
    expect(text).toContain('fast');
    expect(text).toContain('Lab team, Night shift');
    expect(text).toContain('42');
    expect(text).toContain('Bench by name');
    const rowOf = (name: string) =>
      [...document.querySelectorAll('dl.props > div')].find(
        (row) => row.querySelector('dt')?.textContent === name,
      );
    // `constructor` and `toString` are members of every object, not values of this element.
    expect(rowOf('Builder')?.querySelector('dd')?.textContent).toBe('Not set');
    expect(rowOf('Shown as')?.querySelector('dd')?.textContent).toBe('Not set');
  });

  it('read as stored in the catalog and its CSV', () => {
    const graph = buildModelGraph(model, [], definitions);
    const table = catalogTable(
      [...graph.elements.values()],
      'Infrastructure',
      undefined,
      graph.elements,
      definitions,
    );
    const csv = catalogCsv(table.columns, [...graph.elements.values()], graph.elements);
    expect(csv).not.toMatch(objectText);
    expect(csv).toContain('Lab team, Night shift');
    expect(csv).toContain('Bench');
    const cells = table.rows[0]?.cells.map((cell) => cell.text) ?? [];
    expect(cells.join(' | ')).not.toMatch(objectText);
  });

  it('are kept as is on the element form, never shown as [object Object]', async () => {
    stubApi(modeller, handler());
    renderAt(`/modelling/models/${modelId}/elements/rig`);
    const form = await screen.findByRole('form', { name: /^Edit / });
    await act(async () => {
      await Promise.resolve();
    });
    expect(form.textContent).not.toMatch(objectText);
    for (const input of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      'input, select, textarea',
    )) {
      expect(input.value).not.toMatch(objectText);
    }
    expect(within(form).getByRole('group', { name: 'Settings' }).textContent).toContain(
      'Not text, kept as is',
    );
    expect(within(form).getByRole('group', { name: 'Tier' }).textContent).toContain(
      'Elements: Bench',
    );
    expect(within(form).getByRole('group', { name: 'Linked' }).textContent).toContain(
      'Not a reference, kept as is',
    );
    expect(within(form).getByRole<HTMLInputElement>('combobox', { name: 'Rack' }).value).toBe('42');
    expect(within(form).getByLabelText<HTMLInputElement>('Builder').value).toBe('');
    expect(within(form).getByRole<HTMLSelectElement>('combobox', { name: 'Shown as' }).value).toBe(
      '',
    );
  });
});
