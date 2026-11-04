import { maxLogoBytes, type Branding } from '@simplearchitecture/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { imageSize } from '../src/admin/branding/image-size';
import { App } from '../src/App';
import { applyBrandValues, BrandingProvider, readBrandingCache } from '../src/branding';
import {
  admin,
  apiError,
  expectNoSeriousAxeViolations,
  modeller,
  requests,
  stubApi,
  viewer,
  type Handler,
} from './helpers';

/** Branding in the app and Admin → Branding. */

// jsdom can't decode images; the browser's size check is stubbed (a made-up 512 × 128 logo).
vi.mock('../src/admin/branding/image-size', () => ({
  imageSize: vi.fn(() => Promise.resolve({ width: 512, height: 128 })),
}));

const neutral: Branding = { primary: null, secondary: null, logoUrl: null, version: 0 };
const sample: Branding = {
  primary: '#1d6b5f',
  secondary: '#e0892b',
  logoUrl: '/api/branding/logo?v=3',
  version: 3,
};

const database = (configured: boolean) => ({
  configured,
  connected: configured,
  host: null,
  port: null,
  database: null,
  user: null,
  tls: false,
  tlsVerified: false,
  serverVersion: null,
  migrations: { applied: null, total: 4 },
});

interface Server {
  handler: Handler;
  /** The changes sent, in order. */
  writes: string[];
  state: Branding;
  /** Answers the next write with this instead. */
  failNext: ((url: string, method: string) => Response | undefined) | null;
}

function brandingServer(initial: Branding, configured = true): Server {
  const server: Server = {
    writes: [],
    state: { ...initial },
    failNext: null,
    handler: ({ url, method, body }) => {
      if (url === '/api/branding' && method === 'GET') return Response.json(server.state);
      if (url === '/api/admin/database' && method === 'GET') {
        return Response.json(database(configured));
      }
      if (!url.startsWith('/api/admin/branding')) return undefined;
      server.writes.push(`${method} ${url}`);
      const failure = server.failNext?.(url, method);
      if (failure) {
        server.failNext = null;
        return failure;
      }
      const version = server.state.version + 1;
      if (url === '/api/admin/branding' && method === 'PUT') {
        const sent = JSON.parse(String(body)) as Branding;
        server.state = {
          ...server.state,
          primary: sent.primary,
          secondary: sent.secondary,
          version,
        };
      } else if (url.startsWith('/api/admin/branding/logo?') && method === 'PUT') {
        server.state = { ...server.state, logoUrl: `/api/branding/logo?v=${version}`, version };
      } else if (url.startsWith('/api/admin/branding/logo?') && method === 'DELETE') {
        server.state = { ...server.state, logoUrl: null, version };
      } else if (url.startsWith('/api/admin/branding?') && method === 'DELETE') {
        server.state = { ...neutral, version };
      }
      return Response.json(server.state);
    },
  };
  return server;
}

/** Renders the app as main.tsx does: inside the branding provider. */
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

const html = () => document.documentElement.style;
const pngFile = (name = 'example-logo.png', size = 18 * 1024, type = 'image/png') =>
  new File([new Uint8Array(size)], name, { type });

beforeEach(() => {
  vi.mocked(imageSize).mockResolvedValue({ width: 512, height: 128 });
});

afterEach(() => {
  document.documentElement.removeAttribute('style');
});

