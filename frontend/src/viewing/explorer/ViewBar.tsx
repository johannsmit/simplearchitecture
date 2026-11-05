import { useEffect, useRef, useState, type RefObject } from 'react';
import { Icon } from '../../icons';

interface ViewBarProps {
  name: string;
  /** Rename and Delete: Modelling with editing on. */
  editable: boolean;
  saving: boolean;
  /** Goes up by one after each save: "Saved" shows for 3 seconds. */
  savedCount: number;
  /** Rename and Delete wait while a change is being saved (it changes the version). */
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
  /** Move focus to the heading (a view opened from the list, saved, or read again). */
  focusHeading: boolean;
  onHeadingFocused: () => void;
  renameRef: RefObject<HTMLButtonElement | null>;
}

/** Under the toolbar while a view is open: the one clear sign of being in a view. */
export function ViewBar({
  name,
  editable,
  saving,
  savedCount,
  onRename,
  onDelete,
  onClose,
  focusHeading,
  onHeadingFocused,
  renameRef,
}: ViewBarProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [savedShown, setSavedShown] = useState<number | null>(null);
  const headingFocused = useRef(onHeadingFocused);
  useEffect(() => {
    headingFocused.current = onHeadingFocused;
  });

  useEffect(() => {
    if (!focusHeading) return;
    heading.current?.focus();
    headingFocused.current();
  }, [focusHeading]);

  const firstCount = useRef(savedCount);
  useEffect(() => {
    if (savedCount === firstCount.current) return;
    setSavedShown(savedCount);
    const timer = setTimeout(() => {
      setSavedShown(null);
    }, 3000);
    return () => {
      clearTimeout(timer);
    };
  }, [savedCount]);

  const status = saving ? 'Saving…' : savedShown === savedCount ? 'Saved' : '';
  return (
    <section className="view-bar" aria-labelledby="view-name">
      <h2 ref={heading} id="view-name" tabIndex={-1}>
        <span className="mode-pill">
          <Icon name="bookmark" size="sm" />
          View
        </span>{' '}
        <span className="vname" title={name}>
          {name || '(unnamed)'}
        </span>
      </h2>
      <span className="vstatus" role="status">
        {editable && status !== '' && (
          <>
            {status === 'Saved' && <Icon name="check" size="sm" />}
            <span className="vstatus-text">{status}</span>
          </>
        )}
      </span>
      {editable && (
        <>
          <button
            ref={renameRef}
            type="button"
            className="btn vbtn"
            aria-label="Rename"
            title="Rename the view"
            aria-disabled={saving || undefined}
            onClick={() => {
              if (!saving) onRename();
            }}
          >
            <Icon name="pencil" size="sm" />
            <span className="vlabel">Rename</span>
          </button>
          <button
            type="button"
            className="btn vbtn"
            aria-label="Delete"
            title="Delete the view"
            aria-disabled={saving || undefined}
            onClick={() => {
              if (!saving) onDelete();
            }}
          >
            <Icon name="trash" size="sm" />
            <span className="vlabel">Delete</span>
          </button>
        </>
      )}
      <button
        type="button"
        className="btn vbtn"
        aria-label="Close view"
        title="Close view"
        onClick={onClose}
      >
        <Icon name="x" size="sm" />
        <span className="vlabel">Close view</span>
      </button>
    </section>
  );
}
