import type { DatabaseStatus } from '@simplearchitecture/shared';
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

/** Admin → Database shows the PostgreSQL connection, read-only. */

const connected: DatabaseStatus = {
  configured: true,
  connected: true,
  host: 'db.example.test',
  port: 5432,
  database: 'made_up_db',
  user: 'made_up_user',
  tls: true,
  tlsVerified: true,
  serverVersion: '17.5',
  migrations: { applied: 1, total: 1 },
};

const notConfigured: DatabaseStatus = {
  configured: false,
  connected: false,
  host: null,
  port: null,
  database: null,
  user: null,
  tls: false,
  tlsVerified: false,
  serverVersion: null,
  migrations: { applied: null, total: 1 },
};

function api(status: DatabaseStatus, test: () => Response): Handler {
  return ({ url, method }) => {
    if (url === '/api/admin/database' && method === 'GET') return Response.json(status);
    if (url === '/api/admin/database/test' && method === 'POST') return test();
    if (url === '/api/models' && method === 'GET')
      return Response.json({ models: [bakerySummary] });
    if (url === '/api/admin/models/damaged') return Response.json({ models: [] });
    return undefined;
  };
}

const card = () => screen.getByRole('region', { name: 'PostgreSQL' });

function fields(): Record<string, string> {
  const pairs = within(card())
    .getAllByRole('term')
    .map((term) => [term.textContent, term.nextElementSibling?.textContent ?? '']);
  return Object.fromEntries(pairs) as Record<string, string>;
}

describe('Admin → Database', () => {
  it('shows the connection details, read-only, and tests the connection', async () => {
    const fetchMock = stubApi(
      admin,
      api(connected, () => Response.json({ ok: true, message: 'Connected to the database.' })),
    );
    renderAt('/admin/database');

    await screen.findByRole('heading', { name: 'Database', level: 1 });
    await screen.findByRole('region', { name: 'PostgreSQL' });
    expect(fields()).toEqual({
      Status: 'Connected',
      Host: 'db.example.test',
      Port: '5432',
      Database: 'made_up_db',
      User: 'made_up_user',
      TLS: 'On, certificate verified',
      'Server version': '17.5',
      Migrations: '1 of 1 applied',
    });
    expect(card().textContent).toContain('DATABASE_URL');
    expect(card().textContent).toContain('secret store');
    // Nothing to edit: the details come from the environment.
    expect(within(card()).queryByRole('textbox')).toBeNull();

    fireEvent.click(within(card()).getByRole('button', { name: 'Test connection' }));
    await waitFor(() => {
      expect(within(card()).getByRole('status').textContent).toBe('Connected to the database.');
    });
    expect(requests(fetchMock)).toContain('POST /api/admin/database/test');
    await expectNoSeriousAxeViolations();
  });

  it('shows a failed test and a rate limit with the server message', async () => {
    let answer = Response.json({
      ok: false,
      message: 'The database refused the sign-in. Check the user and password in DATABASE_URL.',
    });
    stubApi(
      admin,
      api({ ...connected, connected: false, serverVersion: null }, () => answer),
    );
    renderAt('/admin/database');
    await screen.findByRole('region', { name: 'PostgreSQL' });
    expect(fields().Status).toBe('Not connected');
    expect(fields()['Server version']).toBe('—');

    const button = within(card()).getByRole('button', { name: 'Test connection' });
    fireEvent.click(button);
    await waitFor(() => {
      expect(within(card()).getByRole('status').textContent).toContain('refused the sign-in');
    });
    answer = apiError(429, 'Too many connection tests. Wait a minute and try again.');
    fireEvent.click(button);
    await waitFor(() => {
      expect(within(card()).getByRole('status').textContent).toBe(
        'Too many connection tests. Wait a minute and try again.',
      );
    });
  });

  it('says when there is no database: file storage', async () => {
    stubApi(
      admin,
      api(notConfigured, () =>
        Response.json({ ok: false, message: 'Not configured: using file storage.' }),
      ),
    );
    renderAt('/admin/database');
    await screen.findByRole('region', { name: 'PostgreSQL' });
    expect(card().textContent).toContain('Not configured: using file storage.');
    expect(within(card()).queryAllByRole('term')).toHaveLength(0);
    await expectNoSeriousAxeViolations();
  });

  it('is linked from the Admin pages, next to Models', async () => {
    stubApi(
      admin,
      api(connected, () => Response.json({ ok: true, message: 'x' })),
    );
    renderAt('/admin/models');
    const nav = await screen.findByRole('navigation', { name: 'Admin pages' });
    expect(within(nav).getByRole('link', { name: 'Models' }).getAttribute('aria-current')).toBe(
      'page',
    );
    fireEvent.click(within(nav).getByRole('link', { name: 'Database' }));
    await screen.findByRole('heading', { name: 'Database', level: 1 });
    expect(
      within(screen.getByRole('navigation', { name: 'Admin pages' }))
        .getByRole('link', { name: 'Database' })
        .getAttribute('aria-current'),
    ).toBe('page');
  });

  it('is not shown, and not requested, for someone without Admin', async () => {
    const fetchMock = stubApi(
      viewer,
      api(connected, () => Response.json({ ok: true, message: 'x' })),
    );
    renderAt('/admin/database');
    await screen.findByRole('heading', { level: 1, name: "You don't have access to Admin" });
    expect(requests(fetchMock)).not.toContain('GET /api/admin/database');
  });
});
