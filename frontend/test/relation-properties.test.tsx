import type { JgfDocument, JgfEdge } from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { modeller, renderAt, stubApi, viewer, type Handler } from './helpers';

// Identity, Identity Context and the two lists of data on the relationship form and in the details
// panel. The lists, named after the ends, hold values edited as chips. Made-up data.

const model = (opened: Record<string, unknown>): JgfDocument => ({
  graph: {
    ...bakeryModel.graph,
    edges: (bakeryModel.graph.edges ?? []).map((edge): JgfEdge => {
      if (edge.id === 'e7') return { ...edge, metadata: opened };
      if (edge.id === 'e8' || edge.id === 'e9') {
        return { ...edge, metadata: { ...edge.metadata, sourceToTargetData: ['Orders'] } };
      }
      return edge;
    }),
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

const at = (space: string) => `/${space}/models/${bakeryId}/elements/shop?depth=1`;
const details = () => screen.getByRole('complementary', { name: 'Details' });

async function openHostedOn(
  space: 'modelling' | 'viewing',
  opened: Record<string, unknown> = { identity: 'svc-shop' },
) {
  const { handler, sent } = api(opened);
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
      'Web Shop to Back Office Server',
      'Back Office Server to Web Shop',
    ]);
    expect(labels).not.toContain('Data');
    const identity = within(form).getByRole<HTMLInputElement>('combobox', { name: 'Identity' });
    expect(identity.value).toBe('svc-shop');
    // Both offer the values either has in the model: the values Data had.
    for (const name of ['Web Shop to Back Office Server', 'Back Office Server to Web Shop']) {
      fireEvent.click(within(form).getByRole('combobox', { name }));
      expect(
        within(screen.getByRole('listbox', { name: `Suggestions for ${name}` }))
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['Orders', 'Places orders']);
      fireEvent.click(screen.getByRole('option', { name: 'Orders' }));
      expect(within(form).getByRole('list', { name: `${name}: 1 value` })).toBeTruthy();
    }
    fireEvent.change(identity, { target: { value: '  ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual({
      version: 1,
      identity: null,
      sourceToTargetData: ['Orders'],
      targetToSourceData: ['Orders'],
    });
  });

  it('has none of them on a Contains, and says they go when the type changes', async () => {
    await openHostedOn('modelling');
    const form = await screen.findByRole('form', { name: /^Relationship / });
    fireEvent.click(within(form).getByRole('radio', { name: /^Contains/ }));
    expect(within(form).queryByRole('combobox', { name: 'Identity' })).toBeNull();
    expect(
      within(form).queryByRole('combobox', { name: 'Web Shop to Back Office Server' }),
    ).toBeNull();
    expect(
      within(form).queryByRole('combobox', { name: 'Back Office Server to Web Shop' }),
    ).toBeNull();
    expect(
      within(form).getByText(
        'Identity, Identity Context and the data in both directions are removed when you save.',
      ),
    ).toBeTruthy();
  });

  it('has no Add field, and says new properties come from an Admin', async () => {
    await openHostedOn('modelling');
    const form = await screen.findByRole('form', { name: /^Relationship / });
    expect(within(form).queryByRole('button', { name: 'Add field' })).toBeNull();
    expect(within(form).queryByLabelText('Key')).toBeNull();
    expect(
      within(form).getByText('New properties are added by an Admin, in Admin → Properties.'),
    ).toBeTruthy();
  });
});

