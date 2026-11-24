import type { JgfEdge, JgfNode, ModelElement } from '@simplearchitecture/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { changesOf, clientErrors, draftOf, withoutInvalid, withType } from '../src/modelling/draft';
import { autoSaveDelayMillis } from '../src/modelling/useAutoSave';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { apiError, currentLocation, modeller, renderAt, stubApi, type Handler } from './helpers';
import { settle } from './settle';

// Auto-save in the details panel of Modelling. Made-up data (the bakery fixture).

const modellingBase = `/modelling/models/${bakeryId}`;
const at = (id: string) => `${modellingBase}/elements/${encodeURIComponent(id)}`;
const elementsUrl = `/api/models/${bakeryId}/elements`;
const relationshipsUrl = `/api/models/${bakeryId}/relationships`;

interface Patch {
  url: string;
  body: Record<string, unknown>;
}

/**
 * A small editing API with versions, as the server keeps them: a PATCH with another version is a
 * conflict (409). `hold` makes each PATCH wait until the test lets it go; `answer` overrides any
 * request.
 */
function api(
  options: {
    hold?: boolean;
    answer?: (method: string, url: string, body: unknown) => Response | undefined;
  } = {},
) {
  const nodes = new Map(Object.entries(bakeryModel.graph.nodes ?? {}));
  const edges = new Map(
    (bakeryModel.graph.edges ?? []).map((edge) => [
      edge.id as string,
      edge as JgfEdge & { id: string },
    ]),
  );
  const versions = new Map<string, number>();
  const patches: Patch[] = [];
  const conflicts: string[] = [];
  const waiting: (() => void)[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const elementResult = (id: string) =>
    Response.json({
      element: { id, version: versions.get(id) ?? 1, node: nodes.get(id) },
      warnings: [],
    });
  const relationshipResult = (edge: JgfEdge & { id: string }) =>
    Response.json({
      relationship: { id: edge.id, version: versions.get(edge.id) ?? 1, edge },
      warnings: [],
      nestingChanges: [],
    });

  const patchElement = (id: string, change: Record<string, unknown>): Response => {
    const version = versions.get(id) ?? 1;
    if (change.version !== version) {
      conflicts.push(id);
      return apiError(409, 'Changed', { currentVersion: version });
    }
    const node: JgfNode = nodes.get(id) ?? {};
    const metadata = Object.fromEntries(
      Object.entries({
        ...node.metadata,
        ...(change.type === undefined ? {} : { type: change.type }),
        ...(change.description === undefined ? {} : { description: change.description }),
        ...(change.metadata as Record<string, unknown> | undefined),
      }).filter(([, value]) => value !== null),
    );
    nodes.set(id, { label: (change.name as string | undefined) ?? node.label ?? '', metadata });
    versions.set(id, version + 1);
    return elementResult(id);
  };

  const patchRelationship = (id: string, change: Record<string, unknown>): Response => {
    const edge = edges.get(id);
    if (!edge) return apiError(404, 'Not found', { missing: 'relationship' });
    const version = versions.get(id) ?? 1;
    if (change.version !== version) {
      conflicts.push(id);
      return apiError(409, 'Changed', { currentVersion: version });
    }
    const next = { ...edge, metadata: { ...edge.metadata } };
    if (typeof change.architectureState === 'string') {
      next.metadata.architectureState = change.architectureState;
    }
    if (change.reverse === true) [next.source, next.target] = [edge.target, edge.source];
    if (typeof change.source === 'string') next.source = change.source;
    if (typeof change.target === 'string') next.target = change.target;
    if (change.label === null) delete next.label;
    else if (typeof change.label === 'string') next.label = change.label;
    edges.set(id, next);
    versions.set(id, version + 1);
    return relationshipResult(next);
  };

  const handler: Handler = (request) => {
    const body: unknown = typeof request.body === 'string' ? JSON.parse(request.body) : undefined;
    const custom = options.answer?.(request.method, request.url, body);
    if (custom) return custom;
    if (request.url === '/api/models') return Response.json({ models: [bakerySummary] });
    if (request.url === `/api/models/${bakeryId}`) return Response.json(bakeryModel);
    const isElement = request.url.startsWith(elementsUrl);
    const isRelationship = request.url.startsWith(relationshipsUrl);
    if (!isElement && !isRelationship) return undefined;
    const id = decodeURIComponent(
      request.url.slice((isElement ? elementsUrl : relationshipsUrl).length + 1).split('?')[0] ??
        '',
    );
    if (request.method === 'GET') {
      if (isElement) return elementResult(id);
      const edge = edges.get(id);
      return edge ? relationshipResult(edge) : apiError(404, 'Not found');
    }
    if (request.method !== 'PATCH') return undefined;
    patches.push({ url: request.url, body: body as Record<string, unknown> });
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    const change = body as Record<string, unknown>;
    const answer = () => {
      inFlight -= 1;
      return isElement ? patchElement(id, change) : patchRelationship(id, change);
    };
    if (options.hold !== true) return answer();
    return new Promise<Response>((resolve) => {
      waiting.push(() => {
        resolve(answer());
      });
    });
  };

  /** Lets the oldest PATCH that is waiting go on, and waits for what follows from it. */
  const release = async () => {
    await waitFor(() => {
      expect(waiting.length).toBeGreaterThan(0);
    });
    waiting.shift()?.();
    await settle();
  };

  return {
    handler,
    nodes,
    edges,
    patches,
    conflicts,
    release,
    waiting,
    mostInFlight: () => mostInFlight,
  };
}

const details = () => screen.getByRole('complementary', { name: 'Details' });
const tree = () => screen.getByRole('tree', { name: 'Elements by type' });
const nameField = (form: HTMLElement) =>
  within(form).getByRole<HTMLInputElement>('textbox', { name: /^Name/ });
const descriptionField = (form: HTMLElement) =>
  within(form).getByRole<HTMLTextAreaElement>('textbox', { name: 'Description' });
const stateField = (form: HTMLElement) =>
  within(form).getByRole<HTMLSelectElement>('combobox', { name: 'Architecture state' });
/** The status line in the panel's head, as shown. */
const shownStatus = () => details().querySelector('.save-status')?.textContent ?? '';
/** What the status region says to screen readers (spaces trimmed: a repeat adds one). */
const saidStatus = () =>
  details()
    .querySelector('.save-status ~ [role="status"]')
    ?.textContent.replace(/\u00a0/g, '') ?? '';

async function openForm(path: string, options: Parameters<typeof api>[0] = {}) {
  const server = api(options);
  const fetchMock = stubApi(modeller, server.handler);
  renderAt(path);
  const form = await screen.findByRole('form', { name: /^Edit / });
  await settle();
  return { form, server, fetchMock };
}

/** Runs `step` with the timers faked, so the typing pause can be passed exactly. */
async function withFakeTimers(step: () => Promise<void>) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await step();
  } finally {
    vi.useRealTimers();
  }
}

