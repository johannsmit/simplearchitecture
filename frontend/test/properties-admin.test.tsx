import type {
  JgfDocument,
  JgfEdge,
  RelationshipPropertyDefinition,
  RelationshipPropertyUsage,
} from '@simplearchitecture/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImportPanel } from '../src/viewing/models/ImportPanel';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import {
  admin,
  apiError,
  modalDialogs,
  modeller,
  renderAt,
  stubApi,
  viewer,
  type Handler,
} from './helpers';

// Admin → Properties, a defined property in the read-only panel, and the import result. Made-up
// data.

const tier: RelationshipPropertyDefinition = {
  key: 'tier',
  name: 'tier',
  kind: 'text',
  fromModels: true,
  version: 1,
};
const criticality: RelationshipPropertyDefinition = {
  key: 'criticality',
  name: 'Criticality',
  kind: 'choice',
  options: ['Low', 'Medium', 'High'],
  fromModels: false,
  version: 3,
};
const usageOf = (
  key: string,
  values: RelationshipPropertyUsage['values'] = [],
  counts = { relations: 0, contains: 0, models: 0 },
): RelationshipPropertyUsage => ({ key, ...counts, values, labels: 0 });

interface Sent {
  method: string;
  url: string;
  body: unknown;
}

function propertiesApi(
  properties: RelationshipPropertyDefinition[],
  usage: RelationshipPropertyUsage[],
  answer?: (method: string, url: string, body: unknown) => Response | undefined,
) {
  const sent: Sent[] = [];
  const handler: Handler = (request) => {
    const body: unknown = typeof request.body === 'string' ? JSON.parse(request.body) : undefined;
    if (!request.url.startsWith('/api/properties')) return undefined;
    if (request.method !== 'GET') sent.push({ method: request.method, url: request.url, body });
    const own = answer?.(request.method, request.url, body);
    if (own) return own;
    if (request.url === '/api/properties/usage') return Response.json({ usage });
    if (request.method === 'GET') return Response.json({ properties });
    if (request.method === 'POST') {
      return Response.json(
        { property: { ...(body as object), fromModels: false, version: 1 } },
        { status: 201 },
      );
    }
    if (request.method === 'PATCH') {
      const key = new URL(request.url, 'http://x').searchParams.get('key') ?? '';
      const current = properties.find((property) => property.key === key);
      return Response.json({ property: { ...current, ...(body as object), fromModels: false } });
    }
    if (request.method === 'DELETE') {
      return Response.json({ key: 'tier', values: 48, models: 3 });
    }
    return undefined;
  };
  return { handler, sent };
}

async function openPage(
  properties: RelationshipPropertyDefinition[] = [tier, criticality],
  usage: RelationshipPropertyUsage[] = [
    usageOf('tier', [{ value: 'Gold', count: 40 }], { relations: 45, contains: 3, models: 3 }),
    usageOf('criticality'),
  ],
  answer?: Parameters<typeof propertiesApi>[2],
) {
  const server = propertiesApi(properties, usage, answer);
  stubApi(admin, server.handler);
  renderAt('/admin/properties');
  await screen.findByRole('heading', { level: 1, name: 'Properties' });
  return server;
}

const rows = () =>
  within(screen.getByRole('table', { name: 'Relation properties' }))
    .getAllByRole('row')
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    );

