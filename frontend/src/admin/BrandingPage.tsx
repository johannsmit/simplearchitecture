import {
  brandingConflictMessage,
  brandTokens,
  defaultProductTitle,
  maxProductTitleLength,
  productTitleIssue,
  productTitleLength,
  type ApiError,
  type Branding,
} from '@simplearchitecture/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router';
import {
  ApiRequestError,
  getBranding,
  removeBrandingImage,
  resetBranding,
  saveBrandingColours,
  saveBrandingTitle,
  uploadBrandingImage,
  type BrandingImage,
} from '../api';
import { isDarkLogoUrl, isIconUrl, isLogoUrl, useBranding } from '../branding';
import { Icon } from '../icons';
import { Modal, UnsavedDialog } from '../modelling/dialogs';
import { AdminNav } from './AdminNav';
import { BrandingPreview } from './branding/BrandingPreview';
import { adjustedText, ColourField, hexMessage, parseHex } from './branding/ColourField';
import { ImageField, type ImageFieldWords } from './branding/ImageField';
import {
  checkLogoFile,
  darkLogoRules,
  iconRules,
  logoRules,
  type ImageRules,
  type PickedLogo,
} from './branding/logo-file';

/** Admin → Branding: the product title, the logos, the app icon and the two colours. */

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; saved: Branding };

/** A draft image: unchanged (what's saved), removed, or a new file. */
type DraftImage = { kind: 'saved' } | { kind: 'none' } | { kind: 'new'; logo: PickedLogo };

type Slot = 'logo' | 'darkLogo' | 'icon';
const slotNames: readonly Slot[] = ['logo', 'darkLogo', 'icon'];

interface Draft {
  title: string;
  primary: string;
  secondary: string;
  logo: DraftImage;
  darkLogo: DraftImage;
  icon: DraftImage;
}

type Field = 'title' | 'primary' | 'secondary' | Slot;
type Errors = Partial<Record<Field, string | undefined>>;
type Focus = 'h1' | Field;

/** One step of a save, in order. */
type Stage = 'colours' | 'title' | Slot;

interface ResetState {
  busy: boolean;
  error: string | null;
  /** 409: the danger button becomes Reload. */
  stale: boolean;
}

interface SlotSetup {
  path: BrandingImage;
  /** Ids in the page (the logo's are as they always were). */
  id: string;
  rules: ImageRules;
  accept: string;
  /** In the save messages: "the logo wasn't". */
  noun: string;
  words: ImageFieldWords;
  ready: string;
  removed: string;
  savedUrl: (branding: Branding) => string | null;
}

const slots: Record<Slot, SlotSetup> = {
  logo: {
    path: 'logo',
    id: 'logo',
    rules: logoRules,
    accept: 'image/png,image/jpeg,image/webp',
    noun: 'logo',
    words: {
      file: 'Logo file',
      remove: 'Remove logo',
      current: 'Current logo',
      picked: 'New logo, not saved yet',
    },
    ready: 'Logo ready. Save to apply it.',
    removed: 'Logo removed. Save to apply it.',
    savedUrl: (branding) => (isLogoUrl(branding.logoUrl) ? branding.logoUrl : null),
  },
  darkLogo: {
    path: 'dark-logo',
    id: 'dark-logo',
    rules: darkLogoRules,
    accept: 'image/png,image/jpeg,image/webp',
    noun: 'Dark theme logo',
    words: {
      file: 'Dark theme logo file',
      remove: 'Remove Dark theme logo',
      current: 'Current Dark theme logo',
      picked: 'New Dark theme logo, not saved yet',
    },
    ready: 'Dark theme logo ready. Save to apply it.',
    removed: 'Dark theme logo removed. Save to apply it.',
    savedUrl: (branding) => (isDarkLogoUrl(branding.darkLogoUrl) ? branding.darkLogoUrl : null),
  },
  icon: {
    path: 'icon',
    id: 'icon',
    rules: iconRules,
    accept: 'image/png',
    noun: 'app icon',
    words: {
      file: 'App icon file',
      remove: 'Remove app icon',
      current: 'Current app icon',
      picked: 'New app icon, not saved yet',
    },
    ready: 'App icon ready. Save to apply it.',
    removed: 'App icon removed. Save to apply it.',
    savedUrl: (branding) => (isIconUrl(branding.iconUrl) ? branding.iconUrl : null),
  },
};

