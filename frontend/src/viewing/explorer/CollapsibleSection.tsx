import { useId, useState, type ReactNode } from 'react';
import { Icon } from '../../icons';

interface CollapsibleSectionProps {
  label: string;
  /** Shown after the label, as the section headings show a count. */
  count?: number;
  /** Open when it first shows (uncontrolled). */
  defaultOpen?: boolean;
  /** Controlled: open or closed by the caller, told of a toggle with `onToggle`. */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  /** At the end of the heading row, outside the toggle (Add relationship). */
  extra?: ReactNode;
  children: ReactNode;
}

/**
 * A details panel section that opens and closes with its heading. Closed, its body is hidden but
 * stays mounted, so a form's draft and its auto-save keep working.
 */
export function CollapsibleSection(props: CollapsibleSectionProps) {
  const id = useId();
  const [own, setOwn] = useState(props.defaultOpen ?? false);
  const open = props.open ?? own;
  const toggle = () => {
    setOwn(!open);
    props.onToggle?.(!open);
  };
  const bodyId = `${id}-body`;
  const headingId = `${id}-heading`;
  return (
    <section className={`coll${open ? ' is-open' : ''}`} aria-labelledby={headingId}>
      <div className="coll-head">
        <h3 id={headingId}>
          <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
            <Icon name="chev-right" size="sm" />
            {props.label}
            {props.count !== undefined && (
              <>
                {' '}
                <span className="count">{props.count}</span>
              </>
            )}
          </button>
        </h3>
        {props.extra}
      </div>
      <div className="coll-body" id={bodyId} hidden={!open}>
        {props.children}
      </div>
    </section>
  );
}
