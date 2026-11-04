/**
 * How to prove "no quadratic work" on any machine, however busy. A fixed time limit fails
 * when other work takes the CPU, and says nothing about growth. So these compare two runs of the
 * same code, in the same test, on the same machine, by CPU time: time this process spent running,
 * which waiting for a CPU doesn't add to.
 */

/** CPU time used by this process so far, in milliseconds. */
export const cpuMs = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

export interface GrowthOptions {
  /** How the time is read (tests of this file). Default: CPU time. */
  clock?: () => number;
  /** Rounds that always count, and the most there may be. */
  minRounds?: number;
  maxRounds?: number;
  /** The ratio to get under (`expectGrowthBelow`). */
  limit?: number;
}

/**
 * Times `prepare(size)()` at both sizes, one after the other, and returns the best large time over
 * the best small time, once at least `minRounds` give a ratio under the limit, or after
 * `maxRounds`. `prepare` isn't timed. The first run only warms the code up, as a cold small run
 * would hide growth. Noise only makes a run slower, so the best run is the closest to the real
 * cost. A floor of 1 ms stops timer noise deciding when the small run is too quick to measure.
 */
export async function measureGrowth<Size>(
  prepare: (size: Size) => () => unknown,
  small: Size,
  large: Size,
  options: GrowthOptions = {},
): Promise<number> {
  const { clock = cpuMs, minRounds = 3, maxRounds = 8, limit = defaultGrowthLimit } = options;
  const once = async (size: Size) => {
    const run = prepare(size);
    const started = clock();
    await run();
    return clock() - started;
  };
  await once(small);
  let bestSmall = Infinity;
  let bestLarge = Infinity;
  let ratio = Infinity;
  for (let round = 1; round <= maxRounds; round++) {
    bestSmall = Math.min(bestSmall, await once(small));
    bestLarge = Math.min(bestLarge, await once(large));
    ratio = bestLarge / Math.max(bestSmall, 1);
    if (round >= minRounds && ratio < limit) break;
  }
  return ratio;
}

/**
 * With 4 times the work (the sizes in these tests), linear code takes about 4 times as long and n
 * log n a little more, while quadratic code takes about 16 times as long.
 */
export const defaultGrowthLimit = 10;

/**
 * For code that walks many small objects or a large Map, where a larger run also falls out of the
 * CPU's caches and costs more per item. At 4 times the work that came too close to quadratic (up to
 * 12.8 against 16), so these use 16 times the work, at sizes small enough to measure the code and
 * not the memory: linear reads about 16 to 50, quadratic about 256.
 */
export const wideGrowthLimit = 80;

/** Fails when the large run takes `limit` times the small one or more. */
export async function expectGrowthBelow<Size>(
  prepare: (size: Size) => () => unknown,
  small: Size,
  large: Size,
  limit = defaultGrowthLimit,
): Promise<void> {
  const ratio = await measureGrowth(prepare, small, large, { limit });
  if (ratio >= limit) {
    throw new Error(`Took ${ratio.toFixed(1)} times as long; the limit is ${limit}.`);
  }
}
