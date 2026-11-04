import type { ModelSummary } from '@simplearchitecture/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bakerySummary } from './fixtures';
import {
  admin,
  apiError,
  currentLocation,
  expectNoSeriousAxeViolations,
  modeller,
  renderAt,
  requests,
  stubApi,
  type Handler,
} from './helpers';

// + New model on Admin → Models. Made-up data only.

const created: ModelSummary = {
  id: '44444444-4444-4444-8444-444444444444',
  name: 'Made-up harbour',
  createdAt: '2026-10-30T09:00:00.000Z',
  createdBy: { id: 'u1', name: 'Alex Morgan' },
  nodeCount: 0,
  edgeCount: 0,
};

function api(
  answer: (body: unknown) => Response | Promise<Response> = () =>
    Response.json({ model: created }, { status: 201 }),
  editable = true,
): Handler {
  return ({ url, method, body }) => {
    if (url === '/api/models' && method === 'GET') {
      return Response.json({ models: [bakerySummary], editable });
    }
    if (url === '/api/admin/models/damaged') return Response.json({ models: [] });
    if (url === '/api/models/new' && method === 'POST') {
      return answer(JSON.parse(body as string) as unknown);
    }
    return undefined;
  };
}

const newModelButton = () => screen.getByRole('button', { name: 'New model' });
const dialog = () => screen.getByRole('dialog', { name: 'New model' });
const nameField = () => within(dialog()).getByRole('textbox', { name: /^Name/ });

async function openDialog(handler: Handler = api()) {
  const fetchMock = stubApi(admin, handler);
  renderAt('/admin/models');
  await screen.findByRole('link', { name: 'Bakery landscape' });
  fireEvent.click(newModelButton());
  return fetchMock;
}

function submit() {
  fireEvent.submit(dialog().querySelector('form') as HTMLFormElement);
}

