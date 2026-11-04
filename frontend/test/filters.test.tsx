import type { JgfDocument, JgfNode } from '@simplearchitecture/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { forgetElementFilters } from '../src/viewing/explorer/ElementTree';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { expectNoSeriousAxeViolations, renderAt, stubApi, viewer, type Handler } from './helpers';

// The element list filter and edge states on the canvas.
// Made-up data only. Rendered in StrictMode (renderAt).

const base = `/viewing/models/${bakeryId}`;
const elementUrl = (id: string) => `${base}/elements/${encodeURIComponent(id)}?depth=1`;

function api(model: JgfDocument = bakeryModel): Handler {
  return ({ url, method }) => {
    if (method !== 'GET') return undefined;
    if (url === '/api/models') return Response.json({ models: [bakerySummary] });
    if (url === `/api/models/${bakeryId}`) return Response.json(model);
    return undefined;
  };
}

beforeEach(() => {
  forgetElementFilters();
});

function open(path: string, model?: JgfDocument) {
  stubApi(viewer, api(model));
  renderAt(path);
}

const tree = () => screen.getByRole('tree', { name: 'Elements by type' });
const filterButton = () => screen.getByRole('button', { name: /^Filter elements/ });
const popover = () => screen.getByRole('dialog', { name: 'Filter elements' });
const elementRows = () =>
  within(tree())
    .queryAllByRole('treeitem')
    .filter((row) => row.getAttribute('aria-selected') !== null)
    .map((row) => row.getAttribute('aria-label'));
const resultLine = () => document.querySelector('.result-count')?.textContent;

async function openFilter() {
  // The first test in the file loads the explorer: under a full parallel run that can take over
  // findBy's default 1 s.
  fireEvent.click(
    await screen.findByRole('button', { name: /^Filter elements/ }, { timeout: 5000 }),
  );
  return popover();
}

function pickField(label: string) {
  fireEvent.click(within(popover()).getByRole('button', { name: new RegExp(`^${label}`) }));
}

function check(name: RegExp) {
  fireEvent.click(within(popover()).getByRole('checkbox', { name }));
}

