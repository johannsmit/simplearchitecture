import {
  brandTokens,
  isHexColour,
  type Branding,
  type BrandTokens,
} from '@simplearchitecture/shared';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiRequestError, getBranding } from './api';
import { readPref, writePref } from './prefs';

/**
 * The organisation's branding in the app: the four colour
 * tokens on <html>, the logo for the header and the signed-out page, and the cache that
 * public/theme-init.js reads before first paint. The server's answer always wins.
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

/** Only the logo route, with its version: nothing else is ever used as an image source. */
const logoUrlPattern = /^\/api\/branding\/logo\?v=\d{1,15}$/;

export function isLogoUrl(value: unknown): value is string {
  return typeof value === 'string' && logoUrlPattern.test(value);
}

const isRatio = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1000;

type ThemeValues = Partial<Record<TokenName, string>>;

/** The cache (localStorage `sa-branding`): the worked-out values, never anything private. */
export interface BrandingCache {
  v: 1;
  version: number;
  logoUrl: string | null;
  logoRatio: number | null;
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
  if (
    cache.v !== 1 ||
    typeof cache.version !== 'number' ||
    !(cache.logoUrl === null || isLogoUrl(cache.logoUrl)) ||
    !(cache.logoRatio === null || isRatio(cache.logoRatio)) ||
    !light ||
    !dark
  ) {
    return null;
  }
  return {
    v: 1,
    version: cache.version,
    logoUrl: cache.logoUrl,
    logoRatio: cache.logoRatio,
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
  branding.primary === null && branding.secondary === null && branding.logoUrl === null;

export interface BrandLogo {
  url: string;
  /** Width / height, when known (set on the <img> before it loads, so nothing shifts). */
  ratio: number | null;
}

interface BrandingContextValue {
  /** What the server last said (null until it answers, or when it couldn't be read). */
  branding: Branding | null;
  logo: BrandLogo | null;
  /** Applies new branding at once and rewrites the cache (after a save on Admin → Branding). */
  update: (branding: Branding, logoRatio?: number | null) => void;
  /** The logo loaded: remembers its shape for the next first paint. */
  logoLoaded: (url: string, ratio: number) => void;
}

const BrandingContext = createContext<BrandingContextValue>({
  branding: null,
  logo: null,
  update: () => {},
  logoLoaded: () => {},
});

export function useBranding(): BrandingContextValue {
  return use(BrandingContext);
}

interface State {
  branding: Branding | null;
  logo: BrandLogo | null;
}

function initialState(): State {
  const cache = readBrandingCache();
  return {
    branding: null,
    logo: cache?.logoUrl ? { url: cache.logoUrl, ratio: cache.logoRatio } : null,
  };
}

/**
 * Loads `GET /api/branding` on every app start (signed in or out), applies it and rewrites the
 * cache. Wraps the app in main.tsx.
 */
export function BrandingProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(initialState);

  const update = useCallback((branding: Branding, logoRatio?: number | null) => {
    const logoUrl = isLogoUrl(branding.logoUrl) ? branding.logoUrl : null;
    const cached = readBrandingCache();
    const ratio =
      logoUrl === null
        ? null
        : isRatio(logoRatio)
          ? logoRatio
          : cached?.logoUrl === logoUrl
            ? cached.logoRatio
            : null;
    const tokens = brandTokens(branding);
    const values = setValues(tokens);
    applyBrandValues(values);
    if (isNeutral(branding)) {
      writeBrandingCache(null);
    } else {
      writeBrandingCache({ v: 1, version: branding.version, logoUrl, logoRatio: ratio, ...values });
    }
    setState({ branding, logo: logoUrl === null ? null : { url: logoUrl, ratio } });
  }, []);

  const logoLoaded = useCallback((url: string, ratio: number) => {
    if (!isRatio(ratio)) return;
    const cached = readBrandingCache();
    if (cached?.logoUrl === url && cached.logoRatio !== ratio) {
      writeBrandingCache({ ...cached, logoRatio: ratio });
    }
    setState((current) =>
      current.logo?.url === url && current.logo.ratio !== ratio
        ? { ...current, logo: { url, ratio } }
        : current,
    );
  }, []);

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
        writeBrandingCache(null);
        setState({ branding: null, logo: null });
      });
    return () => {
      controller.abort();
    };
  }, [update]);

  const value = useMemo(() => ({ ...state, update, logoLoaded }), [state, update, logoLoaded]);
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
