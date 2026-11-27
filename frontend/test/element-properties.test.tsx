import {
  buildModelGraph,
  catalogTable,
  type ElementPropertyDefinition,
  type ElementPropertyUsage,
  type JgfDocument,
  type ModelSummary,
} from '@simplearchitecture/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DetailsPanel } from '../src/viewing/explorer/DetailsPanel';
import { forgetCatalogState } from '../src/viewing/explorer/catalog/Catalog';
import { catalogCsv } from '../src/viewing/explorer/catalog/csv';
import { ReportSections, summaryChips } from '../src/viewing/models/ImportReport';
import { admin, modalDialogs, modeller, renderAt, stubApi, type Handler } from './helpers';

// Element properties an Admin defines: Admin → Properties' element list, the element form and
// details panel, the catalog and the import report. Made-up model and names only.

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
  fromModels: false,
  version: 1,
});

const costCentre = define('costCentre', 'Cost centre', 'text');
const dependsOn = define('dependsOn', 'Depends on', 'reference');
const stage = define('stage', 'Lifecycle stage', 'choice', ['Plan', 'Run', 'Retire']);
const hostedOn = { ...define('hostedOn', 'hostedOn', 'text'), fromModels: true };
const definitions = [costCentre, dependsOn, hostedOn, stage];

const modelId = '44444444-4444-4444-8444-444444444444';
const summary: ModelSummary = {
  id: modelId,
  name: 'Made-up claims',
  createdAt: '2026-11-01T09:00:00.000Z',
  createdBy: { id: 'u1', name: 'Alex Morgan' },
  nodeCount: 4,
  edgeCount: 0,
};

const model: JgfDocument = {
  graph: {
    id: modelId,
    label: 'Made-up claims',
    nodes: {
      workbench: {
        label: 'Claims workbench',
        metadata: {
          type: 'Application',
          sourcing: 'Buy',
          functions: ['Claims intake'],
          costCentre: 'CC-410',
          dependsOn: ref('hub'),
          hostedOn: ref('cloud'),
          stage: 'Sunset',
        },
      },
      hub: { label: 'Payment hub', metadata: { type: 'Application' } },
      cloud: { label: 'Cloud platform', metadata: { type: 'Infrastructure' } },
      desk: { label: 'Claims desk', metadata: { type: 'Other', sourcing: 'Build' } },
    },
  },
};

const elementsUrl = `/api/models/${modelId}/elements`;

function api() {
  const nodes = new Map(Object.entries(model.graph.nodes ?? {}));
  const patches: unknown[] = [];
  const handler: Handler = (request) => {
    const body: unknown = typeof request.body === 'string' ? JSON.parse(request.body) : undefined;
    if (request.url === '/api/models') {
      return Response.json({ models: [summary] });
    }
    if (request.url === `/api/models/${modelId}`) return Response.json(model);
    if (/\/views(\?|$)/.test(request.url)) return Response.json({ views: [] });
    if (request.url === '/api/properties') {
      return Response.json({ properties: [], elementProperties: definitions });
    }
    if (!request.url.startsWith(elementsUrl)) return undefined;
    const id = decodeURIComponent(request.url.slice(elementsUrl.length + 1).split('?')[0] ?? '');
    if (request.method === 'PATCH') {
      patches.push(body);
      const change = body as { metadata?: Record<string, unknown>; type?: string };
      const node = nodes.get(id) ?? {};
      const typed: Record<string, unknown> = {};
      if (typeof change.type === 'string') typed.type = change.type;
      const metadata = Object.fromEntries(
        Object.entries({ ...node.metadata, ...change.metadata, ...typed }).filter(
          ([, value]) => value !== null,
        ),
      );
      nodes.set(id, { ...node, metadata });
    }
    return Response.json({
      element: { id, version: patches.length + 1, node: nodes.get(id) },
      warnings: [],
    });
  };
  return { handler, patches };
}

async function openForm(id: string) {
  const server = api();
  stubApi(modeller, server.handler);
  renderAt(`/modelling/models/${modelId}/elements/${id}`);
  const form = await screen.findByRole('form', { name: /^Edit / });
  await act(async () => {
    await Promise.resolve();
  });
  return { form, ...server };
}