describe('the Filter button and its popover', () => {
  it('lists the standard fields in metamodel order, then custom keys; never internal ones', async () => {
    open(base);
    const pop = await openFilter();

    expect(filterButton().getAttribute('aria-expanded')).toBe('true');
    const fields = within(pop)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(fields).toEqual([
      'Owning team',
      'Architecture state',
      'Sourcing',
      'Supplier HQ country',
      'hostingModel',
    ]);
    expect(within(pop).getByText('Custom')).toBeTruthy();
    // Focus on the first field.
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Owning team');
    });
  });

  it('shows values with counts, "(not set)" last, and filters the list at once (OR within a field)', async () => {
    open(base);
    await openFilter();
    pickField('Architecture state');

    const values = within(popover())
      .getAllByRole('checkbox')
      .map((box) => box.getAttribute('aria-label'));
    expect(values).toEqual([
      'Deprecate, 1 element',
      'Current, 2 elements',
      'Target, 1 element',
      'Not set, 3 elements',
    ]);
    expect(within(popover()).getByRole('group', { name: 'Architecture state' })).toBeTruthy();

    check(/^Target/);
    expect(resultLine()).toBe('1 of 7 elements match');
    expect(elementRows()).toEqual(['Oven Planner']);
    expect(within(tree()).getByRole('treeitem', { name: 'Application, 1 element' })).toBeTruthy();
    expect(filterButton().getAttribute('aria-label')).toBe('Filter elements, 1 filter on');
    expect(filterButton().querySelector('.filter-count')?.textContent).toBe('1');

    check(/^Deprecate/);
    expect(elementRows()).toEqual(['Oven Planner', 'Till']);
  });

  it('combines fields and search with AND, and the counts follow them', async () => {
    open(base);
    await openFilter();
    pickField('Architecture state');
    check(/^Current/);
    expect(elementRows()).toEqual(['Web Shop', 'Back Office Server']);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search elements' }), {
      target: { value: 'server' },
    });
    expect(resultLine()).toBe('1 of 7 elements match');
    fireEvent.click(filterButton());
    fireEvent.click(filterButton());
    pickField('Architecture state');
    // Search applies, this field's own filter doesn't.
    expect(
      within(popover())
        .getByRole('checkbox', { name: /^Current/ })
        .getAttribute('aria-label'),
    ).toBe('Current, 1 element');
    expect(
      within(popover())
        .getByRole('checkbox', { name: /^Target/ })
        .closest('label')?.className,
    ).toContain('is-zero');
  });

  it('shows a Supplier HQ country by name and code, and an unknown value as it is', async () => {
    open(base);
    await openFilter();
    pickField('Supplier HQ country');
    expect(
      within(popover())
        .getAllByRole('checkbox')
        .map((box) => box.getAttribute('aria-label')),
    ).toEqual(['Holland, 1 element', 'Netherlands (NL), 1 element', 'Not set, 5 elements']);
  });

  it('adds "Find a value…" when a field has more than 10 values', async () => {
    const nodes: Record<string, JgfNode> = {};
    for (let i = 1; i <= 12; i++) {
      nodes[`n${i}`] = { label: `App ${i}`, metadata: { type: 'Application', team: `Team ${i}` } };
    }
    open(base, { graph: { id: bakeryId, label: 'Teams', nodes, edges: [] } });
    await openFilter();
    pickField('team');
    const find = await within(popover()).findByPlaceholderText('Find a value…');
    await waitFor(() => {
      expect(document.activeElement).toBe(find);
    });
    fireEvent.change(find, { target: { value: 'team 1' } });
    expect(
      within(popover())
        .getAllByRole('checkbox')
        .map((box) => box.getAttribute('aria-label')),
    ).toEqual([
      'Team 1, 1 element',
      'Team 10, 1 element',
      'Team 11, 1 element',
      'Team 12, 1 element',
      'Not set, 0 elements',
    ]);
    // ↓ from the find box goes to the first checkbox.
    fireEvent.keyDown(find, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Team 1, 1 element');
  });

  it('works by keyboard: arrows, → into a field, ← back, Esc closes to the button', async () => {
    open(base);
    await openFilter();
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Owning team');
    });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Architecture state');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('hostingModel');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Deprecate, 1 element');
    });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Current, 2 elements');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Architecture state');
    });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Filter elements' })).toBeNull();
    expect(document.activeElement).toBe(filterButton());
  });

  it('closes on a click outside, leaving focus where the click put it', async () => {
    open(base);
    await openFilter();
    fireEvent.pointerDown(tree());
    expect(screen.queryByRole('dialog', { name: 'Filter elements' })).toBeNull();
  });

  it('says so when the model has no metadata to filter on', async () => {
    open(base, {
      graph: { id: bakeryId, nodes: { a: { label: 'A', metadata: { type: 'Other' } } } },
    });
    const pop = await openFilter();
    expect(within(pop).getByText('This model has no metadata to filter on.')).toBeTruthy();
  });
});

