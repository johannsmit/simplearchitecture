import { groupByLabel, type GroupByChoice } from '@simplearchitecture/shared';
import { useEffect, useRef, type Ref } from 'react';
import { maxGroupByKeyLength } from '../../paths';

interface GroupByPanelProps {
  /** The model's choices: Type, the standard properties, then custom keys. */
  choices: readonly GroupByChoice[];
  /** The property grouped by, or undefined for none. */
  chosen: string | undefined;
  onChange: (key: string | undefined) => void;
  ref?: Ref<HTMLDivElement>;
}

/**
 * Group by: one element property at a time, always open under Show Viewpoints. A choice lays the
 * canvas out again in one box per value; Clear lays it out without boxes. A chosen key the model
 * doesn't have (an old address, or a view) stays listed, checked, so it can be seen and cleared.
 */
export function GroupByPanel({ choices, chosen, onChange, ref }: GroupByPanelProps) {
  const list = useRef<HTMLDivElement>(null);
  const known = chosen === undefined || choices.some((choice) => choice.key === chosen);
  const gone: GroupByChoice | undefined =
    chosen === undefined || known
      ? undefined
      : {
          key: chosen,
          label: groupByLabel(chosen),
          standard: groupByLabel(chosen) !== chosen,
        };
  const standard = [
    ...choices.filter((choice) => choice.standard),
    ...(gone?.standard === true ? [gone] : []),
  ];
  const custom = [
    ...choices.filter((choice) => !choice.standard),
    ...(gone?.standard === false ? [gone] : []),
  ];

  // The chosen row is in view in the list, also when it is set from outside (the address, a view).
  // The list's own box scrolls, not scrollIntoView(): in Chromium that also moves the Tab starting
  // point into the panel.
  useEffect(() => {
    const box = list.current;
    const row = box?.querySelector('input:checked')?.closest('label');
    if (!box || !row) return;
    const rowBox = row.getBoundingClientRect();
    const listBox = box.getBoundingClientRect();
    if (rowBox.top < listBox.top) box.scrollTop -= listBox.top - rowBox.top;
    else if (rowBox.bottom > listBox.bottom) box.scrollTop += rowBox.bottom - listBox.bottom;
  }, [chosen]);

  const row = ({ key, label }: GroupByChoice) => {
    const tooLong = key.length > maxGroupByKeyLength;
    return (
      <label key={key}>
        <input
          type="radio"
          name="group-by"
          checked={key === chosen}
          // A name this long wouldn't survive in the address.
          disabled={key !== chosen && tooLong}
          onChange={() => {
            onChange(key);
          }}
        />
        {label}
        {tooLong && ' (name too long to select)'}
      </label>
    );
  };

  return (
    <div
      ref={ref}
      className="line-props group-by"
      role="radiogroup"
      aria-labelledby="gb-title"
      // As Show Viewpoints: the canvas's own keys wait while focus is in here; Esc goes back to
      // the canvas.
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
        <span id="gb-title">Group by</span>
        {chosen !== undefined && (
          <button
            type="button"
            className="linkbtn"
            onClick={() => {
              onChange(undefined);
              // Clear goes away with the choice, so focus moves to the first choice.
              list.current?.querySelector('input')?.focus();
            }}
          >
            Clear
          </button>
        )}
      </div>
      <div ref={list} className="line-props-list">
        {standard.map(row)}
        {custom.length > 0 && (
          <>
            <div className="gb-custom" aria-hidden="true">
              Custom
            </div>
            {custom.map(row)}
          </>
        )}
      </div>
    </div>
  );
}
