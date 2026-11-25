import type { LogLine, LogsResponse } from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  admin,
  apiError,
  expectNoSeriousAxeViolations,
  modeller,
  renderAt,
  requests,
  stubApi,
  viewer,
  type Handler,
} from './helpers';

/** Admin → Logs: the app's log lines for whole UTC days. All lines are made up. */

const today = '2026-11-25';

function line(overrides: Partial<LogLine> = {}): LogLine {
  return {
    time: '2026-11-25T09:30:05.042Z',
    level: 30,
    levelLabel: 'info',
    msg: 'request completed',
    fields: {},
    ...overrides,
  };
}

function answer(lines: LogLine[], extra: Partial<LogsResponse> = {}): LogsResponse {
  return { from: today, to: today, minLevel: 30, truncated: false, lines, ...extra };
}

/** Answers GET /api/admin/logs with `reply(params)`; other requests fall through. */
function logsApi(reply: (params: URLSearchParams) => Response | Promise<Response>): Handler {
  return ({ url, method }) => {
    const parsed = new URL(url, 'http://localhost');
    if (parsed.pathname === '/api/admin/logs' && method === 'GET') {
      return reply(parsed.searchParams);
    }
    return undefined;
  };
}

const logRequests = (fetchMock: ReturnType<typeof stubApi>) =>
  requests(fetchMock).filter((each) => each.includes('/api/admin/logs'));

const from = () => screen.getByLabelText<HTMLInputElement>('From (UTC)');
const to = () => screen.getByLabelText<HTMLInputElement>('To (UTC)');
const level = () => screen.getByLabelText<HTMLSelectElement>('Minimum level');
const show = () =>
  within(screen.getByRole('search', { name: 'Filter logs' })).getByRole<HTMLButtonElement>(
    'button',
  );
const table = () => screen.getByRole('table');

async function openPage(fetchMock: ReturnType<typeof stubApi>) {
  renderAt('/admin/logs');
  await screen.findByRole('heading', { name: 'Logs', level: 1 });
  await waitFor(() => {
    expect(logRequests(fetchMock).length).toBeGreaterThan(0);
  });
  await waitFor(() => {
    expect(show().textContent).toBe('Show');
  });
}

