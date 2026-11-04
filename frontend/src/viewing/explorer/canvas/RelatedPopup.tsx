import { defaultNeighbourhoodCap, type RelatedGroup } from '@simplearchitecture/shared';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { Icon } from '../../../icons';
import { TypeMark } from '../../../metamodel-ui';
import { formatNumber } from '../../../words';

interface RelatedPopupProps {
  /** The card's element name, for the popup's title. */
  name: string;
  /** The related elements that aren't on the canvas. */
  groups: readonly RelatedGroup[];
  /** Position inside the canvas section, below the pill. */
  top: number;
  left: number;
  /** No room for more elements on the canvas. */
  full: boolean;
  /** The pill that opened the popup: clicks on it don't count as "outside". */
  opener: HTMLElement;
  onPick: (id: string) => void;
  /** Closes the popup; `returnFocus` puts keyboard focus back on the pill. */
  onClose: (returnFocus: boolean) => void;
}

const itemSelector = '[role="menuitem"]';

/**
 * The elements related to a card that aren't on the canvas, grouped by relationship wording and
 * direction. A menu: arrow keys, Home and End move, Enter picks (adds the element), Esc closes and
 * returns focus to the pill, and a click outside closes.
 */
export function RelatedPopup(props: RelatedPopupProps) {
  const { onClose, opener } = props;
  const root = useRef<HTMLDivElement>(null);

  // Focus the first item when the popup opens.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>(itemSelector)?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      if (root.current?.contains(event.target) || opener.contains(event.target)) return;
      onClose(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [onClose, opener]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The canvas has its own keys (arrows, digits); none of them apply inside the popup.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose(true);
      return;
    }
    if (event.key === 'Tab') {
      onClose(false);
      return;
    }
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(itemSelector)];
    const at = items.findIndex((item) => item === document.activeElement);
    const next =
      event.key === 'ArrowDown'
        ? Math.min(at + 1, items.length - 1)
        : event.key === 'ArrowUp'
          ? Math.max(at - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    items[next]?.focus();
  };

  const total = props.groups.reduce((sum, group) => sum + group.elements.length, 0);

  return (
    <div
      ref={root}
      className="related-pop"
      style={{ top: props.top, left: props.left }}
      onKeyDown={onKeyDown}
    >
      <p className="rp-title" id="related-title">
        Not on the canvas: related to {props.name || '(unnamed)'}
      </p>
      {props.full && (
        <p className="rp-note" role="status">
          The canvas is full ({formatNumber(defaultNeighbourhoodCap)} elements). Choose a smaller
          depth to add more.
        </p>
      )}
      {total === 0 ? (
        <p className="rp-note">Every related element is on the canvas.</p>
      ) : (
        <div role="menu" aria-labelledby="related-title" className="rp-menu">
          {props.groups.map((group) => (
            <ul key={group.heading} role="group" aria-label={group.heading} className="rp-group">
              <li className="rp-heading" aria-hidden="true">
                {group.heading}
              </li>
              {group.elements.map((element) => {
                const blocked = props.full;
                const name = element.name || '(unnamed)';
                return (
                  <li key={element.id} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className="rp-item"
                      aria-disabled={blocked ? 'true' : undefined}
                      aria-label={`${name}, ${element.type}, add to canvas`}
                      onClick={() => {
                        if (!blocked) props.onPick(element.id);
                      }}
                    >
                      <TypeMark type={element.type} />
                      <span className="rp-name">{name}</span>{' '}
                      <span className="rp-type">{element.type}</span>{' '}
                      <span className="rp-add" aria-hidden="true">
                        <Icon name="plus" size="sm" />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ))}
        </div>
      )}
    </div>
  );
}
