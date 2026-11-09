import { maxViewNameLength, type StoredView, type ViewSummary } from '@simplearchitecture/shared';
import { useEffect, useRef, useState } from 'react';
import { ApiRequestError, createView, deleteView, renameView } from '../../api';
import { Icon } from '../../icons';
import { Modal } from '../../modelling/dialogs';
import { counted } from '../../words';
import type { ViewContents } from './views';

/** The name check the server makes, with the dialog's words. Uniqueness is the server's. */
export function viewNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Enter a name.';
  if (trimmed.length > maxViewNameLength) {
    return `The name has ${trimmed.length} characters. Use ${maxViewNameLength} or fewer.`;
  }
  return null;
}

/** The message of a 422 (`ViewRejected`) on a field, if there is one. */
function fieldMessage(body: unknown, field: string): string | undefined {
  const fields = (body as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) return undefined;
  const issue = fields.find(
    (entry: unknown) => (entry as { field?: unknown } | null)?.field === field,
  ) as { message?: unknown } | undefined;
  return typeof issue?.message === 'string' ? issue.message : undefined;
}

interface NameDialogProps {
  id: string;
  title: string;
  text?: string;
  initialName: string;
  submitLabel: string;
  busyLabel: string;
  /** Sends the name; a refusal is an ApiRequestError. */
  submit: (name: string) => Promise<void>;
  /** What the dialog says when a 422 isn't about the name, or the server can't be reached. */
  failure: (error: unknown) => string;
  onCancel: () => void;
}

