import { dataViewArrows, type RelationDataProperty } from '@simplearchitecture/shared';
import type { Point } from './positions';

/** Each arrow and the one that points the other way. */
const opposite: Readonly<Record<string, string>> = { '→': '←', '←': '→', '↓': '↑', '↑': '↓' };

/**
 * The arrow a list of data starts with on its line: from where that data leaves to where it
 * arrives, as the line is drawn. Source to target takes the way from the line's first point (at
 * the source) to its last (at the target): across when that is at least as far as up or down, else
 * up or down (screen coordinates, y down). Target to source takes the opposite arrow. An element to
 * itself (`self`), or a line with no length, gets the fixed → and ←.
 */
export function dataArrow(line: readonly Point[], key: RelationDataProperty, self = false): string {
  const first = line[0];
  const last = line[line.length - 1];
  if (self || first === undefined || last === undefined) return dataViewArrows[key];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  if ((dx === 0 && dy === 0) || !Number.isFinite(dx) || !Number.isFinite(dy)) {
    return dataViewArrows[key];
  }
  const forward = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? '→' : '←') : dy > 0 ? '↓' : '↑';
  return key === 'sourceToTargetData' ? forward : (opposite[forward] ?? forward);
}
