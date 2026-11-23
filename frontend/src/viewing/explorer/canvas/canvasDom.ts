/** The innermost card under a point (a nested card is drawn above its container). */
export function cardAtPoint(x: number, y: number, within: HTMLElement | null): string | undefined {
  if (typeof document.elementsFromPoint !== 'function') return undefined;
  for (const element of document.elementsFromPoint(x, y)) {
    if (element.closest('.connect-handle')) continue;
    const card = element.closest('.card[data-element-id]');
    if (card && within?.contains(card)) return card.getAttribute('data-element-id') ?? undefined;
  }
  return undefined;
}

export function pointOf(event: MouseEvent | TouchEvent): { x: number; y: number } {
  const touch = 'changedTouches' in event ? event.changedTouches[0] : undefined;
  return touch
    ? { x: touch.clientX, y: touch.clientY }
    : { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY };
}

/** The element id of the card a DOM node is in, if any. */
export function cardIdOf(target: EventTarget | null): string | undefined {
  return target instanceof HTMLElement
    ? (target.closest('.card')?.getAttribute('data-element-id') ?? undefined)
    : undefined;
}

/**
 * The line nearest the pointer among those whose click area is under it. Lines fan out of a card
 * and cross, and a 20px click area then overlaps its neighbour's: without this, the line drawn on
 * top would take a click aimed at the one beside it. `fallback` is the line clicked.
 */
export function nearestLineAt(x: number, y: number, fallback: string): string {
  let under: Element[];
  try {
    under = document.elementsFromPoint(x, y);
  } catch {
    // Not there (test DOMs): the line clicked.
    return fallback;
  }
  let nearest = fallback;
  let nearestDistance = Infinity;
  for (const element of under) {
    if (!element.classList.contains('react-flow__edge-interaction')) continue;
    const path = element as SVGPathElement;
    const id = path.closest('.react-flow__edge')?.getAttribute('data-id');
    const matrix = path.getScreenCTM();
    if (!id || !matrix || typeof path.getTotalLength !== 'function') continue;
    const length = path.getTotalLength();
    // A point every 2px or so along the line (in canvas units), at most 400.
    const steps = Math.min(400, Math.max(16, Math.ceil(length / 2)));
    for (let step = 0; step <= steps; step++) {
      const point = path.getPointAtLength((length * step) / steps);
      const distance = Math.hypot(
        matrix.a * point.x + matrix.c * point.y + matrix.e - x,
        matrix.b * point.x + matrix.d * point.y + matrix.f - y,
      );
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = id;
      }
    }
  }
  return nearest;
}

/**
 * Moves each popover in the canvas back 8px inside it, now and whenever it resizes: a popover's
 * size is guessed when it is placed, and the real one can be taller (a hint, name matches) and grow
 * while typing, or the canvas's overflow cuts off its buttons. Returns the cleanup, if any.
 */
export function keepPopoversInside(host: HTMLElement): (() => void) | undefined {
  const popovers = () => host.querySelectorAll<HTMLElement>('.canvas-pop, .rel-pop, .edge-menu');
  const keepInside = () => {
    const box = host.getBoundingClientRect();
    for (const element of popovers()) {
      const rect = element.getBoundingClientRect();
      const overBottom = rect.bottom - (box.bottom - 8);
      if (overBottom > 0) element.style.top = `${Math.max(8, rect.top - box.top - overBottom)}px`;
      const overRight = rect.right - (box.right - 8);
      if (overRight > 0) element.style.left = `${Math.max(8, rect.left - box.left - overRight)}px`;
    }
  };
  keepInside();
  if (typeof ResizeObserver === 'undefined') return undefined;
  const observer = new ResizeObserver(keepInside);
  for (const element of popovers()) observer.observe(element);
  return () => {
    observer.disconnect();
  };
}