beforeEach(() => {
  // Only the clock: timers stay real, so the waits work.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-25T23:30:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Admin → Logs', () => {
  it("opens on today's lines (UTC) at Info and above, newest first", async () => {
    const fetchMock = stubApi(
      admin,
      logsApi(() =>
        Response.json(
          answer([
            line({
              time: '2026-11-25T10:00:00.007Z',
              level: 50,
              levelLabel: 'error',
              msg: 'failed',
            }),
            line(),
          ]),
        ),
      ),
    );
    await openPage(fetchMock);

    expect(document.title).toBe('Logs – Admin – SimpleArchitecture');
    expect(
      screen.getByText('Application log lines, kept for 30 days. Dates and times are UTC.'),
    ).toBeTruthy();
    expect(logRequests(fetchMock)).toEqual([
      `GET /api/admin/logs?from=${today}&to=${today}&level=30`,
    ]);
    expect(from().value).toBe(today);
    expect(to().value).toBe(today);
    expect(level().value).toBe('30');
    expect([...level().options].map((option) => option.textContent)).toEqual([
      'Trace and above',
      'Debug and above',
      'Info and above',
      'Warnings and errors',
      'Errors only',
    ]);

    await screen.findByRole('table');
    expect(table().querySelector('caption')?.textContent).toBe(
      `Log lines from ${today} to ${today}, Info and above`,
    );
    expect(
      within(table())
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Time (UTC)', 'Level', 'Message']);
    const rows = within(table()).getAllByRole<HTMLTableRowElement>('row').slice(1);
    expect(rows.map((row) => [...row.cells].map((cell) => cell.textContent))).toEqual([
      ['2026-11-25 10:00:00.007', 'Error', 'failed'],
      ['2026-11-25 09:30:05.042', 'Info', 'request completed'],
    ]);
    expect(rows[0]?.querySelector('.badge')?.classList.contains('level-error')).toBe(true);
    expect(screen.getByText('2 lines, newest first.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Logs' }).getAttribute('aria-current')).toBe('page');
    await expectNoSeriousAxeViolations();
  });

  it('shows the other fields of a line behind its message, and "(no message)" without one', async () => {
    const fetchMock = stubApi(
      admin,
      logsApi(() =>
        Response.json(
          answer([
            line({ msg: 'signed in', fields: { userId: 'made-up-user', roles: ['Admin'] } }),
            line({ msg: null, fields: { reqId: 'req-7' } }),
            line({ msg: null }),
          ]),
        ),
      ),
    );
    await openPage(fetchMock);
    await screen.findByRole('table');

    const [withFields, noMessage, bare] = within(table())
      .getAllByRole<HTMLTableRowElement>('row')
      .slice(1);
    const details = withFields?.querySelector('details');
    expect(details?.querySelector('summary')?.textContent).toBe('signed in');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('pre')?.textContent).toBe(
      JSON.stringify({ userId: 'made-up-user', roles: ['Admin'] }, null, 2),
    );
    fireEvent.click(details?.querySelector('summary') as HTMLElement);
    expect(details?.open).toBe(true);

    expect(noMessage?.querySelector('summary .muted')?.textContent).toBe('(no message)');
    expect(bare?.querySelector('details')).toBeNull();
    expect(bare?.cells[2]?.textContent).toBe('(no message)');
  });

  it('shows markup in a line as text', async () => {
    const markup = '<img src="x" onerror="alert(1)"><b>bold</b>';
    const fetchMock = stubApi(
      admin,
      logsApi(() => Response.json(answer([line({ msg: markup, fields: { note: markup } })]))),
    );
    await openPage(fetchMock);
    await screen.findByRole('table');
    expect(table().querySelector('img')).toBeNull();
    expect(table().querySelector('b')).toBeNull();
    expect(table().querySelector('summary')?.textContent).toBe(markup);
    expect(table().querySelector('pre')?.textContent).toContain('<b>bold</b>');
  });

  it('checks the range before asking, and keeps the last results', async () => {
    const fetchMock = stubApi(
      admin,
      logsApi(() => Response.json(answer([line()]))),
    );
    await openPage(fetchMock);
    await screen.findByRole('table');

    fireEvent.change(from(), { target: { value: '' } });
    fireEvent.change(to(), { target: { value: '' } });
    fireEvent.click(show());
    expect(screen.getByText('Enter a start date.').id).toBe('logs-from-error');
    expect(screen.getByText('Enter an end date.').id).toBe('logs-to-error');
    expect(from().getAttribute('aria-invalid')).toBe('true');
    expect(from().getAttribute('aria-describedby')).toBe('logs-from-error');
    expect(to().getAttribute('aria-describedby')).toBe('logs-to-error');
    expect(document.activeElement).toBe(from());

    fireEvent.change(from(), { target: { value: '2026-11-26' } });
    fireEvent.change(to(), { target: { value: '2026-11-25' } });
    fireEvent.submit(screen.getByRole('search', { name: 'Filter logs' }));
    expect(screen.getByText('The start date must be on or before the end date.').id).toBe(
      'logs-from-error',
    );
    expect(to().hasAttribute('aria-invalid')).toBe(false);
    expect(document.activeElement).toBe(from());

    // 2026-10-25 to 2026-11-25 is 32 days, both ends counted.
    fireEvent.change(from(), { target: { value: '2026-10-25' } });
    fireEvent.click(show());
    expect(screen.getByText('The range can be at most 31 days.').id).toBe('logs-to-error');
    expect(from().hasAttribute('aria-invalid')).toBe(false);
    expect(to().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(to());

    expect(logRequests(fetchMock)).toHaveLength(1);
    expect(screen.getByRole('table')).toBeTruthy();
    await expectNoSeriousAxeViolations();
  });

  it('asks for the range and level shown, says it is busy, and keeps focus on Show', async () => {
    let release: (() => void) | undefined;
    const fetchMock = stubApi(
      admin,
      logsApi(async (params) => {
        if (params.get('from') === today) return Response.json(answer([line()]));
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return Response.json(
          answer([line({ time: '2026-10-26T00:00:00.000Z', level: 40, levelLabel: 'warn' })], {
            from: '2026-10-26',
            to: '2026-11-25',
            minLevel: 40,
          }),
        );
      }),
    );
    await openPage(fetchMock);

    // 31 days, both ends counted: allowed.
    fireEvent.change(from(), { target: { value: '2026-10-26' } });
    fireEvent.change(level(), { target: { value: '40' } });
    show().focus();
    fireEvent.click(show());
    await waitFor(() => {
      expect(show().textContent).toBe('Showing…');
    });
    expect(show().disabled).toBe(true);
    expect(screen.getByText('Loading…').getAttribute('role')).toBe('status');
    release?.();

    await waitFor(() => {
      expect(show().textContent).toBe('Show');
    });
    expect(logRequests(fetchMock).at(-1)).toBe(
      'GET /api/admin/logs?from=2026-10-26&to=2026-11-25&level=40',
    );
    expect(table().querySelector('caption')?.textContent).toBe(
      'Log lines from 2026-10-26 to 2026-11-25, Warnings and errors',
    );
    expect(document.activeElement).toBe(show());
  });

  it('says when no lines match', async () => {
    const fetchMock = stubApi(
      admin,
      logsApi(() => Response.json(answer([]))),
    );
    await openPage(fetchMock);
    await screen.findByText('No log lines match.');
    expect(screen.getByText('Try a wider date range or a lower level.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('0 lines, newest first.')).toBeTruthy();
  });

  it("says when the logs couldn't be loaded, with the server's message, and tries again", async () => {
    let fail = true;
    const fetchMock = stubApi(
      admin,
      logsApi(() =>
        fail
          ? apiError(429, 'Too many log requests. Wait a minute and try again.')
          : Response.json(answer([line()])),
      ),
    );
    await openPage(fetchMock);
    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('load-error')).toBe(true);
    expect(alert.textContent).toContain("Couldn't load the logs.");
    expect(alert.textContent).toContain('Too many log requests. Wait a minute and try again.');

    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('table');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(logRequests(fetchMock)).toHaveLength(2);
  });

  it('is not open to a Modeller or a Viewer, and asks for no lines', async () => {
    for (const who of [modeller, viewer]) {
      document.body.innerHTML = '';
      const fetchMock = stubApi(who);
      renderAt('/admin/logs');
      await screen.findByRole('heading', { level: 1, name: /You don't have access to/ });
      expect(screen.queryByRole('heading', { level: 1, name: 'Logs' })).toBeNull();
      expect(logRequests(fetchMock)).toEqual([]);
    }
  });

  it('reads the same range again on Enter, to refresh', async () => {
    const fetchMock = stubApi(
      admin,
      logsApi(() => Response.json(answer([line()]))),
    );
    await openPage(fetchMock);
    await screen.findByRole('table');
    fireEvent.submit(screen.getByRole('search', { name: 'Filter logs' }));
    await waitFor(() => {
      expect(logRequests(fetchMock)).toHaveLength(2);
    });
    expect(logRequests(fetchMock)).toEqual([
      `GET /api/admin/logs?from=${today}&to=${today}&level=30`,
      `GET /api/admin/logs?from=${today}&to=${today}&level=30`,
    ]);
    await screen.findByRole('table');
  });

  it('says when more lines match than are shown', async () => {
    const lines = Array.from({ length: 1000 }, (_, index) =>
      line({ msg: `made-up line ${String(index)}` }),
    );
    const fetchMock = stubApi(
      admin,
      logsApi(() => Response.json(answer(lines, { truncated: true }))),
    );
    await openPage(fetchMock);
    await screen.findByRole('table');
    const warning = screen.getByText(/^Showing the newest/);
    expect(warning.textContent).toBe(
      'Showing the newest 1,000 lines. More lines match: shorten the date range or raise the level.',
    );
    expect(warning.classList.contains('alert')).toBe(true);
    expect(screen.getByText('1,000 lines, newest first. More lines match.')).toBeTruthy();
  });
});
