import {
  containsType,
  relationshipGroups,
  type ModelElement,
  type ModelGraph,
} from '@simplearchitecture/shared';
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Icon } from '../icons';
import { counted } from '../words';

/** How many relationships the delete dialog names. */
export const namedRelationships = 5;

interface ModalProps {
  id: string;
  className?: string;
  /** Esc and the backdrop's cancel; ignored while `busy`. */
  onCancel: () => void;
  busy: boolean;
  /** Gets focus when the dialog opens. */
  initialFocus: RefObject<HTMLElement | null>;
  describedBy: string;
  children: ReactNode;
}

/** A native modal `<dialog>` in the delete dialog's look; open while mounted. */
export function Modal({
  id,
  className,
  onCancel,
  busy,
  initialFocus,
  describedBy,
  children,
}: ModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    // Browsers without showModal (and test DOMs) still get an open dialog, just not modal.
    if (typeof element.showModal === 'function') {
      if (!element.open) element.showModal();
    } else {
      element.setAttribute('open', '');
    }
    initialFocus.current?.focus();
    return () => {
      if (typeof element.close === 'function' && element.open) element.close();
    };
  }, [initialFocus]);
  return (
    <dialog
      ref={dialog}
      className={`delete-dialog${className ? ` ${className}` : ''}`}
      aria-labelledby={`${id}-title`}
      aria-describedby={describedBy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) onCancel();
        }
      }}
    >
      {children}
    </dialog>
  );
}

interface UnsavedDialogProps {
  name: string;
  /** 'leave': Keep editing, Discard, Save. 'discard': Keep editing, Discard changes. */
  kind: 'leave' | 'discard';
  /**
   * A relationship's form: its own words; `name` is its sentence.
   * Branding: Admin → Branding's words; `name` is unused.
   */
  subject?: 'element' | 'relationship' | 'branding';
  saving: boolean;
  /** Save is off while a conflict shows (another save would fail the same way). */
  canSave: boolean;
  onKeep: () => void;
  onDiscard: () => void;
  onSave: () => void;
}

/** Asks before unsaved changes are dropped. Focus starts on Keep editing; Esc keeps editing. */
export function UnsavedDialog(props: UnsavedDialogProps) {
  const keep = useRef<HTMLButtonElement>(null);
  const shown = props.name.trim() || 'this element';
  return (
    <Modal
      id="unsaved"
      className="unsaved-dialog"
      onCancel={props.onKeep}
      busy={props.saving}
      initialFocus={keep}
      describedBy="unsaved-text"
    >
      {props.subject === 'branding' ? (
        <>
          <h2 id="unsaved-title">Save changes to the branding?</h2>
          <p id="unsaved-text">
            You&apos;ve changed the branding. Save the changes, or discard them.
          </p>
        </>
      ) : props.subject === 'relationship' ? (
        props.kind === 'leave' ? (
          <>
            <h2 id="unsaved-title">Save changes to this relationship?</h2>
            <p id="unsaved-text">
              You&apos;ve changed {props.name}. Save the changes, or discard them.
            </p>
          </>
        ) : (
          <>
            <h2 id="unsaved-title">Discard changes?</h2>
            <p id="unsaved-text">
              Your changes to {props.name} aren&apos;t saved. Discarding them can&apos;t be undone.
            </p>
          </>
        )
      ) : props.kind === 'leave' ? (
        <>
          <h2 id="unsaved-title">Save changes to “{shown}”?</h2>
          <p id="unsaved-text">
            You&apos;ve changed this element. Save the changes, or discard them.
          </p>
        </>
      ) : (
        <>
          <h2 id="unsaved-title">Discard changes?</h2>
          <p id="unsaved-text">
            Your changes to “{shown}” aren&apos;t saved. Discarding them can&apos;t be undone.
          </p>
        </>
      )}
      <div className="row">
        <button
          ref={keep}
          className="btn"
          type="button"
          disabled={props.saving}
          onClick={props.onKeep}
        >
          Keep editing
        </button>
        {props.kind === 'leave' ? (
          <>
            <button className="btn" type="button" disabled={props.saving} onClick={props.onDiscard}>
              Discard
            </button>
            <button
              className="btn primary"
              type="button"
              disabled={props.saving || !props.canSave}
              onClick={props.onSave}
            >
              {props.saving ? 'Saving…' : 'Save'}
            </button>
          </>
        ) : (
          <button className="btn danger" type="button" onClick={props.onDiscard}>
            Discard changes
          </button>
        )}
      </div>
    </Modal>
  );
}

