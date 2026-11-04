import type { RelationshipViewField } from '@simplearchitecture/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '../../../icons';
import { maxShownKeyLength, maxShownProperties } from '../../paths';

interface LinePropertiesProps {
  fields: readonly RelationshipViewField[];
  shown: readonly string[];
  onChange: (keys: string[]) => void;
}

/**
 * Show Viewpoints: which relationship properties the lines show. Lines without any
 * of them are grayed out. It only changes how lines look, so nothing on the canvas moves.
 */
export function LineProperties({ fields, shown, onChange }: LinePropertiesProps) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popId = useId();

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => {
      document.removeEventListener('mousedown', outside);
    };
  }, [open]);

  const full = shown.length >= maxShownProperties;
  const label =
    shown.length === 0 ? 'Show Viewpoints' : `Show Viewpoints: ${shown.length} selected`;
  return (
    <div
      ref={box}
      className="line-props"
      // Tabbing out closes it. No target means a click (handled above) or leaving the window.
      onBlur={(event) => {
        const to = event.relatedTarget;
        if (to !== null && !box.current?.contains(to)) setOpen(false);
      }}
      // The canvas's own keys (depth, arrows, Esc) wait while focus is in here.
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape' && open) {
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="btn line-props-btn"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {label}
        <Icon name="chev-down" size="sm" />
      </button>
      {open && (
        <div id={popId} className="line-props-pop">
          {fields.length === 0 ? (
            <p className="muted">No Relations in this model yet.</p>
          ) : (
            <fieldset>
              <legend>Relationship properties</legend>
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
              <div role="status">
                {full && (
                  <p className="muted">At most {maxShownProperties} properties at a time.</p>
                )}
              </div>
              {shown.length > 0 && (
                <button
                  type="button"
                  className="linkbtn"
                  onClick={() => {
                    onChange([]);
                    // Clear goes away with the selection, so focus moves to the first box.
                    box.current?.querySelector('input')?.focus();
                  }}
                >
                  Clear
                </button>
              )}
            </fieldset>
          )}
        </div>
      )}
    </div>
  );
}
