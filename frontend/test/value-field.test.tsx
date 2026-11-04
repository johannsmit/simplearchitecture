import type { JgfDocument, JgfEdge } from '@simplearchitecture/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ValueField } from '../src/modelling/ValueField';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { cpuMs, modeller, renderAt, stubApi, type Handler } from './helpers';

// Pick a metadata value, or type a new one. Made-up data only.

const values = ['REST', 'rest', 'Message queue via broker', 'SFTP'];

/** The field in a form with a submit button, as the relationship form has while dirty. */
function Harness(props: {
  start?: string;
  values?: readonly string[];
  readOnly?: boolean;
  onSubmit?: () => void;
  onOuterKey?: (key: string, prevented: boolean) => void;
}) {
  const [text, setText] = useState(props.start ?? '');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit?.();
      }}
      onKeyDown={(event) => {
        props.onOuterKey?.(event.key, event.defaultPrevented);
      }}
    >
      <ValueField
        aria-label="Value of protocol"
        value={text}
        values={props.values ?? values}
        label="protocol"
        readOnly={props.readOnly}
        onValue={setText}
      />
      <button type="button">Next</button>
      <output data-testid="text">{text}</output>
    </form>
  );
}

const field = () => screen.getByRole<HTMLInputElement>('combobox', { name: 'Value of protocol' });
const options = () => screen.queryAllByRole('option').map((option) => option.textContent);
const type = (text: string) => {
  fireEvent.change(field(), { target: { value: text } });
};
const key = (name: string, extra = {}) => {
  fireEvent.keyDown(field(), { key: name, ...extra });
};
const shownText = () => screen.getByTestId('text').textContent;

describe('taking and keeping values', () => {
  it('keeps what was typed with Tab or Enter, unless a row was highlighted (criteria 1, 2)', () => {
    render(<Harness />);
    type('re');
    expect(options()).toEqual(['REST', 'rest']);
    key('Tab');
    expect(shownText()).toBe('re');
    expect(options()).toEqual([]);

    type('r');
    key('Enter');
    expect(shownText()).toBe('r');
    expect(options()).toEqual([]);

    type('re');
    key('ArrowDown');
    expect(field().value).toBe('re');
    key('Enter');
    expect(shownText()).toBe('REST');

    type('re');
    key('ArrowDown');
    key('Tab');
    expect(shownText()).toBe('REST');

    type('re');
    key('ArrowDown');
    key('ArrowUp');
    key('Tab');
    expect(shownText()).toBe('re');
  });

  it('ignores a hovered row', () => {
    render(<Harness />);
    type('re');
    fireEvent.mouseEnter(screen.getByRole('option', { name: 'REST' }));
    key('Enter');
    expect(shownText()).toBe('re');
  });

  it('closes only the list with Esc, and lets the second one through', () => {
    const onOuterKey = vi.fn();
    render(<Harness onOuterKey={onOuterKey} />);
    type('re');
    key('Escape');
    expect(options()).toEqual([]);
    expect(shownText()).toBe('re');
    expect(onOuterKey).not.toHaveBeenCalled();
    key('Escape');
    expect(onOuterKey).toHaveBeenCalledWith('Escape', false);
  });

  it('prevents Enter while the list is open, and leaves it alone once closed', () => {
    const onOuterKey = vi.fn();
    render(<Harness onOuterKey={onOuterKey} />);
    type('re');
    key('Enter');
    expect(onOuterKey).toHaveBeenLastCalledWith('Enter', true);
    key('Enter');
    expect(onOuterKey).toHaveBeenLastCalledWith('Enter', false);
  });

  it('lets Ctrl+Enter through with the text shown, ignoring a highlight', () => {
    const onOuterKey = vi.fn();
    render(<Harness onOuterKey={onOuterKey} />);
    type('re');
    key('ArrowDown');
    key('Enter', { ctrlKey: true });
    expect(onOuterKey).toHaveBeenLastCalledWith('Enter', false);
    expect(shownText()).toBe('re');
    expect(options()).toEqual([]);
  });

  it('fills the field on a click, with focus still in it', () => {
    render(<Harness />);
    field().focus();
    type('re');
    const row = screen.getByRole('option', { name: 'rest' });
    // A press on a row, or on the list's scrollbar, keeps focus in the input.
    expect(fireEvent.mouseDown(row)).toBe(false);
    fireEvent.click(row);
    expect(shownText()).toBe('rest');
    expect(document.activeElement).toBe(field());
    expect(options()).toEqual([]);
  });

  it('ignores keys while composing text', () => {
    const onOuterKey = vi.fn();
    render(<Harness onOuterKey={onOuterKey} />);
    type('re');
    fireEvent.keyDown(field(), { key: 'Enter', isComposing: true });
    expect(options()).toHaveLength(2);
    expect(onOuterKey).toHaveBeenLastCalledWith('Enter', false);
  });
});

