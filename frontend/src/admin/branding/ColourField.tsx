import type { BrandValueReport } from '@simplearchitecture/shared';
import type { RefObject } from 'react';
import { Icon } from '../../icons';

/** The picker shows the neutral accent when no colour is set. */
const neutralPick = '#3657d6';

export const hexMessage = 'Enter a colour as # and six hex digits, for example #1d6b5f.';

/** A hex field's text as `#rrggbb` (any case, with or without #), null when empty, or invalid. */
export function parseHex(text: string): `#${string}` | null | 'invalid' {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const digits = /^#?([0-9a-f]{6})$/i.exec(trimmed)?.[1];
  return digits === undefined ? 'invalid' : `#${digits.toLowerCase()}`;
}

/** "Dark theme uses #2f9f8e, so it keeps 4.5:1 contrast." or null when nothing was adjusted. */
export function adjustedText(
  light: BrandValueReport,
  dark: BrandValueReport,
  target: string,
  what = '',
): string | null {
  const lightValue = light.adjusted ? light.value : null;
  const darkValue = dark.adjusted ? dark.value : null;
  if (lightValue === null && darkValue === null) return null;
  const uses =
    lightValue !== null && darkValue !== null
      ? `Light theme uses ${lightValue} and dark theme uses ${darkValue}`
      : lightValue !== null
        ? `Light theme uses ${lightValue}`
        : `Dark theme uses ${darkValue ?? ''}`;
  return `${uses}${what}, so it keeps ${target} contrast.`;
}

interface ColourFieldProps {
  id: 'primary' | 'secondary';
  label: string;
  hint: string;
  text: string;
  error: string | undefined;
  adjusted: string | null;
  busy: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onText: (text: string) => void;
  onBlur: () => void;
}

/** A colour as a native picker, a hex field and a clear button. */
export function ColourField({ inputRef, ...props }: ColourFieldProps) {
  const name = props.label.toLowerCase();
  const parsed = parseHex(props.text);
  const fieldId = `brand-${props.id}`;
  const describedBy = [
    `${fieldId}-hint`,
    props.adjusted === null ? '' : `${fieldId}-adjusted`,
    props.error === undefined ? '' : `${fieldId}-error`,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="field">
      <label htmlFor={fieldId}>{props.label}</label>
      <div className="colour-row">
        <input
          type="color"
          className="colour-pick"
          aria-label={`Pick ${name}`}
          value={parsed === null || parsed === 'invalid' ? neutralPick : parsed}
          disabled={props.busy}
          onChange={(event) => {
            props.onText(event.target.value.toLowerCase());
          }}
        />
        <input
          ref={inputRef}
          id={fieldId}
          type="text"
          className="colour-hex"
          placeholder="Not set"
          spellCheck={false}
          autoComplete="off"
          maxLength={7}
          inputMode="text"
          readOnly={props.busy}
          value={props.text}
          aria-invalid={props.error === undefined ? undefined : true}
          aria-describedby={describedBy}
          onChange={(event) => {
            props.onText(event.target.value);
          }}
          onBlur={props.onBlur}
        />
        {props.text !== '' && (
          <button
            type="button"
            className="icon-btn"
            aria-label={`Clear ${name}`}
            disabled={props.busy}
            onClick={() => {
              props.onText('');
              inputRef.current?.focus();
            }}
          >
            <Icon name="x" />
          </button>
        )}
      </div>
      <p className="colour-hint" id={`${fieldId}-hint`}>
        {props.hint}
      </p>
      {props.adjusted !== null && (
        <p className="colour-adjusted" id={`${fieldId}-adjusted`}>
          <Icon name="info" size="sm" />
          <span>{props.adjusted}</span>
        </p>
      )}
      {props.error !== undefined && (
        <p className="field-error" id={`${fieldId}-error`}>
          <Icon name="alert" size="sm" />
          <span>{props.error}</span>
        </p>
      )}
    </div>
  );
}
