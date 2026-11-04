import type { ModelSummary } from '@simplearchitecture/shared';
import { useEffect, useRef } from 'react';
import { counted } from '../../words';

/** What the dialog says about a stored model. */
export function modelDeleteText(model: ModelSummary): { name: string; description: string } {
  return {
    name: model.name,
    description: `This deletes the model, its ${counted(model.nodeCount, 'element')} and ${counted(model.edgeCount, 'relationship')} for everyone. It can't be undone.`,
  };
}

interface DeleteDialogProps {
  /** Shown in the title: Delete “name”? */
  name: string;
  description: string;
  deleting: boolean;
  /** An error from the last attempt, shown in the dialog. */
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Modal confirmation before a model is deleted. Focus starts on Cancel. */
export function DeleteDialog({
  name,
  description,
  deleting,
  error,
  onCancel,
  onConfirm,
}: DeleteDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    // Browsers without showModal (and test DOMs) still get an open dialog, just not modal.
    if (typeof element.showModal === 'function') {
      if (!element.open) element.showModal();
    } else {
      element.setAttribute('open', '');
    }
    cancel.current?.focus();
    return () => {
      if (typeof element.close === 'function' && element.open) element.close();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="delete-dialog"
      aria-labelledby="delete-title"
      aria-describedby="delete-description"
      onCancel={(event) => {
        // Esc: closing is driven by state, so focus can go back to the trash button.
        event.preventDefault();
        if (!deleting) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (!deleting) onCancel();
        }
      }}
    >
      <h2 id="delete-title">Delete “{name}”?</h2>
      <p id="delete-description">{description}</p>
      {error !== null && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button ref={cancel} className="btn" type="button" disabled={deleting} onClick={onCancel}>
          Cancel
        </button>
        <button className="btn danger" type="button" disabled={deleting} onClick={onConfirm}>
          {deleting ? 'Deleting…' : 'Delete model'}
        </button>
      </div>
    </dialog>
  );
}
