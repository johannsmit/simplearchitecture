import type { JgfDocument, JgfEdge } from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Labels from '../src/viewing/explorer/canvas/labels';
import { linkText, mergeRelationships } from '../src/viewing/explorer/canvas/view';
import { buildModelGraph } from '@simplearchitecture/shared';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { modeller, renderAt, stubApi, viewer, type Handler } from './helpers';

// Property values in relationship labels. Made-up data (the bakery fixture).

// jsdom has no layout, so no spot is ever free for a label: place every label at the origin.
vi.mock('../src/viewing/explorer/canvas/labels', async (importOriginal) => ({
  ...(await importOriginal<typeof Labels>()),
  placeLabel: () => ({ x: 0, y: 0 }),
}));

const markup = '<b>REST</b>';

const model = (): JgfDocument => ({
  graph: {
    ...bakeryModel.graph,
    edges: (bakeryModel.graph.edges ?? []).map((edge): JgfEdge => {
      switch (edge.id) {
        case 'e1':
          return {
            ...edge,
            label: '{Data} via {protocol}',
            metadata: { data: 'Places orders', protocol: markup },
          };
        case 'e3':
          return { ...edge, label: '{Data} ({Dtaa})' };
        case 'e5':
          return { ...edge, label: '{Identity}' };
        case 'e7':
          return { ...edge, label: '{Identity} on {Data}', metadata: { identity: 'svc-shop' } };
        case 'e9':
          // The other way round, so it isn't merged with e7.
          return { ...edge, source: 'server', target: 'shop' };
        default:
          return edge;
      }
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
    const relationship = /\/relationships\/([^/?]+)/.exec(request.url);
    if (relationship) {
      const id = decodeURIComponent(relationship[1] ?? '');
      const edge = (document.graph.edges ?? []).find((candidate) => candidate.id === id);
      if (edge && request.method === 'PATCH' && typeof request.body === 'string') {
        const change = JSON.parse(request.body) as Record<string, unknown>;
        sent.push(change);
        if (typeof change.data === 'string')
          edge.metadata = { ...edge.metadata, data: change.data };
        if (typeof change.label === 'string') edge.label = change.label;
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
const canvas = () => screen.getByRole('region', { name: /^Diagram:/ });
const details = () => screen.getByRole('complementary', { name: 'Details' });
const labels = () =>
  [...canvas().querySelectorAll('.edge-label')].map((label) => label.textContent).sort();

async function openAt(space: 'viewing' | 'modelling') {
  const { handler, sent } = api();
  stubApi(space === 'modelling' ? modeller : viewer, handler);
  renderAt(at(space));
  await screen.findByRole('heading', { level: 2, name: 'Web Shop' });
  await waitFor(() => {
    expect(canvas().querySelectorAll('.card')).toHaveLength(6);
  });
  return { sent };
}

async function openForm() {
  const opened = await openAt('modelling');
  fireEvent.click(
    within(details()).getAllByRole('button', {
      name: /^Open relationship: Relates to Back Office Server/,
    })[0] as HTMLElement,
  );
  const form = await screen.findByRole('form', { name: /^Relationship / });
  const label = within(form).getByRole<HTMLInputElement>('combobox', { name: 'Label' });
  return { ...opened, form, label };
}

beforeEach(() => {
  localStorage.clear();
});

describe('on the canvas', () => {
  it('shows each label filled in, and no label where it fills in to nothing', async () => {
    await openAt('viewing');
    await waitFor(() => {
      expect(labels()).toEqual([`Places orders via ${markup}`, 'svc-shop on', '×3'].sort());
    });
    // A value is text, never markup.
    expect(canvas().querySelector('.edge-label b')).toBeNull();
  });

  it('keeps the expression when a viewpoint shows properties in place of labels', () => {
    const graph = buildModelGraph(model());
    const [e1] = mergeRelationships(graph.relationships);
    expect(e1 && linkText(e1)).toBe(`Places orders via ${markup}`);
    expect(e1 && linkText(e1, ['protocol'])).toBe(markup);
  });

  it('lists the filled-in labels in the chooser of a line holding several', async () => {
    await openAt('viewing');
    const edge = await waitFor(() => {
      const found = [...canvas().querySelectorAll<HTMLElement>('.react-flow__edge')].find(
        (candidate) => candidate.getAttribute('aria-label') === 'Web Shop relates to Oven Planner',
      );
      expect(found).toBeDefined();
      return found as HTMLElement;
    });
    fireEvent.mouseEnter(edge);
    const label = await waitFor(() => {
      const lit = canvas().querySelector<HTMLElement>('.edge-label.is-lit');
      expect(lit?.textContent).toBe('×3');
      return lit as HTMLElement;
    });
    fireEvent.click(label);
    const menu = await screen.findByRole('menu', { name: '3 relationships' });
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.querySelector('.rp-label')?.textContent ?? '');
    expect(items).toEqual([' “Orders ({Dtaa})”', ' “REST API”', '']);
  });

  it('follows a saved change to a property at once', async () => {
    const { form, sent } = await openForm();
    await waitFor(() => {
      expect(labels()).toContain('svc-shop on');
    });
    fireEvent.change(within(form).getByRole('combobox', { name: 'Data' }), {
      target: { value: 'Stock' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent).toEqual([{ version: 1, data: 'Stock' }]);
    });
    await waitFor(() => {
      expect(labels()).toContain('svc-shop on Stock');
    });
  });
});

describe('in the details panel', () => {
  it('lists relationships with their labels filled in, as text', async () => {
    await openAt('viewing');
    const shown = [...details().querySelectorAll('.rlabel')].map((label) => label.textContent);
    expect(shown).toContain(`“Places orders via ${markup}”`);
    expect(shown).toContain('“svc-shop on”');
    expect(shown.some((text) => text.includes('{Identity}'))).toBe(false);
    expect(details().querySelector('.rlabel b')).toBeNull();
    const row = within(details()).getAllByRole('button', { name: /Customer/ })[0];
    expect(row?.getAttribute('aria-label')).toContain(`"Places orders via ${markup}"`);
  });

  it('shows the filled-in label of an open relationship in Viewing', async () => {
    await openAt('viewing');
    fireEvent.click(
      within(details()).getAllByRole('button', {
        name: /^Open relationship: Relates to Back Office Server/,
      })[0] as HTMLElement,
    );
    const line = await within(details()).findByText(
      (_, element) => element?.classList.contains('rel-label') === true,
    );
    expect(line.textContent).toContain('“svc-shop on”');
  });
});

describe('on the relationship form', () => {
  it('says what the label shows, and follows the other fields as they are typed', async () => {
    const { form, label } = await openForm();
    expect(label.value).toBe('{Identity} on {Data}');
    const shows = () => form.querySelector('.label-shows')?.textContent;
    expect(shows()).toBe('Shows as: “svc-shop on”');
    expect(label.getAttribute('aria-describedby')).toContain(
      form.querySelector('.label-shows')?.id ?? 'missing',
    );
    fireEvent.change(within(form).getByRole('combobox', { name: 'Data' }), {
      target: { value: 'Stock' },
    });
    expect(shows()).toBe('Shows as: “svc-shop on Stock”');
    fireEvent.change(within(form).getByRole('combobox', { name: 'Identity' }), {
      target: { value: '' },
    });
    fireEvent.change(within(form).getByRole('combobox', { name: 'Data' }), {
      target: { value: '' },
    });
    fireEvent.change(label, { target: { value: '{Identity} {Data}' } });
    expect(shows()).toBe('Shows as: no label');
    fireEvent.change(label, { target: { value: 'Plain label' } });
    expect(form.querySelector('.label-shows')).toBeNull();
  });

  it('warns about a name the relationship has no property for', async () => {
    const { form, label } = await openForm();
    expect(form.querySelector('.warn-note')).toBeNull();
    fireEvent.change(label, { target: { value: '{Identty} {protocol} {Dtaa}' } });
    const warning = form.querySelector('.label-shows + .warn-note');
    expect(warning?.textContent).toBe('No property called “Identty” or “Dtaa”.');
    expect(label.getAttribute('aria-describedby')).toContain(warning?.id ?? 'missing');
    expect(form.querySelector('.label-shows')?.textContent).toBe('Shows as: “{Identty} {Dtaa}”');
  });

  it('suggests the property names when { is typed, and puts one in with its brace', async () => {
    const { form, label, sent } = await openForm();
    expect(screen.queryByRole('listbox', { name: 'Suggestions for property names' })).toBeNull();
    fireEvent.focus(label);
    fireEvent.change(label, { target: { value: 'via {' } });
    const list = screen.getByRole('listbox', { name: 'Suggestions for property names' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Identity',
      'Identity Context',
      'Data',
      'Architecture state',
      'Description',
      'protocol',
    ]);
    expect(label.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(label, { key: 'ArrowDown' });
    fireEvent.keyDown(label, { key: 'ArrowDown' });
    expect(label.getAttribute('aria-activedescendant')).toBe(
      within(list).getAllByRole('option')[1]?.id,
    );
    fireEvent.keyDown(label, { key: 'Enter' });
    expect(label.value).toBe('via {Identity Context}');
    expect(screen.queryByRole('listbox', { name: 'Suggestions for property names' })).toBeNull();
    // Enter took the name: nothing was saved.
    expect(sent).toEqual([]);

    // Narrowed by what is typed after the brace; a click takes a name too.
    fireEvent.change(label, { target: { value: 'via {Identity Context} {pro' } });
    const narrowed = screen.getByRole('listbox', { name: 'Suggestions for property names' });
    expect(
      within(narrowed)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['protocol']);
    fireEvent.click(within(narrowed).getByRole('option', { name: 'protocol' }));
    expect(label.value).toBe('via {Identity Context} {protocol}');

    // Escape closes the list and leaves the form open.
    fireEvent.change(label, { target: { value: 'via {' } });
    fireEvent.keyDown(label, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Suggestions for property names' })).toBeNull();
    expect(screen.getByRole('form', { name: /^Relationship / })).toBe(form);

    // {{ is a literal brace: nothing to suggest.
    fireEvent.change(label, { target: { value: 'via {{' } });
    expect(screen.queryByRole('listbox', { name: 'Suggestions for property names' })).toBeNull();
  });

  it('saves the label as typed', async () => {
    const { form, label, sent } = await openForm();
    fireEvent.change(label, { target: { value: '{Data} by {Identity}' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent).toEqual([{ version: 1, label: '{Data} by {Identity}' }]);
    });
  });
});
