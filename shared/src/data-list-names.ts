/**
 * The names of a Relation's two lists of data on one relationship, built from its ends: "Order
 * system to Warehouse" (source to target) and "Warehouse to Order system". Pure, so the form, the
 * details panel and the canvas name the lists the same way.
 */
import type { ModelGraph } from './graph.js';
import { standardProperties, type RelationDataProperty } from './metamodel.js';

/** One list's name: in full (hover, screen readers), as shown (ends cut), and whether it was cut. */
export interface DataListName {
  full: string;
  shown: string;
  cut: boolean;
}

export type DataListNames = Record<RelationDataProperty, DataListName>;

/** Longest end name shown in a list's name, in characters (code points), the "…" included. */
export const maxDataEndName = 32;
/** Where a long name is cut at the latest, before its "…". */
const cutAt = maxDataEndName - 1;
/** A cut at a space must leave at least this many characters. */
const minCutAtSpace = 20;

/** What an element without a name is called. */
export const unnamedElement = '(unnamed)';

/**
 * An end's name as shown in a list's name: as it is up to 32 characters; longer, cut at the last
 * space within the first 31 characters when that leaves at least 20, else after 31, with trailing
 * spaces dropped and "…" added. Counts code points, so a surrogate pair is never split.
 */
export function cutEndName(name: string): { text: string; cut: boolean } {
  const characters = Array.from(name);
  if (characters.length <= maxDataEndName) return { text: name, cut: false };
  const first = characters.slice(0, cutAt);
  let space = -1;
  first.forEach((character, index) => {
    if (/\s/.test(character)) space = index;
  });
  const kept = space >= minCutAtSpace ? first.slice(0, space) : first;
  return { text: `${kept.join('').trimEnd()}…`, cut: true };
}

/** How names are compared: ignoring case, and runs of spaces count as one (as in labels). */
const nameKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** The fixed names: where one name covers many relationships, or the ends give no usable names. */
export function fixedDataListNames(): DataListNames {
  const fixed = (key: RelationDataProperty): DataListName => {
    const name = standardProperties[key].label;
    return { full: name, shown: name, cut: false };
  };
  return {
    sourceToTargetData: fixed('sourceToTargetData'),
    targetToSourceData: fixed('targetToSourceData'),
  };
}

/**
 * The two lists' names from the ends' names (undefined: an end that can't be found). The fixed
 * names when an end is missing, or when both names as shown are the same, ignoring case and runs
 * of spaces (an element to itself, two elements with one name, two unnamed ends).
 */
export function dataListNamesOf(
  sourceName: string | undefined,
  targetName: string | undefined,
): DataListNames {
  if (sourceName === undefined || targetName === undefined) return fixedDataListNames();
  const source = cutEndName(sourceName || unnamedElement);
  const target = cutEndName(targetName || unnamedElement);
  if (nameKey(source.text) === nameKey(target.text)) return fixedDataListNames();
  const fullSource = sourceName || unnamedElement;
  const fullTarget = targetName || unnamedElement;
  const cut = source.cut || target.cut;
  return {
    sourceToTargetData: {
      full: `${fullSource} to ${fullTarget}`,
      shown: `${source.text} to ${target.text}`,
      cut,
    },
    targetToSourceData: {
      full: `${fullTarget} to ${fullSource}`,
      shown: `${target.text} to ${source.text}`,
      cut,
    },
  };
}

/** The two lists' names on a relationship between these elements of the model. */
export function dataListNames(graph: ModelGraph, source: string, target: string): DataListNames {
  return dataListNamesOf(graph.elements.get(source)?.name, graph.elements.get(target)?.name);
}
