import { describe, it, expect } from 'vitest';
import { formatMinor, formatMoney, parseMajorToMinor, prorate, sumMinor } from '@propertyos/domain';

describe('money', () => {
  it('parses major units into exact integer minor units', () => {
    expect(parseMajorToMinor('8000')).toBe(800000n);
    expect(parseMajorToMinor('8000.50')).toBe(800050n);
    expect(parseMajorToMinor('R8,000.50')).toBe(800050n);
    expect(parseMajorToMinor('8 000.05')).toBe(800005n);
    expect(parseMajorToMinor('0.01')).toBe(1n);
    expect(parseMajorToMinor('-1000')).toBe(-100000n);
  });

  it('refuses amounts that cannot be represented exactly', () => {
    expect(() => parseMajorToMinor('10.005')).toThrow(/decimal places/);
    expect(() => parseMajorToMinor('abc')).toThrow(/not a valid amount/);
  });

  it('avoids the floating point error that a float ledger would produce', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point. In minor units it is exact.
    const total = parseMajorToMinor('0.10') + parseMajorToMinor('0.20');
    expect(total).toBe(parseMajorToMinor('0.30'));
    expect(formatMinor(total)).toBe('0.30');
  });

  it('formats with grouping and the currency symbol', () => {
    expect(formatMinor(185000n)).toBe('1,850.00');
    expect(formatMoney(185000n, 'ZAR')).toBe('R1,850.00');
    expect(formatMoney(-50n, 'ZAR')).toBe('R-0.50');
    expect(formatMinor(123456789n)).toBe('1,234,567.89');
  });

  it('sums without precision loss at amounts beyond Number.MAX_SAFE_INTEGER', () => {
    const big = [9007199254740993n, 1n, 1n];
    expect(sumMinor(big)).toBe(9007199254740995n);
  });

  describe('proration', () => {
    it('returns the full amount for a complete period', () => {
      expect(prorate(800000n, 31, 31)).toBe(800000n);
    });

    it('prorates by actual occupied days over days in the month', () => {
      // Moved in on the 16th of a 31 day month: 16 days occupied.
      expect(prorate(800000n, 16, 31)).toBe(412903n);
    });

    it('rounds half up at the line level', () => {
      // 1000 * 1/3 = 333.33... -> 333
      expect(prorate(1000n, 1, 3)).toBe(333n);
      // 1000 * 1/2 = 500 exactly
      expect(prorate(1000n, 1, 2)).toBe(500n);
      // 100 * 1/8 = 12.5 -> 13 (half up)
      expect(prorate(100n, 1, 8)).toBe(13n);
    });

    it('handles February and leap years', () => {
      expect(prorate(800000n, 28, 28)).toBe(800000n);
      expect(prorate(800000n, 14, 28)).toBe(400000n);
      expect(prorate(800000n, 29, 29)).toBe(800000n); // 2028 is a leap year
      expect(prorate(800000n, 15, 29)).toBe(413793n);
    });

    it('rejects nonsense inputs rather than guessing', () => {
      expect(() => prorate(1000n, 1, 0)).toThrow(/denominator must be positive/);
      expect(() => prorate(1000n, -1, 30)).toThrow(/cannot be negative/);
      expect(() => prorate(1000n, 1.5, 30)).toThrow(/whole days/);
    });
  });
});
