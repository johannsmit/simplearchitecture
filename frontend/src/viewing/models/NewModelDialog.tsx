import { maxModelNameLength, type ModelSummary } from '@simplearchitecture/shared';
import { useRef, useState } from 'react';
import { ApiRequestError, createModel } from '../../api';
import { Icon } from '../../icons';
import { Modal } from '../../modelling/dialogs';

/** The name check the server makes, with the dialog's words. */
export function newModelNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Enter a name.';
  if (trimmed.length > maxModelNameLength) {
    return `The name has ${trimmed.length} characters. Use ${maxModelNameLength} or fewer.`;
  }
  return null;
}

/** The `name` message of a 422 (`ElementRejected`), if there is one. */
function nameFieldMessage(body: unknown): string | undefined {
  const fields = (body as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) return undefined;
  const issue = fields.find(
    (entry: unknown) => (entry as { field?: unknown } | null)?.field === 'name',
  ) as { message?: unknown } | undefined;
  return typeof issue?.message === 'string' ? issue.message : undefined;
}

interface NewModelDialogProps {
  onCancel: () => void;
  onCreated: (model: ModelSummary) => void;
}

/**
 * Asks for the name of a new, empty model and creates it (Admin). Focus starts in the name field;
 * Esc and Cancel close it unless it is creating. No maxLength: a pasted long name is reported, not
 * cut short.
 */
export function NewModelDialog({ onCancel, onCreated }: NewModelDialogProps) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const create = () => {
    if (creating) return;
    const problem = newModelNameError(name);
    setAlert(null);
    if (problem !== null) {
      setNameError(problem);
      input.current?.focus();
      return;
    }
    setCreating(true);
    createModel(name.trim())
      .then(onCreated)
      .catch((error: unknown) => {
        setCreating(false);
        const status = error instanceof ApiRequestError ? error.status : 0;
        const fieldMessage =
          status === 422 && error instanceof ApiRequestError
            ? nameFieldMessage(error.body)
            : undefined;
        if (fieldMessage !== undefined) {
          setNameError(fieldMessage);
          input.current?.focus();
        } else if (status === 0 || status >= 500) {
          setAlert("The model wasn't created. Check your connection and try again.");
        } else {
          setAlert(
            `The model wasn't created. ${error instanceof Error ? error.message : ''}`.trim(),
          );
        }
      });
  };

  return (
    <Modal
      id="new-model"
      className="new-model-dialog"
      onCancel={onCancel}
      busy={creating}
      initialFocus={input}
      describedBy="new-model-text"
    >
      <form
        noValidate
        aria-busy={creating || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <h2 id="new-model-title">New model</h2>
        <p id="new-model-text">Creates an empty model. Add its elements in Modelling.</p>
        <div className="field">
          <label htmlFor="new-model-name">
            Name <span className="req">Required</span>
          </label>
          <input
            ref={input}
            id="new-model-name"
            autoComplete="off"
            required
            aria-required="true"
            aria-invalid={nameError !== null || undefined}
            aria-describedby={
              nameError !== null ? 'new-model-error new-model-hint' : 'new-model-hint'
            }
            value={name}
            readOnly={creating}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
            }}
          />
          {nameError !== null && (
            <p className="field-error" id="new-model-error">
              <Icon name="alert" size="sm" />
              {nameError}
            </p>
          )}
          <p className="hint" id="new-model-hint">
            Up to {maxModelNameLength} characters.
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
            aria-disabled={creating || undefined}
            onClick={() => {
              if (!creating) onCancel();
            }}
          >
            Cancel
          </button>
          <button type="submit" className="btn primary" aria-disabled={creating || undefined}>
            {creating && <span className="spinner sm" aria-hidden="true" />}
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
