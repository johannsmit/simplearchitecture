import type { JgfDocument, JgfNode, ModelSummary } from '@simplearchitecture/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { TypeMark } from '../src/metamodel-ui';
import { cellChange, clientErrors, draftOf, elementOfNode } from '../src/modelling/draft';
import { forgetCatalogState } from '../src/viewing/explorer/catalog/Catalog';
import { forgetElementFilters } from '../src/viewing/explorer/ElementTree';
import { modeller, renderAt, stubApi, viewer, type Handler } from './helpers';

// A Stakeholder's Kind (Human or AI Agent) on the canvas, the legend, the panel, the form and the
// catalog. Made-up data: a small bakery with a baker, an ordering bot and an odd stored value.

const modelId = '77777777-7777-4777-8777-777777777777';
const model: JgfDocument = {
  graph: {
    id: modelId,
    label: 'Made-up bakery',
    directed: true,
    nodes: {
      baker: { label: 'Baker', metadata: { type: 'Stakeholder' } },
      bot: { label: 'Order bot', metadata: { type: 'Stakeholder', stakeholderKind: 'AI Agent' } },
      odd: { label: 'Odd one', metadata: { type: 'Stakeholder', stakeholderKind: 'robot' } },
      till: { label: 'Till', metadata: { type: 'Application' } },
    },
    edges: [
      { id: 'r1', source: 'baker', target: 'till', relation: 'Relation' },
      { id: 'r2', source: 'bot', target: 'till', relation: 'Relation' },
      { id: 'r3', source: 'odd', target: 'till', relation: 'Relation' },
    ],
  },
};
const summary: ModelSummary = {
  id: modelId,
  name: 'Made-up bakery',
  createdAt: '2026-11-17T10:00:00.000Z',
  createdBy: { id: 'u1', name: 'Alex Morgan' },
  nodeCount: 4,
  edgeCount: 3,
};

const node = (id: string): JgfNode => {
  const found = model.graph.nodes?.[id];
  if (!found) throw new Error(id);
  return found;
};
const element = (id: string) => elementOfNode(id, node(id));

let patches: { url: string; body: unknown }[] = [];

const api: Handler = ({ url, method, body }) => {
  const elementId = url.includes('/elements/')
    ? decodeURIComponent(url.split('/elements/')[1]?.split('?')[0] ?? '')
    : undefined;
  if (method === 'PATCH' && elementId !== undefined) {
    const change = JSON.parse(body as string) as { metadata?: Record<string, unknown> };
    patches.push({ url, body: change });
    const metadata = Object.fromEntries(
      Object.entries({ ...node(elementId).metadata, ...change.metadata }).filter(
        ([, value]) => value !== null,
      ),
    );
    return Response.json({
      element: { id: elementId, version: 2, node: { ...node(elementId), metadata } },
      warnings: [],
    });
  }
  if (method !== 'GET') return undefined;
  if (url === '/api/models') return Response.json({ models: [summary] });
  if (url === `/api/models/${modelId}`) return Response.json(model);
  if (url === `/api/models/${modelId}/views`) return Response.json({ views: [] });
  if (elementId !== undefined && url.endsWith('/views')) return Response.json({ views: [] });
  if (elementId !== undefined) {
    return Response.json({
      element: { id: elementId, version: 1, node: node(elementId) },
      warnings: [],
    });
  }
  return undefined;
};

const at = (space: 'viewing' | 'modelling', path: string) => `/${space}/models/${modelId}${path}`;
const iconOf = (root: Element | null | undefined) =>
  root?.querySelector('svg[data-icon]')?.getAttribute('data-icon');
const card = (id: string) => document.querySelector(`.card[data-element-id="${id}"]`);
const details = () => screen.getByRole('complementary', { name: 'Details' });

beforeEach(() => {
  patches = [];
  forgetElementFilters();
  forgetCatalogState();
});

describe('the type mark', () => {
  it('draws a robot for an AI Agent, and the person otherwise', () => {
    const { container } = render(
      <>
        <TypeMark type="Stakeholder" metadata={{ stakeholderKind: 'AI Agent' }} />
        <TypeMark type="Stakeholder" metadata={{}} />
        <TypeMark type="Stakeholder" metadata={{ stakeholderKind: 'robot' }} />
        <TypeMark type="Stakeholder" />
        <TypeMark type="Application" metadata={{ stakeholderKind: 'AI Agent' }} />
      </>,
    );
    const marks = [...container.children];
    expect(marks.map((mark) => iconOf(mark) ?? mark.className)).toEqual([
      'bot',
      'user',
      'user',
      'user',
      'swatch colour-blue',
    ]);
  });
});

