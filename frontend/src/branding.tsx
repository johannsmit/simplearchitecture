import {
  brandTokens,
  defaultProductTitle,
  isHexColour,
  validProductTitle,
  type Branding,
  type BrandTokens,
} from '@simplearchitecture/shared';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiRequestError, getBranding } from './api';
import { readPref, writePref } from './prefs';

/**
 * The organisation's branding in the app: the four colour tokens on <html>, the product title
 * (header, signed-out page, browser tab), the logos for the header and the signed-out page, the
 * app icon (tab and home screen), and the cache that public/theme-init.js reads before first
 * paint. The server's answer always wins.
 */

/** The four tokens the brand drives; the rest of tokens.css never changes. */
const tokenProperties = {
  accent: '--accent',
  accentSoft: '--accent-soft',
  selectSoft: '--select-soft',
  brandLine: '--brand-line',
} as const;
type TokenName = keyof typeof tokenProperties;
const tokenNames = Object.keys(tokenProperties) as TokenName[];

/** Only the image routes, with their version: nothing else is ever used as an image source. */
const logoUrlPattern = /^\/api\/branding\/logo\?v=\d{1,15}$/;
const darkLogoUrlPattern = /^\/api\/branding\/dark-logo\?v=\d{1,15}$/;
const iconUrlPattern = /^\/api\/branding\/icon\?v=\d{1,15}$/;

export function isLogoUrl(value: unknown): value is string {
  return typeof value === 'string' && logoUrlPattern.test(value);
}

export function isDarkLogoUrl(value: unknown): value is string {
  return typeof value === 'string' && darkLogoUrlPattern.test(value);
}

export function isIconUrl(value: unknown): value is string {
  return typeof value === 'string' && iconUrlPattern.test(value);
}

/** The built-in tab and home-screen icons (frontend/public), as index.html links them. */
const builtInIcon = { href: '/icon.svg', type: 'image/svg+xml' };
const builtInTouchIcon = '/pwa-192x192.png';

const isRatio = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1000;

type ThemeValues = Partial<Record<TokenName, string>>;

/**
 * The cache (localStorage `sa-branding`): the worked-out values, never anything private. The
 * title, Dark theme logo and icon came later: a cache without them reads as none set.
 */
export interface BrandingCache {
  v: 1;
  version: number;
  title: string | null;
  logoUrl: string | null;
  logoRatio: number | null;
  darkLogoUrl: string | null;
  darkLogoRatio: number | null;
  iconUrl: string | null;
  light: ThemeValues;
  dark: ThemeValues;
}

// public/theme-init.js reads the same key ("sa-" + "branding") and checks the same rules.
const cacheKey = 'branding';

function themeValues(value: unknown): ThemeValues | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const values: ThemeValues = {};
  for (const name of tokenNames) {
    const colour = (value as Record<string, unknown>)[name];
    if (colour === undefined || colour === null) continue;
    if (!isHexColour(colour)) return undefined;
    values[name] = colour;
  }
  return values;
}

/** The cache, or null when it's missing or anything in it fails the checks (all or nothing). */
export function readBrandingCache(): BrandingCache | null {
  const text = readPref(cacheKey);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const cache = parsed as Record<string, unknown>;
  const light = themeValues(cache.light);
  const dark = themeValues(cache.dark);
  // Missing (an older cache) is none; anything else must pass the same rules as the server's.
  const optional = <T,>(value: unknown, check: (value: unknown) => value is T) =>
    value === undefined || value === null || check(value);
  const isTitle = (value: unknown): value is string => validProductTitle(value) !== null;
  if (
    cache.v !== 1 ||
    typeof cache.version !== 'number' ||
    !(cache.logoUrl === null || isLogoUrl(cache.logoUrl)) ||
    !(cache.logoRatio === null || isRatio(cache.logoRatio)) ||
    !optional(cache.title, isTitle) ||
    !optional(cache.darkLogoUrl, isDarkLogoUrl) ||
    !optional(cache.darkLogoRatio, isRatio) ||
    !optional(cache.iconUrl, isIconUrl) ||
    !light ||
    !dark
  ) {
    return null;
  }
  return {
    v: 1,
    version: cache.version,
    title: isTitle(cache.title) ? cache.title : null,
    logoUrl: cache.logoUrl,
    logoRatio: cache.logoRatio,
    darkLogoUrl: isDarkLogoUrl(cache.darkLogoUrl) ? cache.darkLogoUrl : null,
    darkLogoRatio: isRatio(cache.darkLogoRatio) ? cache.darkLogoRatio : null,
    iconUrl: isIconUrl(cache.iconUrl) ? cache.iconUrl : null,
    light,
    dark,
  };
}

