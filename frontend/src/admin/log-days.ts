const pad = (value: number) => String(value).padStart(2, '0');

/** A date in the browser's time zone as `YYYY-MM-DD`. */
export function localDay(date: Date): string {
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The browser's offsets from UTC (as Date.getTimezoneOffset gives them) at the two ends of the
 * days `from` to `to` (`YYYY-MM-DD`, both counted): at local midnight starting `from`, and at
 * local midnight after `to`. They differ when a clock change falls in the range, so the server
 * reads each end at its own offset.
 */
export function logRangeOffsets(
  from: string,
  to: string,
): { tzOffset: number; toTzOffset: number } {
  const midnight = (day: string, after: number) => {
    const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
    return new Date(year, month - 1, date + after);
  };
  return {
    tzOffset: midnight(from, 0).getTimezoneOffset(),
    toTzOffset: midnight(to, 1).getTimezoneOffset(),
  };
}
