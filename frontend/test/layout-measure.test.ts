import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { add, madeUpSets, measureModel, noMeasures, type Measures } from './layoutMeasures';

// The layout's measures on the made-up models, as a table: a check to run by hand, before and after
// a change to the layout. Slow (minutes), so it runs only with LAYOUT_MEASURE=1:
//
//   LAYOUT_MEASURE=1 npx vitest run --project frontend test/layout-measure.test.ts
//
// LAYOUT_MEASURE_FUZZED sets how many fuzzed models (default 24); LAYOUT_MEASURE_OUT, a file the
// table is written to as well.

const share = (part: number, whole: number) =>
  whole === 0 ? '-' : `${String(Math.round((100 * part) / whole))}%`;

function row(name: string, m: Measures) {
  return {
    model: name,
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
    for (const set of ['large', 'moderate'] as const) {
      const [model] = madeUpSets[set]();
      if (model) rows.push(row(set, await measureModel(model)));
    }
    for (const [name, models] of [
      ['long names', madeUpSets.long()],
      ['wide cards', madeUpSets.wide()],
    ] as const) {
      const sum = noMeasures();
      for (const model of models) add(sum, await measureModel(model));
      rows.push(row(name, sum));
    }
    const fuzzed = noMeasures();
    for (const model of madeUpSets.fuzzed(Number(process.env.LAYOUT_MEASURE_FUZZED ?? 24))) {
      add(fuzzed, await measureModel(model));
    }
    rows.push(row('fuzzed', fuzzed));
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
