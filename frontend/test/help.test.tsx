import type { MeResponse, Space } from '@simplearchitecture/shared';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spaceLabels } from '../src/auth';
import {
  admin,
  currentLocation,
  expectNoSeriousAxeViolations,
  modeller,
  noRole,
  renderAt,
  requests,
  stubApi,
  viewer,
} from './helpers';

const everyone = [
  ['Viewer', viewer],
  ['Modeller', modeller],
  ['Admin', admin],
  ['no role', noRole],
] as const;

const pages = [
  ['/help', 'Help'],
  ['/help/viewing', 'Viewing help'],
  ['/help/modelling', 'Modelling help'],
  ['/help/admin', 'Admin help'],
] as const;

async function openUserMenu() {
  fireEvent.click(await screen.findByRole('button', { name: /account menu$/ }));
}

async function showPage(path: string, title: string, me: MeResponse = admin) {
  const fetchMock = stubApi(me);
  renderAt(path);
  await screen.findByRole('heading', { level: 1, name: title });
  return fetchMock;
}

describe('Help in the account menu', () => {
  it.each(everyone)('is the first item under the separator for %s', async (_, me) => {
    stubApi(me);
    renderAt('/agents');
    await openUserMenu();

    const first = document.querySelector('.user-pop .pop-sep')?.nextElementSibling;
    const help = screen.getByRole('link', { name: 'Help' });
    expect(first).toBe(help);
    const icon = help.querySelector('svg');
    expect(icon?.getAttribute('data-icon')).toBe('info');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(help.nextElementSibling?.textContent).toBe('Connected apps');
  });

  it('goes to /help and closes the menu', async () => {
    stubApi(viewer);
    renderAt('/agents');
    await openUserMenu();

    fireEvent.click(screen.getByRole('link', { name: 'Help' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Help' })).toBeTruthy();
    expect(currentLocation()).toBe('/help');
    expect(
      screen.getByRole('button', { name: /account menu$/ }).getAttribute('aria-expanded'),
    ).toBe('false');
  });
});

describe('help pages', () => {
  it.each(
    everyone.flatMap(([role, me]) =>
      pages.map(([path, title]) => [role, path, title, me] as const),
    ),
  )(
    'show for %s at %s, inside the shell, asking the API for nothing more',
    async (_, path, title, me) => {
      const fetchMock = await showPage(path, title, me);

      expect(screen.getByRole('navigation', { name: 'Spaces' })).toBeTruthy();
      expect(screen.getByRole('navigation', { name: 'Help pages' })).toBeTruthy();
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(requests(fetchMock)).toEqual(['GET /api/me']);
    },
  );

  it('shows Not found for another address under /help', async () => {
    stubApi(admin);
    renderAt('/help/unknown');

    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
  });

  it.each(pages)('names the browser tab at %s', async (path, title) => {
    await showPage(path, title);
    expect(document.title).toBe(`${title} – SimpleArchitecture`);
  });

  it('marks only the current help page in the help pages links', async () => {
    await showPage('/help/viewing', 'Viewing help');

    const nav = screen.getByRole('navigation', { name: 'Help pages' });
    const current = within(nav)
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page')
      .map((link) => link.textContent);
    expect(current).toEqual(['Viewing']);
  });

  it('marks Overview on /help', async () => {
    await showPage('/help', 'Help');

    const nav = screen.getByRole('navigation', { name: 'Help pages' });
    expect(within(nav).getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('keeps heading levels in order, with no level skipped', async () => {
    for (const [path, title] of pages) {
      stubApi(admin);
      const view = renderAt(path);
      await screen.findByRole('heading', { level: 1, name: title });
      const levels = [...document.querySelectorAll('main h1, main h2, main h3')].map((h) =>
        Number(h.tagName[1]),
      );
      levels.forEach((level, index) => {
        expect(level - (levels[index - 1] ?? 0)).toBeLessThanOrEqual(1);
      });
      view.unmount();
    }
  });

  it('moves focus to a section from the On this page links', async () => {
    await showPage('/help/modelling', 'Modelling help');

    const toc = screen.getByRole('navigation', { name: 'On this page' });
    fireEvent.click(within(toc).getByRole('link', { name: 'Keyboard shortcuts' }));

    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 2, name: 'Keyboard shortcuts' }),
    );
  });

  it("follows Admin's link to the menu and dialog keys on the Viewing page", async () => {
    await showPage('/help/admin', 'Admin help');

    act(() => {
      fireEvent.click(screen.getByRole('link', { name: 'Viewing help page' }));
    });

    await screen.findByRole('heading', { level: 1, name: 'Viewing help' });
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 3, name: 'Menus and dialogs' }),
    );
  });

  it.each(pages)('has no serious accessibility issues at %s', async (path, title) => {
    await showPage(path, title);
    await expectNoSeriousAxeViolations();
  });
});