describe('chips, clearing and the empty result', () => {
  it('shows one chip per field, removes one with ×, and moves focus as the spec says', async () => {
    open(base);
    await openFilter();
    pickField('Architecture state');
    check(/^Target/);
    check(/^Deprecate/);
    check(/^Not set/);
    fireEvent.click(within(popover()).getByRole('button', { name: 'Back to fields' }));
    pickField('Owning team');
    check(/^Not set/);
    fireEvent.keyDown(popover(), { key: 'Escape' });

    const chips = screen.getByRole('group', { name: 'Active filters' });
    const texts = [...chips.querySelectorAll('.filter-chip')].map((chip) => chip.textContent);
    expect(texts).toEqual(['Owning team: (not set)', 'Architecture state: Deprecate +2']);
    expect(chips.querySelectorAll('.filter-chip')[1]?.getAttribute('title')).toBe(
      'Architecture state: Deprecate, Target or (not set)',
    );
    expect(elementRows()).toEqual(['Customer', 'Oven Planner', 'Till', 'Recipe Archive']);
    expect(filterButton().getAttribute('aria-label')).toBe('Filter elements, 2 filters on');
    expect(within(chips).getByRole('button', { name: 'Clear all filters' })).toBeTruthy();

    // × on the first chip: focus goes to the next chip's ×.
    fireEvent.click(
      within(chips).getByRole('button', { name: 'Remove filter: Owning team is (not set)' }),
    );
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        'Remove filter: Architecture state is Deprecate, Target or (not set)',
      );
    });
    // One chip: no Clear all. Removing the last one puts focus on the Filter button.
    expect(screen.queryByRole('button', { name: 'Clear all filters' })).toBeNull();
    fireEvent.click(document.activeElement as HTMLElement);
    await waitFor(() => {
      expect(document.activeElement).toBe(filterButton());
    });
    expect(screen.queryByRole('group', { name: 'Active filters' })).toBeNull();
    expect(resultLine()).toBe('7 elements');
  });

  it('shows the empty result with Clear filters and Clear search', async () => {
    open(base);
    await openFilter();
    pickField('Sourcing');
    check(/^Buy/);
    fireEvent.keyDown(popover(), { key: 'Escape' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search elements' }), {
      target: { value: 'oven' },
    });
    expect(screen.getByText(/No elements match “oven” with these filters\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(document.activeElement).toBe(filterButton());
    expect(elementRows()).toEqual(['Oven Planner']);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search elements' }), {
      target: { value: '' },
    });
    fireEvent.click(filterButton());
    pickField('Sourcing');
    check(/^Buy/);
    fireEvent.click(within(popover()).getByRole('button', { name: 'Back to fields' }));
    pickField('Architecture state');
    check(/^Target/);
    fireEvent.keyDown(popover(), { key: 'Escape' });
    expect(screen.getByText(/No elements match these filters\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });

  it('keeps the filters per model while the list is hidden and shown again', async () => {
    open(base);
    await openFilter();
    pickField('Architecture state');
    check(/^Target/);
    fireEvent.keyDown(popover(), { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: 'Hide the element list' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show the element list' }));
    await screen.findByRole('tree');
    expect(elementRows()).toEqual(['Oven Planner']);
    expect(screen.getByRole('group', { name: 'Active filters' }).textContent).toContain(
      'Architecture state: Target',
    );
  });

  it('has no serious axe issues with the popover open on a field, and with chips', async () => {
    open(base);
    await openFilter();
    pickField('Architecture state');
    check(/^Target/);
    await expectNoSeriousAxeViolations();
    fireEvent.click(within(popover()).getByRole('button', { name: 'Back to fields' }));
    pickField('Owning team');
    check(/^Web team/);
    fireEvent.keyDown(popover(), { key: 'Escape' });
    expect(screen.getAllByRole('button', { name: /^Remove filter/ })).toHaveLength(2);
    await expectNoSeriousAxeViolations();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
    expect(document.activeElement).toBe(filterButton());
  });
});

describe('Architecture state on edges', () => {
  const withStates = structuredClone(bakeryModel);
  for (const edge of withStates.graph.edges ?? []) {
    if (edge.id === 'e5') edge.metadata = { architectureState: 'Deprecate' };
    if (edge.id === 'e6') edge.metadata = { architectureState: 'Target' };
  }
  const canvas = () => screen.getByRole('region', { name: /^Diagram:/ });

  it('gives Target and Deprecate edges their own class (line weight); Current edges stay as they were', async () => {
    open(elementUrl('shop'), withStates);
    await waitFor(() => {
      expect(canvas().querySelectorAll('.react-flow__edge').length).toBeGreaterThan(0);
    });
    const classed = (name: string) =>
      [...canvas().querySelectorAll(`.react-flow__edge.${name}`)].map((e) =>
        e.getAttribute('aria-label'),
      );
    expect(classed('is-deprecate')).toEqual(['Till relates to Web Shop']);
    expect(classed('is-target')).toEqual(['Oven Planner relates to Back Office Server']);
    expect(canvas().querySelectorAll('.react-flow__edge')).toHaveLength(6);
  });

  it('explains the marks in the legend, and shows the state badge in the details', async () => {
    open(elementUrl('shop'), withStates);
    const legend = await screen.findByRole('heading', { name: 'Relationship state' });
    const rows = legend.nextElementSibling?.querySelectorAll('li');
    expect([...(rows ?? [])].map((row) => row.textContent)).toEqual(['Target', 'Deprecate']);

    const details = screen.getByRole('complementary', { name: 'Details' });
    const till = within(details).getByRole('button', { name: /Till, Deprecate, Application/ });
    expect(till.querySelector('.badge.state-deprecate')?.textContent).toBe('Deprecate');
    // Current relationships show no badge.
    const customer = within(details).getByRole('button', { name: /Customer.*Stakeholder/ });
    expect(customer.querySelector('.badge')).toBeNull();
    await act(async () => {
      await expectNoSeriousAxeViolations();
    });
  });
});
