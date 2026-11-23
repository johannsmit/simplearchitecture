import { maxDepth } from '@simplearchitecture/shared';
import { useCallback, useState } from 'react';
import type { NavigateFunction } from 'react-router';
import { elementPath, type ExplorerSpace } from '../paths';
import { parseDepth, readDepth, writeDepth } from './prefs';

interface FocusAndDepthOptions {
  navigate: NavigateFunction;
  params: URLSearchParams;
  modelId: string;
  elementId: string | undefined;
  space: ExplorerSpace;
  shownAsked: readonly string[];
  groupAsked: string | undefined;
}

/**
 * The depth (the address's, else the one last chosen in this browser), focusing an element, and
 * choosing a depth: both move the address, keeping the relationship properties shown and the
 * Group by.
 */
export function useFocusAndDepth({
  navigate,
  params,
  modelId,
  elementId,
  space,
  shownAsked,
  groupAsked,
}: FocusAndDepthOptions) {
  const [rememberedDepth, setRememberedDepth] = useState(readDepth);
  const depth = parseDepth(params.get('depth')) ?? rememberedDepth;

  const focusElement = useCallback(
    (id: string) => {
      void navigate(elementPath(modelId, id, depth, space, shownAsked, groupAsked));
    },
    [navigate, modelId, depth, space, shownAsked, groupAsked],
  );

  const setDepth = useCallback(
    (next: number) => {
      if (next < 1 || next > maxDepth) return;
      setRememberedDepth(next);
      writeDepth(next);
      if (elementId !== undefined) {
        void navigate(elementPath(modelId, elementId, next, space, shownAsked, groupAsked), {
          replace: true,
        });
      }
    },
    [navigate, modelId, elementId, space, shownAsked, groupAsked],
  );

  return { depth, focusElement, setDepth };
}
