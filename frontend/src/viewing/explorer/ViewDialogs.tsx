import {
  maxViewFolderLength,
  maxViewNameLength,
  viewFolderKey,
  viewFolderProblem,
  viewFolderTakenMessage,
  type StoredView,
  type ViewSummary,
} from '@simplearchitecture/shared';
import { useEffect, useRef, useState } from 'react';
import {
  ApiRequestError,
  createView,
  deleteView,
  moveView,
  renameView,
  renameViewFolder,
} from '../../api';
import { Icon } from '../../icons';
import { Modal } from '../../modelling/dialogs';
import { ValueField } from '../../modelling/ValueField';
import { counted } from '../../words';
import { folderNamed, folderNames, type ViewFolder } from './viewFolders';
import { useViewList } from './useViewList';
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

/** A second, optional field under Name: Save as view's Folder. */
interface SecondField {
  label: string;
  /** The suggestions, by name; none makes it a plain text field. */
  values: readonly string[];
  value: string;
  onChange: (value: string) => void;
  hint: string;
  /** What is wrong with the value, checked on saving, or null. */
  check: (value: string) => string | null;
  /** The field of a 422 that is about it. */
  field: string;
}

interface NameDialogProps {
  id: string;
  title: string;
  text?: string;
  initialName: string;
  submitLabel: string;
  busyLabel: string;
  /** Under the Name field. Default: a view name's length. */
  hint?: string;
  /** What is wrong with the name, checked on saving. Default: a view name's rules. */
  check?: (name: string) => string | null;
  /**
   * What is wrong with the name as typed, shown at once and blocking the main button until the
   * name changes (a folder name that exists).
   */
  blocking?: (name: string) => string | null;
  /** The field of a 422 that is about the name. Default `name`. */
  nameField?: string;
  second?: SecondField;
  /** Sends the name (trimmed); a refusal is an ApiRequestError. */
  submit: (name: string) => Promise<void>;
  /** What the dialog says when a 422 isn't about a field, or the server can't be reached. */
  failure: (error: unknown) => string;
  onCancel: () => void;
}

/**
 * Asks for a name (a view's or a folder's), in the New model dialog's layout. The name starts all
 * selected.
 */
function NameDialog(props: NameDialogProps) {
  const input = useRef<HTMLInputElement>(null);
  const secondInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(props.initialName);
  const [nameError, setNameError] = useState<string | null>(null);
  const [secondError, setSecondError] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    input.current?.select();
  }, []);
  const blocked = props.blocking?.(name) ?? null;
  const shownNameError = blocked ?? nameError;

  const send = () => {
    if (busy || blocked !== null) return;
    const problem = (props.check ?? viewNameError)(name);
    const secondProblem = props.second ? props.second.check(props.second.value) : null;
    setAlert(null);
    setNameError(problem);
    setSecondError(secondProblem);
    if (problem !== null) {
      input.current?.focus();
      return;
    }
    if (secondProblem !== null) {
      secondInput.current?.focus();
      return;
    }
    setBusy(true);
    props.submit(name.trim()).catch((error: unknown) => {
      setBusy(false);
      const body = error instanceof ApiRequestError && error.status === 422 ? error.body : null;
      const message = body === null ? undefined : fieldMessage(body, props.nameField ?? 'name');
      const other =
        body === null || props.second === undefined
          ? undefined
          : fieldMessage(body, props.second.field);
      if (message !== undefined) {
        setNameError(message);
        input.current?.focus();
      } else if (other !== undefined) {
        setSecondError(other);
        secondInput.current?.focus();
      } else {
        setAlert(props.failure(error));
      }
    });
  };

  const ids = { name: `${props.id}-name`, error: `${props.id}-error`, hint: `${props.id}-hint` };
  const secondIds = {
    field: `${props.id}-second`,
    error: `${props.id}-second-error`,
    hint: `${props.id}-second-hint`,
  };
  const { second } = props;
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
            aria-invalid={shownNameError !== null || undefined}
            aria-describedby={shownNameError !== null ? `${ids.error} ${ids.hint}` : ids.hint}
            value={name}
            readOnly={busy}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
            }}
          />
          {shownNameError !== null && (
            <p className="field-error" id={ids.error} role={blocked !== null ? 'alert' : undefined}>
              <Icon name="alert" size="sm" />
              {shownNameError}
            </p>
          )}
          <p className="hint" id={ids.hint}>
            {props.hint ?? `Up to ${maxViewNameLength} characters.`}
          </p>
        </div>
        {second && (
          <div className="field vf-field">
            <label htmlFor={secondIds.field}>{second.label}</label>
            <div className="vf-input">
              <ValueField
                ref={secondInput}
                id={secondIds.field}
                values={second.values}
                label={second.label}
                value={second.value}
                readOnly={busy}
                aria-invalid={secondError !== null || undefined}
                aria-describedby={
                  secondError !== null ? `${secondIds.error} ${secondIds.hint}` : secondIds.hint
                }
                onValue={(text) => {
                  second.onChange(text);
                  setSecondError(null);
                }}
              />
            </div>
            {secondError !== null && (
              <p className="field-error" id={secondIds.error}>
                <Icon name="alert" size="sm" />
                {secondError}
              </p>
            )}
            <p className="hint" id={secondIds.hint}>
              {second.hint}
            </p>
          </div>
        )}
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
          <button
            type="submit"
            className={`btn primary${blocked !== null && !busy ? ' is-blocked' : ''}`}
            aria-disabled={busy || blocked !== null || undefined}
          >
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