const labelsIn = (block: HTMLElement) =>
  [...block.querySelectorAll('label, .field-label')].map((label) => label.textContent);

describe('the element form', () => {
  it('shows Name, Description, state and Type, then the other properties by name, with no Add field', async () => {
    const { form } = await openForm('workbench');
    const properties = within(form).getByRole('region', { name: 'Properties' });
    expect(labelsIn(properties)).toEqual([
      'Name Required',
      'Description',
      // Architecture state: three options.
      'Deprecate',
      'Current',
      'Target',
      'Type',
      // The standard properties and the element properties, merged and sorted by name.
      'Cost centre',
      'Depends on',
      'Functions',
      'hostedOn',
      'Lifecycle stage',
      'Owning team',
      'Sourcing',
      'Supplier HQ country',
    ]);
    expect(within(form).queryByRole('button', { name: 'Add field' })).toBeNull();
    expect(within(form).queryByLabelText('Key')).toBeNull();
    expect(
      within(form).getByText('New properties are added by an Admin, in Admin → Properties.'),
    ).toBeTruthy();
    // An Other has no standard property, but every element property.
    document.body.innerHTML = '';
    const other = await openForm('desk');
    expect(within(other.form).getByRole('combobox', { name: 'Cost centre' })).toBeTruthy();
  });

  it('edits each kind: text, a choice (a value not in the list kept), and the @ field', async () => {
    const { form, patches } = await openForm('workbench');
    const choice = within(form).getByRole<HTMLSelectElement>('combobox', {
      name: 'Lifecycle stage',
    });
    expect([...choice.options].map((option) => option.textContent)).toEqual([
      '“Sunset” (not in the list)',
      'Not set',
      'Plan',
      'Run',
      'Retire',
    ]);
    expect(choice.value).toBe('Sunset');
    expect(within(form).getByRole('combobox', { name: 'Add element to Depends on' })).toBeTruthy();
    fireEvent.change(within(form).getByRole('combobox', { name: 'Cost centre' }), {
      target: { value: 'CC-500' },
    });
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(patches).toHaveLength(1);
    });
    // The choice outside the list is kept: only the text changed.
    expect(patches[0]).toEqual({ version: 1, metadata: { costCentre: 'CC-500' } });
  });

  it('keeps a value of another kind as is; Remove shows the empty field, focused, and saves null', async () => {
    const { form, patches } = await openForm('workbench');
    const kept = within(form).getByRole('group', { name: 'hostedOn' });
    expect(kept.textContent).toContain('Not text, kept as is');
    expect(kept.textContent).toContain('Elements: Cloud platform');
    fireEvent.click(within(form).getByRole('button', { name: 'Remove hostedOn' }));
    const field = await within(form).findByLabelText('hostedOn');
    await waitFor(() => {
      expect(document.activeElement).toBe(field);
    });
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(patches).toHaveLength(1);
    });
    expect(patches[0]).toEqual({ version: 1, metadata: { hostedOn: null } });
  });

  it('keeps a standard property the new type lacks as Was a property, editable and removable', async () => {
    const { form, patches } = await openForm('workbench');
    fireEvent.change(within(form).getByRole('combobox', { name: 'Type' }), {
      target: { value: 'Infrastructure' },
    });
    expect(within(form).getByText(/^Infrastructure doesn't have Sourcing\./).textContent).toBe(
      "Infrastructure doesn't have Sourcing. Its value is kept, marked Was a property.",
    );
    const row = within(form).getByTitle('sourcing').closest('.meta-row') as HTMLElement;
    expect(row.textContent).toContain('SourcingWas a property');
    fireEvent.change(within(row).getByLabelText('Value of Sourcing'), {
      target: { value: 'Bought in' },
    });
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(patches).toHaveLength(2);
    });
    // The type goes at once; the value typed meanwhile goes next, with the version it gave.
    expect(patches).toEqual([
      { version: 1, type: 'Infrastructure' },
      { version: 2, metadata: { sourcing: 'Bought in' } },
    ]);
    expect(within(form).getByTitle('sourcing').closest('.meta-row')?.textContent).toContain(
      'Was a property',
    );
  });

  it('shows a Was a property value stored that way, and removes it', async () => {
    const { form, patches } = await openForm('desk');
    const row = within(form).getByTitle('sourcing').closest('.meta-row') as HTMLElement;
    expect(row.textContent).toContain('Was a property');
    fireEvent.click(within(row).getByRole('button', { name: 'Remove Sourcing' }));
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(patches).toHaveLength(1);
    });
    expect(patches[0]).toEqual({ version: 1, metadata: { sourcing: null } });
  });
});

