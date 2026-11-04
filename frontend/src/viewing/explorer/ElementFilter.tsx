import {
  fieldValueCounts,
  pickedValues,
  type ElementFilters,
  type FilterField,
  type ModelGraph,
} from '@simplearchitecture/shared';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { Icon } from '../../icons';
import { counted, formatNumber } from '../../words';

/** Fields with more values than this get a "Find a value…" box. */
export const findBoxThreshold = 10;

const countryNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return undefined;
  }
})();

/** A value as shown: a Supplier HQ country as "Netherlands (NL)", anything else as it is. */
export function displayValue(key: string, value: string | null): string {
  if (value === null) return '(not set)';
  if (key === 'supplierHqCountry' && /^[A-Z]{2}$/.test(value)) {
    try {
      const name = countryNames?.of(value);
      if (name && name !== value) return `${name} (${value})`;
    } catch {
      // Not a region code Intl knows: shown as it is.
    }
  }
  return value;
}

/** The picked values of a field in the field's own order, "(not set)" last. */
export function orderedPicks(field: FilterField, picked: readonly (string | null)[]) {
  const set = new Set(picked);
  const values: (string | null)[] = field.values
    .map((entry) => entry.value)
    .filter((value) => set.has(value));
  // Values no longer in the model (none today) still show, before "(not set)".
  for (const value of picked) {
    if (value !== null && !values.includes(value)) values.push(value);
  }
  if (set.has(null)) values.push(null);
  return values;
}

