import {
  catalogCell,
  type CatalogColumn,
  type CatalogTab,
  type ModelElement,
} from '@simplearchitecture/shared';
import { safeFileBase } from '../../models/exportModel';

/** Excel reads a UTF-8 file as UTF-8 (accents and all) only with this mark at the start. */
export const byteOrderMark = '﻿';

/** A spreadsheet would run a cell starting with one of these as a formula. */
const formulaStarts = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * One CSV field: a leading `'` when a spreadsheet would read it as a formula, then quoted per
 * RFC 4180 when it holds a comma, a double quote or a line break (quotes doubled inside).
 */
export function csvField(text: string): string {
  const safe = formulaStarts.has(text.charAt(0)) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** Rows of fields as CSV text: a byte order mark, then CRLF-ended lines (RFC 4180). */
export function csvText(rows: readonly (readonly string[])[]): string {
  return `${byteOrderMark}${rows.map((row) => `${row.map(csvField).join(',')}\r\n`).join('')}`;
}

/**
 * The catalog's table as CSV: the columns' labels, then one line per element in the order given,
 * with each cell's full text (empty when not set).
 */
export function catalogCsv(
  columns: readonly CatalogColumn[],
  elements: readonly ModelElement[],
): string {
  return csvText([
    columns.map((column) => column.label),
    ...elements.map((element) =>
      columns.map((column) =>
        column.key === 'name' ? element.name : catalogCell(element, column.key).text,
      ),
    ),
  ]);
}

/** `<model>-<type>-<yyyy-mm-dd>.csv`, with the date in local time, made safe for a file system. */
export function catalogCsvFileName(modelName: string, tab: CatalogTab, date: Date): string {
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  const type = tab === 'all' ? 'All' : tab;
  // The model's name is free text; the type and the date are safe as they are, and always kept.
  const model = safeFileBase(modelName, 'model').slice(0, 80).trim();
  return `${model}-${type}-${day}.csv`;
}

/** Hands the browser the CSV text as a file to save. */
export function saveCsvFile(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