describe('the details panel', () => {
  const graph = buildModelGraph(model, [], definitions);
  const panel = (id: string) => {
    const element = graph.elements.get(id);
    if (!element) throw new Error(id);
    render(
      <DetailsPanel graph={graph} element={element} link="/x" onFocusElement={() => undefined} />,
    );
  };
  const rowOf = (name: string) =>
    (
      [...document.querySelectorAll('dl.props > div')].find(
        (row) => row.querySelector('dt')?.textContent === name,
      ) as HTMLElement
    ).querySelector('dd') as HTMLElement;

  it('sorts the element properties among the standard ones by name, Not set included, with marks', () => {
    panel('workbench');
    const names = [...document.querySelectorAll('dl.props > div > dt')].map((dt) => dt.textContent);
    expect(names).toEqual([
      'Name',
      'Description',
      'Architecture state',
      'Type',
      'Cost centre',
      'Depends on',
      'Functions',
      'hostedOn',
      'Lifecycle stage',
      'Owning team',
      'Sourcing',
      'Supplier HQ country',
    ]);
    expect(rowOf('Cost centre').textContent).toBe('CC-410');
    expect(rowOf('Depends on').textContent).toContain('Payment hub');
    expect(rowOf('hostedOn').textContent).toContain('Cloud platform');
    expect(rowOf('hostedOn').textContent).toContain('Not text');
    expect(rowOf('Lifecycle stage').textContent.replace(/\s+/g, ' ')).toBe(
      'Sunset (not in the list)',
    );
  });

  it('says Not set for an empty one, and lists Was a property values under Custom metadata', () => {
    panel('desk');
    expect(rowOf('Cost centre').textContent).toBe('Not set');
    const fold = document.querySelector('details.meta') as HTMLDetailsElement;
    expect(fold.querySelector('dt')?.textContent).toBe('Sourcing Was a property');
  });

  it('names the property in Referenced by', () => {
    panel('hub');
    const section = screen.getByRole('region', { name: /^Referenced by/ });
    expect(within(section).getByRole('button').getAttribute('aria-label')).toBe(
      'Claims workbench, Application, in Depends on. Go to element',
    );
  });
});

describe('the catalog', () => {
  beforeEach(() => {
    forgetCatalogState();
  });

  it('has a column per element property, before Functions, and the CSV the same', () => {
    const graph = buildModelGraph(model, [], definitions);
    const table = catalogTable(
      [...graph.elements.values()],
      'Application',
      undefined,
      graph.elements,
      definitions,
    );
    expect(table.columns.map((column) => column.label)).toEqual([
      'Name',
      'Description',
      'Architecture state',
      'Owning team',
      'Supplier HQ country',
      'Sourcing',
      'Cost centre',
      'Depends on',
      'hostedOn',
      'Lifecycle stage',
      'Functions',
    ]);
    const csv = catalogCsv(table.columns, [...graph.elements.values()], graph.elements);
    expect(csv).toContain('Cost centre,Depends on,hostedOn,Lifecycle stage,Functions');
    expect(csv).toContain('CC-410,Payment hub,Cloud platform,Sunset,Claims intake');
  });

  it('edits Text and Choice cells in place, never a Reference or a value of another kind', async () => {
    stubApi(modeller, api().handler);
    renderAt(`/modelling/models/${modelId}?view=catalog&type=Application`);
    const grid = await screen.findByRole('grid');
    const row = within(grid).getByRole('row', { name: /Claims workbench/ });
    const cellOf = (label: string) => {
      const headers = within(grid)
        .getAllByRole('columnheader')
        .map((header) => header.textContent);
      const at = headers.findIndex((text) => text.startsWith(label));
      return row.querySelectorAll('th, td')[at] as HTMLElement;
    };
    expect(cellOf('Cost centre').getAttribute('aria-readonly')).toBeNull();
    expect(cellOf('Cost centre').classList.contains('is-editable')).toBe(true);
    expect(cellOf('Depends on').getAttribute('aria-readonly')).toBe('true');
    expect(cellOf('Depends on').title).toBe('Payment hub. Change it in the details panel.');
    expect(cellOf('hostedOn').getAttribute('aria-readonly')).toBe('true');
    expect(cellOf('hostedOn').title).toBe('Not text. Change it in the details panel.');
    expect(cellOf('Lifecycle stage').classList.contains('is-editable')).toBe(true);
  });
});

