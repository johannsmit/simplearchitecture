import { useEffect, useRef, useState, type RefObject } from 'react';
import { ApiRequestError, deleteModel, listDamagedModels } from '../../api';
import { Icon } from '../../icons';
import { DeleteDialog } from './DeleteDialog';

interface Target {
  id: string;
  opener: HTMLButtonElement;
  deleting: boolean;
  error: string | null;
}

interface DamagedModelsProps {
  /** Announces a finished delete (the page's status region). */
  onDeleted: (message: string) => void;
  /** Where focus goes when the last damaged entry is gone. */
  fallbackFocus: RefObject<HTMLElement | null>;
}

/**
 * Admin → Models: stored model files that can't be opened (unreadable, or failing validation),
 * by id only, so an Admin can delete them. They still take up room under the cap. Shown only when
 * there are some; the API lists them for Admins only.
 */
export function DamagedModels({ onDeleted, fallbackFocus }: DamagedModelsProps) {
  const [ids, setIds] = useState<string[]>([]);
  const [target, setTarget] = useState<Target | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focusAfter = useRef<string | null>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listDamagedModels(controller.signal)
      .then(setIds)
      .catch(() => {
        // Not being able to list them is no reason to disturb the page: show nothing.
      });
    return () => {
      controller.abort();
    };
  }, []);

  // After a delete: the next entry's button, or the page title when none is left.
  useEffect(() => {
    const id = focusAfter.current;
    if (id === null) return;
    focusAfter.current = null;
    (buttons.current.get(id) ?? fallbackFocus.current)?.focus();
  }, [ids, fallbackFocus]);

  // Cancel: back to the button that opened the dialog, once the dialog is gone.
  useEffect(() => {
    if (target !== null || !returnFocusTo.current) return;
    returnFocusTo.current.focus();
    returnFocusTo.current = null;
  }, [target]);

  const finish = (id: string, message: string) => {
    const at = ids.indexOf(id);
    focusAfter.current = ids[at + 1] ?? ids[at - 1] ?? '';
    setTarget(null);
    setIds((current) => current.filter((other) => other !== id));
    onDeleted(message);
  };

  const confirm = () => {
    if (!target || target.deleting) return;
    const { id } = target;
    setTarget({ ...target, deleting: true, error: null });
    deleteModel(id)
      .then(() => {
        finish(id, 'Deleted the damaged model.');
      })
      .catch((error: unknown) => {
        if (error instanceof ApiRequestError && error.status === 404) {
          finish(id, 'This damaged model was already deleted.');
          return;
        }
        setTarget((current) =>
          current
            ? {
                ...current,
                deleting: false,
                error:
                  error instanceof ApiRequestError
                    ? `The model wasn't deleted. ${error.message}`
                    : "The model wasn't deleted.",
              }
            : current,
        );
      });
  };

  if (ids.length === 0 && target === null) return null;

  return (
    <section className="table-card damaged" aria-labelledby="damaged-title">
      <h2 id="damaged-title">
        <Icon name="alert" />
        Damaged models
      </h2>
      <p className="muted">
        These stored files can&apos;t be read or don&apos;t pass validation, so they can&apos;t be
        opened. They still count towards the limit. Delete them, or repair them on the server.
      </p>
      <ul>
        {ids.map((id) => (
          <li key={id}>
            <code className="damaged-id">{id}</code>
            <span className="muted">Damaged; can&apos;t be opened</span>
            <button
              ref={(element) => {
                if (element) buttons.current.set(id, element);
                else buttons.current.delete(id);
              }}
              className="icon-btn"
              type="button"
              aria-label={`Delete damaged model ${id}`}
              title="Delete"
              onClick={(event) => {
                setTarget({ id, opener: event.currentTarget, deleting: false, error: null });
              }}
            >
              <Icon name="trash" />
            </button>
          </li>
        ))}
      </ul>
      {target && (
        <DeleteDialog
          name="damaged model"
          description={`This deletes the stored file ${target.id}. It can't be opened, so nothing in it can be shown. It can't be undone.`}
          deleting={target.deleting}
          error={target.error}
          onCancel={() => {
            returnFocusTo.current = target.opener;
            setTarget(null);
          }}
          onConfirm={confirm}
        />
      )}
    </section>
  );
}