describe('Viewing: Kind on the canvas, the legend and the panel', () => {
  it('draws an AI Agent as the same circle with a robot, and says its Kind in the panel', async () => {
    stubApi(viewer, api);
    renderAt(at('viewing', '/elements/till?depth=1'));
    await waitFor(() => {
      expect(card('bot')).toBeTruthy();
    });
    expect(card('bot')?.classList.contains('is-circle')).toBe(true);
    expect(iconOf(card('bot')?.querySelector('.ccircle'))).toBe('bot');
    expect(iconOf(card('baker')?.querySelector('.ccircle'))).toBe('user');
    expect(iconOf(card('odd')?.querySelector('.ccircle'))).toBe('user');

    // The legend explains both kinds.
    const legend = document.querySelector('.legend-body');
    const items = [...(legend?.querySelectorAll('li') ?? [])].map((item) => [
      item.textContent,
      iconOf(item) ?? '',
    ]);
    expect(items).toContainEqual(['Stakeholder · Human', 'user']);
    expect(items).toContainEqual(['Stakeholder · AI Agent', 'bot']);

    fireEvent.click(card('bot')?.querySelector('.card-main') as HTMLElement);
    await waitFor(() => {
      expect(within(details()).getByRole('heading', { level: 2 }).textContent).toBe('Order bot');
    });
    expect(iconOf(details().querySelector('.d-type'))).toBe('bot');
    const kindRow = within(details()).getByText('Kind').closest('div');
    expect(kindRow?.querySelector('dd')?.textContent).toBe('AI Agent');
  });

  it("marks each Stakeholder with its own icon in an element's relationships", async () => {
    stubApi(viewer, api);
    renderAt(at('viewing', '/elements/till?depth=1'));
    const button = await within(
      await screen.findByRole('complementary', { name: 'Details' }),
    ).findByRole('button', { name: /Order bot, Stakeholder/ });
    expect(iconOf(button)).toBe('bot');
    expect(iconOf(within(details()).getByRole('button', { name: /Baker, Stakeholder/ }))).toBe(
      'user',
    );
  });

  it('reads a Stakeholder without Kind as Human, and marks an odd stored value', async () => {
    stubApi(viewer, api);
    renderAt(at('viewing', '/elements/till?depth=1'));
    await waitFor(() => {
      expect(card('baker')).toBeTruthy();
    });
    fireEvent.click(card('baker')?.querySelector('.card-main') as HTMLElement);
    await waitFor(() => {
      expect(within(details()).getByRole('heading', { level: 2 }).textContent).toBe('Baker');
    });
    const kind = () =>
      within(details()).getByText('Kind').closest('div')?.querySelector('dd')?.textContent;
    expect(kind()).toBe('Human');
    fireEvent.click(card('odd')?.querySelector('.card-main') as HTMLElement);
    await waitFor(() => {
      expect(within(details()).getByRole('heading', { level: 2 }).textContent).toBe('Odd one');
    });
    expect(kind()).toBe('robot (not Human or AI Agent; read as Human)');
  });
});

