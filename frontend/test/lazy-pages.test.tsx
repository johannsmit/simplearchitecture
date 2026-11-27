import { act, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { admin, renderAt, stubApi } from './helpers';

// The Viewing help page loads only when the test lets it; the Admin help page fails to load, as a
// chunk does when the network is gone or a new version replaced it.
const viewingHelp = vi.hoisted(() => {
  let release = () => {};
  const loaded = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    loaded,
    release: () => {
      release();
    },
  };
});

vi.mock('../src/help/ViewingHelp', async (importOriginal) => {
  await viewingHelp.loaded;
  return importOriginal();
});

vi.mock('../src/help/AdminHelp', () => {
  throw new Error('Made-up chunk load failure');
});

describe('pages that load on first use', () => {
  it('shows Loading… as a status until the page has loaded, then the page', async () => {
    stubApi(admin);
    renderAt('/help/viewing');

    const loading = await screen.findByRole('status');
    expect(loading.textContent).toBe('Loading…');
    // The header is there while the page loads.
    expect(screen.getByRole('navigation', { name: 'Spaces' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();

    await act(async () => {
      viewingHelp.release();
      await viewingHelp.loaded;
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Viewing help' })).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it.each([
    ['/admin/properties', 'Properties'],
    ['/help', 'Help'],
  ])('opens %s from a deep link', async (path, title) => {
    stubApi(admin);
    renderAt(path);
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeTruthy();
  });

  it('shows the error with a way out when a page fails to load', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubApi(admin);
    renderAt('/help/admin');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("This page couldn't be shown.");
    expect(screen.getByRole('link', { name: 'Go to the start page' })).toBeTruthy();
    // The header stays usable.
    expect(screen.getByRole('navigation', { name: 'Spaces' })).toBeTruthy();
    consoleError.mockRestore();
  });
});