describe('Admin → Properties, element properties', () => {
  let undo: () => void;
  beforeEach(() => {
    undo = modalDialogs();
  });
  afterEach(() => {
    undo();
  });

  const usage = (key: string, elements: number, shapes: ElementPropertyUsage['shapes']) => ({
    key,
    elements,
    models: 2,
    shapes,
    values: [],
  });

  function openPage() {
    const sent: { method: string; url: string; body: unknown }[] = [];
    const handler: Handler = (request) => {
      if (!request.url.startsWith('/api/properties')) return undefined;
      const body: unknown = typeof request.body === 'string' ? JSON.parse(request.body) : undefined;
      if (request.method !== 'GET') sent.push({ method: request.method, url: request.url, body });
      if (request.url === '/api/properties/usage') {
        return Response.json({
          usage: [],
          elementUsage: [
            usage('dependsOn', 31, { text: 0, reference: 31, other: 0 }),
            usage('hostedOn', 14, { text: 12, reference: 0, other: 2 }),
          ],
        });
      }
      if (request.method === 'GET') {
        return Response.json({ properties: [], elementProperties: definitions });
      }
      if (request.method === 'POST') {
        return Response.json(
          { property: { ...(body as object), fromModels: false, version: 1 } },
          { status: 201 },
        );
      }
      if (request.method === 'DELETE') {
        return Response.json({ key: 'dependsOn', values: 31, models: 2 });
      }
      return undefined;
    };
    stubApi(admin, handler);
    renderAt('/admin/properties');
    return sent;
  }

  it('shows two sections, element properties first, each with its own New button', async () => {
    openPage();
    const element = await screen.findByRole('region', { name: 'Element properties' });
    const relation = screen.getByRole('region', { name: 'Relation properties' });
    expect(
      element.compareDocumentPosition(relation) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(element).getByRole('button', { name: 'New element property' })).toBeTruthy();
    expect(within(relation).getByRole('button', { name: 'New relation property' })).toBeTruthy();
    const rows = within(within(element).getByRole('table', { name: 'Element properties' }))
      .getAllByRole('row')
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole('cell')
          .slice(1, 4)
          .map((cell) => cell.textContent),
      );
    expect(rows).toEqual([
      ['costCentre', 'Text', 'None'],
      ['dependsOn', 'Reference', '31 in 2 models'],
      ['hostedOn', 'Text', '14 in 2 models'],
      ['stage', 'Choice · 3 options', 'None'],
    ]);
    expect(within(element).getByText(/^1 element property was added/)).toBeTruthy();
    expect(within(relation).getByText('No relation properties defined yet.')).toBeTruthy();
    const types = [...element.querySelectorAll('details.standard-properties tbody tr')].map(
      (row) => row.lastElementChild?.textContent,
    );
    expect(types[0]).toBe('Every type');
    expect(types).toContain('Business, Application, Infrastructure');
  });

  it('creates a Reference property for elements, with its hint and no options', async () => {
    const sent = openPage();
    const element = await screen.findByRole('region', { name: 'Element properties' });
    fireEvent.click(within(element).getByRole('button', { name: 'New element property' }));
    const dialog = await screen.findByRole('dialog', { name: 'New element property' });
    expect(
      within(dialog)
        .getAllByRole('radio')
        .map((radio) => radio.parentElement?.textContent),
    ).toEqual(['Text', 'Choice', 'Reference']);
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Owned by' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Reference' }));
    expect(within(dialog).getByText(/^Other elements of the same model/)).toBeTruthy();
    expect(within(dialog).queryByText('Add option')).toBeNull();
    // An element type's standard name is refused in the dialog.
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Sourcing' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(
      await within(dialog).findByText('“Sourcing” is a standard property of an element type.'),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Owned by' } });
    fireEvent.change(within(dialog).getByLabelText(/^Key/), { target: { value: 'ownedBy' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Created the element property Owned by.')).toBeTruthy();
    expect(sent).toEqual([
      {
        method: 'POST',
        url: '/api/properties?for=element',
        body: { name: 'Owned by', key: 'ownedBy', kind: 'reference' },
      },
    ]);
  });

  it('notes the values that won’t fit before a change to or from Reference', async () => {
    openPage();
    const element = await screen.findByRole('region', { name: 'Element properties' });
    fireEvent.click(
      within(element).getByRole('button', { name: 'Edit element property hostedOn' }),
    );
    let dialog = await screen.findByRole('dialog', { name: 'Edit element property' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Reference' }));
    expect(within(dialog).getByText(/^14 values in 2 models are text/).textContent).toBe(
      '14 values in 2 models are text, not elements. They stay as they are and show as “not a reference” until someone changes them.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(
      within(element).getByRole('button', { name: 'Edit element property Depends on' }),
    );
    dialog = await screen.findByRole('dialog', { name: 'Edit element property' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Choice' }));
    expect(within(dialog).getByText(/^31 values in 2 models are elements/).textContent).toContain(
      'show as “not a choice”',
    );
  });

  it('deletes with the counts and the Referenced by sentence, back on the section heading', async () => {
    const sent = openPage();
    const element = await screen.findByRole('region', { name: 'Element properties' });
    fireEvent.click(
      within(element).getByRole('button', { name: 'Delete element property Depends on' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete the element property Depends on?',
    });
    expect(dialog.textContent).toContain(
      "This deletes Depends on and its 31 values from 2 models. The elements in them no longer show these under Referenced by. It can't be undone.",
    );
    const button = within(dialog).getByRole('button', { name: 'Delete property' });
    fireEvent.click(button);
    expect(sent).toEqual([]);
    fireEvent.change(within(dialog).getByLabelText('Type Depends on to confirm'), {
      target: { value: 'depends on' },
    });
    fireEvent.click(button);
    expect(
      await screen.findByText(
        'Deleted the element property Depends on and 31 values from 2 models.',
      ),
    ).toBeTruthy();
    expect(sent[0]?.url).toBe('/api/properties?for=element&key=dependsOn');
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { level: 2, name: 'Element properties' }),
      );
    });
  });
});

