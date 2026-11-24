import type { Neighbourhood } from '@simplearchitecture/shared';
import { useMemo, useState } from 'react';
import { noRoutes, type Laid } from './canvasModel';
import { bendLinkIdsOf, floatingOf, handRoutesOf, type LineDrag } from './canvasLines';
import type { EndBox } from './edgeLine';
import type { HeldRoute } from './lineRoutes';
import type { Box } from './positions';

/** Lines moved by hand (in a view): the routes this canvas started with, or as last dragged. */
export function useHeldRoutes(laid: Laid | null, hood: Neighbourhood) {
  const [heldState, setHeldState] = useState<{
    canvas: number;
    routes: ReadonlyMap<string, HeldRoute>;
  } | null>(null);
  const held = laid
    ? heldState?.canvas === laid.canvas
      ? heldState.routes
      : laid.routes
    : noRoutes;

  // A line taken out of the view, or given other ends, loses its route for good, as on the server
  // (set while rendering, as React recommends for state that follows a prop).
  if (laid && held.size > 0) {
    const ends = new Map(hood.relationships.map((relationship) => [relationship.id, relationship]));
    const kept = [...held].filter(([id, route]) => {
      const now = ends.get(id);
      return now?.source === route.source && now.target === route.target;
    });
    if (kept.length !== held.size) setHeldState({ canvas: laid.canvas, routes: new Map(kept) });
  }
  return { held, setHeldState };
}

/**
 * How every line runs: moved by hand, or drawn by the canvas between its cards (never on the
 * layout's route); and the lines whose bend handles show.
 */
export function useLineRoutes(input: {
  laid: Laid | null;
  absolute: ReadonlyMap<string, Box>;
  endBoxes: ReadonlyMap<string, EndBox>;
  held: ReadonlyMap<string, HeldRoute>;
  /** Bend handles can show now. */
  bendsAllowed: boolean;
  lineDrag: LineDrag | null;
  hoveredLink: string | undefined;
  /** The relationship open in the details panel. */
  chosen: string | undefined;
}) {
  const { laid, absolute, endBoxes, held, bendsAllowed, lineDrag, hoveredLink, chosen } = input;
  // Lines moved by hand, with their cards where they are now: the stretches the person moved stay,
  // and the stretches at a moved card's end follow it.
  const handRoutes = useMemo(() => handRoutesOf(laid, endBoxes, held), [laid, endBoxes, held]);
  // Lines not moved by hand: their ends on the sides where their cards face each other now, so
  // they follow a moved card (live, while it is dragged) and take the shortest way.
  const floating = useMemo(
    () => floatingOf(laid, absolute, endBoxes, handRoutes),
    [laid, absolute, endBoxes, handRoutes],
  );
  // Bend handles show on the line under the pointer and on the open relationship's line; while a
  // bend is dragged, only on its line.
  const bendLinkIds = useMemo(
    () => bendLinkIdsOf(bendsAllowed, laid, lineDrag, hoveredLink, chosen),
    [bendsAllowed, laid, lineDrag, hoveredLink, chosen],
  );
  return { handRoutes, floating, bendLinkIds };
}
