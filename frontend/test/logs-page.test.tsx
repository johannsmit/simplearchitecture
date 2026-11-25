import type { LogEntry, LogsResponse } from '@simplearchitecture/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { logRangeOffsets } from '../src/admin/log-days';
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

/** Admin → Logs: what the server recorded, for a range of days, newest first. */

const pad = (value: number) => String(value).padStart(2, '0');
const localDay = (date: Date) =>
  `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const today = () => localDay(new Date());
/** The browser's offset at local midnight starting `day`, `after` days on. */
const offsetAt = (day: string, after = 0) => {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  return new Date(year, month - 1, date + after).getTimezoneOffset();
};
const offsets = (from: string, to: string) =>
  `tzOffset=${String(offsetAt(from))}&toTzOffset=${String(offsetAt(to, 1))}`;

/**
 * Runs the test in the time zone `zone` (Node applies a change of TZ at once); put back after it.
 * Central Europe: summer time starts at 02:00 on 2026-03-29 and ends at 03:00 on 2026-10-25.
 */
const startingTimeZone = process.env.TZ;
function useTimeZone(zone: string) {
  process.env.TZ = zone;
}

afterEach(() => {
  if (startingTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = startingTimeZone;
});

const entries: LogEntry[] = [
  {
    id: '3',
    time: '2026-03-10T11:00:05.000Z',
    level: 'error',
    msg: 'request failed',
    extra: { reqId: 'req-9', err: { type: 'Error', message: 'made-up failure' } },
  },
  {
    id: '2',
    time: '2026-03-10T10:30:00.000Z',
    level: 'warn',
    msg: 'cross-origin request refused',
    extra: { origin: 'https://other.example.test' },
  },
  { id: '1', time: '2026-03-10T09:00:00.000Z', level: 'info', msg: 'server listening', extra: {} },
];

const logsUrl = /^\/api\/admin\/logs\?/;

/** Answers GET /api/admin/logs with `answer(params)`. */
function logsApi(answer: (params: URLSearchParams) => Response | Promise<Response>): Handler {
  return ({ url, method }) => {
    if (method === 'GET' && logsUrl.test(url)) return answer(new URL(url, 'http://x').searchParams);
    return undefined;
  };
}

const ok = (body: LogsResponse) => () => Response.json(body);

const logRequests = (fetchMock: ReturnType<typeof stubApi>) =>
  requests(fetchMock).filter((request) => request.startsWith('GET /api/admin/logs'));

const table = () => screen.getByRole('table', { name: 'Log entries' });

async function openPage(
  answer: (params: URLSearchParams) => Response | Promise<Response>,
  me = admin,
) {
  const fetchMock = stubApi(me, logsApi(answer));
  renderAt('/admin/logs');
  await screen.findByRole('heading', { name: 'Logs', level: 1 });
  return fetchMock;
}

describe('Admin → Logs', () => {
  it('is the last Admin page, for Admins only', async () => {
    await openPage(ok({ entries: [], truncated: false }));
    const nav = screen.getByRole('navigation', { name: 'Admin pages' });
    const links = within(nav).getAllByRole('link');
    expect(links.at(-1)?.textContent).toBe('Logs');
    expect(links.at(-1)?.getAttribute('aria-current')).toBe('page');
    expect(document.title).toBe('Logs – Admin – SimpleArchitecture');

    for (const who of [modeller, viewer]) {
      document.body.innerHTML = '';
      const fetchMock = stubApi(who, logsApi(ok({ entries, truncated: false })));
      renderAt('/admin/logs');
      await screen.findByRole('heading', { level: 1, name: "You don't have access to Admin" });
      expect(logRequests(fetchMock)).toEqual([]);
    }
  });

  it('loads today in the browser’s time zone at first, and shows the entries', async () => {
    const fetchMock = await openPage(ok({ entries, truncated: false }));
    await screen.findByRole('table', { name: 'Log entries' });

    expect(screen.getByLabelText<HTMLInputElement>('From').value).toBe(today());
    expect(screen.getByLabelText<HTMLInputElement>('To').value).toBe(today());
    expect(screen.getByLabelText<HTMLSelectElement>('Level').value).toBe('');
    expect(logRequests(fetchMock)).toEqual([
      `GET /api/admin/logs?from=${today()}&to=${today()}&${offsets(today(), today())}`,
    ]);

    const rows = within(table())
      .getAllByRole('row')
      .filter((row) => !row.hidden);
    // The header row and one row per entry; the details rows are hidden.
    expect(rows).toHaveLength(4);
    const first = rows[1] as HTMLElement;
    const time = first.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe('2026-03-10T11:00:05.000Z');
    expect(time?.textContent).toMatch(/^\d{2}:\d{2}:05$/);
    expect(within(first).getByText('error').className).toContain('level-critical');
    expect(within(first).getByText('request failed').getAttribute('title')).toBe('request failed');
    expect(within(rows[2] as HTMLElement).getByText('warn').className).toContain('level-warning');
    expect(within(rows[3] as HTMLElement).getByText('info').className).toContain('level-info');

    await waitFor(() => {
      expect(screen.getByText('3 log entries.')).toBeTruthy();
    });
    expect(table().getAttribute('aria-busy')).toBe('false');
    await expectNoSeriousAxeViolations();
  });

  it('opens and closes an entry’s details', async () => {
    await openPage(ok({ entries, truncated: false }));
    await screen.findByRole('table', { name: 'Log entries' });
    const button = screen.getByRole('button', { name: /^Details of the entry at .*:05$/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const details = document.getElementById(button.getAttribute('aria-controls') ?? '');
    expect(details?.hidden).toBe(true);

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(details?.hidden).toBe(false);
    const fields = within(details as HTMLElement);
    expect(fields.getByText('reqId').nextElementSibling?.textContent).toBe('req-9');
    expect(fields.getByText('err').nextElementSibling?.textContent).toBe(
      JSON.stringify({ type: 'Error', message: 'made-up failure' }, null, 2),
    );

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(details?.hidden).toBe(true);
  });

  it('shows the whole message in Details, for every entry, even one without other fields', async () => {
    const long = `cross-origin request refused ${'from a made-up origin '.repeat(20)}end`;
    await openPage(
      ok({
        entries: [
          { id: '7', time: '2026-03-10T08:00:00.000Z', level: 'warn', msg: long, extra: {} },
          ...entries,
        ],
        truncated: false,
      }),
    );
    await screen.findByRole('table', { name: 'Log entries' });
    const buttons = screen.getAllByRole('button', { name: /^Details of the entry at / });
    expect(buttons).toHaveLength(entries.length + 1);

    const button = buttons[0] as HTMLElement;
    fireEvent.click(button);
    const details = within(
      document.getElementById(button.getAttribute('aria-controls') ?? '') as HTMLElement,
    );
    const terms = details.getAllByRole('term').map((term) => term.textContent);
    expect(terms[0]).toBe('Message');
    expect(details.getByText('Message').nextElementSibling?.textContent).toBe(long);
    expect(details.getByText('No other fields.')).toBeTruthy();
  });

  it('asks again for the dates and level chosen, with dates in times over several days', async () => {
    const fetchMock = await openPage((params) =>
      Response.json({
        entries: params.get('level') === 'warn' ? entries.slice(0, 2) : entries,
        truncated: false,
      }),
    );
    await screen.findByRole('table', { name: 'Log entries' });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-03-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-10' } });
    fireEvent.change(screen.getByLabelText('Level'), { target: { value: 'warn' } });
    // Nothing is asked for until Show logs.
    expect(logRequests(fetchMock)).toHaveLength(1);
    const button = screen.getByRole('button', { name: 'Show logs' });
    button.focus();
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText('2 log entries.')).toBeTruthy();
    });
    expect(logRequests(fetchMock).at(-1)).toBe(
      `GET /api/admin/logs?from=2026-03-01&to=2026-03-10&level=warn&${offsets('2026-03-01', '2026-03-10')}`,
    );
    expect(table().querySelector('time')?.textContent).toMatch(/^2026-03-\d{2} \d{2}:\d{2}:05$/);
    // Focus stays where it was.
    expect(document.activeElement).toBe(button);
  });

  it('asks for each end of the range at its own offset when a clock change falls between', async () => {
    useTimeZone('Europe/Berlin');
    const fetchMock = await openPage(ok({ entries, truncated: false }));
    await screen.findByRole('table', { name: 'Log entries' });

    // Summer time ends during 2026-10-25: the range starts two hours ahead and ends one ahead.
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-20' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-27' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show logs' }));
    await waitFor(() => {
      expect(logRequests(fetchMock)).toHaveLength(2);
    });
    expect(logRequests(fetchMock).at(-1)).toBe(
      'GET /api/admin/logs?from=2026-10-20&to=2026-10-27&tzOffset=-120&toTzOffset=-60',
    );
  });

  it.each([
    ['From empty', { from: '' }, 'From', 'Choose a From date.'],
    ['To before From', { from: '2026-03-10', to: '2026-03-09' }, 'To', "To can't be before From."],
    [
      'more than 31 days',
      { from: '2026-01-01', to: '2026-03-10' },
      'To',
      'Choose 31 days or fewer.',
    ],
  ])('says what is wrong with %s, and asks for nothing', async (_name, values, field, message) => {
    const fetchMock = await openPage(ok({ entries, truncated: false }));
    await screen.findByRole('table', { name: 'Log entries' });
    for (const [name, value] of Object.entries(values)) {
      fireEvent.change(screen.getByLabelText(name === 'from' ? 'From' : 'To'), {
        target: { value },
      });
    }
    fireEvent.submit(screen.getByRole('form', { name: 'Log dates and level' }));

    const input = screen.getByLabelText(field);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const error = document.getElementById(input.getAttribute('aria-describedby') ?? '');
    expect(error?.textContent).toBe(message);
    expect(error?.className).toBe('field-error');
    expect(logRequests(fetchMock)).toHaveLength(1);
  });

  it('says when there are no entries', async () => {
    await openPage(ok({ entries: [], truncated: false }));
    const empty = await screen.findByText('No log entries for these dates.', {
      selector: '.table-card.empty p',
    });
    expect(empty).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says when only the newest 1,000 are shown', async () => {
    await openPage(ok({ entries, truncated: true }));
    await screen.findByRole('table', { name: 'Log entries' });
    expect(
      screen.getByText(
        'Showing the newest 1,000 entries. Narrow the dates or level to see the rest.',
      ),
    ).toBeTruthy();
  });

  it('says when the logs could not be loaded, and tries again', async () => {
    let fail = true;
    const fetchMock = await openPage(() =>
      fail
        ? apiError(503, 'The database is not reachable.')
        : Response.json({ entries, truncated: false }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert.className).toContain('load-error');
    expect(alert.textContent).toContain("The logs couldn't be loaded.");
    expect(alert.textContent).toContain('The database is not reachable.');

    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('table', { name: 'Log entries' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(logRequests(fetchMock)).toHaveLength(2);
  });

  it('shows Loading while it waits', async () => {
    let release: (response: Response) => void = () => undefined;
    stubApi(
      admin,
      logsApi(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    renderAt('/admin/logs');
    expect((await screen.findByText('Loading…')).getAttribute('role')).toBe('status');
    release(Response.json({ entries, truncated: false }));
    await screen.findByRole('table', { name: 'Log entries' });
    expect(screen.queryByText('Loading…')).toBeNull();
  });
});

describe('logRangeOffsets', () => {
  it('gives the offsets at local midnight starting From and after To', () => {
    useTimeZone('Europe/Berlin');
    // Into summer time (it starts during 2026-03-29) and out of it (it ends during 2026-10-25).
    expect(logRangeOffsets('2026-03-20', '2026-03-29')).toEqual({
      tzOffset: -60,
      toTzOffset: -120,
    });
    expect(logRangeOffsets('2026-10-20', '2026-10-25')).toEqual({
      tzOffset: -120,
      toTzOffset: -60,
    });
    // A single day with no change in it, and one with the change.
    expect(logRangeOffsets('2026-07-01', '2026-07-01')).toEqual({
      tzOffset: -120,
      toTzOffset: -120,
    });
    expect(logRangeOffsets('2026-10-25', '2026-10-25')).toEqual({
      tzOffset: -120,
      toTzOffset: -60,
    });
  });

  it('gives the offset as each day starts where the clocks spring forward at midnight', () => {
    // Santiago: 2026-09-06 starts at 01:00, three hours behind UTC; before it, four.
    useTimeZone('America/Santiago');
    expect(logRangeOffsets('2026-09-05', '2026-09-05')).toEqual({
      tzOffset: 240,
      toTzOffset: 240,
    });
    expect(logRangeOffsets('2026-09-06', '2026-09-06')).toEqual({
      tzOffset: 240,
      toTzOffset: 180,
    });
    // Havana: 2026-03-08 starts at 01:00, four hours behind UTC; before it, five.
    useTimeZone('America/Havana');
    expect(logRangeOffsets('2026-03-07', '2026-03-07')).toEqual({
      tzOffset: 300,
      toTzOffset: 300,
    });
    expect(logRangeOffsets('2026-03-08', '2026-03-08')).toEqual({
      tzOffset: 300,
      toTzOffset: 240,
    });
  });
});
