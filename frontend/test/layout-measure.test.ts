import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  add,
  madeUpSets,
  measureModel,
  noMeasures,
  type MadeUpModel,
  type Measures,
} from './layoutMeasures';

// The layout's measures on the made-up models, as a table: a check to run by hand, before and after
// a change to the layout. Slow (minutes), so it runs only with LAYOUT_MEASURE=1:
//
//   LAYOUT_MEASURE=1 npx vitest run --project frontend test/layout-measure.test.ts
//
// LAYOUT_MEASURE_FUZZED sets how many fuzzed models (default 24); LAYOUT_MEASURE_OUT, a file the
// table is written to as well; LAYOUT_MEASURE_GROUP, a property to group every canvas by (Group by,
// for example `type`). The time column is the time the set's layouts took on this machine.

const share = (part: number, whole: number) =>
  whole === 0 ? '-' : `${String(Math.round((100 * part) / whole))}%`;

const groupBy = process.env.LAYOUT_MEASURE_GROUP || undefined;

/** The measures of models, and how long their canvases took, in seconds. */
async function timed(models: MadeUpModel[]): Promise<{ sum: Measures; seconds: number }> {
  const sum = noMeasures();
  const start = performance.now();
  for (const model of models) add(sum, await measureModel(model, [1, 2], groupBy));
  return { sum, seconds: (performance.now() - start) / 1000 };
}

function row(name: string, m: Measures, seconds: number) {
  return {
    model: name,
    'time (s)': seconds.toFixed(1),
    canvases: m.canvases,
    'crossed names': `${String(m.crossedNames)}/${String(m.containers)} (${share(m.crossedNames, m.containers)})`,
    'crossed headers': `${String(m.crossedHeaders)}/${String(m.containers)} (${share(m.crossedHeaders, m.containers)})`,
    lines: m.lines,
    'over cards': m.overCards,
    'over containers': m.overContainers,
    crossings: m.crossings,
    'cards covering cards': m.overlaps,
    'widest container': Math.round(m.widestContainer),
    'tallest container': Math.round(m.tallestContainer),
    'canvas area (Mpx²)': Math.round(m.canvasArea),
    // Information only: cards out of rows by element type, which the layout no longer keeps.
    'type rows out (top/inside)': `${String(m.rowsOutTop)}/${String(m.rowsOutInside)}`,
  };
}

describe.skipIf(process.env.LAYOUT_MEASURE !== '1')('layout measures on made-up models', () => {
  it('prints the table', { timeout: 1_800_000 }, async () => {
    const rows = [];
    for (const [name, models] of [
      ['large', madeUpSets.large()],
      ['moderate', madeUpSets.moderate()],
      ['long names', madeUpSets.long()],
      ['wide cards', madeUpSets.wide()],
      ['fuzzed', madeUpSets.fuzzed(Number(process.env.LAYOUT_MEASURE_FUZZED ?? 24))],
    ] as const) {
      const { sum, seconds } = await timed(models);
      rows.push(row(name, sum, seconds));
    }
    const keys = Object.keys(rows[0] ?? {});
    const table = [
      `| ${keys.join(' | ')} |`,
      `| ${keys.map(() => '---').join(' | ')} |`,
      ...rows.map((r) => `| ${Object.values(r).map(String).join(' | ')} |`),
    ].join('\n');
    const out = process.env.LAYOUT_MEASURE_OUT;
    if (out) writeFileSync(out, `${table}\n`);
    process.stdout.write(`\n${table}\n`);
    expect(rows.length).toBe(5);
  });
});
