import { describe, expect, it } from 'vitest';
import { expectGrowthBelow, measureGrowth } from './growth.js';

// The check the "stays linear" tests rely on: it must still catch quadratic work.

/** A clock that only moves as a run says: `cost(size)`, plus the noise of that run. */
function fakeWork(cost: (size: number) => number, noise: readonly number[] = []) {
  let time = 0;
  let run = 0;
  return {
    clock: () => time,
    prepare: (size: number) => () => {
      time += cost(size) * (noise[run] ?? 1);
      run += 1;
    },
    runs: () => run,
  };
}

describe('measureGrowth', () => {
  it('reads about 4 for linear work, and 16 for quadratic work, 4 times as large', async () => {
    const linear = fakeWork((n) => n);
    expect(await measureGrowth(linear.prepare, 100, 400, { clock: linear.clock })).toBe(4);
    const quadratic = fakeWork((n) => n * n);
    expect(await measureGrowth(quadratic.prepare, 100, 400, { clock: quadratic.clock })).toBe(16);
  });

  it('doesn’t let a slow warm-up run hide growth', async () => {
    // The first run, 50 times slower than it should be, doesn't count.
    const work = fakeWork((n) => n * n, [50]);
    expect(await measureGrowth(work.prepare, 100, 400, { clock: work.clock })).toBe(16);
  });

  it('gets past noise on linear work: a busy large run doesn’t fail it', async () => {
    // Warm-up, then small and large: the large run is 5 times slower for 2 rounds, then clean.
    const work = fakeWork((n) => n, [1, 1, 5, 1, 5, 1, 1]);
    expect(await measureGrowth(work.prepare, 100, 400, { clock: work.clock })).toBe(4);
  });

  it('keeps measuring quadratic work to the last round, and still reads it as quadratic', async () => {
    const work = fakeWork((n) => n * n);
    await measureGrowth(work.prepare, 100, 400, { clock: work.clock, maxRounds: 5 });
    expect(work.runs()).toBe(1 + 2 * 5);
  });

  it('stops at the minimum rounds when the work is linear', async () => {
    const work = fakeWork((n) => n);
    await measureGrowth(work.prepare, 100, 400, { clock: work.clock, minRounds: 3 });
    expect(work.runs()).toBe(1 + 2 * 3);
  });

  it('ignores differences below 1 ms: too small to measure', async () => {
    const work = fakeWork((n) => (n === 100 ? 0.01 : 0.5));
    expect(await measureGrowth(work.prepare, 100, 400, { clock: work.clock })).toBe(0.5);
  });

  it('waits for async work', async () => {
    let time = 0;
    const ratio = await measureGrowth(
      (size: number) => async () => {
        await Promise.resolve();
        time += size;
      },
      10,
      40,
      { clock: () => time },
    );
    expect(ratio).toBe(4);
  });
});

describe('expectGrowthBelow, on real work and the real clock', () => {
  // Not optimised away: the sum is used.
  let sink = 0;
  const pairs = (n: number) => () => {
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) sink += i ^ j;
  };
  const walk = (n: number) => () => {
    for (let i = 0; i < n * n; i++) sink += i;
  };

  it('fails on a real quadratic loop', async () => {
    await expect(expectGrowthBelow(pairs, 2000, 8000)).rejects.toThrow(/times as long/);
    expect(sink).not.toBe(0.5);
  });

  it('passes on real linear work', async () => {
    // `walk` of 2000 and 4000 is 4 times the work, done in one straight loop.
    await expectGrowthBelow(walk, 2000, 4000);
  });
});