function writeBrandingCache(cache: BrandingCache | null): void {
  writePref(cacheKey, cache === null ? null : JSON.stringify(cache));
}

/** The values to set: only for the colours that are set; the rest stay as in tokens.css. */
function setValues(tokens: BrandTokens): Pick<BrandingCache, 'light' | 'dark'> {
  const pick = (theme: 'light' | 'dark'): ThemeValues => {
    const values = tokens[theme];
    return {
      ...(tokens.primary ? { accent: values.accent, accentSoft: values.accentSoft } : {}),
      ...(tokens.secondary && values.brandLine
        ? { selectSoft: values.selectSoft, brandLine: values.brandLine }
        : {}),
    };
  };
  return { light: pick('light'), dark: pick('dark') };
}

/**
 * Sets the tokens on <html> as `light-dark(#light, #dark)`, or removes them. Only
 * `#rrggbb` values are ever written; a pair with anything else is removed instead.
 */
export function applyBrandValues(values: Pick<BrandingCache, 'light' | 'dark'> | null): void {
  const style = document.documentElement.style;
  for (const name of tokenNames) {
    const light = values?.light[name];
    const dark = values?.dark[name];
    if (isHexColour(light) && isHexColour(dark)) {
      style.setProperty(tokenProperties[name], `light-dark(${light}, ${dark})`);
    } else {
      style.removeProperty(tokenProperties[name]);
    }
  }
}

const isNeutral = (branding: Branding): boolean =>
  branding.title === null &&
  branding.primary === null &&
  branding.secondary === null &&
  branding.logoUrl === null &&
  branding.darkLogoUrl === null &&
  branding.iconUrl === null;

function headLink(rel: string): HTMLLinkElement {
  const found = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (found) return found;
  const link = document.createElement('link');
  link.rel = rel;
  document.head.append(link);
  return link;
}

/**
 * Points the tab icon and the home-screen icon at the app icon, or back at the built-in ones.
 * Only ever the versioned icon route or a built-in file.
 */
export function applyIcon(iconUrl: string | null): void {
  const custom = isIconUrl(iconUrl) ? iconUrl : null;
  const icon = headLink('icon');
  icon.href = custom ?? builtInIcon.href;
  icon.type = custom === null ? builtInIcon.type : 'image/png';
  headLink('apple-touch-icon').href = custom ?? builtInTouchIcon;
}

export interface BrandLogo {
  url: string;
  /** Width / height, when known (set on the <img> before it loads, so nothing shifts). */
  ratio: number | null;
}

/** Shapes of new images, when the page that saved them knows them. */
export interface LogoRatios {
  logo?: number | null | undefined;
  darkLogo?: number | null | undefined;
}

interface BrandingContextValue {
  /** What the server last said (null until it answers, or when it couldn't be read). */
  branding: Branding | null;
  /** The product title: the organisation's, or SimpleArchitecture. Plain text. */
  title: string;
  logo: BrandLogo | null;
  /** The logo for the Dark theme (without it, the Dark theme shows `logo`). */
  darkLogo: BrandLogo | null;
  /** Applies new branding at once and rewrites the cache (after a save on Admin → Branding). */
  update: (branding: Branding, ratios?: LogoRatios) => void;
  /** A logo loaded: remembers its shape for the next first paint. */
  logoLoaded: (url: string, ratio: number) => void;
}

const BrandingContext = createContext<BrandingContextValue>({
  branding: null,
  title: defaultProductTitle,
  logo: null,
  darkLogo: null,
  update: () => {},
  logoLoaded: () => {},
});

export function useBranding(): BrandingContextValue {
  return use(BrandingContext);
}

/**
 * Sets the browser tab to `<page><separator><product title>`, or the product title alone, and
 * back to the product title when the page goes.
 */
export function usePageTitle(page: string | null | undefined, separator = ' – '): void {
  const { title } = useBranding();
  useEffect(() => {
    document.title = page ? `${page}${separator}${title}` : title;
    return () => {
      document.title = title;
    };
  }, [page, separator, title]);
}

interface State {
  branding: Branding | null;
  title: string | null;
  logo: BrandLogo | null;
  darkLogo: BrandLogo | null;
}

function initialState(): State {
  const cache = readBrandingCache();
  return {
    branding: null,
    title: cache?.title ?? null,
    logo: cache?.logoUrl ? { url: cache.logoUrl, ratio: cache.logoRatio } : null,
    darkLogo: cache?.darkLogoUrl ? { url: cache.darkLogoUrl, ratio: cache.darkLogoRatio } : null,
  };
}

const neutralState: State = { branding: null, title: null, logo: null, darkLogo: null };

