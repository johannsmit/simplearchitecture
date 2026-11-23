import { useEffect, useState } from 'react';

/**
 * `N`: a new element at the centre of the view, while `active` (not while typing, and not over an
 * open dialog or popover). Goes up by one for each press.
 */
export function useNewElementKey(active: boolean): number {
  const [newElementRequest, setNewElementRequest] = useState(0);
  useEffect(() => {
    if (!active) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'n' && event.key !== 'N') return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement &&
          (target.isContentEditable || target.closest('.rel-pop, .new-pop, .add-rel') !== null))
      ) {
        return;
      }
      if (window.document.querySelector('dialog[open]')) return;
      event.preventDefault();
      setNewElementRequest((n) => n + 1);
    };
    window.document.addEventListener('keydown', onKey);
    return () => {
      window.document.removeEventListener('keydown', onKey);
    };
  }, [active]);
  return newElementRequest;
}