describe('Source to target data and Target to source data as chips', () => {
  const chipsOf = (form: HTMLElement, name: string) =>
    within(form)
      .queryByRole('list', { name: new RegExp(`^${name}: `) })
      ?.querySelectorAll('.chip-text') ?? [];
  const texts = (form: HTMLElement, name: string) =>
    [...chipsOf(form, name)].map((chip) => chip.textContent);
  const input = (form: HTMLElement, name: string) =>
    within(form).getByRole<HTMLInputElement>('combobox', { name });

  it('adds what is typed with Enter, keeps the order, and never saves on Enter', async () => {
    const { sent } = await openHostedOn('modelling', { sourceToTargetData: ['Flour'] });
    const form = await screen.findByRole('form', { name: /^Relationship / });
    expect(texts(form, 'Web Shop to Back Office Server')).toEqual(['Flour']);
    const field = input(form, 'Web Shop to Back Office Server');
    field.focus();
    fireEvent.change(field, { target: { value: '  Sugar  ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(texts(form, 'Web Shop to Back Office Server')).toEqual(['Flour', 'Sugar']);
    expect(field.value).toBe('');
    expect(document.activeElement).toBe(field);
    expect(within(form).getByText('Added Sugar.')).toBeTruthy();
    // Enter on an empty box adds nothing and saves nothing.
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(texts(form, 'Web Shop to Back Office Server')).toEqual(['Flour', 'Sugar']);
    expect(sent).toEqual([]);
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(sent).toEqual([{ version: 1, sourceToTargetData: ['Flour', 'Sugar'] }]);
    });
  });

  it('refuses a value that is there already, ignoring case, and says so', async () => {
    await openHostedOn('modelling', { targetToSourceData: ['Order ids'] });
    const form = await screen.findByRole('form', { name: /^Relationship / });
    const field = input(form, 'Back Office Server to Web Shop');
    fireEvent.change(field, { target: { value: 'ORDER IDS' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(texts(form, 'Back Office Server to Web Shop')).toEqual(['Order ids']);
    expect(field.value).toBe('ORDER IDS');
    const note = within(form).getAllByText('“Order ids” is there already.');
    expect(note.length).toBeGreaterThan(0);
    expect(field.getAttribute('aria-describedby')).toContain(
      note.find((element) => element.tagName === 'P')?.id,
    );
  });

  it('picks a suggestion with the arrows and Enter, offering only values not there yet', async () => {
    await openHostedOn('modelling', { sourceToTargetData: ['Orders'] });
    const form = await screen.findByRole('form', { name: /^Relationship / });
    const field = input(form, 'Web Shop to Back Office Server');
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    const list = screen.getByRole('listbox', {
      name: 'Suggestions for Web Shop to Back Office Server',
    });
    expect(
      within(list)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Places orders']);
    expect(field.getAttribute('aria-activedescendant')).toBe(within(list).getByRole('option').id);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(texts(form, 'Web Shop to Back Office Server')).toEqual(['Orders', 'Places orders']);
    expect(
      screen.queryByRole('listbox', { name: 'Suggestions for Web Shop to Back Office Server' }),
    ).toBeNull();
  });

  it('removes a chip with its button and puts focus on the next one, then on the box', async () => {
    const { sent } = await openHostedOn('modelling', {
      sourceToTargetData: ['Flour', 'Sugar', 'Salt'],
    });
    const form = await screen.findByRole('form', { name: /^Relationship / });
    fireEvent.click(within(form).getByRole('button', { name: 'Remove Sugar' }));
    expect(texts(form, 'Web Shop to Back Office Server')).toEqual(['Flour', 'Salt']);
    await waitFor(() => {
      expect(document.activeElement).toBe(
        within(form).getByRole('button', { name: 'Remove Salt' }),
      );
    });
    expect(within(form).getByText('Removed Sugar.')).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: 'Remove Salt' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Remove Flour' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(input(form, 'Web Shop to Back Office Server'));
    });
    expect(chipsOf(form, 'Web Shop to Back Office Server')).toHaveLength(0);
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent).toEqual([{ version: 1, sourceToTargetData: null }]);
    });
  });

  it('saves a value typed and not yet added, and shows an older single text as one chip', async () => {
    const { sent } = await openHostedOn('modelling', { sourceToTargetData: 'Flour' });
    const form = await screen.findByRole('form', { name: /^Relationship / });
    expect(texts(form, 'Web Shop to Back Office Server')).toEqual(['Flour']);
    fireEvent.change(input(form, 'Back Office Server to Web Shop'), {
      target: { value: 'Loaves' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent).toEqual([{ version: 1, targetToSourceData: ['Loaves'] }]);
    });
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
      expect.arrayContaining([
        'Identity',
        'Identity Context',
        'Web Shop to Back Office Server',
        'Back Office Server to Web Shop',
      ]),
    );
    const value = (term: string) =>
      [...panel.querySelectorAll('dt')].find((dt) => dt.textContent === term)?.nextElementSibling
        ?.textContent;
    expect(value('Identity')).toBe('svc-shop');
    expect(value('Web Shop to Back Office Server')).toBe('Not set');
    expect(value('Back Office Server to Web Shop')).toBe('Not set');
    // Both lists in one Data row, named after the ends.
    expect(terms).toContain('Data');
    expect(terms).not.toContain('Source to target data');
    expect(within(details()).queryByRole('heading', { name: /^Custom metadata/ })).toBeNull();
  });

  it('lists the values of Source to target data and Target to source data, in their order', async () => {
    await openHostedOn('viewing', {
      sourceToTargetData: ['Flour', 'Sugar'],
      targetToSourceData: 'Loaves',
    });
    const list = await within(details()).findByRole('list', {
      name: 'Web Shop to Back Office Server',
    });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Flour', 'Sugar']);
    const response = within(details()).getByRole('list', {
      name: 'Back Office Server to Web Shop',
    });
    expect(
      within(response)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Loaves']);
    expect(within(details()).queryByRole('button', { name: /^Remove / })).toBeNull();
  });
});
