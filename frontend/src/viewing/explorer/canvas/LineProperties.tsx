import type { RelationshipViewField } from '@simplearchitecture/shared';
import { useRef, type Ref } from 'react';
import { maxShownKeyLength, maxShownProperties } from '../../paths';

interface LinePropertiesProps {
  fields: readonly RelationshipViewField[];
  shown: readonly string[];
  onChange: (keys: string[]) => void;
  /** The panel's box: the canvas keeps cards clear of it. */
  ref?: Ref<HTMLDivElement>;
}

/**
 * Show Viewpoints: which relationship properties the lines show, always open at the canvas's top
 * left. Lines without any of them are grayed out. It only changes how lines look, so nothing on
 * the canvas moves.
 */
export function LineProperties({ fields, shown, onChange, ref }: LinePropertiesProps) {
  const list = useRef<HTMLDivElement>(null);
  const full = shown.length >= maxShownProperties;
  return (
    <div
      ref={ref}
      className="line-props"
      role="group"
      aria-labelledby="sv-title"
      // The canvas's own keys (depth, arrows, T, M) wait while focus is in here; Esc goes back to
      // the canvas, as it does from a card.
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          document.getElementById('canvas')?.focus();
        }
      }}
      // A wheel over it scrolls its choices, never zooms the canvas.
      onWheel={(event) => {
        event.stopPropagation();
      }}
    >
      <div className="line-props-head">
        <span id="sv-title">Show Viewpoints</span>
        {shown.length > 0 && (
          <button
            type="button"
            className="linkbtn"
            onClick={() => {
              onChange([]);
              // Clear goes away with the selection, so focus moves to the first box.
              list.current?.querySelector('input')?.focus();
            }}
          >
            Clear
          </button>
        )}
      </div>
      {fields.length === 0 ? (
        <p className="line-props-note">No Relations in this model yet.</p>
      ) : (
        <>
          <div ref={list} className="line-props-list">
            {fields.map(({ key, label: name }) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={shown.includes(key)}
                  // A name this long, or one past the cap, wouldn't survive in the address.
                  disabled={!shown.includes(key) && (full || key.length > maxShownKeyLength)}
                  onChange={(event) => {
                    onChange(
                      event.target.checked
                        ? [...shown, key]
                        : shown.filter((other) => other !== key),
                    );
                  }}
                />
                {name}
                {key.length > maxShownKeyLength && ' (name too long to select)'}
              </label>
            ))}
          </div>
          {/* Outside the part that scrolls, so it is seen whichever box was ticked. */}
          <div role="status" className="line-props-status">
            {full && (
              <p className="line-props-note">At most {maxShownProperties} properties at a time.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
