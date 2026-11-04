import { useEffect, useRef } from 'react';

interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** A modal confirmation, styled like the model delete dialog. Focus starts on Cancel. */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busyLabel,
  busy,
  error,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
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
      aria-labelledby="confirm-title"
      aria-describedby="confirm-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (!busy) onCancel();
        }
      }}
    >
      <h2 id="confirm-title">{title}</h2>
      <p id="confirm-description">{description}</p>
      {error !== null && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button ref={cancel} className="btn" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button className="btn danger" type="button" disabled={busy} onClick={onConfirm}>
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
