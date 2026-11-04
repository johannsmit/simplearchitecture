import type { ElementFilters } from '@simplearchitecture/shared';
import { useCallback, useState } from 'react';

/**
 * The search text and filters that narrow the element list and the catalog. The
 * explorer owns them, so both show the same matches and they survive switching views or hiding
 * the list. The search text is for the model shown; the filters are kept per model for this tab's
 * session (not saved), as the list did before.
 */
export interface ElementSearch {
  query: string;
  filters: ElementFilters;
  setQuery: (query: string) => void;
  setFilters: (filters: ElementFilters) => void;
}

/** The filters, per model, for this tab's session. */
const filtersByModel = new Map<string, ElementFilters>();

/** Forgets every model's filters (as a reload does). For tests. */
export function forgetElementFilters(): void {
  filtersByModel.clear();
}

const noFilters: ElementFilters = {};

export function useElementSearch(modelId: string): ElementSearch {
  const [state, setState] = useState(() => ({
    modelId,
    query: '',
    filters: filtersByModel.get(modelId) ?? noFilters,
  }));
  // Another model: its own filters and an empty search. Adjusted while rendering.
  let current = state;
  if (state.modelId !== modelId) {
    current = { modelId, query: '', filters: filtersByModel.get(modelId) ?? noFilters };
    setState(current);
  }
  const setQuery = useCallback(
    (query: string) => {
      setState((s) => (s.modelId === modelId ? { ...s, query } : s));
    },
    [modelId],
  );
  const setFilters = useCallback(
    (filters: ElementFilters) => {
      // Kept when set (not in an effect), so a hook that is only a fallback never writes.
      filtersByModel.set(modelId, filters);
      setState((s) => (s.modelId === modelId ? { ...s, filters } : s));
    },
    [modelId],
  );
  return { query: current.query, filters: current.filters, setQuery, setFilters };
}
