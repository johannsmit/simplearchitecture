import {
  relationshipOfEdge,
  type ElementChangeResult,
  type ModelElement,
  type ModelRelationship,
} from '@simplearchitecture/shared';
import { ApiRequestError, getElement, getRelationship, updateElement } from '../api';
import { cellChange, elementOfNode, type CellKey } from './draft';

/**
 * The element's version for a save or delete: the one read, or read now. When it is read now and
 * the element changed since `base` was shown, that is a conflict (409), as if the save had been
 * refused, so nobody overwrites a change they haven't seen.
 */
export async function versionToSave(
  modelId: string,
  base: ModelElement,
  known: number | undefined,
): Promise<number> {
  if (known !== undefined) return known;
  const latest = await getElement(modelId, base.id);
  const node = elementOfNode(latest.element.id, latest.element.node);
  if (JSON.stringify(node) !== JSON.stringify(base)) {
    throw new ApiRequestError(409, 'Changed', { currentVersion: latest.element.version });
  }
  return latest.element.version;
}

/** The same for a relationship: `base` is the copy the form shows. */
export async function relationshipVersionToSave(
  modelId: string,
  base: ModelRelationship,
  known: number | undefined,
): Promise<number> {
  if (known !== undefined) return known;
  const latest = await getRelationship(modelId, base.id);
  const stored = relationshipOfEdge(latest.relationship.edge);
  if (JSON.stringify(stored) !== JSON.stringify(base)) {
    throw new ApiRequestError(409, 'Changed', { currentVersion: latest.relationship.version });
  }
  return latest.relationship.version;
}

/**
 * Saves one catalog cell with the panel's PATCH: only that field, with the version.
 * Undefined when nothing changed (nothing is sent). The server's refusals come as the panel's do:
 * ApiRequestError 422 (`ElementRejected`, see `cellServerErrors`), 409, 404, 403.
 */
export async function saveCell(
  modelId: string,
  element: ModelElement,
  version: number | undefined,
  key: CellKey,
  text: string,
): Promise<ElementChangeResult | undefined> {
  const change = cellChange(element, key, text);
  if (change === undefined) return undefined;
  const current = await versionToSave(modelId, element, version);
  return updateElement(modelId, element.id, { version: current, ...change });
}