/** The folder check the server makes, with the dialog's words; empty is no folder. */
const optionalFolderError = (folder: string): string | null =>
  folder.trim() === '' ? null : viewFolderProblem(folder);

/** Save as view: the canvas's cards and relationships, under a name, in a folder or none. */
export function SaveViewDialog(props: SaveViewDialogProps) {
  const { elementIds, relationshipIds } = props.contents;
  const [folder, setFolder] = useState('');
  // The model's folders to pick from; without them the field is plain text.
  const [list] = useViewList(props.modelId, true);
  const views = list.status === 'ready' ? list.views : [];
  return (
    <NameDialog
      id="save-view"
      title="Save as view"
      text={`Saves the ${counted(elementIds.length, 'element')} and ${counted(relationshipIds.length, 'relationship')} on the canvas. Everyone who can open this model can open the view. It's laid out when it opens, and keeps where you then put its cards.`}
      initialName={props.initialName}
      submitLabel="Save view"
      busyLabel="Saving…"
      second={{
        label: 'Folder',
        values: folderNames(views),
        value: folder,
        onChange: setFolder,
        hint: 'Optional. Pick a folder or type a new one.',
        check: optionalFolderError,
        field: 'folder',
      }}
      submit={async (name) => {
        const trimmed = folder.trim();
        const view = await createView(props.modelId, {
          name,
          ...(trimmed === '' ? {} : { folder: folderNamed(views, trimmed) ?? trimmed }),
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

/** The blocking check of a folder's new name: another folder has it, ignoring case and spaces. */
function takenBy(folders: readonly ViewFolder[], except?: string) {
  return (name: string): string | null => {
    if (name.trim() === '') return null;
    const key = viewFolderKey(name);
    const taken = folders.find((folder) => folder.key === key && folder.key !== except);
    return taken === undefined ? null : viewFolderTakenMessage(taken.name);
  };
}

const folderHint = `Up to ${maxViewFolderLength} characters.`;

interface NewFolderDialogProps {
  modelId: string;
  view: ViewSummary;
  /** The model's folders as the list shows them. */
  folders: readonly ViewFolder[];
  onCancel: () => void;
  /** Made, with the view in it. */
  onMade: (view: ViewSummary) => void;
  /** The view was deleted meanwhile. */
  onGone: () => void;
}

/**
 * New folder: a view dropped on New folder… goes into a folder of this name. The view doesn't
 * move until it is saved. A name another folder has is refused, never merged.
 */
export function NewFolderDialog(props: NewFolderDialogProps) {
  const name = props.view.name.trim();
  return (
    <NameDialog
      id="new-folder"
      title="New folder"
      text={name ? `Puts “${name}” in a new folder.` : 'Puts the view in a new folder.'}
      initialName=""
      submitLabel="Create folder"
      busyLabel="Creating…"
      hint={folderHint}
      check={viewFolderProblem}
      blocking={takenBy(props.folders)}
      nameField="folder"
      submit={async (folder) => {
        const view = await moveView(props.modelId, props.view.id, { folder, newFolder: true });
        props.onMade(view);
      }}
      failure={(error) => {
        if (error instanceof ApiRequestError && error.status === 404) {
          props.onGone();
          return 'Someone else deleted this view.';
        }
        return offline(error)
          ? "The view wasn't moved. Check your connection and try again."
          : `The view wasn't moved. ${error instanceof Error ? error.message : ''}`.trim();
      }}
      onCancel={props.onCancel}
    />
  );
}

interface RenameFolderDialogProps {
  modelId: string;
  folder: ViewFolder;
  /** The model's folders as the list shows them. */
  folders: readonly ViewFolder[];
  onCancel: () => void;
  /** Renamed on its views (as the server returned them). */
  onRenamed: (folder: string, views: ViewSummary[]) => void;
  /** No view is in the folder any more. */
  onGone: () => void;
}

/**
 * Rename folder: on every view in it, for everyone. Only the case may change to a name that
 * matches; another folder's name is refused, never merged. The same name closes it.
 */
export function RenameFolderDialog(props: RenameFolderDialogProps) {
  const from = props.folder.name;
  return (
    <NameDialog
      id="rename-folder"
      title="Rename folder"
      text={`Renames the folder on its ${counted(props.folder.views.length, 'view')}, for everyone.`}
      initialName={from}
      submitLabel="Rename"
      busyLabel="Renaming…"
      hint={folderHint}
      check={viewFolderProblem}
      blocking={takenBy(props.folders, props.folder.key)}
      nameField="folder"
      submit={async (to) => {
        if (to === from) {
          props.onCancel();
          return;
        }
        const result = await renameViewFolder(props.modelId, { from, to });
        props.onRenamed(result.folder, result.views);
      }}
      failure={(error) => {
        if (error instanceof ApiRequestError && error.status === 404) {
          props.onGone();
          return 'This folder has no views any more.';
        }
        return offline(error)
          ? "The folder wasn't renamed. Check your connection and try again."
          : `The folder wasn't renamed. ${error instanceof Error ? error.message : ''}`.trim();
      }}
      onCancel={props.onCancel}
    />
  );
}
