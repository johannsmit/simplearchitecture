import { maxDepth } from '@simplearchitecture/shared';
import { readBooleanPref, readNumberPref, writePref } from '../../prefs';

/** Explorer preferences remembered in this browser. UI choices only, never model content. */

export const defaultDepth = 1;

export function readDepth(): number {
  return readNumberPref('depth', 1, maxDepth, defaultDepth);
}

export function writeDepth(depth: number): void {
  writePref('depth', String(depth));
}

/** A depth from the URL, or undefined when it isn't 1 to 3. */
export function parseDepth(value: string | null): number | undefined {
  if (value === null || !/^\d$/.test(value)) return undefined;
  const depth = Number(value);
  return depth >= 1 && depth <= maxDepth ? depth : undefined;
}

export interface PanelSpec {
  key: string;
  name: string;
  min: number;
  max: number;
  fallback: number;
}

export const panels = {
  tree: { key: 'tree-width', name: 'element list', min: 220, max: 420, fallback: 280 },
  details: { key: 'details-width', name: 'details', min: 300, max: 520, fallback: 360 },
} as const satisfies Record<string, PanelSpec>;

export type PanelName = keyof typeof panels;

export function readPanelWidth(panel: PanelName): number {
  const spec = panels[panel];
  return readNumberPref(spec.key, spec.min, spec.max, spec.fallback);
}

export function writePanelWidth(panel: PanelName, width: number | null): void {
  writePref(panels[panel].key, width === null ? null : String(Math.round(width)));
}

export function readPanelOpen(panel: PanelName): boolean {
  return readBooleanPref(`${panel}-open`, true);
}

export function writePanelOpen(panel: PanelName, open: boolean): void {
  writePref(`${panel}-open`, String(open));
}

export function readLegendOpen(): boolean {
  return readBooleanPref('legend-open', true);
}

export function writeLegendOpen(open: boolean): void {
  writePref('legend-open', String(open));
}

/** The fixed viewpoint older versions remembered means nothing now, so it is dropped. */
export function dropOldViewpoint(): void {
  writePref('viewpoint', null);
}

/** "Nest contained elements" in the legend: on unless switched off. */
export function readNestContained(): boolean {
  return readBooleanPref('nest-contained', true);
}

export function writeNestContained(nest: boolean): void {
  writePref('nest-contained', String(nest));
}

/** "Show lines" in the legend: on unless switched off. Never part of a view. */
export function readShowLines(): boolean {
  return readBooleanPref('show-lines', true);
}

export function writeShowLines(lines: boolean): void {
  writePref('show-lines', String(lines));
}
