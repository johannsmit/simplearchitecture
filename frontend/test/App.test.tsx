import type { MeResponse, ModelSummary } from '@simplearchitecture/shared';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { bakeryModel, bakerySummary, pilotSummary } from './fixtures';
import {
  admin,
  apiError,
  currentLocation,
  expectNoSeriousAxeViolations,
  modeller,
  noRole,
  renderAt,
  requests,
  stubApi,
  viewer,
  type Handler,
} from './helpers';

const modellerAndViewer: MeResponse = { ...modeller, roles: ['Modeller', 'Viewer'] };

function modelsApi(models: ModelSummary[] = [bakerySummary, pilotSummary]): Handler {
  return ({ url, method }) => {
    if (method === 'GET' && url === '/api/models') return Response.json({ models });
    if (method === 'GET' && url === `/api/models/${bakerySummary.id}`) {
      return Response.json(bakeryModel);
    }
    return undefined;
  };
}

const signedOut = () => apiError(401, 'Unauthorized');

function header() {
  return screen.getByRole('banner');
}

async function openUserMenu() {
  fireEvent.click(await screen.findByRole('button', { name: /account menu$/ }));
}

describe('signed out', () => {
  it('shows only a Sign in button that goes to /auth/login', async () => {
    stubApi(signedOut);
    renderAt('/viewing');

    const signIn = await screen.findByRole('link', { name: 'Sign in' });
    // Signing in comes back to the page that was asked for (the API checks the path).
    expect(signIn.getAttribute('href')).toBe('/auth/login?returnTo=%2Fviewing');
    expect(screen.queryByRole('navigation', { name: 'Spaces' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says when sign-in failed', async () => {
    stubApi(signedOut);
    renderAt('/?signin=failed');

    expect((await screen.findByRole('alert')).textContent).toContain("Sign-in didn't complete");
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/auth/login');
  });

  it('says when there were too many sign-in attempts (the API sends ?signin=busy)', async () => {
    stubApi(signedOut);
    renderAt('/?signin=busy');

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Too many sign-in attempts from your network. Wait a minute and try again.',
    );
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/auth/login');
  });

  it('shows an error, not the sign-in page, when the API is unreachable', async () => {
    stubApi(() => Promise.reject(new TypeError('Failed to fetch')));
    renderAt('/viewing');

    expect(
      await screen.findByRole('heading', { name: 'SimpleArchitecture is unavailable' }),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
  });

  it('treats an unexpected /api/me body as an error', async () => {
    stubApi(() => Response.json({ name: 'x', roles: ['Root'], spaces: ['admin'] }));
    renderAt('/admin');

    expect(
      await screen.findByRole('heading', { name: 'SimpleArchitecture is unavailable' }),
    ).toBeTruthy();
  });

  it('shows the sign-in page with a note when the session ends during use', async () => {
    stubApi(admin, ({ url }) =>
      url === '/api/models' ? apiError(401, 'Unauthorized') : undefined,
    );
    renderAt('/viewing');

    expect((await screen.findByRole('alert')).textContent).toContain('Your session ended');
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
      '/auth/login?returnTo=%2Fviewing',
    );
  });
});

describe('header', () => {
  it('redirects / to the first allowed space (the Models page for Viewing)', async () => {
    stubApi(admin, modelsApi());
    renderAt('/');

    expect(await screen.findByRole('heading', { level: 1, name: 'Models' })).toBeTruthy();
    expect(currentLocation()).toBe('/viewing');
  });

  it.each([
    ['Admin', admin, ['Viewing', 'Modelling', 'Admin']],
    ['Modeller', modeller, ['Viewing', 'Modelling']],
    ['Viewer', viewer, ['Viewing']],
    ['no role', noRole, []],
  ] as const)('shows only the allowed space links for %s', async (_name, me, visible) => {
    stubApi(me, modelsApi());
    renderAt('/does-not-exist');

    const nav = await screen.findByRole('navigation', { name: 'Spaces' });
    expect(
      within(nav)
        .queryAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(visible);
  });

  it('marks the current space in the navigation', async () => {
    stubApi(admin);
    renderAt('/modelling');

    const nav = await screen.findByRole('navigation', { name: 'Spaces' });
    expect(within(nav).getByRole('link', { name: 'Modelling' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      within(nav).getByRole('link', { name: 'Admin' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it.each([
    [['Admin', 'Modeller'], 'Admin · Modeller'],
    [['Admin', 'Modeller', 'Viewer'], 'Admin · Modeller · Viewer'],
    [['Viewer', 'Modeller'], 'Modeller · Viewer'],
    [['Viewer'], 'Viewer'],
  ] as const)('shows all of the roles %j as "%s" on the user button', async (roles, label) => {
    stubApi({ ...admin, roles: [...roles] }, modelsApi());
    renderAt('/viewing');

    // Named by its visible text (WCAG 2.5.3), then what it opens.
    const button = await screen.findByRole('button', {
      name: `Alex Morgan ${label}, account menu`,
    });
    expect(button.querySelector('.roles-line')?.textContent).toBe(label);
    expect(button.textContent).toContain('Alex Morgan');
  });

  it('shows who is signed in, their roles and access, and a sign-out form POST', async () => {
    stubApi(modellerAndViewer, modelsApi());
    renderAt('/viewing');
    await openUserMenu();

    expect(screen.getByText('alex@example.com')).toBeTruthy();
    const roles = screen.getByRole('list', { name: 'Roles' });
    expect(
      within(roles)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Modeller', 'Viewer']);
    const access = document.querySelector('.access');
    expect(access?.textContent).toContain('ViewingRead');
    expect(access?.textContent).toContain('ModellingEdit elements');
    expect(access?.textContent).toContain('AdminNo access');
    const signOut = screen.getByRole('button', { name: 'Sign out' });
    const form = signOut.closest('form');
    expect(form?.getAttribute('method')).toBe('post');
    expect(form?.getAttribute('action')).toBe('/auth/logout');
  });

  it('leaves out the email when there is none, and says "No role" without roles', async () => {
    stubApi({ ...noRole, email: null });
    renderAt('/');
    await openUserMenu();

    expect(screen.queryByText('alex@example.com')).toBeNull();
    expect(screen.getByRole('list', { name: 'Roles' }).textContent).toBe('No role');
  });

  it('opens one popover at a time and closes it on Esc with focus back on its button', async () => {
    stubApi(admin, modelsApi());
    renderAt('/viewing');

    const theme = await screen.findByRole('button', { name: 'Theme: Light' });
    fireEvent.click(theme);
    expect(theme.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu')).toBeTruthy();

    await openUserMenu();
    expect(theme.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();

    const user = screen.getByRole('button', { name: /account menu$/ });
    expect(user.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(user.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(user);
  });

  it('closes a popover on a click outside', async () => {
    stubApi(admin, modelsApi());
    renderAt('/viewing');
    await openUserMenu();
    // The page loads apart from the header, so it may come after the menu's button.
    fireEvent.mouseDown(await screen.findByRole('heading', { level: 1, name: 'Models' }));

    expect(
      screen.getByRole('button', { name: /account menu$/ }).getAttribute('aria-expanded'),
    ).toBe('false');
  });
});

describe('theme', () => {
  it('is Light by default and applies and remembers Dark only when selected', async () => {
    stubApi(admin);
    renderAt('/admin');

    const button = await screen.findByRole('button', { name: 'Theme: Light' });
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);

    fireEvent.click(button);
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual(['Light', 'Dark']);
    expect(items[0]?.getAttribute('aria-checked')).toBe('true');
    // The menu puts focus on the checked item; arrow keys move.
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('sa-theme')).toBe('dark');
    expect(screen.getByRole('button', { name: 'Theme: Dark' })).toBe(document.activeElement);

    fireEvent.click(screen.getByRole('button', { name: 'Theme: Dark' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Light' }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem('sa-theme')).toBeNull();
  });

  it('still switches when storage is blocked', async () => {
    stubApi(admin);
    const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      renderAt('/admin');
      fireEvent.click(await screen.findByRole('button', { name: 'Theme: Light' }));
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    } finally {
      blocked.mockRestore();
    }
  });
});

describe('model picker', () => {
  it('shows in Viewing and Modelling, not in Admin', async () => {
    stubApi(admin, modelsApi());
    renderAt('/admin/models');

    await screen.findByRole('heading', { level: 1, name: 'Models' });
    expect(screen.queryByRole('button', { name: /^Model:/ })).toBeNull();
  });

  it('lists every model with counts and an All models link', async () => {
    stubApi(viewer, modelsApi());
    renderAt('/viewing');

    const picker = await screen.findByRole('button', { name: 'Model: Choose a model' });
    fireEvent.click(picker);
    const list = await screen.findByRole('list', { name: 'Models' });
    const links = within(list).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Bakery landscape 7 elements · 8 relationships',
      'Payments pilot 38 elements · 51 relationships',
    ]);
    expect(links[0]?.getAttribute('href')).toBe(`/viewing/models/${bakerySummary.id}`);
    expect(within(header()).getByRole('link', { name: 'All models' }).getAttribute('href')).toBe(
      '/viewing',
    );
  });

  it('names and marks the open model, and navigates on choice', async () => {
    stubApi(viewer, modelsApi());
    renderAt(`/viewing/models/${bakerySummary.id}`);

    const picker = await screen.findByRole('button', { name: 'Model: Bakery landscape' });
    fireEvent.click(picker);
    const current = screen.getByRole('link', { name: /^Bakery landscape/ });
    expect(current.getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('link', { name: /^Payments pilot/ }));
    expect(currentLocation()).toBe(`/viewing/models/${pilotSummary.id}`);
    expect(picker.getAttribute('aria-expanded')).toBe('false');
  });

  it('says when there are no models yet', async () => {
    stubApi(viewer, modelsApi([]));
    renderAt('/viewing');

    expect(await screen.findByRole('button', { name: 'Model: No models yet' })).toBeTruthy();
  });

  it('gets a filter field above 7 models', async () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      ...pilotSummary,
      id: `${index}0000000-0000-4000-8000-000000000000`,
      name: `Model ${index + 1}`,
    }));
    stubApi(viewer, modelsApi(many));
    renderAt('/viewing');
    // Wait for the list: the picker shows the filter only once the models are loaded.
    await screen.findByRole('link', { name: 'Model 9' });

    fireEvent.click(screen.getByRole('button', { name: /^Model:/ }));
    const filter = screen.getByRole('searchbox', { name: 'Find a model' });
    fireEvent.change(filter, { target: { value: 'model 9' } });
    expect(
      within(screen.getByRole('list', { name: 'Models' }))
        .getAllByRole('link')
        .map((link) => link.querySelector('b')?.textContent),
    ).toEqual(['Model 9']);
  });
});

describe('pages', () => {
  it('lists the models on the Modelling page, each opening in Modelling', async () => {
    stubApi(modeller, modelsApi());
    renderAt('/modelling');

    expect(
      await screen.findByText('Open a model to add, edit and delete its elements.'),
    ).toBeTruthy();
    const links = await screen.findAllByRole('link', { name: /Open .* in the explorer/ });
    expect(links[0]?.getAttribute('href')).toMatch(/^\/modelling\/models\//);
  });

  it('renders a not-found page for unknown routes, inside the shell', async () => {
    stubApi(admin);
    renderAt('/does-not-exist');

    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Spaces' })).toBeTruthy();
  });

  it('has no licence page, and nothing sends an Admin to one', async () => {
    const fetchMock = stubApi(admin);
    renderAt('/admin/licence');

    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(screen.queryByText(/licensed to/i)).toBeNull();
    expect(requests(fetchMock).some((request) => request.includes('licence'))).toBe(false);
  });

  it('has a skip link first that moves focus to the page', async () => {
    stubApi(admin, modelsApi());
    renderAt('/viewing');

    await screen.findByRole('heading', { level: 1, name: 'Models' });
    const skip = screen.getByRole('link', { name: 'Skip to models' });
    expect(document.querySelectorAll('a, button')[0]).toBe(skip);
    act(() => {
      fireEvent.click(skip);
    });
    expect(document.activeElement?.id).toBe('models');
  });

  it('has no serious accessibility issues in the shell with the user menu open', async () => {
    stubApi(admin, modelsApi());
    renderAt('/viewing');
    await screen.findByRole('link', { name: 'Bakery landscape' });
    await openUserMenu();

    await expectNoSeriousAxeViolations();
  });
});

describe('No access page', () => {
  it.each([
    ['admin', 'Admin', viewer, 'Viewer'],
    ['admin', 'Admin', modeller, 'Modeller'],
    ['modelling', 'Modelling', viewer, 'Viewer'],
    // Several roles are all shown, the same way as in the shell.
    ['admin', 'Admin', modellerAndViewer, 'Modeller · Viewer'],
  ] as const)(
    'replaces /%s for a user without access and requests nothing for that space',
    async (path, label, me, role) => {
      const fetchMock = stubApi(me);
      renderAt(`/${path}`);

      expect(
        await screen.findByRole('heading', { level: 1, name: `You don't have access to ${label}` }),
      ).toBeTruthy();
      const page = screen.getByRole('heading', { level: 1 }).closest('section');
      expect(page?.textContent).toContain(`You're signed in as Alex Morgan (${role})`);
      expect(page?.textContent).toContain('Ask an administrator');
      expect(screen.queryByRole('heading', { level: 1, name: label })).toBeNull();
      expect(screen.getByRole('link', { name: 'Go to Viewing' }).getAttribute('href')).toBe(
        '/viewing',
      );
      // No request for the forbidden space's data: only who-am-I.
      expect(requests(fetchMock)).toEqual(['GET /api/me']);
    },
  );

  it('explains that a user without any role has no access, with no space to go to', async () => {
    stubApi(noRole);
    renderAt('/');

    expect(
      await screen.findByRole('heading', { level: 1, name: "You don't have access yet" }),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Go to/ })).toBeNull();
  });

  it('shows No access for a direct /viewing link when the user has no role', async () => {
    const fetchMock = stubApi(noRole);
    renderAt('/viewing');

    expect(
      await screen.findByRole('heading', { level: 1, name: "You don't have access to Viewing" }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Model:/ })).toBeNull();
    expect(requests(fetchMock)).toEqual(['GET /api/me']);
  });
});