describe('access on the help pages', () => {
  it('shows a Viewer which spaces they can use on the index', async () => {
    await showPage('/help', 'Help', viewer);

    const cards = document.querySelector<HTMLElement>('.help-cards');
    if (!cards) throw new Error('no space cards');
    const card = (name: string) =>
      within(cards).getByRole('link', { name: new RegExp(`^${name}`) });
    expect(card('Viewing').textContent).toContain('Read');
    expect(card('Viewing').querySelector('[data-icon="check"]')).toBeTruthy();
    for (const space of ['Modelling', 'Admin']) {
      expect(card(space).textContent).toContain('No access');
      expect(card(space).querySelector('[data-icon="lock"]')).toBeTruthy();
    }
    expect(card('Modelling').getAttribute('href')).toBe('/help/modelling');
  });

  it.each([
    ['modelling', 'Modelling', 'It is for people with the Modeller role or higher.'],
    ['admin', 'Admin', 'It is for people with the Admin role. Ask'],
  ] as const)(
    'tells a Viewer they have no access on the %s page, with no Open link',
    async (space, label, rule) => {
      await showPage(`/help/${space}`, `${label} help`, viewer);

      const notice = document.querySelector('.help-notice');
      expect(notice?.textContent).toContain(`You don't have access to ${label}.`);
      expect(notice?.textContent).toContain(rule);
      expect(notice?.getAttribute('role')).toBeNull();
      expect(screen.queryByRole('link', { name: `Open ${label}` })).toBeNull();
    },
  );

  it('ends the Viewing page with Open Viewing for a Viewer', async () => {
    await showPage('/help/viewing', 'Viewing help', viewer);

    expect(document.querySelector('.help-notice')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open Viewing' }).getAttribute('href')).toBe(
      '/viewing',
    );
  });

  it.each(['viewing', 'modelling', 'admin'] as const)(
    'shows an Admin no notice and an Open link on the %s page',
    async (space) => {
      const label = spaceLabels[space];
      await showPage(`/help/${space}`, `${label} help`, admin);

      expect(document.querySelector('.help-notice')).toBeNull();
      expect(screen.getByRole('link', { name: `Open ${label}` }).getAttribute('href')).toBe(
        `/${space}`,
      );
    },
  );

  it('shows an Admin access to every space on the index', async () => {
    await showPage('/help', 'Help', admin);
    expect(document.body.textContent).not.toContain('No access');
  });
});

/** A row of a table in guide/keyboard-shortcuts.md: its section, keys and meaning. */
interface GuideRow {
  section: string;
  keys: string;
  does: string;
}

function guideRows(): GuideRow[] {
  const text = readFileSync(join(import.meta.dirname, '../../guide/keyboard-shortcuts.md'), 'utf8');
  const rows: GuideRow[] = [];
  let section = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) section = line.slice(3).trim();
    if (!line.startsWith('|')) continue;
    const [keys = '', does = ''] = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (keys === 'Key' || /^-+$/.test(keys)) continue;
    rows.push({ section, keys, does });
  }
  return rows;
}

/** A rendered key cell written back the guide's way: each <kbd> as `key`, its symbol if it has one. */
function asGuideKeys(cell: Element): string {
  return [...cell.childNodes]
    .map((node) => {
      if (!(node instanceof HTMLElement) || node.tagName !== 'KBD') return node.textContent;
      const symbol = node.querySelector('[aria-hidden="true"]');
      return `\`${(symbol ?? node).textContent}\``;
    })
    .join('');
}

describe('keyboard tables', () => {
  it('has every row of the keyboard shortcuts guide, each on the page of its space', async () => {
    const shown = new Map<string, Space[]>();
    for (const space of ['viewing', 'modelling', 'admin'] as const) {
      const label = spaceLabels[space];
      stubApi(admin);
      const view = renderAt(`/help/${space}`);
      await screen.findByRole('heading', { level: 1, name: `${label} help` });
      for (const table of document.querySelectorAll<HTMLElement>('.help-keys')) {
        for (const cell of table.querySelectorAll('tbody td:first-child')) {
          const key = `${table.dataset.guide ?? ''} | ${asGuideKeys(cell)}`;
          shown.set(key, [...(shown.get(key) ?? []), space]);
        }
      }
      view.unmount();
    }

    const guide = guideRows();
    expect(guide.length).toBeGreaterThan(80);
    const inGuide = new Set(guide.map((row) => `${row.section} | ${row.keys}`));
    // Nothing on the help pages that the guide doesn't have.
    expect([...shown.keys()].filter((key) => !inGuide.has(key))).toEqual([]);
    for (const row of guide) {
      const where = shown.get(`${row.section} | ${row.keys}`);
      // A row whose meaning differs between Viewing and Modelling is on both pages; any other on one.
      const both = row.does.includes('Viewing') && row.does.includes('Modelling');
      expect({ ...row, where }).toEqual({
        ...row,
        where: both ? ['viewing', 'modelling'] : [expect.any(String)],
      });
    }
  });

  it('reads symbol keys as words', async () => {
    await showPage('/help/viewing', 'Viewing help');

    const arrows = screen.getByRole('table', { name: 'Canvas' }).querySelector('tbody td');
    const kbd = arrows?.querySelector('kbd');
    expect(kbd?.getAttribute('aria-label')).toBeNull();
    expect(kbd?.querySelector('[aria-hidden="true"]')?.textContent).toBe('↑');
    expect(kbd?.querySelector('.vh')?.textContent).toBe('Up arrow');
  });

  it('writes key combinations as separate keys joined by a plain +', async () => {
    await showPage('/help/modelling', 'Modelling help');

    const forms = screen.getByRole('table', { name: 'Forms' });
    const cell = forms.querySelector('tbody td');
    expect(cell?.innerHTML).toBe('<kbd>Ctrl</kbd> + <kbd>Enter</kbd>');
  });
});
