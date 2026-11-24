import type { Branding } from '@simplearchitecture/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { imageSize } from '../src/admin/branding/image-size';
import { App } from '../src/App';
import { BrandingProvider, readBrandingCache } from '../src/branding';
import { applyTheme } from '../src/theme';
import { admin, apiError, expectNoSeriousAxeViolations, stubApi, type Handler } from './helpers';

/** The product title, the logo for the Dark theme and the app icon, in the app and on the page. */

// jsdom can't decode images; the browser's size check is stubbed.
vi.mock('../src/admin/branding/image-size', () => ({
  imageSize: vi.fn(() => Promise.resolve({ width: 512, height: 512 })),
}));

const neutral: Branding = {
  title: null,
  primary: null,
  secondary: null,
  logoUrl: null,
  darkLogoUrl: null,
  iconUrl: null,
  version: 1,
};
const branded: Branding = {
  ...neutral,
  title: 'Example Atlas',
  logoUrl: '/api/branding/logo?v=3',
  darkLogoUrl: '/api/branding/dark-logo?v=3',
  iconUrl: '/api/branding/icon?v=3',
  version: 3,
};

interface Server {
  handler: Handler;
  writes: string[];
  bodies: string[];
  state: Branding;
  failNext: ((url: string) => Response | undefined) | null;
}

function brandingServer(initial: Branding): Server {
  const server: Server = {
    writes: [],
    bodies: [],
    state: { ...initial },
    failNext: null,
    handler: ({ url, method, body }) => {
      if (url === '/api/branding' && method === 'GET') return Response.json(server.state);
      if (!url.startsWith('/api/admin/branding')) return undefined;
      server.writes.push(`${method} ${url}`);
      if (typeof body === 'string') server.bodies.push(body);
      const failure = server.failNext?.(url);
      if (failure) {
        server.failNext = null;
        return failure;
      }
      const version = server.state.version + 1;
      if (url === '/api/admin/branding/title') {
        const sent = JSON.parse(String(body)) as { title: string | null };
        server.state = { ...server.state, title: sent.title, version };
      } else if (url === '/api/admin/branding') {
        const sent = JSON.parse(String(body)) as Branding;
        server.state = {
          ...server.state,
          primary: sent.primary,
          secondary: sent.secondary,
          version,
        };
      } else if (url.startsWith('/api/admin/branding?')) {
        server.state = { ...neutral, version };
      } else {
        const image = /branding\/([a-z-]+)\?/.exec(url)?.[1] ?? '';
        const field = { logo: 'logoUrl', 'dark-logo': 'darkLogoUrl', icon: 'iconUrl' }[image];
        if (field === undefined) return undefined;
        server.state = {
          ...server.state,
          [field]: method === 'PUT' ? `/api/branding/${image}?v=${version}` : null,
          version,
        };
      }
      return Response.json(server.state);
    },
  };
  return server;
}

function renderBranded(path: string) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <BrandingProvider>
          <App />
        </BrandingProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

const link = (rel: string) => document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
const pngFile = (name = 'example-icon.png', size = 20 * 1024, type = 'image/png') =>
  new File([new Uint8Array(size)], name, { type });

beforeEach(() => {
  vi.mocked(imageSize).mockResolvedValue({ width: 512, height: 512 });
  document.title = 'SimpleArchitecture';
});

afterEach(() => {
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
  for (const rel of ['icon', 'apple-touch-icon']) link(rel)?.remove();
});

