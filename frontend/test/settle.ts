import { act } from '@testing-library/react';

/** The layouts started on the tests' in-process ELK (see test/setup.ts), and those still running. */
export const layoutsInFlight = { started: 0, running: new Set<Promise<unknown>>() };

/** How long the canvas must stay quiet: longer than its two-frame fit after a layout. */
const quietRounds = 3;
const roundMs = 50;

/**
 * Lets every layout that has started finish, however long the machine takes, then waits until no
 * new one starts for three rounds of 50 ms, with the effects, frames and saves they set off. A check
 * that nothing moved or saved comes after this: an unwanted layout that starts within that time,
 * or is still running, is seen.
 */
export async function settle(): Promise<void> {
  let quiet = 0;
  while (quiet < quietRounds) {
    const started = layoutsInFlight.started;
    await act(async () => {
      await Promise.allSettled([...layoutsInFlight.running]);
      await new Promise((resolve) => setTimeout(resolve, roundMs));
    });
    quiet =
      layoutsInFlight.started === started && layoutsInFlight.running.size === 0 ? quiet + 1 : 0;
  }
}
