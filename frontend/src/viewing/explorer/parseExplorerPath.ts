import type { ExplorerSpace } from '../paths';

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * Reads `/viewing|modelling/models/:modelId[/elements/:elementId | /views/:viewId]` from the raw
 * (still encoded) path, so element ids may hold any character, including "/".
 */
export function parseExplorerPath(pathname: string):
  | {
      space: ExplorerSpace;
      modelId: string;
      elementId: string | undefined;
      viewId: string | undefined;
    }
  | undefined {
  const match =
    /^\/(viewing|modelling)\/models\/([^/]+)(?:\/elements\/([^/]+)|\/views\/([^/]+))?\/?$/.exec(
      pathname,
    );
  const modelId = match?.[2] === undefined ? undefined : decode(match[2]);
  if (modelId === undefined) return undefined;
  const space: ExplorerSpace = match?.[1] === 'modelling' ? 'modelling' : 'viewing';
  const element = match?.[3];
  const view = match?.[4];
  // A segment that can't be decoded can't be in the model: show "not in this model".
  return {
    space,
    modelId,
    elementId: element === undefined ? undefined : (decode(element) ?? element),
    viewId: view === undefined ? undefined : (decode(view) ?? view),
  };
}