describe('the product title in the app', () => {
  it('shows in the header, names the home link and is the browser tab title', async () => {
    stubApi(admin, brandingServer(branded).handler);
    renderBranded('/viewing');
    const home = await screen.findByRole('link', { name: 'Example Atlas home' });
    expect(within(home).getByText('Example Atlas')).toBeTruthy();
    await waitFor(() => {
      expect(document.title).toBe('Example Atlas');
    });
    expect(readBrandingCache()?.title).toBe('Example Atlas');
  });

  it('carries into the titles pages set for themselves', async () => {
    stubApi(admin, brandingServer(branded).handler, ({ url }) =>
      url === '/api/agents' ? Response.json({ apps: [] }) : undefined,
    );
    renderBranded('/agents');
    await waitFor(() => {
      expect(document.title).toBe('Connected apps – Example Atlas');
    });
  });

  it('shows on the sign-in page', async () => {
    stubApi(() => apiError(401, 'Not signed in'), brandingServer(branded).handler);
    renderBranded('/');
    await screen.findByRole('heading', { level: 1, name: 'Example Atlas' });
    expect(document.title).toBe('Example Atlas');
  });

  it('is plain text: markup in it is shown as written', async () => {
    const title = '<img src=x onerror=alert(1)>';
    stubApi(admin, brandingServer({ ...neutral, title }).handler);
    renderBranded('/viewing');
    const home = await screen.findByRole('link', { name: `${title} home` });
    expect(home.querySelector('img[src="x"]')).toBeNull();
    expect(home.textContent).toContain(title);
  });

  it.each([
    ['over 40 characters', 'x'.repeat(41)],
    ['with a line break', 'Example\nAtlas'],
    ['padded', ' Example'],
  ])('never shows a server title %s: the default instead', async (_name, title) => {
    stubApi(admin, brandingServer({ ...neutral, title }).handler);
    renderBranded('/viewing');
    await screen.findByRole('link', { name: 'SimpleArchitecture home' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.title).toBe('SimpleArchitecture');
    expect(readBrandingCache()).toBeNull();
  });
});

describe('the logo for the Dark theme', () => {
  const logoSrc = () => screen.getByRole('img', { name: 'Company logo' }).getAttribute('src');

  it('shows in the Dark theme and swaps with the theme, without a reload', async () => {
    stubApi(admin, brandingServer(branded).handler);
    renderBranded('/viewing');
    await screen.findByRole('img', { name: 'Company logo' });
    expect(logoSrc()).toBe('/api/branding/logo?v=3');
    await act(async () => {
      applyTheme('dark');
      await Promise.resolve();
    });
    expect(logoSrc()).toBe('/api/branding/dark-logo?v=3');
    await act(async () => {
      applyTheme('light');
      await Promise.resolve();
    });
    expect(logoSrc()).toBe('/api/branding/logo?v=3');
  });

  it('falls back to the logo in the Dark theme when there is none, or it fails to load', async () => {
    const server = brandingServer({ ...branded, darkLogoUrl: null });
    stubApi(admin, server.handler);
    document.documentElement.setAttribute('data-theme', 'dark');
    const { unmount } = renderBranded('/viewing');
    await screen.findByRole('img', { name: 'Company logo' });
    expect(logoSrc()).toBe('/api/branding/logo?v=3');
    unmount();

    stubApi(admin, brandingServer(branded).handler);
    renderBranded('/viewing');
    await waitFor(() => {
      expect(logoSrc()).toBe('/api/branding/dark-logo?v=3');
    });
    fireEvent.error(screen.getByRole('img', { name: 'Company logo' }));
    expect(logoSrc()).toBe('/api/branding/logo?v=3');
  });

  it('may be set without a logo: the Light theme keeps the mark', async () => {
    stubApi(
      admin,
      brandingServer({ ...neutral, darkLogoUrl: '/api/branding/dark-logo?v=2' }).handler,
    );
    renderBranded('/viewing');
    const home = await screen.findByRole('link', { name: 'SimpleArchitecture home' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(within(home).queryByRole('img', { name: 'Company logo' })).toBeNull();
    await act(async () => {
      applyTheme('dark');
      await Promise.resolve();
    });
    expect(within(home).getByRole('img', { name: 'Company logo' }).getAttribute('src')).toBe(
      '/api/branding/dark-logo?v=2',
    );
  });

  it('never shows a dark logo URL other than its own route', async () => {
    stubApi(admin, brandingServer({ ...neutral, darkLogoUrl: '/api/branding/logo?v=2' }).handler);
    document.documentElement.setAttribute('data-theme', 'dark');
    renderBranded('/viewing');
    await screen.findByRole('link', { name: 'SimpleArchitecture home' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('img', { name: 'Company logo' })).toBeNull();
  });
});

describe('the app icon', () => {
  it('becomes the tab icon and the home-screen icon, and the built-in ones come back without it', async () => {
    const server = brandingServer(branded);
    stubApi(admin, server.handler);
    const { unmount } = renderBranded('/viewing');
    await waitFor(() => {
      expect(link('icon')?.getAttribute('href')).toBe('/api/branding/icon?v=3');
    });
    expect(link('icon')?.getAttribute('type')).toBe('image/png');
    expect(link('apple-touch-icon')?.getAttribute('href')).toBe('/api/branding/icon?v=3');
    expect(readBrandingCache()?.iconUrl).toBe('/api/branding/icon?v=3');
    unmount();

    stubApi(admin, brandingServer({ ...branded, iconUrl: null }).handler);
    renderBranded('/viewing');
    await waitFor(() => {
      expect(link('icon')?.getAttribute('href')).toBe('/icon.svg');
    });
    expect(link('icon')?.getAttribute('type')).toBe('image/svg+xml');
    expect(link('apple-touch-icon')?.getAttribute('href')).toBe('/pwa-192x192.png');
  });

  it('never uses an icon URL other than its own route', async () => {
    stubApi(
      admin,
      brandingServer({ ...neutral, primary: '#1d6b5f', iconUrl: 'https://example.test/i.png' })
        .handler,
    );
    renderBranded('/viewing');
    await waitFor(() => {
      expect(link('icon')?.getAttribute('href')).toBe('/icon.svg');
    });
    expect(readBrandingCache()?.iconUrl).toBeNull();
  });
});

describe('theme-init.js: the title and icon before first paint', () => {
  const script = readFileSync(join(import.meta.dirname, '../public/theme-init.js'), 'utf8');
  const runThemeInit = () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the shipped file as is
    const run = new Function(script) as () => void;
    run();
  };
  const cache = {
    v: 1,
    version: 4,
    title: 'Example Atlas',
    logoUrl: null,
    logoRatio: null,
    darkLogoUrl: '/api/branding/dark-logo?v=4',
    darkLogoRatio: 2,
    iconUrl: '/api/branding/icon?v=4',
    light: { accent: '#1d6b5f' },
    dark: { accent: '#529b8e' },
  };

  beforeEach(() => {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<link rel="icon" href="/icon.svg" type="image/svg+xml" /><link rel="apple-touch-icon" href="/pwa-192x192.png" />',
    );
  });

  it('applies a cached title and icon', () => {
    localStorage.setItem('sa-branding', JSON.stringify(cache));
    runThemeInit();
    expect(document.title).toBe('Example Atlas');
    expect(link('icon')?.getAttribute('href')).toBe('/api/branding/icon?v=4');
    expect(link('icon')?.getAttribute('type')).toBe('image/png');
    expect(link('apple-touch-icon')?.getAttribute('href')).toBe('/api/branding/icon?v=4');
    expect(readBrandingCache()).toEqual(cache);
  });

  it('keeps the first paint from flashing the default title once the app runs', async () => {
    localStorage.setItem('sa-branding', JSON.stringify(cache));
    runThemeInit();
    const titles: string[] = [];
    const observer = new MutationObserver(() => {
      titles.push(document.title);
    });
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    stubApi(admin, brandingServer({ ...branded, version: 4 }).handler);
    renderBranded('/viewing');
    await screen.findByRole('link', { name: 'Example Atlas home' });
    await act(async () => {
      await Promise.resolve();
    });
    observer.disconnect();
    expect(titles).not.toContain('SimpleArchitecture');
    expect(document.title).toBe('Example Atlas');
  });

  it.each([
    ['a title with a line break', { ...cache, title: 'Example\nAtlas' }],
    ['a title over 40 characters', { ...cache, title: 'x'.repeat(41) }],
    ['a title that is not text', { ...cache, title: ['Example'] }],
    ['an icon from elsewhere', { ...cache, iconUrl: 'https://example.test/i.png' }],
    ['a dark logo on another route', { ...cache, darkLogoUrl: '/api/branding/logo?v=4' }],
  ])('ignores the whole cache with %s', (_name, bad) => {
    localStorage.setItem('sa-branding', JSON.stringify(bad));
    runThemeInit();
    expect(document.title).toBe('SimpleArchitecture');
    expect(link('icon')?.getAttribute('href')).toBe('/icon.svg');
    expect(document.documentElement.style.length).toBe(0);
    expect(readBrandingCache()).toBeNull();
  });
});

describe('Admin → Branding: title, Dark theme logo and app icon', () => {
  const titleField = () => screen.getByRole('textbox', { name: 'Product title' });
  const saveButton = () => screen.getByRole('button', { name: 'Save' });
  const darkDrop = () =>
    screen.getByRole('button', { name: /^Logo for Dark theme \(optional\) Drop .*choose a file/ });
  const iconDrop = () => screen.getByRole('button', { name: /^App icon Drop .*choose a file/ });
  const pick = (label: string, file: File) => {
    fireEvent.change(screen.getByLabelText(label), { target: { files: [file] } });
  };

  async function openPage(server: Server) {
    stubApi(admin, server.handler);
    renderBranded('/admin/branding');
    await screen.findByRole('textbox', { name: 'Product title' });
  }

  it('lays out title, logo, Dark theme logo, app icon and colours in order', async () => {
    await openPage(brandingServer(neutral));
    const field = titleField();
    expect(field.getAttribute('placeholder')).toBe('SimpleArchitecture');
    const describedBy = field.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy.split(' ')[0] ?? '')?.textContent).toBe(
      'Shown in the header, on the sign-in page and in the browser tab. Leave empty to use SimpleArchitecture.',
    );
    expect(describedBy).toContain('brand-title-count');
    expect(document.getElementById('brand-title-count')?.textContent).toBe('0 / 40');
    expect(
      screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent)
        .filter((text) => text !== ''),
    ).toEqual([
      'Product title, logo, app icon and colours',
      'Product title',
      'Logo',
      'App icon',
      'Colours',
      'Preview',
    ]);
    expect(
      screen.getByRole('heading', { level: 3, name: 'Logo for Dark theme (optional)' }),
    ).toBeTruthy();
    expect(darkDrop().getAttribute('aria-describedby')).toBe('dark-logo-hint');
    expect(document.getElementById('dark-logo-hint')?.textContent).toBe(
      'Same rules as the logo. Used in the Dark theme; without it, the logo above is used.',
    );
    expect(document.getElementById('icon-hint')?.textContent).toBe(
      'A square PNG, 512 × 512 pixels, up to 300 KB. Used for the browser tab and the installed app.',
    );
    expect(screen.getByText('Built-in icon')).toBeTruthy();
    // Keyboard order follows the layout: title, logo, Dark theme logo, icon, colours.
    const order = [
      titleField(),
      screen.getByRole('button', { name: /^Logo Drop/ }),
      darkDrop(),
      iconDrop(),
      screen.getByRole('textbox', { name: 'Primary colour' }),
    ];
    for (let index = 1; index < order.length; index++) {
      const before = order[index - 1];
      const after = order[index];
      if (!before || !after) throw new Error('missing');
      expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    await expectNoSeriousAxeViolations();
  });

  it('counts characters, and says when the title is too long or has a control character', async () => {
    const server = brandingServer(neutral);
    await openPage(server);
    fireEvent.change(titleField(), { target: { value: 'x'.repeat(41) } });
    expect(document.getElementById('brand-title-count')?.textContent).toBe('41 / 40');
    expect(titleField().getAttribute('aria-invalid')).toBe('true');
    const error = screen.getByText('The product title must be at most 40 characters.');
    expect(titleField().getAttribute('aria-describedby')).toContain(error.parentElement?.id ?? 'x');
    fireEvent.change(titleField(), { target: { value: 'Example\tAtlas' } });
    expect(
      screen.getByText("The product title can't contain line breaks or control characters."),
    ).toBeTruthy();
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(document.activeElement).toBe(titleField());
    });
    expect(server.writes).toEqual([]);
    // 40 emoji are 40 characters.
    fireEvent.change(titleField(), { target: { value: '\u{1F30D}'.repeat(40) } });
    expect(document.getElementById('brand-title-count')?.textContent).toBe('40 / 40');
    expect(titleField().getAttribute('aria-invalid')).toBeNull();
  });

  it('saves a trimmed title: the preview, header and tab follow', async () => {
    const server = brandingServer(neutral);
    await openPage(server);
    fireEvent.change(titleField(), { target: { value: '  Example Atlas ' } });
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    const preview = screen.getByRole('region', { name: 'Preview' });
    expect(within(preview).getAllByText('Example Atlas')).toHaveLength(3);
    fireEvent.click(saveButton());
    await screen.findByText('Saved');
    expect(server.writes).toEqual(['PUT /api/admin/branding/title']);
    expect(server.bodies).toEqual([JSON.stringify({ title: 'Example Atlas', version: 1 })]);
    expect(screen.getByRole('link', { name: 'Example Atlas home' })).toBeTruthy();
    expect(document.title).toBe('Example Atlas');
    expect(titleField()).toHaveProperty('value', 'Example Atlas');

    // Emptied: back to the default.
    fireEvent.change(titleField(), { target: { value: '   ' } });
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(server.state.title).toBeNull();
    });
    await screen.findByRole('link', { name: 'SimpleArchitecture home' });
    expect(document.title).toBe('SimpleArchitecture');
  });

  it('shows a 422 on the title at the field', async () => {
    const server = brandingServer(neutral);
    await openPage(server);
    fireEvent.change(titleField(), { target: { value: 'Example' } });
    server.failNext = () =>
      apiError(422, 'Not saved', {
        fields: [{ field: 'title', message: 'Made-up server message for the title.' }],
      });
    fireEvent.click(saveButton());
    await screen.findByText('Made-up server message for the title.');
    expect(titleField().getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => {
      expect(document.activeElement).toBe(titleField());
    });
  });

  it('picks and saves a Dark theme logo and an app icon; the preview shows them', async () => {
    const server = brandingServer({ ...neutral, logoUrl: '/api/branding/logo?v=1' });
    await openPage(server);
    vi.mocked(imageSize).mockResolvedValueOnce({ width: 400, height: 100 });
    pick('Dark theme logo file', pngFile('example-dark.png'));
    await screen.findByText('example-dark.png');
    expect(screen.getByText('Dark theme logo ready. Save to apply it.')).toBeTruthy();
    const darkFigure = document.querySelector('figure.pv.dark');
    expect(darkFigure?.querySelector('img.brand-logo')?.getAttribute('src')).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(document.querySelector('figure.pv.light img.brand-logo')?.getAttribute('src')).toBe(
      '/api/branding/logo?v=1',
    );

    pick('App icon file', pngFile('example-icon.png'));
    await screen.findByText('example-icon.png');
    expect(screen.getByText('App icon ready. Save to apply it.')).toBeTruthy();
    const tab = document.querySelector('.pv-tab');
    expect(tab?.closest('[inert]')).not.toBeNull();
    expect(tab?.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(tab?.textContent).toBe('SimpleArchitecture');

    fireEvent.click(saveButton());
    await screen.findByText('Saved');
    expect(server.writes).toEqual([
      'PUT /api/admin/branding/dark-logo?version=1',
      'PUT /api/admin/branding/icon?version=2',
    ]);
    expect(readBrandingCache()).toMatchObject({
      darkLogoUrl: '/api/branding/dark-logo?v=2',
      darkLogoRatio: 4,
      iconUrl: '/api/branding/icon?v=3',
    });
    expect(link('icon')?.getAttribute('href')).toBe('/api/branding/icon?v=3');
    expect(screen.getByRole('img', { name: 'Current app icon' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Current Dark theme logo' })).toBeTruthy();
  });

  it.each([
    [
      'a JPEG',
      pngFile('icon.jpg', 2000, 'image/jpeg'),
      undefined,
      'The app icon must be a PNG image.',
    ],
    [
      'a file over 300 KB',
      pngFile('big.png', 301 * 1024),
      undefined,
      'The app icon must be at most 300 KB.',
    ],
    [
      'the wrong size',
      pngFile(),
      { width: 512, height: 128 },
      'The app icon must be 512 × 512 pixels. This one is 512 × 128.',
    ],
  ])(
    'refuses %s as the app icon in the browser and sends nothing',
    async (_name, file, size, message) => {
      const server = brandingServer(neutral);
      await openPage(server);
      if (size) vi.mocked(imageSize).mockResolvedValueOnce(size);
      pick('App icon file', file);
      await screen.findByText(message);
      expect(iconDrop().getAttribute('aria-describedby')).toBe('icon-hint icon-error');
      await waitFor(() => {
        expect(document.activeElement).toBe(iconDrop());
      });
      expect(saveButton()).toHaveProperty('disabled', true);
      expect(server.writes).toEqual([]);
    },
  );

  it.each([
    [
      'an SVG',
      pngFile('logo.svg', 200, 'image/svg+xml'),
      'The Dark theme logo must be a PNG, JPEG or WebP image.',
    ],
    [
      'a file over 300 KB',
      pngFile('big.png', 301 * 1024),
      'The Dark theme logo must be at most 300 KB.',
    ],
  ])('refuses %s as the Dark theme logo', async (_name, file, message) => {
    const server = brandingServer(neutral);
    await openPage(server);
    pick('Dark theme logo file', file);
    await screen.findByText(message);
    await waitFor(() => {
      expect(document.activeElement).toBe(darkDrop());
    });
    expect(server.writes).toEqual([]);
  });

  it('a 415 on the icon after the title went through says what was saved', async () => {
    const server = brandingServer(neutral);
    await openPage(server);
    fireEvent.change(titleField(), { target: { value: 'Example Atlas' } });
    pick('App icon file', pngFile());
    await screen.findByText('example-icon.png');
    server.failNext = (url) =>
      url.includes('/icon') ? apiError(415, 'The app icon must be a PNG image.') : undefined;
    fireEvent.click(saveButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("The product title was saved; the app icon wasn't.");
    await waitFor(() => {
      expect(document.activeElement).toBe(iconDrop());
    });
    // The title is saved now; Save retries only the icon.
    expect(titleField()).toHaveProperty('value', 'Example Atlas');
    fireEvent.click(saveButton());
    await screen.findByText('Saved');
    expect(server.writes).toEqual([
      'PUT /api/admin/branding/title',
      'PUT /api/admin/branding/icon?version=2',
      'PUT /api/admin/branding/icon?version=2',
    ]);
  });

  it('removes and discards: Discard brings back the title, Dark theme logo and icon', async () => {
    await openPage(brandingServer(branded));
    await waitFor(() => {
      expect(titleField()).toHaveProperty('value', 'Example Atlas');
    });
    fireEvent.change(titleField(), { target: { value: 'Another' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Dark theme logo' }));
    expect(screen.getByText('Dark theme logo removed. Save to apply it.')).toBeTruthy();
    expect(document.activeElement).toBe(darkDrop());
    fireEvent.click(screen.getByRole('button', { name: 'Remove app icon' }));
    expect(screen.getByText('Built-in icon')).toBeTruthy();
    // Without its own, the Dark preview shows the logo.
    expect(document.querySelector('figure.pv.dark img.brand-logo')?.getAttribute('src')).toBe(
      '/api/branding/logo?v=3',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(titleField()).toHaveProperty('value', 'Example Atlas');
    expect(screen.getByRole('img', { name: 'Current Dark theme logo' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Current app icon' })).toBeTruthy();
  });

  it('a 409 on the title shows the conflict', async () => {
    const server = brandingServer(neutral);
    await openPage(server);
    fireEvent.change(titleField(), { target: { value: 'Example' } });
    server.failNext = () => apiError(409, 'Changed', { currentVersion: 5 });
    fireEvent.click(saveButton());
    await screen.findByText('Someone else changed the branding');
    expect(saveButton()).toHaveProperty('disabled', true);
  });

  it('asks before leaving with only a title change', async () => {
    await openPage(brandingServer(neutral));
    fireEvent.change(titleField(), { target: { value: 'Example' } });
    fireEvent.click(screen.getByRole('link', { name: 'Database' }));
    expect(screen.getByRole('dialog', { name: 'Save changes to the branding?' })).toBeTruthy();
  });

  it('Reset names everything it removes, and clears the title and icon at once', async () => {
    const server = brandingServer(branded);
    await openPage(server);
    await waitFor(() => {
      expect(link('icon')?.getAttribute('href')).toBe('/api/branding/icon?v=3');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset to the neutral look' }));
    const dialog = screen.getByRole('dialog', { name: 'Reset to the neutral look?' });
    expect(within(dialog).getByText(/^This removes/).textContent).toBe(
      "This removes the product title, both logos, the app icon and both colours for everyone, also on the sign-in page. It can't be undone.",
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset' }));
    await screen.findByText('Branding reset to the neutral look.');
    expect(titleField()).toHaveProperty('value', '');
    expect(screen.getByRole('link', { name: 'SimpleArchitecture home' })).toBeTruthy();
    expect(link('icon')?.getAttribute('href')).toBe('/icon.svg');
    expect(document.title).toBe('SimpleArchitecture');
    expect(localStorage.getItem('sa-branding')).toBeNull();
  });
});