const builtInIcon = '/icon.svg';

const draftOf = (saved: Branding): Draft => ({
  title: saved.title ?? '',
  primary: saved.primary ?? '',
  secondary: saved.secondary ?? '',
  logo: { kind: 'saved' },
  darkLogo: { kind: 'saved' },
  icon: { kind: 'saved' },
});

const announcements = {
  saved: 'Branding saved. Everyone sees it on their next page load.',
  discarded: 'Changes discarded.',
  reset: 'Branding reset to the neutral look.',
};

const offline = 'Check your connection and try again.';

const stageNouns: Record<Stage, string> = {
  colours: 'colours',
  title: 'product title',
  logo: slots.logo.noun,
  darkLogo: slots.darkLogo.noun,
  icon: slots.icon.noun,
};

/** "The colours were saved; the logo wasn't." and the like, or the plain failure. */
function failureTitle(stage: Stage, saved: readonly Stage[]): string {
  const failed = stageNouns[stage];
  if (saved.length === 0) return "The branding wasn't saved.";
  if (saved.length > 1) return `Some changes were saved; the ${failed} wasn't.`;
  // The colours are always saved first, so they never come after another stage.
  const [only = 'colours'] = saved;
  const what = only === 'colours' ? 'The colours were' : `The ${stageNouns[only]} was`;
  return `${what} saved; the ${failed} wasn't.`;
}

/** The title as it would be stored: trimmed, null when empty. */
const storedTitle = (text: string): string | null => {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
};

function serverMessage(error: ApiRequestError): string | undefined {
  const body = error.body as Partial<ApiError> | undefined;
  return typeof body?.message === 'string' && body.message !== '' ? body.message : undefined;
}

/** A 422's field messages (`fields: [{ field, message }]`). */
function fieldIssues(error: ApiRequestError): { field: string; message: string }[] {
  const fields = (error.body as { fields?: unknown } | undefined)?.fields;
  if (!Array.isArray(fields)) return [];
  return fields.filter(
    (issue): issue is { field: string; message: string } =>
      typeof (issue as { field?: unknown } | null)?.field === 'string' &&
      typeof (issue as { message?: unknown }).message === 'string',
  );
}

