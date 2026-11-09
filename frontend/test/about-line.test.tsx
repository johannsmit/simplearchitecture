import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  admin,
  apiError,
  expectNoSeriousAxeViolations,
  noRole,
  renderAt,
  requests,
  stubApi,
  type Handler,
} from './helpers';

const models: Handler = ({ url }) =>
  url === '/api/models' ? Response.json({ models: [] }) : undefined;

const aboutAs =
  (answer: () => Response): Handler =>
  ({ url, method }) =>
    method === 'GET' && url === '/api/about' ? answer() : undefined;

const madeUpAbout = aboutAs(() => Response.json({ version: '0.10.0', commit: 'a1b2c3d' }));

async function openAccountMenu() {
  fireEvent.click(await screen.findByRole('button', { name: /account menu$/ }));
  return document.getElementById('user-popover') as HTMLElement;
}

describe('the code version in the account menu', () => {
  it('shows the version and commit as the last line, once the menu opens', async () => {
    const fetchMock = stubApi(admin, models, madeUpAbout);
    renderAt('/admin/models');
    await screen.findByRole('button', { name: /account menu$/ });
    expect(requests(fetchMock)).not.toContain('GET /api/about');

    const menu = await openAccountMenu();
    const line = await screen.findByText(/^SimpleArchitecture 0\.10\.0/);
    // Seen as "SimpleArchitecture 0.10.0 · a1b2c3d"; a screen reader hears ", commit" for the dot.
    expect(line.textContent).toBe('SimpleArchitecture 0.10.0 ·, commit a1b2c3d');
    expect(line.querySelector('[aria-hidden="true"]')?.textContent).toBe('·');
    expect(line.querySelector('.vh')?.textContent).toBe(', commit');
    expect(menu.lastElementChild).toBe(line);
    // No Copy button, and nothing to click.
    expect(line.querySelector('button, a')).toBeNull();
    await expectNoSeriousAxeViolations(menu);
  });

  it('asks again each time the menu opens, so a new deployment shows', async () => {
    let commit = 'a1b2c3d';
    stubApi(
      admin,
      models,
      aboutAs(() => Response.json({ version: '0.10.0', commit })),
    );
    renderAt('/admin/models');
    await openAccountMenu();
    await screen.findByText(/a1b2c3d/);

    fireEvent.keyDown(document, { key: 'Escape' });
    commit = 'e4f5a6b';
    await openAccountMenu();
    await screen.findByText(/e4f5a6b/);
  });

  it('asks nothing before sign-in', async () => {
    const fetchMock = stubApi(() => apiError(401, 'Unauthorized'), madeUpAbout);
    renderAt('/viewing');
    await screen.findByRole('link', { name: 'Sign in' });
    expect(requests(fetchMock)).toEqual(['GET /api/me']);
    expect(document.querySelector('.about-line')).toBeNull();
  });

  it('shows nothing for someone without a role, whom the API refuses', async () => {
    const fetchMock = stubApi(
      noRole,
      aboutAs(() => apiError(403, 'Forbidden')),
    );
    renderAt('/');
    await openAccountMenu();
    await waitFor(() => {
      expect(requests(fetchMock)).toContain('GET /api/about');
    });
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    expect(document.querySelector('.about-line')).toBeNull();
  });

  it('shows nothing when the answer is not a version and a short commit', async () => {
    for (const body of [
      { version: '0.10.0', commit: '<b>a1b2c3d</b>' },
      { version: '0.10.0', commit: 'a1b2c3d4e5f6' },
      { version: '0.10.0 <i>beta</i>', commit: 'a1b2c3d' },
      { version: '0.10.0' },
    ]) {
      const fetchMock = stubApi(
        admin,
        models,
        aboutAs(() => Response.json(body)),
      );
      const { unmount } = renderAt('/admin/models');
      await openAccountMenu();
      await waitFor(() => {
        expect(requests(fetchMock)).toContain('GET /api/about');
      });
      expect(document.querySelector('.about-line'), JSON.stringify(body)).toBeNull();
      unmount();
    }
  });

  it('shows "unknown" for a build that did not record its commit', async () => {
    stubApi(
      admin,
      models,
      aboutAs(() => Response.json({ version: '0.10.0', commit: 'unknown' })),
    );
    renderAt('/admin/models');
    await openAccountMenu();
    expect((await screen.findByText(/^SimpleArchitecture 0/)).textContent).toContain(
      'commit unknown',
    );
  });
});