describe('the import report', () => {
  it('counts and lists the properties added from elements and from relationships', () => {
    const added = [{ key: 'costCentre', name: 'costCentre', kind: 'text' as const, values: 4 }];
    const relationships = [{ key: 'tier', name: 'tier', values: 2 }];
    expect(
      summaryChips(undefined, 0, relationships, [], [], [], added).map((chip) => chip.text),
    ).toEqual(['2 new properties']);
    render(
      <MemoryRouter>
        <ReportSections
          validation={{
            valid: true,
            errorCount: 0,
            warningCount: 0,
            errors: [],
            warnings: [],
            summary: {
              nodes: {
                total: 0,
                byType: {
                  Stakeholder: 0,
                  Business: 0,
                  Application: 0,
                  Infrastructure: 0,
                  Other: 0,
                },
              },
              edges: { total: 0, byRelation: { Relation: 0, Contains: 0 } },
            },
            truncated: false,
          }}
          newProperties={relationships}
          newElementProperties={added}
        />
      </MemoryRouter>,
    );
    const section = screen.getByText('New properties').closest('details') as HTMLElement;
    expect(section.textContent).toContain('1 added from elements, 1 from relationships');
    expect(within(section).getByText('Added to Element properties')).toBeTruthy();
    expect(within(section).getByText('Added to Relation properties')).toBeTruthy();
  });
});