export function BrandingPage() {
  const { update: updateApp } = useBranding();
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [draft, setDraft] = useState<Draft>({
    title: '',
    primary: '',
    secondary: '',
    logo: { kind: 'saved' },
    darkLogo: { kind: 'saved' },
    icon: { kind: 'saved' },
  });
  // The preview keeps the last valid colour while a field holds an unfinished one.
  const [shown, setShown] = useState<{ primary: string | null; secondary: string | null }>({
    primary: null,
    secondary: null,
  });
  const [errors, setErrors] = useState<Errors>({});
  const [alert, setAlert] = useState<{ title: string; text: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [reset, setReset] = useState<ResetState | null>(null);
  const [leave, setLeave] = useState<{ proceed: () => void } | null>(null);
  // A new object each time, so focusing the same target twice still runs the effect.
  const [focus, setFocusState] = useState<{ target: Focus } | null>(null);
  const setFocus = (target: Focus) => {
    setFocusState({ target });
  };

  const heading = useRef<HTMLHeadingElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const primaryInput = useRef<HTMLInputElement>(null);
  const secondaryInput = useRef<HTMLInputElement>(null);
  const logoDrop = useRef<HTMLButtonElement>(null);
  const darkLogoDrop = useRef<HTMLButtonElement>(null);
  const iconDrop = useRef<HTMLButtonElement>(null);

  const saved = load.status === 'ready' ? load.saved : null;

  const startFrom = useCallback((branding: Branding) => {
    setDraft(draftOf(branding));
    setShown({ primary: branding.primary, secondary: branding.secondary });
    setErrors({});
    setAlert(null);
    setConflict(false);
  }, []);

  const loadPage = useCallback(
    (signal?: AbortSignal, then?: Focus) => {
      getBranding(signal)
        .then((branding) => {
          setLoad({ status: 'ready', saved: branding });
          startFrom(branding);
          updateApp(branding);
          if (then) setFocusState({ target: then });
        })
        .catch((error: unknown) => {
          if (signal?.aborted) return;
          setLoad({
            status: 'error',
            message: error instanceof Error ? error.message : 'Something went wrong.',
          });
        });
    },
    [updateApp, startFrom],
  );

  useEffect(() => {
    const controller = new AbortController();
    loadPage(controller.signal);
    return () => {
      controller.abort();
    };
  }, [loadPage]);

  useEffect(() => {
    if (focus === null) return;
    const target = {
      h1: heading,
      title: titleInput,
      primary: primaryInput,
      secondary: secondaryInput,
      logo: logoDrop,
      darkLogo: darkLogoDrop,
      icon: iconDrop,
    }[focus.target].current;
    target?.focus();
  }, [focus]);

  useEffect(() => {
    if (!savedNote) return;
    const timer = setTimeout(() => {
      setSavedNote(false);
    }, 3000);
    return () => {
      clearTimeout(timer);
    };
  }, [savedNote]);

  const primary = parseHex(draft.primary);
  const secondary = parseHex(draft.secondary);
  const title = storedTitle(draft.title);
  const titleIssue = title === null ? null : productTitleIssue(title);
  const coloursChanged =
    saved !== null && (primary !== saved.primary || secondary !== saved.secondary);
  const titleChanged = saved !== null && title !== saved.title;
  const imageChanged = (slot: Slot): boolean => {
    const image = draft[slot];
    return (
      saved !== null &&
      (image.kind === 'new' || (image.kind === 'none' && slots[slot].savedUrl(saved) !== null))
    );
  };
  const dirty = coloursChanged || titleChanged || slotNames.some(imageChanged);

  const tokens = useMemo(() => brandTokens(shown), [shown]);
  /** What the draft shows for an image: the new file, nothing, or what's saved. */
  const imageSrc = (slot: Slot): string | null => {
    const image = draft[slot];
    if (image.kind === 'new') return image.logo.src;
    if (image.kind === 'none' || saved === null) return null;
    return slots[slot].savedUrl(saved);
  };
  const picked = (slot: Slot): PickedLogo | undefined => {
    const image = draft[slot];
    return image.kind === 'new' ? image.logo : undefined;
  };
  const logoSrc = imageSrc('logo');
  const darkLogoSrc = imageSrc('darkLogo');
  const iconSrc = imageSrc('icon');

  // Links out of the page and reloads while there are changes (as the explorer).
  useEffect(() => {
    if (!dirty) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest('a[href]');
      if (!(link instanceof HTMLAnchorElement) || link.target === '_blank' || link.download) return;
      const target = new URL(link.href, window.location.href);
      if (target.origin !== window.location.origin) return;
      const path = `${target.pathname}${target.search}`;
      if (path === `${window.location.pathname}${window.location.search}`) return;
      event.preventDefault();
      event.stopPropagation();
      setLeave({
        proceed: () => {
          void navigate(path);
        },
      });
    };
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [dirty, navigate]);

  const setColour = (field: 'primary' | 'secondary', text: string) => {
    setDraft((current) => ({ ...current, [field]: text }));
    const parsed = parseHex(text);
    if (parsed !== 'invalid') {
      setShown((current) => ({ ...current, [field]: parsed }));
      setErrors((current) => ({ ...current, [field]: undefined }));
    }
  };

  const tidy = (field: 'primary' | 'secondary') => {
    const parsed = parseHex(draft[field]);
    if (parsed === 'invalid') {
      setErrors((current) => ({ ...current, [field]: hexMessage }));
    } else {
      setDraft((current) => ({ ...current, [field]: parsed ?? '' }));
    }
  };

  const setTitle = (text: string) => {
    setDraft((current) => ({ ...current, title: text }));
    const next = storedTitle(text);
    setErrors((current) => ({
      ...current,
      title: next === null ? undefined : (productTitleIssue(next) ?? undefined),
    }));
  };

  const pickFiles = (slot: Slot, files: FileList | null) => {
    const file = files?.[0];
    if (!file || saving) return;
    void checkLogoFile(file, slots[slot].rules).then((result) => {
      if (result.ok) {
        setDraft((current) => ({ ...current, [slot]: { kind: 'new', logo: result.logo } }));
        setErrors((current) => ({ ...current, [slot]: undefined }));
        setAnnouncement(slots[slot].ready);
      } else {
        setErrors((current) => ({ ...current, [slot]: result.message }));
        setFocus(slot);
      }
    });
  };

  const removeImage = (slot: Slot) => {
    setDraft((current) => ({ ...current, [slot]: { kind: 'none' } }));
    setErrors((current) => ({ ...current, [slot]: undefined }));
    setAnnouncement(slots[slot].removed);
    setFocus(slot);
  };

  /** Shows why a save failed at `stage`, after the stages in `done` went through. */
  const failed = (error: unknown, stage: Stage, done: readonly Stage[]) => {
    if (!(error instanceof ApiRequestError)) {
      setAlert({ title: "The branding wasn't saved.", text: offline });
      return;
    }
    if (error.status === 401) return; // The shell shows the session ended.
    if (error.status === 409) {
      setConflict(true);
      return;
    }
    const message = serverMessage(error);
    const title = failureTitle(stage, done);
    if (stage !== 'colours' && stage !== 'title' && [413, 415, 422].includes(error.status)) {
      const { messages } = slots[stage].rules;
      const file = picked(stage);
      const fallback =
        error.status === 415
          ? messages.type
          : error.status === 413
            ? file
              ? messages.tooLarge(file.size)
              : messages.tooLargeUnknown
            : messages.unreadable;
      const text = message ?? fallback;
      setErrors({ [stage]: text });
      if (done.length > 0) setAlert({ title, text });
      setFocus(stage);
      return;
    }
    if (error.status === 422) {
      const next: Errors = {};
      for (const issue of fieldIssues(error)) {
        if (stage === 'colours' && (issue.field === 'primary' || issue.field === 'secondary')) {
          next[issue.field] = issue.message || hexMessage;
        }
        if (stage === 'title' && issue.field === 'title') next.title = issue.message;
      }
      const first = (['title', 'primary', 'secondary'] as const).find(
        (field) => next[field] !== undefined,
      );
      if (first !== undefined) {
        setErrors(next);
        if (done.length > 0) setAlert({ title, text: next[first] ?? '' });
        setFocus(first);
        return;
      }
    }
    setAlert({ title, text: error.status === 0 ? offline : (message ?? offline) });
  };

  /**
   * Saves what changed, one step at a time (each carries the version the last one gave): the
   * colours, the title, then the images. True when all went through.
   */
  const save = async (): Promise<boolean> => {
    if (saved === null || saving || conflict) return false;
    const invalid: Errors = {};
    if (titleIssue !== null) invalid.title = titleIssue;
    if (primary === 'invalid') invalid.primary = hexMessage;
    if (secondary === 'invalid') invalid.secondary = hexMessage;
    const firstInvalid = (['title', 'primary', 'secondary'] as const).find(
      (field) => invalid[field] !== undefined,
    );
    if (firstInvalid !== undefined) {
      setErrors((current) => ({ ...current, ...invalid }));
      setFocus(firstInvalid);
      return false;
    }
    if (primary === 'invalid' || secondary === 'invalid') return false;
    setSaving(true);
    setAlert(null);
    setErrors({});
    let current = saved;
    const done: Stage[] = [];
    const ratios: { logo?: number; darkLogo?: number } = {};
    const steps: [Stage, () => Promise<Branding> | null][] = [
      [
        'colours',
        () =>
          primary !== saved.primary || secondary !== saved.secondary
            ? saveBrandingColours(primary, secondary, current.version)
            : null,
      ],
      ['title', () => (title !== saved.title ? saveBrandingTitle(title, current.version) : null)],
      ...slotNames.map((slot): [Stage, () => Promise<Branding> | null] => [
        slot,
        () => {
          const image = draft[slot];
          if (image.kind === 'new') {
            if (slot !== 'icon') ratios[slot] = image.logo.width / image.logo.height;
            return uploadBrandingImage(
              slots[slot].path,
              image.logo.file,
              image.logo.type,
              current.version,
            );
          }
          if (image.kind === 'none' && slots[slot].savedUrl(current) !== null) {
            return removeBrandingImage(slots[slot].path, current.version);
          }
          return null;
        },
      ]),
    ];
    for (const [stage, step] of steps) {
      try {
        const request = step();
        if (request === null) continue;
        current = await request;
        done.push(stage);
      } catch (error) {
        setSaving(false);
        if (done.length > 0) {
          // What went through stays saved; the rest stays in the draft, so Save retries it.
          const now = current;
          setLoad({ status: 'ready', saved: now });
          setDraft((before) => {
            const after = { ...before };
            for (const each of done) {
              if (each === 'colours') {
                after.primary = now.primary ?? '';
                after.secondary = now.secondary ?? '';
              } else if (each === 'title') {
                after.title = now.title ?? '';
              } else {
                after[each] = { kind: 'saved' };
              }
            }
            return after;
          });
          updateApp(now, ratios);
        }
        failed(error, stage, done);
        return false;
      }
    }
    setSaving(false);
    setLoad({ status: 'ready', saved: current });
    startFrom(current);
    updateApp(current, ratios);
    setSavedNote(true);
    setAnnouncement(announcements.saved);
    setFocus('h1');
    return true;
  };

  const discard = () => {
    if (saved === null) return;
    startFrom(saved);
    setAnnouncement(announcements.discarded);
    setFocus('h1');
  };

  const runReset = () => {
    if (saved === null) return;
    setReset({ busy: true, error: null, stale: false });
    resetBranding(saved.version)
      .then((result) => {
        setReset(null);
        setLoad({ status: 'ready', saved: result });
        startFrom(result);
        updateApp(result);
        setAnnouncement(announcements.reset);
        setFocus('h1');
      })
      .catch((error: unknown) => {
        if (error instanceof ApiRequestError && error.status === 409) {
          setReset({ busy: false, error: brandingConflictMessage, stale: true });
        } else {
          setReset({
            busy: false,
            error:
              error instanceof ApiRequestError && error.status !== 0
                ? (serverMessage(error) ?? offline)
                : offline,
            stale: false,
          });
        }
      });
  };

  const reload = () => {
    setReset(null);
    setLoad({ status: 'loading' });
    loadPage(undefined, 'h1');
  };

  const savedIsNeutral =
    saved !== null &&
    saved.title === null &&
    saved.primary === null &&
    saved.secondary === null &&
    saved.logoUrl === null &&
    saved.darkLogoUrl === null &&
    saved.iconUrl === null;

  const onDrag = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const titleLength = title === null ? 0 : productTitleLength(title);
  const titleDescribedBy = [
    'brand-title-hint',
    'brand-title-count',
    errors.title === undefined ? '' : 'brand-title-error',
  ]
    .filter(Boolean)
    .join(' ');

  const imageField = (slot: Slot, labelledBy: string) => (
    <ImageField
      id={slots[slot].id}
      labelledBy={labelledBy}
      words={slots[slot].words}
      accept={slots[slot].accept}
      src={imageSrc(slot)}
      picked={picked(slot)}
      changed={imageChanged(slot)}
      error={errors[slot]}
      busy={saving}
      dropRef={{ logo: logoDrop, darkLogo: darkLogoDrop, icon: iconDrop }[slot]}
      onFiles={(files) => {
        pickFiles(slot, files);
      }}
      onRemove={() => {
        removeImage(slot);
      }}
      {...(slot === 'icon'
        ? { none: { src: builtInIcon, caption: 'Built-in icon' }, tile: 'icon' as const }
        : {})}
    />
  );

  return (
    <main
      id="content"
      tabIndex={-1}
      className="page-scroll"
      // Files dropped outside the drop areas are ignored, never opened by the browser.
      onDragOver={onDrag}
      onDrop={onDrag}
    >
      <div className="page brand-page">
        <AdminNav />
        <div className="page-head">
          <div>
            <h1 ref={heading} tabIndex={-1}>
              Branding
            </h1>
            <p>
              Your organisation&apos;s product title, logo, app icon and colours. Everyone sees
              them, also on the sign-in page.
            </p>
          </div>
        </div>
        <p className="vh" aria-live="polite">
          {announcement}
        </p>

        {load.status === 'loading' && (
          <p className="app-message" role="status">
            Loading…
          </p>
        )}

        {load.status === 'error' && (
          <div className="table-card load-error" role="alert">
            <Icon name="alert" />
            <div>
              <p>
                <b>The branding couldn&apos;t be loaded.</b>
              </p>
              <p className="muted">{load.message}</p>
            </div>
            <button className="btn" type="button" onClick={reload}>
              Try again
            </button>
          </div>
        )}

        {saved !== null && (
          <div className="brand-grid">
            <form
              className="table-card brand-card brand-form"
              aria-labelledby="brand-form-title"
              aria-busy={saving}
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <h2 id="brand-form-title" className="vh">
                Product title, logo, app icon and colours
              </h2>
              {conflict && (
                <div className="conflict" role="alert">
                  <Icon name="alert" />
                  <div>
                    <h3>Someone else changed the branding</h3>
                    <p>
                      Reload to see their changes. What you&apos;ve chosen here stays until you
                      reload.
                    </p>
                    <button className="btn" type="button" onClick={reload}>
                      Reload
                    </button>
                  </div>
                </div>
              )}
              {alert && (
                <div className="form-alert" role="alert">
                  <Icon name="alert" />
                  <div>
                    <p className="form-alert-title">{alert.title}</p>
                    <p>{alert.text}</p>
                  </div>
                </div>
              )}

              <h2 className="brand-section">
                <label htmlFor="brand-title">Product title</label>
              </h2>
              <p className="brand-hint" id="brand-title-hint">
                Shown in the header, on the sign-in page and in the browser tab. Leave empty to use{' '}
                {defaultProductTitle}.
              </p>
              <div className="brand-title-row">
                <input
                  ref={titleInput}
                  id="brand-title"
                  type="text"
                  className="brand-title-input"
                  placeholder={defaultProductTitle}
                  autoComplete="off"
                  spellCheck={false}
                  readOnly={saving}
                  value={draft.title}
                  aria-invalid={errors.title === undefined ? undefined : true}
                  aria-describedby={titleDescribedBy}
                  onChange={(event) => {
                    setTitle(event.target.value);
                  }}
                />
                <span
                  className={`brand-title-count${
                    titleLength > maxProductTitleLength ? ' is-over' : ''
                  }`}
                  id="brand-title-count"
                >
                  {titleLength} / {maxProductTitleLength}
                </span>
              </div>
              {errors.title !== undefined && (
                <p className="field-error brand-logo-error" id="brand-title-error">
                  <Icon name="alert" size="sm" />
                  <span>{errors.title}</span>
                </p>
              )}

              <div className="brand-sep" />
              <h2 className="brand-section" id="logo-heading">
                Logo
              </h2>
              <p className="brand-hint" id="logo-hint">
                PNG, JPEG or WebP, up to 300 KB and 1024 × 1024 px. Shown up to 28px high in the
                header.
              </p>
              {imageField('logo', 'logo-heading')}

              <h3 className="brand-subsection" id="dark-logo-heading">
                Logo for Dark theme (optional)
              </h3>
              <p className="brand-hint" id="dark-logo-hint">
                Same rules as the logo. Used in the Dark theme; without it, the logo above is used.
              </p>
              {imageField('darkLogo', 'dark-logo-heading')}

              <div className="brand-sep" />
              <h2 className="brand-section" id="icon-heading">
                App icon
              </h2>
              <p className="brand-hint" id="icon-hint">
                A square PNG, 512 × 512 pixels, up to 300 KB. Used for the browser tab and the
                installed app.
              </p>
              {imageField('icon', 'icon-heading')}

              <div className="brand-sep" />
              <h2 className="brand-section">Colours</h2>
              <div className="brand-fields">
                <ColourField
                  id="primary"
                  label="Primary colour"
                  hint="Buttons, links, the selected tab, selection and focus rings, lit lines."
                  text={draft.primary}
                  error={errors.primary}
                  adjusted={adjustedText(
                    tokens.report.light.accent,
                    tokens.report.dark.accent,
                    '4.5:1',
                  )}
                  busy={saving}
                  inputRef={primaryInput}
                  onText={(text) => {
                    setColour('primary', text);
                  }}
                  onBlur={() => {
                    tidy('primary');
                  }}
                />
                <ColourField
                  id="secondary"
                  label="Secondary colour"
                  hint="The line along the top of the header, and the tint behind the selected row and the active Admin page."
                  text={draft.secondary}
                  error={errors.secondary}
                  adjusted={adjustedText(
                    tokens.report.light.brandLine,
                    tokens.report.dark.brandLine,
                    '3:1',
                    ' for the header line',
                  )}
                  busy={saving}
                  inputRef={secondaryInput}
                  onText={(text) => {
                    setColour('secondary', text);
                  }}
                  onBlur={() => {
                    tidy('secondary');
                  }}
                />
              </div>

              <div className="brand-actions">
                <button
                  className="btn"
                  type="button"
                  disabled={savedIsNeutral || saving}
                  onClick={() => {
                    setReset({ busy: false, error: null, stale: false });
                  }}
                >
                  Reset to the neutral look
                </button>
                <div className="brand-actions-2">
                  {/* Announced through the page's live region, not here (no double reading). */}
                  <p className="brand-status">
                    {savedNote && !dirty ? (
                      <span className="saved">
                        <Icon name="check" size="sm" />
                        Saved
                      </span>
                    ) : dirty ? (
                      'Unsaved changes'
                    ) : (
                      ''
                    )}
                  </p>
                  <div className="brand-buttons">
                    <button
                      className="btn"
                      type="button"
                      disabled={!dirty || saving}
                      onClick={discard}
                    >
                      Discard changes
                    </button>
                    <button
                      className="btn primary brand-save"
                      type="submit"
                      disabled={!dirty || saving || conflict}
                    >
                      {saving && <span className="spinner sm" aria-hidden="true" />}
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              </div>
            </form>
            <BrandingPreview
              tokens={tokens}
              title={title ?? defaultProductTitle}
              logoSrc={logoSrc}
              darkLogoSrc={darkLogoSrc ?? logoSrc}
              iconSrc={iconSrc ?? builtInIcon}
            />
          </div>
        )}
      </div>

      {reset && saved && (
        <ResetDialog
          state={reset}
          unsaved={dirty}
          onCancel={() => {
            setReset(null);
          }}
          onReset={runReset}
          onReload={reload}
        />
      )}
      {leave && (
        <UnsavedDialog
          kind="leave"
          name=""
          subject="branding"
          saving={saving}
          canSave={!conflict}
          onKeep={() => {
            setLeave(null);
          }}
          onDiscard={() => {
            if (saved) startFrom(saved);
            setLeave(null);
            leave.proceed();
          }}
          onSave={() => {
            void save().then((ok) => {
              setLeave(null);
              if (ok) leave.proceed();
            });
          }}
        />
      )}
    </main>
  );
}

function ResetDialog(props: {
  state: ResetState;
  unsaved: boolean;
  onCancel: () => void;
  onReset: () => void;
  onReload: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const { busy, error, stale } = props.state;
  return (
    <Modal
      id="reset"
      className="reset-dialog"
      onCancel={props.onCancel}
      busy={busy}
      initialFocus={cancel}
      describedBy="reset-text"
    >
      <h2 id="reset-title">Reset to the neutral look?</h2>
      <p id="reset-text">
        This removes the product title, both logos, the app icon and both colours for everyone, also
        on the sign-in page. It can&apos;t be undone.
        {props.unsaved ? ' Your unsaved changes are discarded too.' : ''}
      </p>
      {error !== null && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button ref={cancel} className="btn" type="button" disabled={busy} onClick={props.onCancel}>
          Cancel
        </button>
        {stale ? (
          <button className="btn" type="button" onClick={props.onReload}>
            Reload
          </button>
        ) : (
          <button className="btn danger" type="button" disabled={busy} onClick={props.onReset}>
            {busy ? 'Resetting…' : 'Reset'}
          </button>
        )}
      </div>
    </Modal>
  );
}
