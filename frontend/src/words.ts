const numberFormat = new Intl.NumberFormat();

/** A count with its noun: "1 element", "1,204 elements". */
export function counted(count: number, singular: string, plural = `${singular}s`): string {
  return `${numberFormat.format(count)} ${count === 1 ? singular : plural}`;
}

export function formatNumber(count: number): string {
  return numberFormat.format(count);
}