export interface DeleteSummary {
  count: number;
  /** "Integrates with Customer Portal", in the details panel's group order. */
  named: string[];
  /** Distinct elements this one contains. */
  contained: number;
}

/** What deleting an element takes with it. */
export function deleteSummary(graph: ModelGraph, element: ModelElement): DeleteSummary {
  const relationships = graph.relationshipsByElement.get(element.id) ?? [];
  const seen = new Set<string>();
  const named: string[] = [];
  for (const group of relationshipGroups(graph, element.id)) {
    for (const { relationship, other, self } of group.rows) {
      if (seen.has(relationship.id)) continue;
      seen.add(relationship.id);
      named.push(`${group.heading} ${self ? '(this element)' : other.name || '(unnamed)'}`);
    }
  }
  const contained = new Set(
    relationships
      .filter((r) => r.type === containsType && r.source === element.id && r.target !== element.id)
      .map((r) => r.target),
  );
  return { count: relationships.length, named, contained: contained.size };
}

interface DeleteElementDialogProps {
  name: string;
  summary: DeleteSummary;
  deleting: boolean;
  error: string | null;
  /** The element changed meanwhile (409): the danger button becomes Reload. */
  stale: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onReload: () => void;
}

export function DeleteElementDialog(props: DeleteElementDialogProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  const { count, named, contained } = props.summary;
  const more = named.length - namedRelationships;
  const described = [
    'delete-text',
    named.length > 0 ? 'delete-list' : '',
    contained > 0 ? 'delete-note' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Modal
      id="delete"
      className="delete-element"
      onCancel={props.onCancel}
      busy={props.deleting}
      initialFocus={cancel}
      describedBy={described}
    >
      <h2 id="delete-title">
        {props.name.trim() ? `Delete “${props.name.trim()}”?` : 'Delete this element?'}
      </h2>
      <p id="delete-text">
        {count > 0 ? (
          <>
            This deletes the element and its <b>{counted(count, 'relationship')}</b> for everyone.
            It can&apos;t be undone.
          </>
        ) : (
          "This deletes the element for everyone. It has no relationships. It can't be undone."
        )}
      </p>
      {named.length > 0 && (
        <div id="delete-list">
          <ul className="del-list">
            {named.slice(0, namedRelationships).map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
          {more > 0 && <p className="del-more">and {more} more</p>}
        </div>
      )}
      {contained > 0 && (
        <div id="delete-note" className="type-note">
          <Icon name="info" />
          <span>
            It contains <b>{counted(contained, 'element')}</b>. They stay in the model but are no
            longer nested.
          </span>
        </div>
      )}
      {props.error !== null && (
        <p className="alert" role="alert">
          {props.error}
        </p>
      )}
      <div className="row">
        <button
          ref={cancel}
          className="btn"
          type="button"
          disabled={props.deleting}
          onClick={props.onCancel}
        >
          Cancel
        </button>
        {props.stale ? (
          <button className="btn" type="button" onClick={props.onReload}>
            Reload
          </button>
        ) : (
          <button
            className="btn danger"
            type="button"
            disabled={props.deleting}
            onClick={props.onConfirm}
          >
            {props.deleting ? 'Deleting…' : 'Delete element'}
          </button>
        )}
      </div>
    </Modal>
  );
}
