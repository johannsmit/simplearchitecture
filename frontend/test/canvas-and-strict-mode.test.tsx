import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { bakeryId, bakeryModel, bakerySummary } from './fixtures';
import { admin, renderAt, stubApi, viewer } from './helpers';

/**
 * Regressions: the model list under StrictMode and moving a card. Made-up data only.
 */

function modelsApi() {
  return ({ url, method }: { url: string; method: string }) =>
    url === '/api/models' && method === 'GET'
      ? Response.json({ models: [bakerySummary] })
      : undefined;
}

describe('regressions', () => {
  // main.tsx renders the app in <StrictMode>, which in development mounts every effect twice.
  // ModelsProvider aborts the list request on the simulated unmount, and its `loaded` guard stops
  // the second mount from asking again, so a direct load or reload of /viewing or /admin/models
  // under `npm run dev` shows skeleton rows forever ("the models aren't loading").
  it.each([
    ['/viewing', viewer],
    ['/admin/models', admin],
  ])('%s loads the model list under StrictMode (as in npm run dev)', async (path, me) => {
    stubApi(me, modelsApi());
    render(
      <StrictMode>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </StrictMode>,
    );
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Bakery landscape' })).toBeTruthy();
    });
  });

  // The lift shadow (dragging and keyboard move mode) must show. `.card:hover` and
  // `.react-flow__node.is-lit .card` (the dragged card is always hovered and lit) and
  // `.card.is-focus` have the same specificity and come later in explorer.css, so they win.
  it('the lift shadow rule comes after the hover, lit and focused card shadows', () => {
    const css = readFileSync(join(import.meta.dirname, '../src/styles/explorer.css'), 'utf8');
    const lift = css.lastIndexOf('box-shadow: 0 6px 16px');
    for (const rule of ['.react-flow__node.is-lit .card', '.card:hover', '.card.is-focus {']) {
      expect(css.indexOf(rule), rule).toBeGreaterThan(-1);
      expect(css.indexOf(rule), rule).toBeLessThan(lift);
    }
  });

  // Tab drops the card in keyboard move mode. Tab from the card goes to its own count
  // button, which counts as "still on the card", so move mode goes on (and the arrows still move
  // the card from the count button).
  it('Tab to the card’s count button ends move mode', async () => {
    stubApi(viewer, ({ url, method }) =>
      method !== 'GET'
        ? undefined
        : url === '/api/models'
          ? Response.json({ models: [bakerySummary] })
          : url === `/api/models/${bakeryId}`
            ? Response.json(bakeryModel)
            : undefined,
    );
    // From the customer, the shop's card has related elements not on the canvas (a count button).
    renderAt(`/viewing/models/${bakeryId}/elements/customer?depth=1`);
    let main: HTMLElement | null = null;
    await waitFor(() => {
      main = document.querySelector<HTMLElement>('.card[data-element-id="shop"] .card-main');
      expect(main).not.toBeNull();
    });
    const button = main as unknown as HTMLElement;
    act(() => {
      button.focus();
    });
    fireEvent.keyDown(button, { key: 'm' });
    expect(document.querySelector('.card.is-moving')).not.toBeNull();
    const count = button.closest('.card')?.querySelector<HTMLElement>('.cpill');
    expect(count).toBeTruthy();
    act(() => {
      count?.focus(); // where Tab goes next
    });
    expect(document.querySelector('.card.is-moving')).toBeNull();
  });
});
