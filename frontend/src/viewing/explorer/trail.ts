import { useState } from 'react';

/** The most elements the breadcrumb trail keeps; the oldest drops off. */
export const trailLength = 5;

/**
 * The trail after focusing an element: back to it when it is in the trail already (a crumb click
 * or Back), otherwise added at the end, keeping the last `trailLength` elements.
 */
export function nextTrail(trail: readonly string[], elementId: string): string[] {
  const at = trail.lastIndexOf(elementId);
  return at >= 0 ? trail.slice(0, at + 1) : [...trail, elementId].slice(-trailLength);
}

/** The last elements focused in this tab, per model (reset when the model changes). */
export function useTrail(modelId: string, elementId: string | undefined): string[] {
  const [trail, setTrail] = useState<{ modelId: string; elementId?: string; ids: string[] }>({
    modelId,
    ...(elementId === undefined ? {} : { elementId }),
    ids: elementId === undefined ? [] : [elementId],
  });
  // Updated while rendering (not in an effect), so the trail never lags the URL.
  if (trail.modelId !== modelId || trail.elementId !== elementId) {
    let ids: string[];
    if (trail.modelId !== modelId) ids = elementId === undefined ? [] : [elementId];
    else if (elementId === undefined) ids = trail.ids;
    else ids = nextTrail(trail.ids, elementId);
    setTrail({ modelId, ...(elementId === undefined ? {} : { elementId }), ids });
    return ids;
  }
  return trail.ids;
}
