import {
  brandingConflictMessage,
  brandTokens,
  type ApiError,
  type Branding,
} from '@simplearchitecture/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  ApiRequestError,
  getBranding,
  getDatabaseStatus,
  removeBrandingLogo,
  resetBranding,
  saveBrandingColours,
  uploadBrandingLogo,
} from '../api';
import { isLogoUrl, useBranding } from '../branding';
import { Icon } from '../icons';
import { Modal, UnsavedDialog } from '../modelling/dialogs';
import { AdminNav } from './AdminNav';
import { BrandingPreview } from './branding/BrandingPreview';
import { adjustedText, ColourField, hexMessage, parseHex } from './branding/ColourField';
import { checkLogoFile, kilobytes, logoMessages, type PickedLogo } from './branding/logo-file';

/** Admin → Branding: the logo and the two colours. */

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'no-database' }
  | { status: 'ready'; saved: Branding };

/** The draft logo: unchanged (what's saved), removed, or a new file. */
type DraftLogo = { kind: 'saved' } | { kind: 'none' } | { kind: 'new'; logo: PickedLogo };

interface Draft {
  primary: string;
  secondary: string;
  logo: DraftLogo;
}

interface Errors {
  primary?: string | undefined;
  secondary?: string | undefined;
  logo?: string | undefined;
}

type Focus = 'h1' | 'primary' | 'secondary' | 'logo';

interface ResetState {
  busy: boolean;
  error: string | null;
  /** 409: the danger button becomes Reload. */
  stale: boolean;
}

const draftOf = (saved: Branding): Draft => ({
  primary: saved.primary ?? '',
  secondary: saved.secondary ?? '',
  logo: { kind: 'saved' },
});

const announcements = {
  logoReady: 'Logo ready. Save to apply it.',
  logoRemoved: 'Logo removed. Save to apply it.',
  saved: 'Branding saved. Everyone sees it on their next page load.',
  discarded: 'Changes discarded.',
  reset: 'Branding reset to the neutral look.',
};

