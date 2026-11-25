const pad = (value: number) => String(value).padStart(2, '0');

/** A date in the browser's time zone as `YYYY-MM-DD`. */
export function localDay(date: Date): string {
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The browser's offsets from UTC, in minutes behind it as Date.getTimezoneOffset counts them, at
 * the two ends of the days `from` to `to` (`YYYY-MM-DD`, both counted): at the start of `from` and
 * at the end of `to`. They differ when a clock change falls in the range, so the server reads each
 * end at its own offset. Each is the offset in force just before local midnight, worked out from
 * the instant the day starts: where the clocks spring forward at midnight, that midnight doesn't
 * exist and the day starts at 01:00 new time, which is still the old offset past UTC midnight.
 */
export function logRangeOffsets(
  from: string,
  to: string,
): { tzOffset: number; toTzOffset: number } {
  const offsetAt = (day: string, after: number) => {
    const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
    return (
      (new Date(year, month - 1, date + after).getTime() -
        Date.UTC(year, month - 1, date + after)) /
      60_000
    );
  };
  return { tzOffset: offsetAt(from, 0), toTzOffset: offsetAt(to, 1) };
}
