import { cutEndName, dataListNamesOf } from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';

// The names of a Relation's two lists on one relationship, built from its ends. Made-up names.

const fixed = {
  sourceToTargetData: {
    full: 'Source to target data',
    shown: 'Source to target data',
    cut: false,
  },
  targetToSourceData: {
    full: 'Target to source data',
    shown: 'Target to source data',
    cut: false,
  },
};

describe('the names of the two lists', () => {
  it('are built from the ends, source to target first', () => {
    expect(dataListNamesOf('Order system', 'Warehouse')).toEqual({
      sourceToTargetData: {
        full: 'Order system to Warehouse',
        shown: 'Order system to Warehouse',
        cut: false,
      },
      targetToSourceData: {
        full: 'Warehouse to Order system',
        shown: 'Warehouse to Order system',
        cut: false,
      },
    });
  });

  it('cut a long end at a word, keeping the full name', () => {
    const names = dataListNamesOf('Customer relationship management platform', 'Warehouse');
    expect(names.sourceToTargetData).toEqual({
      full: 'Customer relationship management platform to Warehouse',
      shown: 'Customer relationship… to Warehouse',
      cut: true,
    });
    expect(names.targetToSourceData.shown).toBe('Warehouse to Customer relationship…');
  });

  it('are fixed for the same name twice, an end missing, or two unnamed ends', () => {
    expect(dataListNamesOf('Warehouse', 'warehouse ')).toEqual(fixed);
    expect(dataListNamesOf('Ware  house', 'WARE HOUSE')).toEqual(fixed);
    expect(dataListNamesOf('Warehouse', undefined)).toEqual(fixed);
    expect(dataListNamesOf('', '')).toEqual(fixed);
    // Alike only once cut.
    const long = 'Customer relationship management ';
    expect(dataListNamesOf(`${long}platform`, `${long}suite`)).toEqual(fixed);
    expect(dataListNamesOf('', 'Warehouse').sourceToTargetData.shown).toBe(
      '(unnamed) to Warehouse',
    );
  });
});

describe('cutting an end name', () => {
  it('keeps a name of 32 characters or fewer', () => {
    expect(cutEndName('x'.repeat(32))).toEqual({ text: 'x'.repeat(32), cut: false });
  });

  it('cuts at the last space in the first 31 when 20 or more are left, else after 31', () => {
    expect(cutEndName('Customer relationship management platform').text).toBe(
      'Customer relationship…',
    );
    expect(cutEndName(`${'a'.repeat(10)} ${'b'.repeat(30)}`).text).toBe(
      `${'a'.repeat(10)} ${'b'.repeat(20)}…`,
    );
    expect(cutEndName('y'.repeat(40)).text).toBe(`${'y'.repeat(31)}…`);
  });

  it('counts characters, never splitting a pair', () => {
    const name = '😀'.repeat(40);
    const { text } = cutEndName(name);
    expect(Array.from(text)).toHaveLength(32);
    expect(text).toBe(`${'😀'.repeat(31)}…`);
  });
});