describe('branding in the app', () => {
  it('applies the server branding as light-dark() tokens, shows the logo and caches it', async () => {
    const server = brandingServer(sample);
    stubApi(admin, server.handler);
    renderBranded('/viewing');

    const logo = await screen.findByRole('img', { name: 'Company logo' });
    expect(logo.tagName).toBe('IMG');
    expect(logo.getAttribute('src')).toBe('/api/branding/logo?v=3');
    // The link keeps its name; the logo takes the mark's place.
    const home = screen.getByRole('link', { name: 'SimpleArchitecture home' });
    expect(home.contains(logo)).toBe(true);
    expect(home.querySelector('svg')).toBeNull();

    expect(html().getPropertyValue('--accent')).toMatch(/^light-dark\(#1d6b5f, #[0-9a-f]{6}\)$/);
    expect(html().getPropertyValue('--brand-line')).toMatch(
      /^light-dark\(#[0-9a-f]{6}, #e0892b\)$/,
    );
    expect(html().getPropertyValue('--accent-soft')).toMatch(
      /^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/,
    );
    expect(html().getPropertyValue('--select-soft')).toMatch(
      /^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/,
    );
    // --focus and --edge-lit follow --accent through tokens.css; nothing else is set.
    expect(html().length).toBe(4);

    const cache = readBrandingCache();
    expect(cache?.version).toBe(3);
    expect(cache?.logoUrl).toBe('/api/branding/logo?v=3');
    expect(cache?.light.accent).toBe('#1d6b5f');
    expect(cache?.dark.brandLine).toBe('#e0892b');

    // The logo's shape is remembered for the next first paint.
    Object.defineProperties(logo, {
      naturalWidth: { value: 400 },
      naturalHeight: { value: 100 },
    });
    fireEvent.load(logo);
    expect(readBrandingCache()?.logoRatio).toBe(4);
    expect((logo as HTMLImageElement).style.aspectRatio).toMatch(/^4( \/ 1)?$/);
  });

  it('shows the mark when the logo fails to load (never a broken image)', async () => {
    stubApi(admin, brandingServer(sample).handler);
    renderBranded('/viewing');
    const logo = await screen.findByRole('img', { name: 'Company logo' });
    fireEvent.error(logo);
    expect(screen.queryByRole('img', { name: 'Company logo' })).toBeNull();
    const home = screen.getByRole('link', { name: 'SimpleArchitecture home' });
    expect(home.querySelector('svg')).not.toBeNull();
  });

  it('brands the signed-out page without signing in', async () => {
    stubApi(() => apiError(401, 'Not signed in'), brandingServer(sample).handler);
    renderBranded('/');
    await screen.findByRole('link', { name: 'Sign in' });
    const logo = await screen.findByRole('img', { name: 'Company logo' });
    expect(logo.tagName).toBe('IMG');
    expect(logo.classList.contains('signed-out-logo')).toBe(true);
    await waitFor(() => {
      expect(html().getPropertyValue('--accent')).toContain('#1d6b5f');
    });
  });

  it('neutral branding removes the tokens and the cache, and the server wins over the cache', async () => {
    localStorage.setItem(
      'sa-branding',
      JSON.stringify({
        v: 1,
        version: 2,
        logoUrl: '/api/branding/logo?v=2',
        logoRatio: 2,
        light: { accent: '#123456' },
        dark: { accent: '#abcdef' },
      }),
    );
    applyBrandValues(readBrandingCache());
    expect(html().getPropertyValue('--accent')).toBe('light-dark(#123456, #abcdef)');
    stubApi(admin, brandingServer({ ...neutral, version: 5 }).handler);
    renderBranded('/viewing');
    // First render uses the cached logo, then the server's answer (neutral) wins.
    await waitFor(() => {
      expect(html().getPropertyValue('--accent')).toBe('');
    });
    expect(localStorage.getItem('sa-branding')).toBeNull();
    expect(screen.queryByRole('img', { name: 'Company logo' })).toBeNull();
  });

  it('falls back to the neutral look on a server error or a bad answer', async () => {
    applyBrandValues({ light: { accent: '#123456' }, dark: { accent: '#abcdef' } });
    stubApi(admin, ({ url }) =>
      url === '/api/branding' ? apiError(500, 'Something went wrong') : undefined,
    );
    renderBranded('/viewing');
    await waitFor(() => {
      expect(html().getPropertyValue('--accent')).toBe('');
    });
  });

  it('never writes a server colour that is not #rrggbb', async () => {
    stubApi(admin, ({ url }) =>
      url === '/api/branding'
        ? Response.json({
            primary: 'red; background: url(https://example.test/x)',
            secondary: '#e0892b',
            logoUrl: null,
            version: 1,
          })
        : undefined,
    );
    renderBranded('/viewing');
    await screen.findByRole('link', { name: 'SimpleArchitecture home' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(html().length).toBe(0);
  });

  it.each([
    ['another origin', 'https://example.test/logo.png'],
    ['a script URL', 'javascript:alert(1)'],
    ['another API path', '/api/me'],
    ['a data URL', 'data:image/png;base64,AAAA'],
  ])('never shows or caches a server logo URL from %s', async (_name, logoUrl) => {
    stubApi(admin, ({ url }) =>
      url === '/api/branding'
        ? Response.json({ primary: '#1d6b5f', secondary: null, logoUrl, version: 2 })
        : undefined,
    );
    renderBranded('/viewing');
    await waitFor(() => {
      expect(html().getPropertyValue('--accent')).toContain('#1d6b5f');
    });
    expect(screen.queryByRole('img', { name: 'Company logo' })).toBeNull();
    expect(document.querySelector(`img[src="${logoUrl}"]`)).toBeNull();
    // The colours come from their own request: the header may come after them.
    const home = await screen.findByRole('link', { name: 'SimpleArchitecture home' });
    expect(home.querySelector('svg')).not.toBeNull();
    expect(readBrandingCache()?.logoUrl).toBeNull();
  });

  it('only writes #rrggbb pairs to <html>', () => {
    applyBrandValues({
      light: { accent: '#1d6b5f', brandLine: 'url(x)', accentSoft: '#FFFFFF' },
      dark: { accent: '#2f9f8e', brandLine: '#e0892b', accentSoft: '#ffffff' },
    });
    expect(html().getPropertyValue('--accent')).toBe('light-dark(#1d6b5f, #2f9f8e)');
    expect(html().getPropertyValue('--brand-line')).toBe('');
    expect(html().getPropertyValue('--accent-soft')).toBe('');
    applyBrandValues(null);
    expect(html().length).toBe(0);
  });
});

describe('the branding cache', () => {
  const good = {
    v: 1,
    version: 4,
    logoUrl: '/api/branding/logo?v=4',
    logoRatio: 4,
    light: {
      accent: '#1d6b5f',
      accentSoft: '#daf6ef',
      selectSoft: '#feebdb',
      brandLine: '#d6801d',
    },
    dark: { accent: '#529b8e', accentSoft: '#002e27', selectSoft: '#3b1f01', brandLine: '#e0892b' },
  };
  const bad: [string, unknown][] = [
    ['an invalid colour', { ...good, light: { ...good.light, accent: 'red' } }],
    ['an upper-case colour', { ...good, dark: { ...good.dark, accent: '#ABCDEF' } }],
    ['CSS text', { ...good, light: { ...good.light, brandLine: '#000000; color: red' } }],
    ['a colour that is an array', { ...good, light: { ...good.light, accent: ['#000000'] } }],
    ['another logo URL', { ...good, logoUrl: 'https://example.test/logo.png' }],
    ['a script URL', { ...good, logoUrl: 'javascript:alert(1)' }],
    ['an unknown cache version', { ...good, v: 2 }],
    ['no theme values', { ...good, dark: null }],
  ];

  // public/theme-init.js runs before the app, as a blocking script in <head>.
  const script = readFileSync(join(import.meta.dirname, '../public/theme-init.js'), 'utf8');
  const runThemeInit = () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the shipped file as is
    const run = new Function(script) as () => void;
    run();
  };

  it('theme-init.js applies only a saved Dark, and Light is the default whatever the OS prefers', () => {
    for (const saved of ['light', 'system', 'other']) {
      localStorage.setItem('sa-theme', saved);
      runThemeInit();
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    }
    localStorage.setItem('sa-theme', 'dark');
    runThemeInit();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    const frontend = join(import.meta.dirname, '..');
    const tokens = readFileSync(join(frontend, 'src/styles/tokens.css'), 'utf8');
    expect(tokens).toMatch(/:root \{\s+color-scheme: light;/);
    const page = readFileSync(join(frontend, 'index.html'), 'utf8');
    expect(page).toContain('<meta name="color-scheme" content="light" />');
  });

  it('theme-init.js applies a good cache before first paint', () => {
    localStorage.setItem('sa-branding', JSON.stringify(good));
    runThemeInit();
    expect(html().getPropertyValue('--accent')).toBe('light-dark(#1d6b5f, #529b8e)');
    expect(html().getPropertyValue('--brand-line')).toBe('light-dark(#d6801d, #e0892b)');
    expect(html().length).toBe(4);
    expect(readBrandingCache()).toEqual(good);
  });

  it.each(bad)('ignores the whole cache with %s', (_, cache) => {
    localStorage.setItem('sa-branding', JSON.stringify(cache));
    runThemeInit();
    expect(html().length).toBe(0);
    expect(readBrandingCache()).toBeNull();
  });

  it('ignores a cache that is not JSON, and blocked storage', () => {
    localStorage.setItem('sa-branding', '{not json');
    runThemeInit();
    expect(html().length).toBe(0);
    expect(readBrandingCache()).toBeNull();
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(runThemeInit).not.toThrow();
    expect(readBrandingCache()).toBeNull();
    getItem.mockRestore();
  });
});

describe('Admin → Branding', () => {
  const primaryField = () => screen.getByRole('textbox', { name: 'Primary colour' });
  const secondaryField = () => screen.getByRole('textbox', { name: 'Secondary colour' });
  const saveButton = () => screen.getByRole('button', { name: 'Save' });
  const dropArea = () => screen.getByRole('button', { name: /choose a file/ });
  const fileInput = () => screen.getByLabelText<HTMLInputElement>('Logo file');
  const table = () => screen.getByRole('table', { name: 'Contrast' });
  const pick = (file: File) => {
    fireEvent.change(fileInput(), { target: { files: [file] } });
  };

  async function openPage(server: Server, me = admin) {
    const fetchMock = stubApi(me, server.handler);
    renderBranded('/admin/branding');
    await screen.findByRole('heading', { name: 'Branding', level: 1 });
    return fetchMock;
  }

  it('is the third Admin page and shows what is saved', async () => {
    const server = brandingServer(sample);
    await openPage(server);
    const nav = screen.getByRole('navigation', { name: 'Admin pages' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Models',
      'Database',
      'Branding',
      'Connected apps',
    ]);
    expect(links[2]?.getAttribute('aria-current')).toBe('page');

    await waitFor(() => {
      expect(primaryField()).toHaveProperty('value', '#1d6b5f');
    });
    expect(secondaryField()).toHaveProperty('value', '#e0892b');
    expect(screen.getByRole('img', { name: 'Current logo' }).getAttribute('src')).toBe(
      '/api/branding/logo?v=3',
    );
    expect(saveButton()).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Discard changes' })).toHaveProperty(
      'disabled',
      true,
    );
    // The dark theme lifts the dark teal; the light theme darkens the orange line.
    expect(
      screen.getByText(/^Dark theme uses #[0-9a-f]{6}, so it keeps 4\.5:1 contrast\.$/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /^Light theme uses #[0-9a-f]{6} for the header line, so it keeps 3:1 contrast\.$/,
      ),
    ).toBeTruthy();
    expect(within(table()).getAllByText('Adjusted from #1d6b5f')).toHaveLength(1);
    // The previews are a picture: nothing in them can be focused.
    for (const figure of document.querySelectorAll('figure.pv')) {
      expect(figure.querySelector('[inert]')).not.toBeNull();
    }
    await expectNoSeriousAxeViolations();
  });

  it.each([
    ['Modeller', modeller],
    ['Viewer', viewer],
  ])('is Admin only: a %s gets No access', async (_, me) => {
    const fetchMock = stubApi(me, brandingServer(sample).handler);
    renderBranded('/admin/branding');
    await screen.findByRole('heading', { name: "You don't have access to Admin" });
    expect(screen.queryByRole('textbox', { name: 'Primary colour' })).toBeNull();
    expect(requests(fetchMock)).not.toContain('GET /api/admin/database');
  });

  it('says branding needs a database, with a link to Admin → Database', async () => {
    await openPage(brandingServer(neutral, false));
    await screen.findByText('Branding needs a database.');
    const link = screen.getByRole('link', { name: 'Admin → Database' });
    expect(link.getAttribute('href')).toBe('/admin/database');
    expect(screen.queryByRole('textbox', { name: 'Primary colour' })).toBeNull();
    expect(screen.queryByRole('figure')).toBeNull();
  });

  it('shows a load error with Try again', async () => {
    let fail = true;
    const server = brandingServer(neutral);
    stubApi(admin, (request) =>
      request.url === '/api/admin/database' && fail
        ? apiError(500, 'Something went wrong')
        : server.handler(request),
    );
    renderBranded('/admin/branding');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("The branding couldn't be loaded.");
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('textbox', { name: 'Primary colour' });
  });

  it('picks and types colours: picker, hex field, previews and table follow at once', async () => {
    await openPage(brandingServer(neutral));
    await screen.findByRole('textbox', { name: 'Primary colour' });
    expect(screen.queryByRole('button', { name: 'Reset to the neutral look' })).toHaveProperty(
      'disabled',
      true,
    );
    const picker = screen.getByLabelText<HTMLInputElement>('Pick primary colour');
    expect(picker.value).toBe('#3657d6');
    fireEvent.change(picker, { target: { value: '#F2C200' } });
    expect(primaryField()).toHaveProperty('value', '#f2c200');
    expect(saveButton()).toHaveProperty('disabled', false);
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    // A yellow primary is darkened for the light theme.
    expect(
      screen.getByText(/^Light theme uses #[0-9a-f]{6}, so it keeps 4\.5:1 contrast\.$/),
    ).toBeTruthy();
    expect(within(table()).getByText('Adjusted from #f2c200')).toBeTruthy();
    const light = document.querySelector<HTMLElement>('figure.pv.light');
    expect(light?.style.getPropertyValue('--accent')).toMatch(/^#[0-9a-f]{6}$/);
    expect(light?.style.getPropertyValue('--accent')).not.toBe('#f2c200');
    expect(
      document.querySelector<HTMLElement>('figure.pv.dark')?.style.getPropertyValue('--accent'),
    ).toBe('#f2c200');

    // Typing: an unfinished value keeps the last valid one in the preview; blur tidies.
    fireEvent.change(secondaryField(), { target: { value: '1B2A4' } });
    expect(light?.style.getPropertyValue('--brand-line')).toBe('transparent');
    fireEvent.change(secondaryField(), { target: { value: '1B2A4A' } });
    expect(screen.getByLabelText<HTMLInputElement>('Pick secondary colour').value).toBe('#1b2a4a');
    expect(light?.style.getPropertyValue('--brand-line')).toBe('#1b2a4a');
    fireEvent.blur(secondaryField());
    expect(secondaryField()).toHaveProperty('value', '#1b2a4a');

    // An invalid value shows its error on blur, tied to the field.
    fireEvent.change(primaryField(), { target: { value: 'teal' } });
    fireEvent.blur(primaryField());
    expect(primaryField().getAttribute('aria-invalid')).toBe('true');
    const error = screen.getByText('Enter a colour as # and six hex digits, for example #1d6b5f.');
    expect(primaryField().getAttribute('aria-describedby')).toContain(
      error.parentElement?.id ?? 'x',
    );

    // Clear empties the field and returns focus to it.
    fireEvent.click(screen.getByRole('button', { name: 'Clear primary colour' }));
    expect(primaryField()).toHaveProperty('value', '');
    expect(document.activeElement).toBe(primaryField());
  });

  it('saves the colours first, then the logo, and updates the app at once', async () => {
    const server = brandingServer(neutral);
    await openPage(server);
    await screen.findByRole('textbox', { name: 'Primary colour' });
    fireEvent.change(primaryField(), { target: { value: '#1d6b5f' } });
    fireEvent.change(secondaryField(), { target: { value: '#e0892b' } });
    pick(pngFile());
    await screen.findByText('example-logo.png');
    expect(screen.getByText('18 KB · 512 × 128 px')).toBeTruthy();
    expect(screen.getByText('Not saved yet')).toBeTruthy();
    expect(
      screen.getByRole('img', { name: 'New logo, not saved yet' }).getAttribute('src'),
    ).toMatch(/^data:image\/png;base64,/);
    expect(screen.getByText('Logo ready. Save to apply it.')).toBeTruthy();

    fireEvent.click(saveButton());
    await screen.findByText('Saved');
    expect(server.writes).toEqual([
      'PUT /api/admin/branding',
      'PUT /api/admin/branding/logo?version=1',
    ]);
    expect(
      screen.getByText('Branding saved. Everyone sees it on their next page load.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Branding', level: 1 }),
      );
    });
    // The app's own header, tokens and cache show it.
    const header = screen.getByRole('link', { name: 'SimpleArchitecture home' });
    expect(within(header).getByRole('img', { name: 'Company logo' }).getAttribute('src')).toBe(
      '/api/branding/logo?v=2',
    );
    expect(html().getPropertyValue('--accent')).toContain('#1d6b5f');
    expect(readBrandingCache()?.logoRatio).toBe(4);
    expect(saveButton()).toHaveProperty('disabled', true);
  });

  it('shows "Saved" for 3 seconds', async () => {
    const server = brandingServer(neutral);
    await openPage(server);
    await screen.findByRole('textbox', { name: 'Primary colour' });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fireEvent.change(primaryField(), { target: { value: '#1d6b5f' } });
      fireEvent.click(saveButton());
      await screen.findByText('Saved');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      expect(screen.queryByText('Saved')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [
      'a wrong type',
      pngFile('logo.svg', 200, 'image/svg+xml'),
      "This file isn't a PNG, JPEG or WebP image. SVG isn't accepted.",
    ],
    [
      'a file over 300 KB',
      pngFile('big.png', 412 * 1024),
      'This file is 412 KB. The largest logo is 300 KB.',
    ],
    [
      'one byte over the cap',
      pngFile('edge.png', maxLogoBytes + 1),
      'This file is 301 KB. The largest logo is 300 KB.',
    ],
  ])('refuses %s in the browser and sends nothing', async (_, file, message) => {
    const server = brandingServer(neutral);
    await openPage(server);
    await screen.findByRole('textbox', { name: 'Primary colour' });
    pick(file);
    await screen.findByText(message);
    expect(dropArea().getAttribute('aria-describedby')).toContain('logo-error');
    // Focus moves in an effect, which may run just after the text shows.
    await waitFor(() => {
      expect(document.activeElement).toBe(dropArea());
    });
    expect(screen.queryByText('Not saved yet')).toBeNull();
    expect(saveButton()).toHaveProperty('disabled', true);
    expect(server.writes).toEqual([]);
  });

  it('refuses a picture over 1024 × 1024 px and one that is not an image', async () => {
    const server = brandingServer(neutral);
    await openPage(server);
    await screen.findByRole('textbox', { name: 'Primary colour' });
    vi.mocked(imageSize).mockResolvedValueOnce({ width: 2000, height: 1500 });
    pick(pngFile());
    await screen.findByText('This image is 2000 × 1500 px. The largest is 1024 × 1024 px.');
    vi.mocked(imageSize).mockRejectedValueOnce(new Error('not an image'));
    pick(pngFile());
    await screen.findByText("This file couldn't be read as an image.");
    expect(server.writes).toEqual([]);
  });

  it('opens the file chooser from the drop area and accepts a dropped file', async () => {
    await openPage(brandingServer(neutral));
    await screen.findByRole('textbox', { name: 'Primary colour' });
    const click = vi.spyOn(fileInput(), 'click');
    fireEvent.click(dropArea());
    expect(click).toHaveBeenCalled();
    expect(fileInput().accept).toBe('image/png,image/jpeg,image/webp');
    fireEvent.drop(dropArea(), {
      dataTransfer: { files: [pngFile('dropped.png'), pngFile('second.png')] },
    });
    await screen.findByText('dropped.png');
    expect(screen.queryByText('second.png')).toBeNull();
  });

  it.each([
    [413, 'The logo must be at most 300 KB.'],
    [415, 'The logo must be a PNG, JPEG or WebP image.'],
    [422, 'The logo is larger than 1024 × 1024 pixels.'],
  ])(
    'a %s on the logo shows at the drop area; the saved colours are said',
    async (status, message) => {
      const server = brandingServer(neutral);
      await openPage(server);
      await screen.findByRole('textbox', { name: 'Primary colour' });
      fireEvent.change(primaryField(), { target: { value: '#1d6b5f' } });
      pick(pngFile());
      await screen.findByText('example-logo.png');
      server.failNext = (url) =>
        url.includes('/logo')
          ? apiError(
              status,
              message,
              status === 422 ? { fields: [{ field: 'logo', message }] } : {},
            )
          : undefined;
      fireEvent.click(saveButton());
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain("The colours were saved; the logo wasn't.");
      expect(screen.getAllByText(message).length).toBeGreaterThanOrEqual(1);
      await waitFor(() => {
        expect(document.activeElement).toBe(dropArea());
      });
      // The colours are saved now; Save retries only the logo, with the new version.
      expect(primaryField()).toHaveProperty('value', '#1d6b5f');
      expect(screen.getByText('Not saved yet')).toBeTruthy();
      fireEvent.click(saveButton());
      await screen.findByText('Saved');
      expect(server.writes).toEqual([
        'PUT /api/admin/branding',
        'PUT /api/admin/branding/logo?version=1',
        'PUT /api/admin/branding/logo?version=1',
      ]);
    },
  );

  it('a 422 on a colour shows at that field with focus on it', async () => {
    const server = brandingServer(neutral);
    await openPage(server);
    await screen.findByRole('textbox', { name: 'Primary colour' });
    fireEvent.change(secondaryField(), { target: { value: '#e0892b' } });
    server.failNext = () =>
      apiError(422, 'The branding was not saved.', {
        fields: [{ field: 'secondary', message: 'Made-up server message for the colour.' }],
      });
    fireEvent.click(saveButton());
    await screen.findByText('Made-up server message for the colour.');
    expect(secondaryField().getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => {
      expect(document.activeElement).toBe(secondaryField());
    });
  });

  it('a 409 shows the conflict with Reload and sends nothing more', async () => {
    const server = brandingServer(sample);
    await openPage(server);
    await waitFor(() => {
      expect(primaryField()).toHaveProperty('value', '#1d6b5f');
    });
    fireEvent.change(primaryField(), { target: { value: '#000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove logo' }));
    expect(document.activeElement).toBe(dropArea());
    expect(screen.getByText('Logo removed. Save to apply it.')).toBeTruthy();
    server.failNext = () => apiError(409, 'Changed', { currentVersion: 9 });
    fireEvent.click(saveButton());
    await screen.findByText('Someone else changed the branding');
    expect(server.writes).toEqual(['PUT /api/admin/branding']);
    expect(saveButton()).toHaveProperty('disabled', true);
    server.state = { ...sample, primary: '#1b2a4a', version: 9 };
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => {
      expect(primaryField()).toHaveProperty('value', '#1b2a4a');
    });
    expect(screen.queryByText('Someone else changed the branding')).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Branding', level: 1 }),
      );
    });
  });

  it('a network failure keeps the draft and says so', async () => {
    const server = brandingServer(neutral);
    await openPage(server);
    await screen.findByRole('textbox', { name: 'Primary colour' });
    fireEvent.change(primaryField(), { target: { value: '#1d6b5f' } });
    server.failNext = () => apiError(403, 'Made-up refusal.');
    fireEvent.click(saveButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("The branding wasn't saved.");
    expect(alert.textContent).toContain('Made-up refusal.');
    expect(primaryField()).toHaveProperty('value', '#1d6b5f');
  });

  it('a 501 on save switches to "Branding needs a database."', async () => {
    const server = brandingServer(neutral);
    await openPage(server);
    await screen.findByRole('textbox', { name: 'Primary colour' });
    fireEvent.change(primaryField(), { target: { value: '#1d6b5f' } });
    server.failNext = () => apiError(501, 'Branding needs a database.');
    fireEvent.click(saveButton());
    await screen.findByText(/This server keeps models in files/);
    expect(screen.queryByRole('textbox', { name: 'Primary colour' })).toBeNull();
  });

  it('Discard changes brings back what is saved', async () => {
    await openPage(brandingServer(sample));
    await waitFor(() => {
      expect(primaryField()).toHaveProperty('value', '#1d6b5f');
    });
    fireEvent.change(primaryField(), { target: { value: '#000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove logo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(primaryField()).toHaveProperty('value', '#1d6b5f');
    expect(screen.getByRole('img', { name: 'Current logo' })).toBeTruthy();
    expect(screen.getByText('Changes discarded.')).toBeTruthy();
    expect(saveButton()).toHaveProperty('disabled', true);
  });

  it('Reset asks first, then makes everything neutral at once', async () => {
    const server = brandingServer(sample);
    await openPage(server);
    await waitFor(() => {
      expect(primaryField()).toHaveProperty('value', '#1d6b5f');
    });
    await waitFor(() => {
      expect(html().getPropertyValue('--accent')).toContain('#1d6b5f');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset to the neutral look' }));
    const dialog = screen.getByRole('dialog', { name: 'Reset to the neutral look?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(server.writes).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Reset to the neutral look' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Reset to the neutral look?' })).getByRole(
        'button',
        {
          name: 'Reset',
        },
      ),
    );
    await screen.findByText('Branding reset to the neutral look.');
    expect(server.writes).toEqual(['DELETE /api/admin/branding?version=3']);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(primaryField()).toHaveProperty('value', '');
    expect(html().length).toBe(0);
    expect(localStorage.getItem('sa-branding')).toBeNull();
    expect(screen.queryByRole('img', { name: 'Company logo' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reset to the neutral look' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('Reset with a 409 offers Reload in the dialog', async () => {
    const server = brandingServer(sample);
    await openPage(server);
    await waitFor(() => {
      expect(primaryField()).toHaveProperty('value', '#1d6b5f');
    });
    fireEvent.change(primaryField(), { target: { value: '#000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset to the neutral look' }));
    const dialog = screen.getByRole('dialog', { name: 'Reset to the neutral look?' });
    expect(dialog.textContent).toContain('Your unsaved changes are discarded too.');
    server.failNext = () => apiError(409, 'Changed', { currentVersion: 7 });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset' }));
    await within(dialog).findByRole('button', { name: 'Reload' });
    expect(within(dialog).queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('asks before leaving with unsaved changes', async () => {
    await openPage(brandingServer(neutral));
    await screen.findByRole('textbox', { name: 'Primary colour' });
    fireEvent.change(primaryField(), { target: { value: '#1d6b5f' } });
    fireEvent.click(screen.getByRole('link', { name: 'Database' }));
    const dialog = screen.getByRole('dialog', { name: 'Save changes to the branding?' });
    expect(dialog.textContent).toContain("You've changed the branding.");
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Keep editing' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await screen.findByRole('heading', { name: 'Database', level: 1 });
  });
});