const offline = 'Check your connection and try again.';

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
    primary: '',
    secondary: '',
    logo: { kind: 'saved' },
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
  const [dragOver, setDragOver] = useState(false);

  const heading = useRef<HTMLHeadingElement>(null);
  const primaryInput = useRef<HTMLInputElement>(null);
  const secondaryInput = useRef<HTMLInputElement>(null);
  const dropzone = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

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
      Promise.all([getBranding(signal), getDatabaseStatus(signal)])
        .then(([branding, database]) => {
          if (!database.configured) {
            setLoad({ status: 'no-database' });
            return;
          }
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
      primary: primaryInput,
      secondary: secondaryInput,
      logo: dropzone,
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
  const coloursChanged =
    saved !== null && (primary !== saved.primary || secondary !== saved.secondary);
  const logoChanged =
    saved !== null &&
    (draft.logo.kind === 'new' || (draft.logo.kind === 'none' && saved.logoUrl !== null));
  const dirty = coloursChanged || logoChanged;

  const tokens = useMemo(() => brandTokens(shown), [shown]);
  const savedLogoSrc = saved !== null && isLogoUrl(saved.logoUrl) ? saved.logoUrl : null;
  const logoSrc =
    draft.logo.kind === 'new'
      ? draft.logo.logo.src
      : draft.logo.kind === 'none'
        ? null
        : savedLogoSrc;

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

  const pickFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (!file || saving) return;
    void checkLogoFile(file).then((result) => {
      if (result.ok) {
        setDraft((current) => ({ ...current, logo: { kind: 'new', logo: result.logo } }));
        setErrors((current) => ({ ...current, logo: undefined }));
        setAnnouncement(announcements.logoReady);
      } else {
        setErrors((current) => ({ ...current, logo: result.message }));
        setFocus('logo');
      }
    });
  };

  const noDatabase = () => {
    setLoad({ status: 'no-database' });
  };

  /** Shows why a save failed. `coloursSaved`: the colours went through, the logo didn't. */
  const failed = (error: unknown, stage: 'colours' | 'logo', coloursSaved: boolean) => {
    if (!(error instanceof ApiRequestError)) {
      setAlert({ title: "The branding wasn't saved.", text: offline });
      return;
    }
    if (error.status === 401) return; // The shell shows the session ended.
    if (error.status === 501) {
      noDatabase();
      return;
    }
    if (error.status === 409) {
      setConflict(true);
      return;
    }
    const message = serverMessage(error);
    const title = coloursSaved
      ? "The colours were saved; the logo wasn't."
      : "The branding wasn't saved.";
    if (stage === 'logo' && [413, 415, 422].includes(error.status)) {
      const logo = draft.logo.kind === 'new' ? draft.logo.logo : undefined;
      const fallback =
        error.status === 415
          ? logoMessages.type
          : error.status === 413
            ? logo
              ? logoMessages.tooLarge(logo.size)
              : logoMessages.tooLargeUnknown
            : logoMessages.unreadable;
      const text = message ?? fallback;
      setErrors({ logo: text });
      if (coloursSaved) setAlert({ title, text });
      setFocus('logo');
      return;
    }
    if (stage === 'colours' && error.status === 422) {
      const next: Errors = {};
      for (const issue of fieldIssues(error)) {
        if (issue.field === 'primary' || issue.field === 'secondary') {
          next[issue.field] = issue.message || hexMessage;
        }
      }
      if (next.primary !== undefined || next.secondary !== undefined) {
        setErrors(next);
        setFocus(next.primary !== undefined ? 'primary' : 'secondary');
        return;
      }
    }
    setAlert({ title, text: error.status === 0 ? offline : (message ?? offline) });
  };

  /** Saves what changed, colours first (they carry the version). True when all went through. */
  const save = async (): Promise<boolean> => {
    if (saved === null || saving || conflict) return false;
    const invalid: Errors = {};
    if (primary === 'invalid') invalid.primary = hexMessage;
    if (secondary === 'invalid') invalid.secondary = hexMessage;
    if (primary === 'invalid' || secondary === 'invalid') {
      setErrors((current) => ({ ...current, ...invalid }));
      setFocus(primary === 'invalid' ? 'primary' : 'secondary');
      return false;
    }
    setSaving(true);
    setAlert(null);
    setErrors({});
    let current = saved;
    let coloursSaved = false;
    try {
      if (primary !== saved.primary || secondary !== saved.secondary) {
        current = await saveBrandingColours(primary, secondary, current.version);
        coloursSaved = true;
      }
    } catch (error) {
      setSaving(false);
      failed(error, 'colours', false);
      return false;
    }
    let newLogo: PickedLogo | undefined;
    try {
      if (draft.logo.kind === 'new') {
        newLogo = draft.logo.logo;
        current = await uploadBrandingLogo(newLogo.file, newLogo.type, current.version);
      } else if (draft.logo.kind === 'none' && current.logoUrl !== null) {
        current = await removeBrandingLogo(current.version);
      }
    } catch (error) {
      setSaving(false);
      if (coloursSaved) {
        // The colours stay saved; the logo stays in the draft, so Save retries it.
        setLoad({ status: 'ready', saved: current });
        setDraft((now) => ({
          ...now,
          primary: current.primary ?? '',
          secondary: current.secondary ?? '',
        }));
        updateApp(current);
      }
      failed(error, 'logo', coloursSaved);
      return false;
    }
    setSaving(false);
    setLoad({ status: 'ready', saved: current });
    startFrom(current);
    updateApp(current, newLogo ? newLogo.width / newLogo.height : undefined);
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
        } else if (error instanceof ApiRequestError && error.status === 501) {
          setReset(null);
          noDatabase();
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
    saved !== null && saved.primary === null && saved.secondary === null && saved.logoUrl === null;

  const onDrag = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const logo = draft.logo.kind === 'new' ? draft.logo.logo : undefined;
  const dropDescribedBy = ['logo-hint', errors.logo === undefined ? '' : 'logo-error']
    .filter(Boolean)
    .join(' ');

  return (
    <main
      id="content"
      tabIndex={-1}
      className="page-scroll"
      // Files dropped outside the drop area are ignored, never opened by the browser.
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
              Your organisation&apos;s logo and colours. Everyone sees them, also on the sign-in
              page.
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

        {load.status === 'no-database' && (
          <div className="info-notice brand-no-db">
            <Icon name="info" />
            <div>
              <p>
                <b>Branding needs a database.</b>
              </p>
              <p>
                This server keeps models in files (no DATABASE_URL), so everyone sees the neutral
                look. Branding can be set once the server uses PostgreSQL. See{' '}
                <Link to="/admin/database">Admin → Database</Link>.
              </p>
            </div>
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
                Logo and colours
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

              <h2 className="brand-section">Logo</h2>
              <p className="brand-hint" id="logo-hint">
                PNG, JPEG or WebP, up to 300 KB and 1024 × 1024 px. Shown up to 28px high in the
                header.
              </p>
              {logoSrc !== null && (
                <div className="logo-row">
                  <div className="logo-tile">
                    <img
                      src={logoSrc}
                      alt={logo ? 'New logo, not saved yet' : 'Current logo'}
                      draggable={false}
                    />
                  </div>
                  <div className="logo-text">
                    <b>{logo ? logo.name : 'Current logo'}</b>
                    {logo && (
                      <small>
                        {kilobytes(logo.size)} KB · {logo.width} × {logo.height} px
                      </small>
                    )}
                    {logoChanged && <span className="tag">Not saved yet</span>}
                  </div>
                  <button
                    className="btn"
                    type="button"
                    aria-label="Remove logo"
                    disabled={saving}
                    onClick={() => {
                      setDraft((current) => ({ ...current, logo: { kind: 'none' } }));
                      setErrors((current) => ({ ...current, logo: undefined }));
                      setAnnouncement(announcements.logoRemoved);
                      setFocus('logo');
                    }}
                  >
                    <Icon name="trash" size="sm" />
                    Remove
                  </button>
                </div>
              )}
              <button
                ref={dropzone}
                type="button"
                className={`dropzone brand-drop${dragOver ? ' is-over' : ''}${
                  errors.logo === undefined ? '' : ' is-invalid'
                }`}
                aria-describedby={dropDescribedBy}
                disabled={saving}
                onClick={() => fileInput.current?.click()}
                onDragEnter={(event) => {
                  onDrag(event);
                  setDragOver(true);
                }}
                onDragOver={(event) => {
                  onDrag(event);
                  setDragOver(true);
                }}
                onDragLeave={() => {
                  setDragOver(false);
                }}
                onDrop={(event) => {
                  onDrag(event);
                  setDragOver(false);
                  pickFiles(event.dataTransfer.files);
                }}
              >
                <Icon name="upload" />
                <span>
                  {logoSrc === null ? 'Drop an image here, or ' : 'Drop a new image here, or '}
                  <u>choose a file</u>
                </span>
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label="Logo file"
                hidden
                onChange={(event) => {
                  pickFiles(event.target.files);
                  event.target.value = '';
                }}
              />
              {errors.logo !== undefined && (
                <p className="field-error brand-logo-error" id="logo-error">
                  <Icon name="alert" size="sm" />
                  <span>{errors.logo}</span>
                </p>
              )}

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
            <BrandingPreview tokens={tokens} logoSrc={logoSrc} />
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
        This removes the logo and both colours for everyone, also on the sign-in page. It can&apos;t
        be undone.{props.unsaved ? ' Your unsaved changes are discarded too.' : ''}
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
