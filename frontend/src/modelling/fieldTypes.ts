import { elementMetadataNames, isReference, type ModelGraph } from '@simplearchitecture/shared';

/** A custom metadata field's type on an element's form. */
export type FieldType = 'text' | 'reference';

/** How other elements use a custom metadata name: as text, as a Reference, or both. */
export interface NameTypes {
  text: boolean;
  reference: boolean;
}

/**
 * The custom metadata names other elements than `exceptId` use, most used first, each with the
 * types it is used as. A name whose values are all kept as is (lists, objects) has neither.
 */
export function metadataNameTypes(
  graph: ModelGraph,
  exceptId: string | undefined,
): ReadonlyMap<string, NameTypes> {
  const names = new Set(elementMetadataNames(graph));
  const found = new Map<string, NameTypes>();
  for (const element of graph.elements.values()) {
    if (element.id === exceptId) continue;
    for (const [key, value] of Object.entries(element.metadata)) {
      if (!names.has(key)) continue;
      const types = found.get(key) ?? { text: false, reference: false };
      if (isReference(value)) types.reference = true;
      else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        types.text = true;
      found.set(key, types);
    }
  }
  // In the order the names are offered everywhere: most used first.
  const sorted = new Map<string, NameTypes>();
  for (const name of names) {
    const types = found.get(name);
    if (types) sorted.set(name, types);
  }
  return sorted;
}

/** "Text", "Reference", "Text, Reference", or undefined for a name used as neither. */
export function typesLabel(types: NameTypes | undefined): string | undefined {
  if (!types) return undefined;
  const words = [types.text && 'Text', types.reference && 'Reference'].filter(
    (word): word is string => typeof word === 'string',
  );
  return words.length > 0 ? words.join(', ') : undefined;
}

/** The type a name is used as only, if it is used as one type only. */
export function onlyType(types: NameTypes | undefined): FieldType | undefined {
  if (!types || types.text === types.reference) return undefined;
  return types.reference ? 'reference' : 'text';
}

/** The type's word as the form shows it. */
export const fieldTypeWord: Record<FieldType, string> = { text: 'Text', reference: 'Reference' };
