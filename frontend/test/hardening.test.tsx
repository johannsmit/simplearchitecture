import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../src/ErrorBoundary';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { admin, renderAt, stubApi, viewer } from './helpers';

/** Hardening: error boundary, explorer landmarks, third-party licence notices. */

function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new SyntaxError('Invalid selector');
  return <p>Drawn</p>;
}

function Harness() {
  const [explode, setExplode] = useState(true);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setExplode(false);
        }}
      >
        Fix it
      </button>
      <ErrorBoundary
        resetKey="same"
        title="This model couldn't be shown."
        backTo="/viewing"
        backLabel="Back to models"
      >
        <Bomb explode={explode} />
      </ErrorBoundary>
    </>
  );
}

describe('error boundary', () => {
  it('shows a message, a way back and Try again instead of an empty page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <MemoryRouter>
        <Harness />
      </MemoryRouter>,
    );

    const alert = screen.getByRole('alert');
    expect(
      within(alert).getByRole('heading', { name: "This model couldn't be shown." }),
    ).toBeTruthy();
    expect(within(alert).getByRole('link', { name: 'Back to models' }).getAttribute('href')).toBe(
      '/viewing',
    );
    // No internals on the page.
    expect(alert.textContent).not.toContain('Invalid selector');

    fireEvent.click(screen.getByRole('button', { name: 'Fix it' }));
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Drawn')).toBeTruthy();
    vi.restoreAllMocks();
  });
});

describe('explorer landmarks', () => {
  it('has an h1 and keeps the resize handles inside the main landmark', async () => {
    stubApi(viewer, ({ url }) =>
      url === '/api/models'
        ? Response.json({ models: [bakerySummary] })
        : url === `/api/models/${bakeryId}`
          ? Response.json(bakeryModel)
          : undefined,
    );
    renderAt(`/viewing/models/${bakeryId}/elements/shop`);

    await screen.findByRole('heading', { level: 2, name: 'Web Shop' });
    expect(screen.getByRole('heading', { level: 1, name: 'Bakery landscape' })).toBeTruthy();
    const main = screen.getByRole('main');
    for (const handle of screen.getAllByRole('separator')) {
      expect(main.contains(handle)).toBe(true);
    }
    expect(screen.getAllByRole('separator')).toHaveLength(2);
  });
});

describe('licence notices', () => {
  it('links to the third-party licences from the user menu', async () => {
    stubApi(admin, ({ url }) =>
      url === '/api/models' ? Response.json({ models: [] }) : undefined,
    );
    renderAt('/admin/models');

    fireEvent.click(await screen.findByRole('button', { name: /account menu$/ }));
    const link = screen.getByRole('link', { name: 'Third-party licences' });
    expect(link.getAttribute('href')).toBe('/third-party-licenses.txt');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