describe('Admin → Properties', () => {
  it('is in the Admin nav after Models, and only for Admins', async () => {
    await openPage();
    const nav = screen.getByRole('navigation', { name: 'Admin pages' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Models', 'Properties', 'Database', 'Branding', 'Connected apps', 'Logs']);
    expect(document.title).toBe('Properties – Admin – SimpleArchitecture');
    for (const who of [modeller, viewer]) {
      document.body.innerHTML = '';
      stubApi(who);
      renderAt('/admin/properties');
      await screen.findByRole('heading', { level: 1, name: /You don't have access to/ });
      expect(screen.queryByRole('heading', { level: 1, name: 'Properties' })).toBeNull();
    }
  });

  it('lists name, key, kind and values by name, with the note on properties from models', async () => {
    await openPage();
    await screen.findByRole('table', { name: 'Relation properties' });
    expect(rows()).toEqual([
      ['Criticality', 'criticality', 'Choice · 3 options', 'None', ''],
      [
        'tierFrom models. Added from the custom metadata in models. Check its name and kind.',
        'tier',
        'Text',
        '48 in 3 models',
        '',
      ],
    ]);
    expect(
      screen.getByText(/1 relation property was added from the custom metadata in models/),
    ).toBeDefined();
  });

  it('shows the empty state with no properties, and the standard ones below', async () => {
    await openPage([], []);
    expect(await screen.findByText('No relation properties defined yet.')).toBeDefined();
    expect(screen.getByText('No element properties defined yet.')).toBeDefined();
    expect(
      [...document.querySelectorAll('details.standard-properties summary')].map(
        (summary) => summary.textContent,
      ),
    ).toEqual(['Standard properties of an element 7', 'Standard properties of a Relation 6']);
  });

  it('creates a property: the key follows the name until typed in', async () => {
    const { sent } = await openPage([], []);
    fireEvent.click(screen.getByRole('button', { name: 'New relation property' }));
    const dialog = await screen.findByRole('dialog', { name: 'New relation property' });
    const name = within(dialog).getByLabelText(/^Name/);
    const key = within(dialog).getByLabelText<HTMLInputElement>(/^Key/);
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: 'Cost centre' } });
    expect(key.value).toBe('costCentre');
    fireEvent.change(key, { target: { value: 'costCenter' } });
    fireEvent.change(name, { target: { value: 'Cost centre (EU)' } });
    expect(key.value).toBe('costCenter');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(sent).toEqual([
        {
          method: 'POST',
          url: '/api/properties',
          body: { name: 'Cost centre (EU)', key: 'costCenter', kind: 'text' },
        },
      ]);
    });
    expect(
      await screen.findByText('Created the relation property Cost centre (EU).'),
    ).toBeDefined();
  });

  it('refuses at the dialog what the server would, and shows the server’s refusals at their field', async () => {
    const { sent } = await openPage([criticality], [usageOf('criticality')], (method) =>
      method === 'POST'
        ? apiError(422, 'Not valid.', {
            fields: [{ field: 'key', message: 'This key is reserved. Use another one.' }],
          })
        : undefined,
    );
    fireEvent.click(screen.getByRole('button', { name: 'New relation property' }));
    const dialog = await screen.findByRole('dialog', { name: 'New relation property' });
    const name = within(dialog).getByLabelText(/^Name/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(within(dialog).getByText('Enter a name.')).toBeDefined();
    fireEvent.change(name, { target: { value: 'Identity' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(within(dialog).getByText('“Identity” is a standard property.')).toBeDefined();
    fireEvent.change(name, { target: { value: 'CRITICALITY' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(
      within(dialog).getByText("There's already a property called “Criticality”."),
    ).toBeDefined();
    expect(sent).toEqual([]);
    fireEvent.change(name, { target: { value: 'Made-up' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    const key = within(dialog).getByLabelText(/^Key/);
    await waitFor(() => {
      expect(key.getAttribute('aria-invalid')).toBe('true');
    });
    expect(within(dialog).getByText('This key is reserved. Use another one.')).toBeDefined();
  });

  it('edits a choice list: two rows to start, Enter adds one, moves and removes', async () => {
    const { sent } = await openPage([], []);
    fireEvent.click(screen.getByRole('button', { name: 'New relation property' }));
    const dialog = await screen.findByRole('dialog', { name: 'New relation property' });
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Level' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Choice' }));
    const option = (n: number, of: number) =>
      within(dialog).getByRole<HTMLInputElement>('textbox', { name: `Option ${n} of ${of}` });
    await waitFor(() => {
      expect(document.activeElement).toBe(option(1, 2));
    });
    fireEvent.change(option(1, 2), { target: { value: 'High' } });
    fireEvent.keyDown(option(1, 2), { key: 'Enter' });
    await waitFor(() => {
      expect(document.activeElement).toBe(option(2, 3));
    });
    fireEvent.change(option(2, 3), { target: { value: 'Low' } });
    fireEvent.change(option(3, 3), { target: { value: 'Spare' } });
    expect(within(dialog).getByRole('button', { name: 'Move High up' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(dialog).getByRole('button', { name: 'Move Spare down' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move Low up' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Spare' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({
        name: 'Level',
        key: 'level',
        kind: 'choice',
        options: ['Low', 'High'],
      });
    });
  });

  it('keeps a key with values, and adds the values in use to the list', async () => {
    const { sent } = await openPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit relation property tier' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit relation property' });
    const key = within(dialog).getByLabelText<HTMLInputElement>(/^Key/);
    expect(key.readOnly).toBe(true);
    expect(
      within(dialog).getByText("Can't change: 48 values in 3 models use this key."),
    ).toBeDefined();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Choice' }));
    expect(within(dialog).getByText('In use, not in the list:')).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add all' }));
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Tier' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add option' }));
    const last = within(dialog)
      .getAllByRole('textbox', { name: /^Option \d of \d$/ })
      .at(-1);
    fireEvent.change(last as HTMLElement, { target: { value: 'Silver' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent.at(-1)).toEqual({
        method: 'PATCH',
        url: '/api/properties?key=tier',
        body: { version: 1, name: 'Tier', kind: 'choice', options: ['Gold', 'Silver'] },
      });
    });
    expect(await screen.findByText('Saved the relation property Tier.')).toBeDefined();
  });

  it('says so when someone else changed the property, and stops Save', async () => {
    await openPage(undefined, undefined, (method) =>
      method === 'PATCH' ? apiError(409, 'Changed.', { currentVersion: 4 }) : undefined,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit relation property Criticality' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Edit relation property' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(/Someone else changed this property since you opened it/),
    ).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  });

  it('deletes only once the name is typed, and gives the counts deleted', async () => {
    const { sent } = await openPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete relation property tier' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete the relation property tier?',
    });
    expect(
      within(dialog).getByText(
        "This deletes tier and its 48 values from 3 models. It can't be undone.",
      ),
    ).toBeDefined();
    const button = within(dialog).getByRole('button', { name: 'Delete property' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(sent).toEqual([]);
    const field = within(dialog).getByLabelText('Type tier to confirm');
    fireEvent.change(field, { target: { value: ' TIER ' } });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => {
      expect(sent).toEqual([
        { method: 'DELETE', url: '/api/properties?key=tier', body: undefined },
      ]);
    });
    expect(
      await screen.findByText('Deleted the relation property tier and 48 values from 3 models.'),
    ).toBeDefined();
  });
});

describe('Admin → Properties: focus and keys in the dialogs', () => {
  // In a browser the page behind a modal dialog is inert, so focus can only move there once the
  // dialog is gone. These tests make jsdom's dialogs modal (see modalDialogs).
  let undo: () => void = () => undefined;
  beforeEach(() => {
    undo = modalDialogs();
  });
  afterEach(() => {
    undo();
  });

  const press = (element: HTMLElement) => {
    act(() => {
      element.focus();
    });
    fireEvent.click(element);
  };
  const closed = async () => {
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  };

  it('returns focus to New relation property, the row’s pencil or trash, or the section heading after a delete', async () => {
    await openPage();
    const newButton = screen.getByRole('button', { name: 'New relation property' });
    const pencil = await screen.findByRole('button', {
      name: 'Edit relation property Criticality',
    });
    const trash = screen.getByRole('button', { name: 'Delete relation property tier' });
    for (const [opener, title, how] of [
      [newButton, 'New relation property', 'Escape'],
      [newButton, 'New relation property', 'Cancel'],
      [pencil, 'Edit relation property', 'Escape'],
      [pencil, 'Edit relation property', 'Cancel'],
      [trash, 'Delete the relation property tier?', 'Escape'],
      [trash, 'Delete the relation property tier?', 'Cancel'],
    ] as const) {
      press(opener);
      const dialog = await screen.findByRole('dialog', { name: title });
      expect(dialog.contains(document.activeElement)).toBe(true);
      if (how === 'Escape') fireEvent.keyDown(dialog, { key: 'Escape' });
      else fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await closed();
      expect(document.activeElement, `${title}, ${how}`).toBe(opener);
    }

    press(newButton);
    let dialog = await screen.findByRole('dialog', { name: 'New relation property' });
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Cost centre' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await closed();
    expect(document.activeElement, 'Create').toBe(newButton);

    press(pencil);
    dialog = await screen.findByRole('dialog', { name: 'Edit relation property' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await closed();
    await screen.findByText('Saved the relation property Criticality.');
    expect(document.activeElement, 'Save').toBe(
      screen.getByRole('button', { name: 'Edit relation property Criticality' }),
    );

    press(trash);
    dialog = await screen.findByRole('dialog', { name: 'Delete the relation property tier?' });
    const field = within(dialog).getByLabelText('Type tier to confirm');
    fireEvent.change(field, { target: { value: 'tier' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await closed();
    expect(document.activeElement, 'Delete').toBe(
      screen.getByRole('heading', { level: 2, name: 'Relation properties' }),
    );
  });

  it('after a save that gives the row a new key, focus is on that row’s pencil', async () => {
    const zone: RelationshipPropertyDefinition = {
      key: 'zone',
      name: 'Zone',
      kind: 'text',
      fromModels: false,
      version: 2,
    };
    const properties = [criticality, zone];
    await openPage(properties, [usageOf('criticality'), usageOf('zone')], (method) => {
      // The list read again after the save holds the new key.
      if (method === 'PATCH') properties[1] = { ...zone, key: 'area', version: 3 };
      return undefined;
    });
    press(await screen.findByRole('button', { name: 'Edit relation property Zone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit relation property' });
    fireEvent.change(within(dialog).getByLabelText(/^Key/), { target: { value: 'area' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await closed();
    await waitFor(() => {
      expect(rows().map((row) => row[1])).toEqual(['criticality', 'area']);
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Edit relation property Zone' }),
      );
    });
  });

  it('Kind is a radio group: the arrow keys switch it and focus stays on it; a click focuses the first option', async () => {
    await openPage([], []);
    press(screen.getByRole('button', { name: 'New relation property' }));
    const dialog = await screen.findByRole('dialog', { name: 'New relation property' });
    const text = within(dialog).getByRole<HTMLInputElement>('radio', { name: 'Text' });
    const choice = within(dialog).getByRole<HTMLInputElement>('radio', { name: 'Choice' });
    const options = () => within(dialog).queryAllByRole('textbox', { name: /^Option \d of \d$/ });
    // As a browser does on an arrow key: the next radio gets focus and is checked (a click).
    const arrow = (from: HTMLInputElement, key: string, to: HTMLInputElement) => {
      fireEvent.keyDown(from, { key });
      act(() => {
        to.focus();
      });
      fireEvent.click(to);
    };

    act(() => {
      text.focus();
    });
    arrow(text, 'ArrowRight', choice);
    expect(choice.checked).toBe(true);
    expect(options()).toHaveLength(2);
    expect(document.activeElement).toBe(choice);

    arrow(choice, 'ArrowLeft', text);
    expect(text.checked).toBe(true);
    expect(options()).toHaveLength(0);
    expect(document.activeElement).toBe(text);

    // Back to Choice with no options left, now by mouse: focus goes to the first option.
    arrow(text, 'ArrowRight', choice);
    for (const remove of within(dialog).getAllByRole('button', { name: /^Remove / })) {
      fireEvent.click(remove);
    }
    expect(options()).toHaveLength(0);
    for (const radio of [text, choice]) {
      fireEvent.pointerDown(radio);
      fireEvent.click(radio);
    }
    await waitFor(() => {
      expect(document.activeElement).toBe(options()[0]);
    });
  });

  it('saves a new name for a property whose key differs from another’s only in case', async () => {
    const tierUpper: RelationshipPropertyDefinition = {
      key: 'Tier',
      name: 'Tier (2)',
      kind: 'text',
      fromModels: true,
      version: 5,
    };
    const { sent } = await openPage([tier, tierUpper], [usageOf('tier'), usageOf('Tier')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit relation property Tier (2)' }));
    let dialog = await screen.findByRole('dialog', { name: 'Edit relation property' });
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Tier two' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent).toEqual([
        {
          method: 'PATCH',
          url: '/api/properties?key=Tier',
          body: { version: 5, name: 'Tier two', kind: 'text' },
        },
      ]);
    });
    await screen.findByText('Saved the relation property Tier two.');

    // The name "tier" is the other's key ignoring case, and is checked only when it changes too.
    fireEvent.click(screen.getByRole('button', { name: 'Edit relation property tier' }));
    dialog = await screen.findByRole('dialog', { name: 'Edit relation property' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Choice' }));
    const [first, second] = within(dialog).getAllByRole('textbox', { name: /^Option \d of 2$/ });
    fireEvent.change(first as HTMLElement, { target: { value: 'Gold' } });
    fireEvent.change(second as HTMLElement, { target: { value: 'Silver' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(sent.at(-1)).toEqual({
        method: 'PATCH',
        url: '/api/properties?key=tier',
        body: { version: 1, name: 'tier', kind: 'choice', options: ['Gold', 'Silver'] },
      });
    });
    await screen.findByText('Saved the relation property tier.');

    // A changed key is still checked against the others.
    fireEvent.click(screen.getByRole('button', { name: 'Edit relation property tier' }));
    dialog = await screen.findByRole('dialog', { name: 'Edit relation property' });
    fireEvent.change(within(dialog).getByLabelText(/^Key/), { target: { value: 'TIER' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      within(dialog).getByText("There's already a property with the key “Tier”."),
    ).toBeDefined();
    expect(sent).toHaveLength(2);
  });
});

describe('a defined property in the read-only panel', () => {
  const document_: JgfDocument = {
    graph: {
      ...bakeryModel.graph,
      edges: (bakeryModel.graph.edges ?? []).map((edge): JgfEdge =>
        edge.id === 'e7' ? { ...edge, metadata: { criticality: 'Gold' } } : edge,
      ),
    },
  };

  it('shows defined properties after the standard rows, marks a value outside the list', async () => {
    const handler: Handler = (request) => {
      if (request.url === '/api/models') {
        return Response.json({ models: [bakerySummary] });
      }
      if (request.url === `/api/models/${bakeryId}`) return Response.json(document_);
      if (request.url === '/api/properties') {
        return Response.json({ properties: [criticality, { ...tier, name: 'Service tier' }] });
      }
      return undefined;
    };
    stubApi(viewer, handler);
    renderAt(`/viewing/models/${bakeryId}/elements/shop?depth=1`);
    await screen.findByRole('heading', { level: 2, name: 'Web Shop' });
    const details = screen.getByRole('complementary', { name: 'Details' });
    fireEvent.click(
      within(details).getAllByRole('button', {
        name: /^Open relationship: Relates to Back Office Server/,
      })[0] as HTMLElement,
    );
    const terms = await waitFor(() => {
      const found = [...details.querySelectorAll('dt')].map((term) => term.textContent);
      expect(found).toContain('Criticality');
      return found;
    });
    // After the Data row's two lists, named after the ends.
    expect(terms.slice(-3)).toEqual([
      'Back Office Server to Web Shop',
      'Criticality',
      'Service tier',
    ]);
    expect(within(details).getByTitle('Not in the list').textContent).toContain('Gold');
    expect(within(details).queryByText('Custom metadata')).toBeNull();
  });
});

describe('the import result', () => {
  it('says which properties were added, and links to Admin → Properties', () => {
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
                summary: bakeryValidationSummary,
              },
              newProperties: [
                { key: 'tier', name: 'tier', values: 31 },
                { key: 'zone', name: 'zone', values: 2 },
              ],
            } as never,
          }}
          onDismiss={() => undefined}
          onChooseFile={() => undefined}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '2 new properties' }));
    const section = document.getElementById('import-section-new-properties');
    expect(section?.hasAttribute('open')).toBe(true);
    expect(within(section as HTMLElement).getByText('2 added from relationships')).toBeDefined();
    expect(within(section as HTMLElement).getByText('tier')).toBeDefined();
    expect(within(section as HTMLElement).getByText('31')).toBeDefined();
    expect(
      within(section as HTMLElement)
        .getByRole('link', { name: 'Admin → Properties' })
        .getAttribute('href'),
    ).toBe('/admin/properties');
  });
});

const bakeryValidationSummary = {};