/** Asks for a view's name, in the New model dialog's layout. The name starts all selected. */
function NameDialog(props: NameDialogProps) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(props.initialName);
  const [nameError, setNameError] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    input.current?.select();
  }, []);

  const send = () => {
    if (busy) return;
    const problem = viewNameError(name);
    setAlert(null);
    if (problem !== null) {
      setNameError(problem);
      input.current?.focus();
      return;
    }
    setBusy(true);
    props.submit(name.trim()).catch((error: unknown) => {
      setBusy(false);
      const message =
        error instanceof ApiRequestError && error.status === 422
          ? fieldMessage(error.body, 'name')
          : undefined;
      if (message !== undefined) {
        setNameError(message);
        input.current?.focus();
      } else {
        setAlert(props.failure(error));
      }
    });
  };

  const ids = { name: `${props.id}-name`, error: `${props.id}-error`, hint: `${props.id}-hint` };
  return (
    <Modal
      id={props.id}
      className="new-model-dialog"
      onCancel={props.onCancel}
      busy={busy}
      initialFocus={input}
      describedBy={props.text === undefined ? ids.hint : `${props.id}-text`}
    >
      <form
        noValidate
        aria-busy={busy || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <h2 id={`${props.id}-title`}>{props.title}</h2>
        {props.text !== undefined && <p id={`${props.id}-text`}>{props.text}</p>}
        <div className="field">
          <label htmlFor={ids.name}>
            Name <span className="req">Required</span>
          </label>
          <input
            ref={input}
            id={ids.name}
            autoComplete="off"
            required
            aria-required="true"
            aria-invalid={nameError !== null || undefined}
            aria-describedby={nameError !== null ? `${ids.error} ${ids.hint}` : ids.hint}
            value={name}
            readOnly={busy}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
            }}
          />
          {nameError !== null && (
            <p className="field-error" id={ids.error}>
              <Icon name="alert" size="sm" />
              {nameError}
            </p>
          )}
          <p className="hint" id={ids.hint}>
            Up to {maxViewNameLength} characters.
          </p>
        </div>
        {alert !== null && (
          <p className="alert" role="alert">
            {alert}
          </p>
        )}
        <div className="row">
          <button
            className="btn"
            type="button"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) props.onCancel();
            }}
          >
            Cancel
          </button>
          <button type="submit" className="btn primary" aria-disabled={busy || undefined}>
            {busy && <span className="spinner sm" aria-hidden="true" />}
            {busy ? props.busyLabel : props.submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const offline = (error: unknown) =>
  !(error instanceof ApiRequestError) || error.status === 0 || error.status >= 500;

interface SaveViewDialogProps {
  modelId: string;
  /** The focused element's name, the name to start with. */
  initialName: string;
  contents: ViewContents;
  onCancel: () => void;
  onSaved: (view: StoredView) => void;
}

/** Save as view: the canvas's cards and relationships, under a name. */
export function SaveViewDialog(props: SaveViewDialogProps) {
  const { elementIds, relationshipIds } = props.contents;
  return (
    <NameDialog
      id="save-view"
      title="Save as view"
      text={`Saves the ${counted(elementIds.length, 'element')} and ${counted(relationshipIds.length, 'relationship')} on the canvas. Everyone who can open this model can open the view. It's laid out when it opens, and keeps where you then put its cards.`}
      initialName={props.initialName}
      submitLabel="Save view"
      busyLabel="Saving…"
      submit={async (name) => {
        const view = await createView(props.modelId, {
          name,
          elementIds: [...elementIds],
          relationshipIds: [...relationshipIds],
        });
        props.onSaved(view);
      }}
      failure={(error) =>
        offline(error)
          ? "The view wasn't saved. Check your connection and try again."
          : error instanceof ApiRequestError && error.status === 422
            ? "Part of the canvas was deleted meanwhile, so the view wasn't saved. Reload the page and try again."
            : `The view wasn't saved. ${error instanceof Error ? error.message : ''}`.trim()
      }
      onCancel={props.onCancel}
    />
  );
}

interface RenameViewDialogProps {
  modelId: string;
  view: StoredView;
  onCancel: () => void;
  onRenamed: (view: ViewSummary) => void;
}

/** Rename view. An unchanged name closes it without a request. */
export function RenameViewDialog(props: RenameViewDialogProps) {
  return (
    <NameDialog
      id="rename-view"
      title="Rename view"
      initialName={props.view.name}
      submitLabel="Rename"
      busyLabel="Renaming…"
      submit={async (name) => {
        if (name === props.view.name) {
          props.onCancel();
          return;
        }
        const view = await renameView(props.modelId, props.view.id, {
          version: props.view.version,
          name,
        });
        props.onRenamed(view);
      }}
      failure={(error) =>
        offline(error)
          ? "The view wasn't renamed. Check your connection and try again."
          : error instanceof ApiRequestError && error.status === 409
            ? 'Someone else changed this view since you opened it. Close this, use Reload view, then rename it again.'
            : error instanceof ApiRequestError && error.status === 404
              ? 'Someone else deleted this view.'
              : `The view wasn't renamed. ${error instanceof Error ? error.message : ''}`.trim()
      }
      onCancel={props.onCancel}
    />
  );
}

interface DeleteViewDialogProps {
  modelId: string;
  view: StoredView;
  onCancel: () => void;
  /** Deleted, or already gone (`already`). */
  onDeleted: (already: boolean) => void;
  /** The view changed meanwhile: read it again. */
  onReload: () => void;
}

/** Delete the view, asked first. Its elements and relationships stay in the model. */
export function DeleteViewDialog(props: DeleteViewDialogProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  const [deleting, setDeleting] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = props.view.name.trim();

  const confirm = () => {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    deleteView(props.modelId, props.view.id, props.view.version)
      .then(() => {
        props.onDeleted(false);
      })
      .catch((failure: unknown) => {
        setDeleting(false);
        const status = failure instanceof ApiRequestError ? failure.status : 0;
        if (status === 404) {
          props.onDeleted(true);
        } else if (status === 409) {
          setStale(true);
          setError(
            'Someone else changed this view since you opened it. Reload to see the changes, then delete again.',
          );
        } else if (offline(failure)) {
          setError("The view wasn't deleted. Check your connection and try again.");
        } else {
          setError(
            `The view wasn't deleted. ${failure instanceof Error ? failure.message : ''}`.trim(),
          );
        }
      });
  };

  return (
    <Modal
      id="delete-view"
      className="delete-view"
      onCancel={props.onCancel}
      busy={deleting}
      initialFocus={cancel}
      describedBy="delete-view-text"
    >
      <h2 id="delete-view-title">{name ? `Delete the view “${name}”?` : 'Delete this view?'}</h2>
      <p id="delete-view-text">
        This deletes the view for everyone. Its elements and relationships stay in the model. It
        can&apos;t be undone.
      </p>
      {error !== null && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button
          ref={cancel}
          className="btn"
          type="button"
          disabled={deleting}
          onClick={props.onCancel}
        >
          Cancel
        </button>
        {stale ? (
          <button className="btn" type="button" onClick={props.onReload}>
            Reload
          </button>
        ) : (
          <button className="btn danger" type="button" disabled={deleting} onClick={confirm}>
            {deleting ? 'Deleting…' : 'Delete view'}
          </button>
        )}
      </div>
    </Modal>
  );
}
