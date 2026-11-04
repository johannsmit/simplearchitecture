import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bakerySummary } from './fixtures';
import {
  admin,
  apiError,
  expectNoSeriousAxeViolations,
  renderAt,
  requests,
  stubApi,
  viewer,
  type Handler,
} from './helpers';

/** Damaged model files are shown to Admins on Admin → Models, by id only. */

const damagedA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const damagedB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function api(damaged: string[]): Handler {
  let left = [...damaged];
  return ({ url, method }) => {
    if (url === '/api/models' && method === 'GET') {
      return Response.json({ models: [bakerySummary] });
    }
    if (url === '/api/admin/models/damaged' && method === 'GET') {
      return Response.json({ models: left.map((id) => ({ id })) });
    }
    const deleted = /^\/api\/models\/(.+)$/.exec(url)?.[1];
    if (method === 'DELETE' && deleted !== undefined) {
      left = left.filter((id) => id !== deleted);
      return new Response(null, { status: 204 });
    }
    return undefined;
  };
}

const section = () => screen.getByRole('region', { name: 'Damaged models' });

describe('damaged models on Admin → Models', () => {
  it('lists them by id with no content or counts, and deletes one after confirming', async () => {
    const fetchMock = stubApi(admin, api([damagedA, damagedB]));
    renderAt('/admin/models');

    await screen.findByRole('heading', { name: 'Damaged models' });
    const rows = within(section()).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      `${damagedA}Damaged; can't be opened`,
      `${damagedB}Damaged; can't be opened`,
    ]);
    // Not in the model table, and nothing links to the explorer.
    expect(within(section()).queryByRole('link')).toBeNull();

    // Cancel returns focus to the button.
    const deleteA = within(section()).getByRole('button', {
      name: `Delete damaged model ${damagedA}`,
    });
    deleteA.focus();
    fireEvent.click(deleteA);
    let dialog = await screen.findByRole('dialog', { name: 'Delete “damaged model”?' });
    expect(dialog.textContent).toContain(damagedA);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(deleteA);

    fireEvent.click(deleteA);
    dialog = await screen.findByRole('dialog', { name: 'Delete “damaged model”?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete model' }));
    await waitFor(() => {
      expect(within(section()).getAllByRole('listitem')).toHaveLength(1);
    });
    expect(requests(fetchMock)).toContain(`DELETE /api/models/${damagedA}`);
    expect(screen.getByText('Deleted the damaged model.').getAttribute('role')).toBe('status');
    // Focus moves to the next damaged entry's button.
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        `Delete damaged model ${damagedB}`,
      );
    });

    // The last one: the section goes, and focus goes to the page title.
    fireEvent.click(document.activeElement as HTMLElement);
    dialog = await screen.findByRole('dialog', { name: 'Delete “damaged model”?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete model' }));
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Damaged models' })).toBeNull();
    });
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Models' }));
    // The working model is untouched.
    expect(screen.getByRole('link', { name: 'Bakery landscape' })).toBeTruthy();
  });

  it('shows nothing when there are none, or when the list fails', async () => {
    stubApi(admin, api([]));
    const { unmount } = renderAt('/admin/models');
    await screen.findByRole('link', { name: 'Bakery landscape' });
    expect(screen.queryByRole('heading', { name: 'Damaged models' })).toBeNull();
    unmount();

    const failing: Handler = ({ url }) =>
      url === '/api/admin/models/damaged' ? apiError(500, 'Made-up failure') : undefined;
    const fetchMock = stubApi(admin, failing, api([damagedA]));
    renderAt('/admin/models');
    await screen.findByRole('link', { name: 'Bakery landscape' });
    await waitFor(() => {
      expect(requests(fetchMock)).toContain('GET /api/admin/models/damaged');
    });
    expect(screen.queryByRole('heading', { name: 'Damaged models' })).toBeNull();
    expect(screen.queryByText(/Made-up failure/)).toBeNull();
  });

  it('is never asked for or shown in Viewing, even for an Admin', async () => {
    for (const me of [viewer, admin]) {
      const fetchMock = stubApi(me, api([damagedA]));
      const { unmount } = renderAt('/viewing');
      await screen.findByRole('link', { name: 'Bakery landscape' });
      expect(screen.queryByRole('heading', { name: 'Damaged models' })).toBeNull();
      expect(requests(fetchMock)).not.toContain('GET /api/admin/models/damaged');
      unmount();
    }
  });

  it('has no serious axe issues with damaged models listed', async () => {
    stubApi(admin, api([damagedA]));
    renderAt('/admin/models');
    await screen.findByRole('heading', { name: 'Damaged models' });
    await expectNoSeriousAxeViolations();
  });
});