describe('New model', () => {
  it('sits next to Import, opens with focus in Name and closes with Esc back to the button', async () => {
    await openDialog();

    const actions = newModelButton().parentElement;
    expect(actions?.className).toBe('page-actions');
    expect(
      within(actions as HTMLElement).getByRole('button', { name: /Import file/ }),
    ).toBeTruthy();
    expect(newModelButton().getAttribute('aria-haspopup')).toBe('dialog');
    expect(document.activeElement).toBe(nameField());
    expect(nameField().hasAttribute('maxlength')).toBe(false);
    expect(nameField().getAttribute('autocomplete')).toBe('off');
    expect(dialog().getAttribute('aria-describedby')).toBe('new-model-text');
    expect(screen.getByText('Creates an empty model. Add its elements in Modelling.')).toBeTruthy();
    expect(within(dialog()).getByText('Up to 200 characters.')).toBeTruthy();
    await expectNoSeriousAxeViolations(dialog());

    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'New model' })).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(newModelButton());
    });

    fireEvent.click(newModelButton());
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'New model' })).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(newModelButton());
    });
  });

  it('checks the name before sending: empty and too long, with the real count', async () => {
    const fetchMock = await openDialog();

    submit();
    expect(within(dialog()).getByText('Enter a name.')).toBeTruthy();
    expect(nameField().getAttribute('aria-invalid')).toBe('true');
    expect(nameField().getAttribute('aria-describedby')).toBe('new-model-error new-model-hint');
    expect(document.activeElement).toBe(nameField());

    fireEvent.change(nameField(), { target: { value: '   ' } });
    expect(within(dialog()).queryByText('Enter a name.')).toBeNull();
    expect(nameField().hasAttribute('aria-invalid')).toBe(false);
    submit();
    expect(within(dialog()).getByText('Enter a name.')).toBeTruthy();

    // Counted after trimming, as the server does; never cut short.
    fireEvent.change(nameField(), { target: { value: ` ${'n'.repeat(243)} ` } });
    submit();
    expect(
      within(dialog()).getByText('The name has 243 characters. Use 200 or fewer.'),
    ).toBeTruthy();
    expect((nameField() as HTMLInputElement).value).toHaveLength(245);
    expect(requests(fetchMock)).not.toContain('POST /api/models/new');
  });

  it('shows the server’s name message, and keeps the dialog and name on other errors', async () => {
    let answer: () => Response = () =>
      apiError(422, 'The change is not valid. Nothing was saved.', {
        fields: [{ field: 'name', message: 'Must be at most 200 characters.' }],
      });
    await openDialog(api(() => answer()));

    fireEvent.change(nameField(), { target: { value: 'Made-up harbour' } });
    submit();
    expect(await within(dialog()).findByText('Must be at most 200 characters.')).toBeTruthy();
    expect(document.activeElement).toBe(nameField());

    answer = () => apiError(500, 'Internal Server Error');
    submit();
    expect((await within(dialog()).findByRole('alert')).textContent).toBe(
      "The model wasn't created. Check your connection and try again.",
    );
    expect((nameField() as HTMLInputElement).value).toBe('Made-up harbour');

    answer = () => apiError(409, 'The store already holds 500 models.');
    submit();
    await waitFor(() => {
      expect(within(dialog()).getByRole('alert').textContent).toBe(
        "The model wasn't created. The store already holds 500 models.",
      );
    });
  });

  it('creates the model: the dialog closes, the result shows with focus, the row is listed', async () => {
    let finish: (response: Response) => void = () => undefined;
    const sent: unknown[] = [];
    await openDialog(
      api((body) => {
        sent.push(body);
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }),
    );

    fireEvent.change(nameField(), { target: { value: '  Made-up harbour ' } });
    fireEvent.keyDown(nameField(), { key: 'Enter' });
    submit();
    // Busy: the button says so and stays focusable; Esc does nothing.
    const createButton = within(dialog()).getByRole('button', { name: 'Creating…' });
    expect(createButton.getAttribute('aria-disabled')).toBe('true');
    expect(createButton.hasAttribute('disabled')).toBe(false);
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(dialog()).toBeTruthy();
    // One request, with the trimmed name.
    submit();
    expect(sent).toEqual([{ name: 'Made-up harbour' }]);

    await act(async () => {
      finish(Response.json({ model: created }, { status: 201 }));
      await Promise.resolve();
    });

    const heading = await screen.findByRole('heading', { name: 'Created “Made-up harbour”' });
    expect(screen.queryByRole('dialog', { name: 'New model' })).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    const panel = heading.closest('section') as HTMLElement;
    expect(panel.textContent).toContain(
      'An empty model. Open it in Modelling to add its first element.',
    );
    const openLink = within(panel).getByRole('link', { name: 'Open in Modelling' });
    expect(openLink.getAttribute('href')).toBe(`/modelling/models/${created.id}`);
    const row = screen.getByRole('link', { name: 'Made-up harbour' }).closest('tr');
    expect(row?.className).toContain('is-new');

    fireEvent.click(within(panel).getByRole('button', { name: 'Dismiss the result' }));
    expect(screen.queryByRole('heading', { name: /^Created/ })).toBeNull();
    expect(document.activeElement).toBe(newModelButton());
  });

  it('says the new model opens read-only when editing is off', async () => {
    await openDialog(api(undefined, false));
    fireEvent.change(nameField(), { target: { value: 'Made-up harbour' } });
    submit();
    const heading = await screen.findByRole('heading', { name: 'Created “Made-up harbour”' });
    expect(heading.closest('section')?.textContent).toContain(
      'An empty model. Editing is off on this server, so it opens read-only.',
    );
    fireEvent.click(
      within(heading.closest('section') as HTMLElement).getByRole('link', {
        name: 'Open in Modelling',
      }),
    );
    await waitFor(() => {
      expect(currentLocation()).toBe(`/modelling/models/${created.id}`);
    });
  });

  // No import behind the dialog.
  it('ignores a file dropped on the page while the dialog is open', async () => {
    const fetchMock = await openDialog();
    const file = new File(['<model/>'], 'landscape.xml', { type: 'application/xml' });

    fireEvent.dragOver(window, { dataTransfer: { types: ['Files'], files: [] } });
    fireEvent.drop(screen.getByRole('heading', { level: 1, name: 'Models' }), {
      dataTransfer: { types: ['Files'], files: [file] },
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(requests(fetchMock).filter((r) => r.includes('/import'))).toEqual([]);
    expect(screen.queryByRole('heading', { name: /^Import/ })).toBeNull();
    expect(dialog()).toBeTruthy();
    expect(document.activeElement).toBe(nameField());
  });

  it('is not offered outside Admin → Models', async () => {
    stubApi(modeller, api());
    renderAt('/modelling');
    await screen.findByRole('link', { name: 'Bakery landscape' });
    expect(screen.queryByRole('button', { name: 'New model' })).toBeNull();
  });
});