describe('opening', () => {
  it('stays closed on focus, and opens on a click, typing, or an arrow', () => {
    render(<Harness />);
    field().focus();
    expect(options()).toEqual([]);
    fireEvent.click(field());
    expect(options()).toHaveLength(4);
    key('Escape');
    type('r');
    expect(options()).toHaveLength(3);
    key('Escape');
    key('ArrowUp');
    expect(field().getAttribute('aria-activedescendant')).toBe(
      screen.getAllByRole('option').at(-1)?.id,
    );
  });

  it('shows the other values on a click, not matches for the text', () => {
    render(<Harness start="REST" />);
    fireEvent.click(field());
    expect(options()).toEqual(['rest', 'Message queue via broker', 'SFTP']);
    // Taking a row resets it too.
    fireEvent.click(screen.getByRole('option', { name: 'SFTP' }));
    fireEvent.click(field());
    expect(options()).toEqual(['REST', 'rest', 'Message queue via broker']);
  });

  it('stops at the last row, and goes back to no highlight from the first', () => {
    render(<Harness start="" values={['a', 'b']} />);
    key('ArrowDown');
    key('ArrowDown');
    key('ArrowDown');
    const [first, second] = screen.getAllByRole('option');
    expect(second?.getAttribute('aria-selected')).toBe('true');
    key('ArrowUp');
    expect(first?.getAttribute('aria-selected')).toBe('true');
    key('ArrowUp');
    expect(field().hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('has no list while read-only', () => {
    render(<Harness readOnly />);
    fireEvent.click(field());
    key('ArrowDown');
    expect(options()).toEqual([]);
    expect(field().getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the list', () => {
  it('narrows in order, ignoring case, and matches anywhere', () => {
    render(<Harness />);
    type('ST');
    expect(options()).toEqual(['REST', 'rest']);
    type('broker');
    expect(options()).toEqual(['Message queue via broker']);
  });

  it('never lists the value in the field, and shows nothing with nothing to offer', () => {
    render(<Harness />);
    type('rest');
    expect(options()).toEqual(['REST']);
    type('no match');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByText(/no match/i, { selector: 'li' })).toBeNull();
  });

  it('shows 50 rows of more, with the note, and stays quick', () => {
    const many = Array.from({ length: 1000 }, (_, i) => `Value ${i}`);
    render(<Harness values={many} />);
    fireEvent.click(field());
    expect(screen.getAllByRole('option')).toHaveLength(50);
    expect(screen.getByText('Showing 50 of 1000. Keep typing to narrow it down.')).toBeDefined();
    const start = cpuMs();
    type('Value 99');
    expect(cpuMs() - start).toBeLessThan(500);
    // 'Value 99' itself is what the field holds.
    expect(options()).toHaveLength(10);
    expect(screen.queryByText(/^Showing/)).toBeNull();
  });

  it('gives a long value its full text as a title', () => {
    const long = 'x'.repeat(300);
    render(<Harness values={[long]} />);
    fireEvent.click(field());
    expect(screen.getByRole('option').getAttribute('title')).toBe(long);
  });
});

describe('for assistive technology', () => {
  it('has the combobox attributes, and a highlight only when there is one', () => {
    render(<Harness />);
    expect(field().getAttribute('aria-autocomplete')).toBe('list');
    expect(field().getAttribute('aria-expanded')).toBe('false');
    expect(field().hasAttribute('aria-controls')).toBe(false);
    const hint = document.getElementById(field().getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe('Down arrow for suggestions.');
    type('re');
    const list = screen.getByRole('listbox', { name: 'Suggestions for protocol' });
    expect(field().getAttribute('aria-expanded')).toBe('true');
    expect(field().getAttribute('aria-controls')).toBe(list.id);
    expect(field().hasAttribute('aria-activedescendant')).toBe(false);
    key('ArrowDown');
    const row = screen.getByRole('option', { name: 'REST' });
    expect(field().getAttribute('aria-activedescendant')).toBe(row.id);
    expect(row.getAttribute('aria-selected')).toBe('true');
  });

  it('stays a plain textbox with no values, keeping the same element', () => {
    const { rerender } = render(
      <ValueField aria-label="Plain" value="" values={[]} label="x" onValue={() => undefined} />,
    );
    const input = screen.getByRole('textbox', { name: 'Plain' });
    expect(input.hasAttribute('aria-expanded')).toBe(false);
    expect(input.hasAttribute('aria-describedby')).toBe(false);
    rerender(
      <ValueField aria-label="Plain" value="" values={['a']} label="x" onValue={() => undefined} />,
    );
    expect(screen.getByRole('combobox', { name: 'Plain' })).toBe(input);
  });

  it('says how many rows there are, half a second after typing, and nothing for none', () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      act(() => {
        field().focus();
      });
      type('re');
      const status = () => document.querySelector('.vh[role="status"]')?.textContent;
      expect(status()).toBe('');
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(status()).toBe('2 suggestions');
      type('nothing like it');
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(status()).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
});

// On the forms and in the catalog.
const withData = (): JgfDocument => ({
  graph: {
    ...bakeryModel.graph,
    nodes: Object.fromEntries(
      Object.entries(bakeryModel.graph.nodes ?? {}).map(([id, node], index) => [
        id,
        {
          ...node,
          metadata: {
            ...node.metadata,
            ...(id === 'shop' ? { zone: 'Element zone', multi: 'two\nlines' } : {}),
            ...(id === 'till' ? { zone: 'Till zone', protocol: 'Element only' } : {}),
            ...(index === 2 ? { supplierHqCountry: 'nl' } : {}),
          },
        },
      ]),
    ),
    edges: (bakeryModel.graph.edges ?? []).map((edge, index) =>
      index < 4 ? { ...edge, metadata: { ...edge.metadata, protocol: 'REST' } } : edge,
    ),
  },
});

function api(model: JgfDocument) {
  const nodes = new Map(Object.entries(model.graph.nodes ?? {}));
  const edges = new Map((model.graph.edges ?? []).map((e) => [e.id ?? '', e]));
  const bodies: unknown[] = [];
  const handler: Handler = (request) => {
    const body: unknown = typeof request.body === 'string' ? JSON.parse(request.body) : undefined;
    if (request.method === 'GET' && request.url === '/api/models') {
      return Response.json({ models: [bakerySummary], editable: true });
    }
    if (request.method === 'GET' && request.url === `/api/models/${bakeryId}`) {
      return Response.json(model);
    }
    const elements = /\/elements\/([^/?]+)/.exec(request.url);
    if (elements) {
      const id = decodeURIComponent(elements[1] ?? '');
      if (request.method === 'PATCH') {
        bodies.push(body);
        const change = body as { metadata?: Record<string, unknown> };
        const node = nodes.get(id) ?? {};
        nodes.set(id, { ...node, metadata: { ...node.metadata, ...change.metadata } });
      }
      return Response.json({
        element: { id, version: 1, node: nodes.get(id) },
        warnings: [],
      });
    }
    const relationships = /\/relationships\/([^/?]+)/.exec(request.url);
    if (relationships) {
      const id = decodeURIComponent(relationships[1] ?? '');
      if (request.method === 'PATCH') bodies.push(body);
      return Response.json({
        relationship: { id, version: 1, edge: edges.get(id) as JgfEdge },
        warnings: [],
        nestingChanges: [],
      });
    }
    return undefined;
  };
  return { handler, bodies, nodes };
}

const details = () => screen.getByRole('complementary', { name: 'Details' });
const list = () => screen.queryByRole('listbox', { name: /^Suggestions for / });
const offeredNow = () => {
  const open = list();
  return open
    ? within(open)
        .queryAllByRole('option')
        .map((o) => o.textContent)
    : [];
};
const offered = () => offeredNow();
const shopAt = `/modelling/models/${bakeryId}/elements/shop?depth=1`;

async function openShop() {
  const server = api(withData());
  stubApi(modeller, server.handler);
  renderAt(shopAt);
  const form = await screen.findByRole('form', { name: /^Edit / });
  return { ...server, form };
}

const newRow = (form: HTMLElement, name: string) => {
  fireEvent.click(within(form).getByRole('button', { name: 'Add field' }));
  const key = within(form).getAllByRole('textbox', { name: 'Key' }).at(-1) as HTMLElement;
  fireEvent.change(key, { target: { value: name } });
  return key;
};

describe('custom rows', () => {
  it('follows the key as it is now, and never touches the value', async () => {
    const { form } = await openShop();
    fireEvent.click(within(form).getByRole('button', { name: 'Add field' }));
    const key = within(form).getAllByRole('textbox', { name: 'Key' }).at(-1) as HTMLElement;
    // No key: a plain text field.
    expect(within(form).getByRole('textbox', { name: 'Value of the new field' })).toBeDefined();
    fireEvent.change(key, { target: { value: ' zone ' } });
    const value = within(form)
      .getAllByRole<HTMLInputElement>('combobox', { name: 'Value of zone' })
      .at(-1) as HTMLInputElement;
    fireEvent.change(value, { target: { value: 'typed' } });
    fireEvent.change(value, { target: { value: '' } });
    expect(offered()).toEqual(['Element zone', 'Till zone']);
    fireEvent.change(key, { target: { value: 'Zone' } });
    expect(within(form).getByRole('textbox', { name: 'Value of Zone' })).toBe(value);
  });

  it('offers nothing for a key the model lacks, or a reserved or standard one', async () => {
    const { form } = await openShop();
    for (const name of ['constructor', 'toString', 'type', 'description', 'owningTeam']) {
      newRow(form, name);
      expect(within(form).getByRole('textbox', { name: `Value of ${name}` })).toBeDefined();
    }
    expect(list()).toBeNull();
  });

  it('leaves a row with a line break a textarea, and never offers such a value', async () => {
    const { form } = await openShop();
    const multi = within(form).getByRole('textbox', { name: 'Value of multi' });
    expect(multi.tagName).toBe('TEXTAREA');
    newRow(form, 'multi');
    expect(within(form).getAllByRole('textbox', { name: 'Value of multi' })).toHaveLength(2);
    expect(within(form).queryByRole('combobox', { name: 'Value of multi' })).toBeNull();
  });

  it('keeps separate lists for elements and relationships', async () => {
    const { form } = await openShop();
    newRow(form, 'protocol');
    fireEvent.click(within(form).getByRole('combobox', { name: 'Value of protocol' }));
    expect(offered()).toEqual(['Element only']);
  });

  it('offers a relationship only what relationships hold', async () => {
    await openShop();
    fireEvent.click(
      within(details()).getAllByRole('button', { name: /^Open relationship: / })[0] as HTMLElement,
    );
    const relationship = await screen.findByRole('form', { name: /^Relationship / });
    newRow(relationship, 'protocol');
    const fields = within(relationship).getAllByRole('combobox', { name: 'Value of protocol' });
    fireEvent.click(fields.at(-1) as HTMLElement);
    expect(offered()).toEqual(['REST']);
  });
});

describe('on the element form', () => {
  it('offers a value saved in this session, and not text only typed', async () => {
    const { form } = await openShop();
    const team = () =>
      within(form).getByRole<HTMLInputElement>('combobox', { name: 'Owning team' });
    const offeredOnClick = () => {
      fireEvent.click(team());
      return offeredNow();
    };
    fireEvent.change(team(), { target: { value: 'New team' } });
    fireEvent.change(team(), { target: { value: '' } });
    expect(offeredOnClick()).not.toContain('New team');
    fireEvent.change(team(), { target: { value: 'New team' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await within(form).findByText('Saved');
    fireEvent.change(team(), { target: { value: '' } });
    expect(offeredOnClick()).toContain('New team');
  });

  it('sends a typed value as it is, close to a listed one', async () => {
    const { form, bodies } = await openShop();
    const team = within(form).getByRole('combobox', { name: 'Owning team' });
    fireEvent.change(team, { target: { value: 'web team' } });
    fireEvent.keyDown(team, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(bodies.at(-1)).toEqual({ version: 1, metadata: { owningTeam: 'web team' } });
    });
  });

  it('has no list on Name, Description or the fixed choices', async () => {
    const { form } = await openShop();
    expect(within(form).getByRole('textbox', { name: /^Name/ })).toBeDefined();
    expect(within(form).getByRole('textbox', { name: 'Description' })).toBeDefined();
    expect(within(form).getByRole('combobox', { name: 'Sourcing' }).tagName).toBe('SELECT');
  });

  it('keeps the country note, following the text, and upper-cases the list (criteria 20, 21)', async () => {
    const { form } = await openShop();
    const country = () =>
      within(form).getByRole<HTMLInputElement>('combobox', { name: 'Supplier HQ country' });
    fireEvent.change(country(), { target: { value: '' } });
    expect(offered()).toEqual(expect.arrayContaining(['NL', 'HOLLAND']));
    expect(offered().filter((text) => text === 'NL')).toHaveLength(1);
    fireEvent.change(country(), { target: { value: 'ho' } });
    expect(country().value).toBe('HO');
    expect(within(form).getByText(/^Not an ISO 3166-1/)).toBeDefined();
    fireEvent.keyDown(country(), { key: 'ArrowDown' });
    expect(country().value).toBe('HO');
    fireEvent.keyDown(country(), { key: 'Enter' });
    expect(country().value).toBe('HOLLAND');
    expect(within(form).getByText(/^Not an ISO 3166-1/)).toBeDefined();
    expect(country().closest('.country-row')?.querySelector('.country-warn')).not.toBeNull();
  });
});

describe('in the catalog', () => {
  const openCatalog = async () => {
    const server = api(withData());
    stubApi(modeller, server.handler);
    renderAt(`/modelling/models/${bakeryId}?view=catalog&type=Application`);
    await screen.findByRole('grid');
    return server;
  };
  const cell = (row: string, column: string) => {
    const at = screen.getByRole<HTMLTableCellElement>('columnheader', {
      name: new RegExp(`^${column}`),
    }).cellIndex;
    const found = screen.getByRole('row', { name: new RegExp(row) }).children[at];
    return found as HTMLElement;
  };
  const input = (row: string) =>
    screen.getByRole<HTMLInputElement>('combobox', { name: `Owning team, ${row}` });
  const startCell = async (row: string) => {
    const target = cell(row, 'Owning team');
    fireEvent.click(target);
    await screen.findByRole('form', { name: /^Edit / });
    target.focus();
    return target;
  };

  it('opens closed by Enter, and open by a character, Delete or a double click', async () => {
    await openCatalog();
    const target = await startCell('Till');
    fireEvent.keyDown(target, { key: 'Enter' });
    expect(list()).toBeNull();
    fireEvent.keyDown(input('Till'), { key: 'Escape' });

    fireEvent.keyDown(cell('Till', 'Owning team'), { key: 'w' });
    expect(list()?.textContent).toContain('Web team');
    fireEvent.keyDown(input('Till'), { key: 'Escape' });

    fireEvent.keyDown(cell('Till', 'Owning team'), { key: 'Delete' });
    expect(list()).not.toBeNull();
    fireEvent.keyDown(input('Till'), { key: 'Escape' });
    expect(list()).toBeNull();
  });

  it('saves and moves with one press, with the highlight if any, and arrows stay in the list (criteria 22, 23)', async () => {
    const { bodies } = await openCatalog();
    const target = await startCell('Till');
    fireEvent.keyDown(target, { key: 'Enter' });
    fireEvent.keyDown(input('Till'), { key: 'ArrowDown' });
    const row = within(list() as HTMLElement).getAllByRole('option')[0] as HTMLElement;
    const first = row.textContent;
    expect(row.getAttribute('aria-selected')).toBe('true');
    // Still in the cell: the arrow went to the list.
    expect(document.activeElement).toBe(input('Till'));
    fireEvent.keyDown(input('Till'), { key: 'Enter' });
    await waitFor(() => {
      expect(bodies.at(-1)).toEqual({ version: 1, metadata: { owningTeam: first } });
    });
    await waitFor(() => {
      expect(cell('Till', 'Owning team').textContent).toBe(first);
    });
  });

  it('cancels with one Esc with the list open, and keeps what was there', async () => {
    const { bodies } = await openCatalog();
    const target = await startCell('Till');
    fireEvent.keyDown(target, { key: 'w' });
    fireEvent.keyDown(input('Till'), { key: 'Escape' });
    expect(screen.queryByRole('combobox', { name: 'Owning team, Till' })).toBeNull();
    expect(bodies).toEqual([]);
  });

  it('saves a clicked row and stays on the cell', async () => {
    const { bodies } = await openCatalog();
    const target = await startCell('Till');
    fireEvent.keyDown(target, { key: 'Delete' });
    const row = within(list() as HTMLElement).getByRole('option', { name: 'Web team' });
    fireEvent.mouseDown(row);
    fireEvent.click(row);
    await waitFor(() => {
      expect(bodies.at(-1)).toEqual({ version: 1, metadata: { owningTeam: 'Web team' } });
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(cell('Till', 'Owning team'));
    });
  });

  it('says so in the cell’s hint', async () => {
    await openCatalog();
    const target = await startCell('Till');
    fireEvent.keyDown(target, { key: 'Enter' });
    expect(document.getElementById('cat-keys')?.textContent).toBe(
      'Down arrow for suggestions. Enter saves, Esc cancels.',
    );
  });
});