/** "Payments, Sales or Data" */
export function valuesInWords(field: FilterField, picked: readonly (string | null)[]): string {
  const words = orderedPicks(field, picked).map((value) => displayValue(field.key, value));
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1] ?? ''}`;
}

/** Visible chip values: one or two in full, else the first and "+N". */
function chipValues(field: FilterField, picked: readonly (string | null)[]): string {
  const words = orderedPicks(field, picked).map((value) => displayValue(field.key, value));
  if (words.length <= 2) return words.join(', ');
  return `${words[0] ?? ''} +${words.length - 1}`;
}

/** The filters with one field's values replaced; no values removes the field. */
export function withField(
  filters: ElementFilters,
  key: string,
  values: readonly (string | null)[],
): ElementFilters {
  const others = Object.entries(filters).filter(([other]) => other !== key);
  return Object.fromEntries(values.length === 0 ? others : [...others, [key, values]]);
}

/** Number of fields with a filter (= the number of chips). */
export function activeFilterCount(filters: ElementFilters): number {
  return Object.values(filters).filter((values) => values.length > 0).length;
}

interface FilterButtonProps {
  graph: ModelGraph;
  fields: readonly FilterField[];
  query: string;
  filters: ElementFilters;
  onChange: (filters: ElementFilters) => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}

/**
 * The Filter button and its non-modal popover: pick a field, then values. Changes apply at once.
 * Closes on Esc, a click outside, focus leaving it, or the button.
 */
export function FilterButton(props: FilterButtonProps) {
  const { graph, fields, query, filters, onChange, buttonRef } = props;
  const [open, setOpen] = useState(false);
  const [fieldKey, setFieldKey] = useState<string | undefined>();
  const [find, setFind] = useState('');
  const popover = useRef<HTMLDivElement>(null);
  /** What to focus after the next render: a field row, the first value, or nothing. */
  const focusNext = useRef<{ kind: 'field'; key: string | undefined } | { kind: 'values' } | null>(
    null,
  );
  const [maxHeight, setMaxHeight] = useState<number | undefined>();
  const active = activeFilterCount(filters);
  const field = fieldKey === undefined ? undefined : fields.find((f) => f.key === fieldKey);

  const close = (refocus: boolean) => {
    setOpen(false);
    setFieldKey(undefined);
    setFind('');
    if (refocus) buttonRef.current?.focus();
  };

  // A click outside closes it; focus goes where the click put it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (popover.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
      setFieldKey(undefined);
      setFind('');
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, buttonRef]);

  // At most min(420px, the viewport bottom − 16px) high; the list part scrolls.
  useLayoutEffect(() => {
    if (!open) return;
    const top = popover.current?.getBoundingClientRect().top ?? 0;
    setMaxHeight(Math.max(160, Math.min(420, window.innerHeight - top - 16)));
  }, [open]);

  // Focus after a step change: the field row (step 1) or the find box / first checkbox (step 2).
  useEffect(() => {
    const next = focusNext.current;
    if (!next || !open) return;
    focusNext.current = null;
    const box = popover.current;
    if (!box) return;
    if (next.kind === 'field') {
      const rows = [...box.querySelectorAll<HTMLButtonElement>('.fp-field')];
      (rows.find((row) => row.dataset.key === next.key) ?? rows[0])?.focus();
    } else {
      (
        box.querySelector<HTMLInputElement>('.fp-find input') ??
        box.querySelector<HTMLInputElement>('input[type="checkbox"]')
      )?.focus();
    }
  });

  const counts = useMemo(
    () => (field ? fieldValueCounts(graph, field, { query, filters }) : undefined),
    [graph, field, query, filters],
  );

  const picked = field ? pickedValues(filters, field.key) : [];
  const setPicked = (key: string, values: (string | null)[]) => {
    onChange(withField(filters, key, values));
  };
  const toggleValue = (value: string | null) => {
    if (!field) return;
    setPicked(
      field.key,
      picked.includes(value) ? picked.filter((v) => v !== value) : [...picked, value],
    );
  };

  const openField = (key: string) => {
    setFieldKey(key);
    setFind('');
    focusNext.current = { kind: 'values' };
  };
  const backToFields = () => {
    focusNext.current = { kind: 'field', key: fieldKey };
    setFieldKey(undefined);
    setFind('');
  };

  /** ↑ ↓ Home End between the elements matching `selector`. */
  const moveAmong = (event: KeyboardEvent, selector: string): boolean => {
    const items = [...(popover.current?.querySelectorAll<HTMLElement>(selector) ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    let to: number | undefined;
    if (event.key === 'ArrowDown') to = at === -1 ? 0 : Math.min(at + 1, items.length - 1);
    else if (event.key === 'ArrowUp') to = at === -1 ? 0 : Math.max(at - 1, 0);
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = items.length - 1;
    if (to === undefined) return false;
    event.preventDefault();
    items[to]?.focus();
    return true;
  };

  const onPopoverKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    const target = event.target as HTMLElement;
    if (!field) {
      if (moveAmong(event, '.fp-field')) return;
      if (event.key === 'ArrowRight' && target.classList.contains('fp-field')) {
        event.preventDefault();
        const key = target.dataset.key;
        if (key !== undefined) openField(key);
      }
      return;
    }
    const inFind = target.closest('.fp-find') !== null;
    if (inFind) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        popover.current?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus();
      }
      return;
    }
    if (target instanceof HTMLInputElement && target.type === 'checkbox') {
      if (
        (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
        moveAmong(event, '.fp-value input')
      ) {
        return;
      }
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      backToFields();
    }
  };

  const needle = find.trim().toLowerCase();
  const valueRows =
    field && counts
      ? counts.values.filter(
          ({ value }) =>
            needle === '' ||
            picked.includes(value) ||
            displayValue(field.key, value).toLowerCase().includes(needle),
        )
      : [];
  const standardFields = fields.filter((f) => f.standard);
  const customFields = fields.filter((f) => !f.standard);

  const fieldRow = (f: FilterField) => {
    const count = pickedValues(filters, f.key).length;
    return (
      <li key={f.key}>
        <button
          type="button"
          className="fp-field"
          data-key={f.key}
          aria-label={count > 0 ? `${f.label}, ${formatNumber(count)} picked` : f.label}
          onClick={() => {
            openField(f.key);
          }}
        >
          <span className="fp-label">{f.label}</span>
          {count > 0 && <span className="count picked">{formatNumber(count)}</span>}
          <Icon name="chev-right" />
        </button>
      </li>
    );
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`filter-btn${active > 0 || open ? ' is-active' : ''}`}
        aria-label={
          active > 0 ? `Filter elements, ${counted(active, 'filter')} on` : 'Filter elements'
        }
        title="Filter by metadata"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close(false);
          } else {
            setOpen(true);
            focusNext.current = { kind: 'field', key: undefined };
          }
        }}
      >
        <Icon name="list-filter" />
        {active > 0 && (
          <span className="filter-count" aria-hidden="true">
            {active}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={popover}
          className="filter-pop"
          role="dialog"
          aria-label="Filter elements"
          style={maxHeight === undefined ? undefined : { maxHeight }}
          onKeyDown={onPopoverKeyDown}
          onBlur={(event) => {
            const to = event.relatedTarget as Node | null;
            // Focus moved out by itself (Tab past the end, or elsewhere): close, focus stays.
            if (to && !popover.current?.contains(to) && !buttonRef.current?.contains(to)) {
              close(false);
            }
          }}
        >
          {field && counts ? (
            <>
              <div className="fp-head">
                <button
                  type="button"
                  className="fp-back"
                  aria-label="Back to fields"
                  onClick={backToFields}
                >
                  <Icon name="back" />
                  <span>{field.label}</span>
                </button>
                {picked.length > 0 && (
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() => {
                      setPicked(field.key, []);
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
              {field.values.length > findBoxThreshold && (
                <div className="fp-find">
                  <Icon name="search" size="sm" />
                  <input
                    type="search"
                    aria-label={`Find a value of ${field.label}`}
                    placeholder="Find a value…"
                    value={find}
                    onChange={(event) => {
                      setFind(event.target.value);
                    }}
                  />
                </div>
              )}
              <fieldset className="fp-list">
                <legend className="vh">{field.label}</legend>
                {[...valueRows, { value: null, count: counts.notSetCount }].map(
                  ({ value, count }) => {
                    const text = displayValue(field.key, value);
                    const name = `${value === null ? 'Not set' : text}, ${counted(count, 'element')}`;
                    return (
                      <label
                        key={value ?? '\u0000not-set'}
                        className={`fp-value${count === 0 ? ' is-zero' : ''}${value === null ? ' is-not-set' : ''}`}
                        title={text}
                      >
                        <input
                          type="checkbox"
                          aria-label={name}
                          checked={picked.includes(value)}
                          onChange={() => {
                            toggleValue(value);
                          }}
                        />
                        <span className="fp-label">{text}</span>
                        <span className="count">{formatNumber(count)}</span>
                      </label>
                    );
                  },
                )}
              </fieldset>
            </>
          ) : fields.length === 0 ? (
            <p className="fp-none">This model has no metadata to filter on.</p>
          ) : (
            <div className="fp-list">
              <div className="fp-title" aria-hidden="true">
                Filter by
              </div>
              <ul aria-label="Fields">{standardFields.map(fieldRow)}</ul>
              {customFields.length > 0 && (
                <>
                  <div className="fp-custom" aria-hidden="true">
                    Custom
                  </div>
                  <ul aria-label="Custom fields">{customFields.map(fieldRow)}</ul>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

interface FilterChipsProps {
  fields: readonly FilterField[];
  filters: ElementFilters;
  onChange: (filters: ElementFilters) => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}

/** One chip per field with a filter, each with ×; "Clear all" from 2 chips. */
export function FilterChips({ fields, filters, onChange, buttonRef }: FilterChipsProps) {
  const row = useRef<HTMLDivElement>(null);
  /** After a removal: the index of the chip whose × gets focus (or the button when none). */
  const focusAt = useRef<number | null>(null);
  const active = fields.filter((field) => pickedValues(filters, field.key).length > 0);

  useEffect(() => {
    const at = focusAt.current;
    if (at === null) return;
    focusAt.current = null;
    const buttons = [...(row.current?.querySelectorAll<HTMLButtonElement>('.chip-x') ?? [])];
    const target = buttons[Math.min(at, buttons.length - 1)];
    if (target) target.focus();
    else buttonRef.current?.focus();
  });

  if (active.length === 0) return null;
  return (
    <div className="filter-chips" role="group" aria-label="Active filters" ref={row}>
      {active.map((field, index) => {
        const picked = pickedValues(filters, field.key);
        const full = `${field.label}: ${valuesInWords(field, picked)}`;
        return (
          <span key={field.key} className="filter-chip" title={full}>
            <span className="chip-text">
              <span className="chip-field">{field.label}:</span> {chipValues(field, picked)}
            </span>
            <button
              type="button"
              className="chip-x"
              aria-label={`Remove filter: ${field.label} is ${valuesInWords(field, picked)}`}
              onClick={() => {
                focusAt.current = index;
                onChange(withField(filters, field.key, []));
              }}
            >
              <Icon name="x" size="sm" />
            </button>
          </span>
        );
      })}
      {active.length >= 2 && (
        <button
          type="button"
          className="linkbtn chips-clear"
          aria-label="Clear all filters"
          onClick={() => {
            focusAt.current = -1;
            onChange({});
          }}
        >
          Clear all
        </button>
      )}
    </div>
  );
}