/** The ratio to keep for an image: the one given, else the cached one for the same URL. */
function keptRatio(
  url: string | null,
  given: number | null | undefined,
  cachedUrl: string | null | undefined,
  cachedRatio: number | null | undefined,
): number | null {
  if (url === null) return null;
  if (isRatio(given)) return given;
  return cachedUrl === url && isRatio(cachedRatio) ? cachedRatio : null;
}

/**
 * Loads `GET /api/branding` on every app start (signed in or out), applies it and rewrites the
 * cache. Wraps the app in main.tsx.
 */
export function BrandingProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(initialState);

  const update = useCallback((branding: Branding, ratios: LogoRatios = {}) => {
    const title = validProductTitle(branding.title);
    const logoUrl = isLogoUrl(branding.logoUrl) ? branding.logoUrl : null;
    const darkLogoUrl = isDarkLogoUrl(branding.darkLogoUrl) ? branding.darkLogoUrl : null;
    const iconUrl = isIconUrl(branding.iconUrl) ? branding.iconUrl : null;
    const cached = readBrandingCache();
    const logoRatio = keptRatio(logoUrl, ratios.logo, cached?.logoUrl, cached?.logoRatio);
    const darkLogoRatio = keptRatio(
      darkLogoUrl,
      ratios.darkLogo,
      cached?.darkLogoUrl,
      cached?.darkLogoRatio,
    );
    const tokens = brandTokens(branding);
    const values = setValues(tokens);
    applyBrandValues(values);
    applyIcon(iconUrl);
    if (isNeutral(branding)) {
      writeBrandingCache(null);
    } else {
      writeBrandingCache({
        v: 1,
        version: branding.version,
        title,
        logoUrl,
        logoRatio,
        darkLogoUrl,
        darkLogoRatio,
        iconUrl,
        ...values,
      });
    }
    setState({
      branding,
      title,
      logo: logoUrl === null ? null : { url: logoUrl, ratio: logoRatio },
      darkLogo: darkLogoUrl === null ? null : { url: darkLogoUrl, ratio: darkLogoRatio },
    });
  }, []);

  const logoLoaded = useCallback((url: string, ratio: number) => {
    if (!isRatio(ratio)) return;
    const cached = readBrandingCache();
    if (cached?.logoUrl === url && cached.logoRatio !== ratio) {
      writeBrandingCache({ ...cached, logoRatio: ratio });
    } else if (cached?.darkLogoUrl === url && cached.darkLogoRatio !== ratio) {
      writeBrandingCache({ ...cached, darkLogoRatio: ratio });
    }
    setState((current) => {
      if (current.logo?.url === url && current.logo.ratio !== ratio) {
        return { ...current, logo: { url, ratio } };
      }
      if (current.darkLogo?.url === url && current.darkLogo.ratio !== ratio) {
        return { ...current, darkLogo: { url, ratio } };
      }
      return current;
    });
  }, []);

  // The tab shows the product title when no page sets its own (theme-init.js set it from the
  // cache before first paint). A page's own title is left alone: it carries the product title.
  const title = state.title ?? defaultProductTitle;
  const shownTitle = useRef(title);
  useEffect(() => {
    if (document.title === shownTitle.current || document.title === defaultProductTitle) {
      document.title = title;
    }
    shownTitle.current = title;
  }, [title]);

  useEffect(() => {
    const controller = new AbortController();
    getBranding(controller.signal)
      .then((branding) => {
        update(branding);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // Unreachable (offline): keep the cached look. A server error: the neutral look.
        if (error instanceof ApiRequestError && error.status === 0) return;
        applyBrandValues(null);
        applyIcon(null);
        writeBrandingCache(null);
        setState(neutralState);
      });
    return () => {
      controller.abort();
    };
  }, [update]);

  const value = useMemo(
    () => ({ ...state, title, update, logoLoaded }),
    [state, title, update, logoLoaded],
  );
  return <BrandingContext value={value}>{children}</BrandingContext>;
}

/** Inline custom properties for a preview that shows one theme's draft tokens. */
export function previewStyle(tokens: BrandTokens, theme: 'light' | 'dark'): Record<string, string> {
  const values = tokens[theme];
  const style: Record<string, string> = {};
  const set = (property: string, colour: string | null) => {
    if (isHexColour(colour)) style[property] = colour;
  };
  set('--accent', values.accent);
  set('--accent-soft', values.accentSoft);
  set('--select-soft', values.selectSoft);
  set('--focus', values.accent);
  set('--edge-lit', values.accent);
  style['--brand-line'] = isHexColour(values.brandLine) ? values.brandLine : 'transparent';
  return style;
}