const pass = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

afterEach(() => {
  vi.useRealTimers();
});

describe('auto-save on the element form', () => {
  it('has no Save bar, Save or Discard changes button', async () => {
    const { form } = await openForm(at('till'));
    fireEvent.change(nameField(form), { target: { value: 'Till 2' } });
    expect(form.querySelector('.d-form-foot')).toBeNull();
    expect(within(details()).queryByRole('button', { name: /^Save/ })).toBeNull();
    expect(within(details()).queryByRole('button', { name: 'Discard changes' })).toBeNull();
    // Nothing shows before the first save.
    expect(shownStatus()).toBe('');
  });

  it('saves a name once, after the typing pause, and each keystroke starts the pause again', async () => {
    const { form, server } = await openForm(at('till'));
    await withFakeTimers(async () => {
      fireEvent.change(nameField(form), { target: { value: 'Till 2' } });
      await pass(autoSaveDelayMillis - 1);
      fireEvent.change(nameField(form), { target: { value: 'Till 22' } });
      await pass(autoSaveDelayMillis - 1);
      expect(server.patches).toEqual([]);
      await pass(1);
    });
    await waitFor(() => {
      expect(server.patches).toHaveLength(1);
    });
    expect(server.patches[0]?.body).toEqual({ version: 1, name: 'Till 22' });
    await settle();
    expect(server.patches).toHaveLength(1);
  });

  it('saves at once when focus leaves a field with a change waiting, and keeps focus where it went', async () => {
    const { form, server } = await openForm(at('till'));
    act(() => {
      nameField(form).focus();
    });
    fireEvent.change(nameField(form), { target: { value: 'Till 2' } });
    act(() => {
      descriptionField(form).focus();
    });
    await waitFor(() => {
      expect(server.patches.map((patch) => patch.body)).toEqual([{ version: 1, name: 'Till 2' }]);
    });
    await settle();
    expect(document.activeElement).toBe(descriptionField(form));
    // Leaving a field with nothing waiting sends nothing.
    act(() => {
      nameField(form).focus();
    });
    await settle();
    expect(server.patches).toHaveLength(1);
  });

  it('saves a pick at once: a choice, and the type', async () => {
    const { form, server } = await openForm(at('till'));
    fireEvent.change(stateField(form), { target: { value: 'Current' } });
    await waitFor(() => {
      expect(server.patches.map((patch) => patch.body)).toEqual([
        { version: 1, metadata: { architectureState: 'Current' } },
      ]);
    });
    await settle();
    fireEvent.change(within(form).getByRole('combobox', { name: 'Type' }), {
      target: { value: 'Other' },
    });
    await waitFor(() => {
      expect(server.patches[1]?.body).toEqual({ version: 2, type: 'Other' });
    });
  });

  it('saves a burst of edits in order, one at a time, each with the version the last one gave', async () => {
    const { form, server } = await openForm(at('till'), { hold: true });
    act(() => {
      nameField(form).focus();
    });
    fireEvent.change(nameField(form), { target: { value: 'Till A' } });
    // Ctrl+Enter: save now.
    fireEvent.keyDown(nameField(form), { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(server.patches).toHaveLength(1);
    });
    // While the first is on its way: a pick, more typing, and another pick.
    fireEvent.change(stateField(form), { target: { value: 'Current' } });
    fireEvent.change(nameField(form), { target: { value: 'Till AB' } });
    fireEvent.change(descriptionField(form), { target: { value: 'Takes orders at the counter' } });
    fireEvent.change(stateField(form), { target: { value: 'Target' } });
    await settle();
    expect(server.patches).toHaveLength(1);
    await server.release();
    await waitFor(() => {
      expect(server.patches).toHaveLength(2);
    });
    // More while the second is on its way.
    fireEvent.change(nameField(form), { target: { value: 'Till ABC' } });
    fireEvent.keyDown(nameField(form), { key: 'Enter', ctrlKey: true });
    await server.release();
    await waitFor(() => {
      expect(server.patches).toHaveLength(3);
    });
    await server.release();
    await settle();

    expect(server.patches.map((patch) => patch.body)).toEqual([
      { version: 1, name: 'Till A' },
      {
        version: 2,
        name: 'Till AB',
        description: 'Takes orders at the counter',
        metadata: { architectureState: 'Target' },
      },
      { version: 3, name: 'Till ABC' },
    ]);
    expect(server.mostInFlight()).toBe(1);
    expect(server.conflicts).toEqual([]);
    expect(server.nodes.get('till')).toEqual({
      label: 'Till ABC',
      metadata: {
        type: 'Application',
        architectureState: 'Target',
        description: 'Takes orders at the counter',
      },
    });
    expect(within(details()).queryByText('Someone else changed this element')).toBeNull();
    expect(within(tree()).getByRole('treeitem', { name: 'Till ABC' })).toBeTruthy();
  });

  it('keeps what is typed while a save is on its way, and saves it next', async () => {
    const { form, server } = await openForm(at('till'), { hold: true });
    fireEvent.change(nameField(form), { target: { value: 'Till 2' } });
    fireEvent.keyDown(nameField(form), { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(server.patches).toHaveLength(1);
    });
    // Fields stay editable while saving.
    expect(nameField(form).readOnly).toBe(false);
    fireEvent.change(nameField(form), { target: { value: 'Till 2 at the door ' } });
    await server.release();
    // The response doesn't overwrite it, not even to trim the space at the end.
    expect(nameField(form).value).toBe('Till 2 at the door ');
    fireEvent.keyDown(nameField(form), { key: 'Enter', ctrlKey: true });
    await server.release();
    expect(server.patches.map((patch) => patch.body)).toEqual([
      { version: 1, name: 'Till 2' },
      { version: 2, name: 'Till 2 at the door' },
    ]);
    expect(nameField(form).value).toBe('Till 2 at the door ');
    // Typed on: the trimmed space is already saved, so nothing more goes.
    await settle();
    expect(server.patches).toHaveLength(2);
  });

  it('shows Saving… during a save and Saved until the next edit; says Saved once a save, never Saving…', async () => {
    const { form, server } = await openForm(at('till'), { hold: true });
    fireEvent.change(stateField(form), { target: { value: 'Current' } });
    await waitFor(() => {
      expect(shownStatus()).toBe('Saving…');
    });
    expect(saidStatus()).toBe('');
    await server.release();
    expect(shownStatus()).toBe('Saved');
    expect(saidStatus()).toBe('Saved');
    const region = details().querySelector('.save-status ~ [role="status"]');
    const first = region?.textContent;

    fireEvent.change(stateField(form), { target: { value: 'Target' } });
    await waitFor(() => {
      expect(shownStatus()).toBe('Saving…');
    });
    await server.release();
    expect(shownStatus()).toBe('Saved');
    // Said again: the region's text changed, so it is announced once more.
    expect(region?.textContent).not.toBe(first);
    expect(saidStatus()).toBe('Saved');

    // The next edit clears it.
    fireEvent.change(nameField(form), { target: { value: 'Till 2' } });
    expect(shownStatus()).toBe('');
  });

  it('keeps an empty name unsaved at its field, and saves a description changed with it', async () => {
    const { form, server } = await openForm(at('till'));
    act(() => {
      nameField(form).focus();
    });
    fireEvent.change(nameField(form), { target: { value: '  ' } });
    // Not while typing.
    expect(within(form).queryByText('Enter a name.')).toBeNull();
    fireEvent.change(descriptionField(form), { target: { value: 'At the counter' } });
    fireEvent.keyDown(nameField(form), { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(server.patches.map((patch) => patch.body)).toEqual([
        { version: 1, description: 'At the counter' },
      ]);
    });
    await settle();
    const field = nameField(form);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toContain('ef-name-error');
    expect(within(form).getByText('Enter a name.')).toBeTruthy();
    expect(shownStatus()).toBe("Couldn't save: 1 field needs a fix");
    expect(saidStatus()).toBe("Couldn't save: 1 field needs a fix");
    expect(document.activeElement).toBe(field);

    // Fixed: the name goes too.
    fireEvent.change(field, { target: { value: 'Till 2' } });
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(server.patches[1]?.body).toEqual({ version: 2, name: 'Till 2' });
    });
  });

  it('says to check the connection when a save fails, keeps the values, and Try again sends them', async () => {
    let failing = true;
    const { form, server } = await openForm(at('till'), {
      answer: (method) =>
        method === 'PATCH' && failing ? apiError(503, 'Unavailable') : undefined,
    });
    fireEvent.change(nameField(form), { target: { value: 'Till 2' } });
    fireEvent.keyDown(nameField(form), { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(shownStatus()).toBe("Couldn't save: check your connection");
    });
    expect(within(form).getByRole('alert').textContent).toContain(
      "The change wasn't saved. Check your connection and try again.",
    );
    expect(nameField(form).value).toBe('Till 2');

    failing = false;
    fireEvent.click(within(form).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(server.patches.map((patch) => patch.body)).toEqual([{ version: 1, name: 'Till 2' }]);
    });
    await waitFor(() => {
      expect(shownStatus()).toBe('Saved');
    });
    expect(within(form).queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('says so when the network is down', async () => {
    const { form } = await openForm(at('till'), {
      answer: (method) => {
        if (method === 'PATCH') throw new TypeError('Failed to fetch');
        return undefined;
      },
    });
    fireEvent.change(stateField(form), { target: { value: 'Current' } });
    await waitFor(() => {
      expect(shownStatus()).toBe("Couldn't save: check your connection");
    });
    expect(within(form).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('shows a conflict as before, sends nothing more until Reload, and leaves focus where it is', async () => {
    const { form, server } = await openForm(at('till'));
    server.nodes.set('till', { label: 'Till (theirs)', metadata: { type: 'Application' } });
    act(() => {
      nameField(form).focus();
    });
    // Someone else saved meanwhile: the version moved on.
    await act(async () => {
      await fetch(`${elementsUrl}/till`, {
        method: 'PATCH',
        body: JSON.stringify({ version: 1, name: 'Till (theirs)' }),
      });
    });
    server.patches.length = 0;
    fireEvent.change(nameField(form), { target: { value: 'Till (mine)' } });
    fireEvent.keyDown(nameField(form), { key: 'Enter', ctrlKey: true });

    await within(form).findByRole('heading', { name: 'Someone else changed this element' });
    expect(document.activeElement).toBe(nameField(form));
    expect(within(form).getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(nameField(form).value).toBe('Till (mine)');
    expect(shownStatus()).toBe("Couldn't save: someone else changed this element");

    fireEvent.change(stateField(form), { target: { value: 'Current' } });
    fireEvent.change(nameField(form), { target: { value: 'Till (mine) 2' } });
    fireEvent.keyDown(nameField(form), { key: 'Enter', ctrlKey: true });
    await settle();
    expect(server.patches).toHaveLength(1);

    fireEvent.click(within(form).getByRole('button', { name: 'Reload' }));
    await waitFor(() => {
      expect(nameField(form).value).toBe('Till (theirs)');
    });
    expect(shownStatus()).toBe('');
    fireEvent.change(nameField(form), { target: { value: 'Till 3' } });
    fireEvent.keyDown(nameField(form), { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(server.patches[1]?.body).toEqual({ version: 2, name: 'Till 3' });
    });
  });

  it('never saves on Enter in a one-line field, and Esc opens no dialog', async () => {
    const { form, server } = await openForm(at('till'));
    fireEvent.change(nameField(form), { target: { value: 'Till 2' } });
    fireEvent.keyDown(nameField(form), { key: 'Enter' });
    fireEvent.keyDown(nameField(form), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(nameField(form).value).toBe('Till 2');
    expect(server.patches).toEqual([]);
    // ⌘+Enter saves now too.
    fireEvent.keyDown(nameField(form), { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(server.patches).toHaveLength(1);
    });
  });

  it('saves a change waiting for the pause when another element is picked, without asking', async () => {
    const { form, server } = await openForm(at('till'));
    fireEvent.change(nameField(form), { target: { value: 'Till 2' } });
    fireEvent.click(within(tree()).getByText('Web Shop'));
    await waitFor(() => {
      expect(within(details()).getByRole('heading', { level: 2 }).textContent).toBe('Web Shop');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(server.patches.map((patch) => patch.body)).toEqual([{ version: 1, name: 'Till 2' }]);
    expect(within(tree()).getByRole('treeitem', { name: 'Till 2' })).toBeTruthy();
  });

  it('asks "Leave without saving?" when a change couldn’t be saved; Keep editing stays, Leave goes', async () => {
    const { form, server } = await openForm(at('till'));
    fireEvent.change(nameField(form), { target: { value: '' } });
    fireEvent.click(within(tree()).getByText('Web Shop'));

    let dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    expect(dialog.textContent).toContain(
      "Your last change to “Till” couldn't be saved: 1 field needs a fix.",
    );
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Keep editing' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => {
      expect(currentLocation()).toContain('/elements/till');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(nameField(form).value).toBe('');

    // Esc keeps editing too.
    fireEvent.click(within(tree()).getByText('Web Shop'));
    dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    fireEvent.click(within(tree()).getByText('Web Shop'));
    dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave without saving' }));
    await waitFor(() => {
      expect(within(details()).getByRole('heading', { level: 2 }).textContent).toBe('Web Shop');
    });
    expect(server.patches).toEqual([]);
  });

  it('asks before leaving after a failed save, following a link out of the explorer', async () => {
    const { form } = await openForm(at('till'), {
      answer: (method) => (method === 'PATCH' ? apiError(500, 'Broken') : undefined),
    });
    fireEvent.change(stateField(form), { target: { value: 'Current' } });
    await waitFor(() => {
      expect(shownStatus()).toBe("Couldn't save: check your connection");
    });
    const nav = screen.getByRole('navigation', { name: 'Spaces' });
    fireEvent.click(within(nav).getByRole('link', { name: 'Viewing' }));
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    expect(dialog.textContent).toContain('check your connection.');
    expect(currentLocation()).toContain('/modelling/');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave without saving' }));
    await waitFor(() => {
      expect(currentLocation()).toBe('/viewing');
    });
  });

  it('warns on closing the tab only while a save waits, is on its way or failed', async () => {
    let failing = false;
    const { form, server } = await openForm(at('till'), {
      hold: true,
      answer: (method) => (method === 'PATCH' && failing ? apiError(500, 'Broken') : undefined),
    });
    const closing = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(closing()).toBe(false);
    fireEvent.change(nameField(form), { target: { value: 'Till 2' } });
    await settle();
    // Waiting for the typing pause.
    expect(closing()).toBe(true);
    fireEvent.keyDown(nameField(form), { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(server.patches).toHaveLength(1);
    });
    // On its way.
    expect(closing()).toBe(true);
    await server.release();
    expect(shownStatus()).toBe('Saved');
    expect(closing()).toBe(false);

    failing = true;
    fireEvent.change(stateField(form), { target: { value: 'Current' } });
    await waitFor(() => {
      expect(shownStatus()).toBe("Couldn't save: check your connection");
    });
    // Failed.
    expect(closing()).toBe(true);
  });

  it('flushes a waiting change before deleting, so the delete sends the version it gave', async () => {
    const deletes: string[] = [];
    const { form } = await openForm(at('lonely'), {
      answer: (method, url) => {
        if (method !== 'DELETE') return undefined;
        deletes.push(url);
        return Response.json({
          id: 'lonely',
          deletedRelationshipCount: 0,
          deletedRelationshipIds: [],
          unnestedElementIds: [],
          referencesRemovedFrom: [],
        });
      },
    });
    fireEvent.change(nameField(form), { target: { value: 'Recipe Archive 2' } });
    fireEvent.click(within(details()).getByRole('button', { name: 'Delete element' }));
    const dialog = await screen.findByRole('dialog', { name: /^Delete “/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete element' }));
    await waitFor(() => {
      expect(deletes).toEqual([`${elementsUrl}/lonely?version=2`]);
    });
  });
});

describe('closing the details panel', () => {
  const close = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Close the details' }));
  };

  it('still saves a change typed while a save was on its way', async () => {
    const { form, server } = await openForm(at('till'), { hold: true });
    fireEvent.change(stateField(form), { target: { value: 'Current' } });
    await waitFor(() => {
      expect(server.patches).toHaveLength(1);
    });
    fireEvent.change(nameField(form), { target: { value: 'Till typed during save' } });
    close();
    await settle();
    expect(screen.queryByRole('form', { name: /^Edit / })).toBeNull();
    await server.release();
    await server.release();
    expect(server.patches).toHaveLength(2);
    expect(server.patches[1]?.body).toMatchObject({ version: 2, name: 'Till typed during save' });
    expect(server.conflicts).toEqual([]);
    expect(server.nodes.get('till')).toEqual({
      label: 'Till typed during save',
      metadata: { type: 'Application', architectureState: 'Current' },
    });
  });

  it('still saves a pick made while a save was on its way', async () => {
    const { form, server } = await openForm(at('till'), { hold: true });
    fireEvent.change(stateField(form), { target: { value: 'Current' } });
    await waitFor(() => {
      expect(server.patches).toHaveLength(1);
    });
    fireEvent.change(stateField(form), { target: { value: 'Target' } });
    close();
    await settle();
    await server.release();
    await server.release();
    expect(server.patches.map((patch) => patch.body.version)).toEqual([1, 2]);
    expect(server.conflicts).toEqual([]);
    expect(server.nodes.get('till')?.metadata?.architectureState).toBe('Target');
  });

  it('saves a change waiting for the typing pause', async () => {
    const { form, server } = await openForm(at('till'));
    fireEvent.change(nameField(form), { target: { value: 'Till closed' } });
    close();
    await waitFor(() => {
      expect(server.patches.map((patch) => patch.body)).toEqual([
        { version: 1, name: 'Till closed' },
      ]);
    });
    await settle();
    expect(server.patches).toHaveLength(1);
  });
});

describe('auto-save on the relationship form', () => {
  async function openRelationship(options: Parameters<typeof api>[0] = {}) {
    const result = await openForm(at('shop'), options);
    fireEvent.click(
      within(details()).getAllByRole('button', {
        name: /^Open relationship: Relates to Back Office Server/,
      })[0] as HTMLElement,
    );
    const form = await screen.findByRole('form', { name: /^Relationship / });
    await settle();
    return { ...result, form };
  }

  it('saves a state at once, and a label after the pause, with the version each time', async () => {
    const { form, server } = await openRelationship();
    expect(within(details()).queryByRole('button', { name: /^Save/ })).toBeNull();
    fireEvent.click(within(form).getByRole('radio', { name: /Target/ }));
    await waitFor(() => {
      expect(server.patches.map((patch) => patch.body)).toEqual([
        { version: 1, architectureState: 'Target' },
      ]);
    });
    await waitFor(() => {
      expect(shownStatus()).toBe('Saved');
    });
    const label = within(form).getByRole('combobox', { name: 'Label' });
    await withFakeTimers(async () => {
      fireEvent.change(label, { target: { value: 'Stock levels' } });
      await pass(autoSaveDelayMillis - 1);
      expect(server.patches).toHaveLength(1);
      await pass(1);
    });
    await waitFor(() => {
      expect(server.patches[1]?.body).toEqual({ version: 2, label: 'Stock levels' });
    });
  });

  it('saves Reverse at once, and a second Reverse as a reverse of the saved ends', async () => {
    const { form, server } = await openRelationship({ hold: true });
    const reverse = () => within(details()).getByRole('button', { name: 'Reverse direction' });
    fireEvent.click(reverse());
    await waitFor(() => {
      expect(server.patches).toHaveLength(1);
    });
    // Reversed again while the first is on its way: it goes next, as a reverse back.
    fireEvent.click(reverse());
    fireEvent.click(within(form).getByRole('radio', { name: /Target/ }));
    await server.release();
    await server.release();
    fireEvent.click(reverse());
    await server.release();
    expect(server.patches.map((patch) => patch.body)).toEqual([
      { version: 1, reverse: true },
      { version: 2, reverse: true, architectureState: 'Target' },
      { version: 3, reverse: true },
    ]);
    expect(server.conflicts).toEqual([]);
    expect(server.edges.get('e7')).toMatchObject({ source: 'server', target: 'shop' });
    expect(
      within(details()).getByRole('heading', { name: 'Back Office Server relates to Web Shop' }),
    ).toBeDefined();
    expect(reverse().getAttribute('aria-pressed')).toBe('false');
  });

  it('sends nothing more once the server says the model can no longer be edited', async () => {
    const { form, fetchMock } = await openRelationship({
      answer: (method) =>
        method === 'PATCH' ? apiError(403, 'You can no longer edit this model.') : undefined,
    });
    const patchCount = () =>
      fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH').length;
    fireEvent.click(within(form).getByRole('radio', { name: /Target/ }));
    await waitFor(() => {
      expect(shownStatus()).toBe("Couldn't save: you can no longer edit this model");
    });
    expect(within(form).getByRole('alert').textContent).toContain(
      'You can no longer edit this model.',
    );
    expect(patchCount()).toBe(1);
    fireEvent.click(within(form).getByRole('radio', { name: /Deprecate/ }));
    const label = within(form).getByRole('combobox', { name: 'Label' });
    fireEvent.change(label, { target: { value: 'Stock levels' } });
    fireEvent.keyDown(label, { key: 'Enter', ctrlKey: true });
    await settle();
    expect(patchCount()).toBe(1);
    expect(shownStatus()).toBe("Couldn't save: you can no longer edit this model");
  });

  it('opens no Discard dialog on Esc, and leaving with a change waiting saves it without asking', async () => {
    const { form, server } = await openRelationship();
    const label = within(form).getByRole('combobox', { name: 'Label' });
    fireEvent.change(label, { target: { value: 'Stock levels' } });
    fireEvent.keyDown(label, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(within(details()).getByRole('button', { name: 'Back to Web Shop' }));
    await screen.findByRole('form', { name: /^Edit / });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(server.patches.map((patch) => patch.body)).toEqual([
      { version: 1, label: 'Stock levels' },
    ]);
  });
});

describe('what a save leaves out', () => {
  const till = (): ModelElement => ({
    id: 'till',
    name: 'Till',
    type: 'Application',
    metadata: { type: 'Application', architectureState: 'Deprecate' },
  });

  it('puts a field that fails the checks back as stored, so the other changes can go', () => {
    const initial = draftOf(till());
    const draft = { ...initial, name: ' ', description: 'At the counter' };
    const errors = clientErrors(draft);
    expect([...errors.keys()]).toEqual(['name']);
    const send = withoutInvalid(initial, draft, errors);
    expect(send && changesOf(initial, send)).toEqual({ description: 'At the counter' });
  });

  it('holds everything while the type changes and a field fails the checks', () => {
    const initial = draftOf(till());
    const draft = { ...withType(initial, 'Other'), name: '' };
    expect(withoutInvalid(initial, draft, clientErrors(draft))).toBeUndefined();
  });
});

describe('the save status in the panel head', () => {
  const css = readFileSync(join(import.meta.dirname, '../src/styles/explorer.css'), 'utf8');
  const rule = (selector: string) =>
    new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(
      css,
    )?.[2] ?? '';

  it('stays on one line and shrinks with an ellipsis, so the head never overflows', () => {
    expect(rule('.save-status')).toMatch(/white-space: nowrap;/);
    expect(rule('.save-status')).toMatch(/min-width: 0;/);
    expect(rule('.save-status-text')).toMatch(/text-overflow: ellipsis;/);
    expect(rule('.save-status-text')).toMatch(/overflow: hidden;/);
  });
});
