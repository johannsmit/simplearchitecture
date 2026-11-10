import {
  dataValuesOf,
  dataValuesText,
  repeatedDataValue,
  sameDataValue,
  withDataValue,
} from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';

// The values of Request Data and Response Data, read and compared one way everywhere. Made-up
// data only.

describe('dataValuesOf', () => {
  it('reads a list in its order, trimmed, skipping blanks and anything that is not text', () => {
    expect(
      dataValuesOf(['Orders', ' Invoices ', '', '  ', 3, true, null, { a: 1 }, ['x']]),
    ).toEqual(['Orders', 'Invoices', '3', 'true']);
    expect(dataValuesOf([])).toEqual([]);
  });

  it('reads a single text as one value, and other shapes as none', () => {
    expect(dataValuesOf('Orders')).toEqual(['Orders']);
    expect(dataValuesOf('  ')).toEqual([]);
    expect(dataValuesOf(undefined)).toEqual([]);
    expect(dataValuesOf({ a: 1 })).toEqual([]);
  });
});

describe('comparing and adding values', () => {
  it('counts values the same ignoring case and white space at the ends', () => {
    expect(sameDataValue('Orders', ' orders ')).toBe(true);
    expect(sameDataValue('Orders', 'Order')).toBe(false);
    expect(repeatedDataValue(['Orders', 'Invoices', 'ORDERS'])).toBe('ORDERS');
    expect(repeatedDataValue(['Orders', 'Invoices'])).toBeUndefined();
  });

  it('adds a value last, trimmed, unless it is blank or there already', () => {
    const values = ['Orders'];
    expect(withDataValue(values, ' Invoices ')).toEqual(['Orders', 'Invoices']);
    expect(withDataValue(values, 'orders')).toBe(values);
    expect(withDataValue(values, '   ')).toBe(values);
    expect(values).toEqual(['Orders']);
  });

  it('joins the values on one line with ", "', () => {
    expect(dataValuesText(['Orders', 'Order\n  lines'])).toBe('Orders, Order lines');
    expect(dataValuesText([])).toBeUndefined();
  });
});