describe('Modelling: the Kind field', () => {
  async function openForm(id: string) {
    stubApi(modeller, api);
    renderAt(at('modelling', `/elements/${id}?depth=1`));
    const form = await screen.findByRole('form', { name: /^Edit / });
    return { form, kind: within(form).getByRole<HTMLSelectElement>('combobox', { name: 'Kind' }) };
  }
  const options = (select: HTMLSelectElement) =>
    [...select.options].map((option) => option.textContent);

  it('shows Human for a Stakeholder without Kind, and saves AI Agent', async () => {
    const { form, kind } = await openForm('baker');
    expect(options(kind)).toEqual(['Human', 'AI Agent']);
    expect(kind.selectedOptions[0]?.textContent).toBe('Human');
    expect(iconOf(form.querySelector('.select-wrap.has-mark'))).toBe('user');

    fireEvent.change(kind, { target: { value: 'AI Agent' } });
    // The type mark follows the field before saving.
    expect(iconOf(form.querySelector('.select-wrap.has-mark'))).toBe('bot');
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(patches).toHaveLength(1);
    });
    expect(patches[0]?.body).toEqual({ version: 1, metadata: { stakeholderKind: 'AI Agent' } });
  });

  it('sends nothing when Human is picked again for a Stakeholder without Kind', async () => {
    const { form, kind } = await openForm('baker');
    fireEvent.change(kind, { target: { value: 'AI Agent' } });
    expect(within(form).getByRole('status').textContent).toBe('Unsaved changes');
    fireEvent.change(kind, { target: { value: kind.options[0]?.value ?? '' } });
    expect(form.querySelector('.d-form-foot')).toBeNull();
  });

  it('saves Human for an AI Agent', async () => {
    const { form, kind } = await openForm('bot');
    expect(kind.selectedOptions[0]?.textContent).toBe('AI Agent');
    fireEvent.change(kind, { target: { value: 'Human' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(patches).toHaveLength(1);
    });
    expect(patches[0]?.body).toEqual({ version: 1, metadata: { stakeholderKind: 'Human' } });
  });

  it('keeps an odd stored value while another field is saved', async () => {
    const { form, kind } = await openForm('odd');
    expect(options(kind)).toEqual(['“robot” (not valid)', 'Human', 'AI Agent']);
    fireEvent.change(within(form).getByRole('textbox', { name: /^Name/ }), {
      target: { value: 'Odd two' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(patches).toHaveLength(1);
    });
    expect(patches[0]?.body).toEqual({ version: 1, name: 'Odd two' });
  });
});

describe('the draft rules for Kind', () => {
  it('checks only a changed value against the options', () => {
    const odd = draftOf(element('odd'));
    expect(clientErrors(odd, element('odd').metadata).has('field:stakeholderKind')).toBe(false);
    const typed = { ...odd, fields: { ...odd.fields, stakeholderKind: 'Robot' } };
    expect(clientErrors(typed, element('odd').metadata).get('field:stakeholderKind')).toBe(
      'Pick one of Human, AI Agent.',
    );
  });

  it('sends a catalog cell change like the form', () => {
    expect(cellChange(element('baker'), 'stakeholderKind', '')).toBeUndefined();
    expect(cellChange(element('baker'), 'stakeholderKind', 'AI Agent')).toEqual({
      metadata: { stakeholderKind: 'AI Agent' },
    });
    expect(cellChange(element('bot'), 'stakeholderKind', 'Human')).toEqual({
      metadata: { stakeholderKind: 'Human' },
    });
  });
});

describe('the catalog: Kind', () => {
  const grid = () => screen.getByRole('grid');
  const cell = (name: string, column: string) => {
    const headers = within(grid()).getAllByRole('columnheader');
    const index = headers.findIndex((header) => header.textContent === column);
    const row = within(grid()).getByRole('rowheader', { name }).closest('tr');
    const found = row?.children[index];
    if (!(found instanceof HTMLElement)) throw new Error(`${name} ${column}`);
    return found;
  };

  it('shows Kind on the Stakeholder tab, Human when not set, and offers Human and AI Agent', async () => {
    stubApi(modeller, api);
    renderAt(at('modelling', '?view=catalog&type=Stakeholder'));
    await screen.findByRole('grid');
    expect(cell('Baker', 'Kind').textContent).toBe('Human');
    expect(cell('Order bot', 'Kind').textContent).toBe('AI Agent');

    const target = cell('Baker', 'Kind');
    fireEvent.click(target);
    await waitFor(() => {
      expect(within(details()).getByRole('heading', { level: 2 }).textContent).toBe('Baker');
    });
    target.focus();
    fireEvent.keyDown(target, { key: 'Enter' });
    const combo = screen.getByRole('combobox', { name: 'Kind, Baker' });
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Human', 'AI Agent']);
    fireEvent.keyDown(combo, { key: 'ArrowDown' });
    fireEvent.keyDown(combo, { key: 'Enter' });
    await waitFor(() => {
      expect(patches).toHaveLength(1);
    });
    expect(patches[0]?.body).toEqual({ version: 1, metadata: { stakeholderKind: 'AI Agent' } });
  });
});
