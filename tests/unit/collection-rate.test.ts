/**
 * The two pure decisions inside collection measurement.
 *
 * Both used to be made inline, in more than one place, which is how the
 * overview and the collection report came to state the same month differently.
 * They are functions now so there is something to pin.
 */
import { describe, expect, it } from 'vitest';
import { collectionRatePercent, defaultCutOff } from '@propertyos/domain';

describe('collection rate', () => {
  it('is null when nothing was billed', () => {
    // Not 0, and not 100. An empty month has no collection rate, and either
    // number would be read as a judgement about an operator who did nothing
    // wrong.
    expect(collectionRatePercent(0n, 0n)).toBeNull();
    expect(collectionRatePercent(0n, 500_00n)).toBeNull();
  });

  it('truncates rather than rounds up', () => {
    // 6,150 / 8,000 = 76.875%. Reporting 76.88% would overstate money received.
    expect(collectionRatePercent(800_000n, 615_000n)).toBe(76.87);
  });

  it('reports a fully collected period as exactly 100', () => {
    expect(collectionRatePercent(835_000n, 835_000n)).toBe(100);
  });

  it('can exceed 100 when a period was overpaid, and says so plainly', () => {
    // Clamping would hide an over-allocation, which is a thing to investigate
    // rather than a thing to tidy away.
    expect(collectionRatePercent(100_000n, 120_000n)).toBe(120);
  });

  it('handles amounts far beyond what a float could carry', () => {
    // Minor units are bigint throughout; the rate must not route through Number
    // on the way in.
    expect(collectionRatePercent(9_007_199_254_740_993n, 9_007_199_254_740_993n)).toBe(100);
  });
});

describe('default cut-off', () => {
  it('is the period end while the period is still running', () => {
    expect(defaultCutOff('2026-10-31', '2026-10-08')).toBe('2026-10-31');
  });

  it('is today once the period has closed', () => {
    // So a past month reads as "collected against it so far", not as it stood
    // on the last day of the month.
    expect(defaultCutOff('2026-01-31', '2026-10-08')).toBe('2026-10-08');
  });

  it('is the period end on the last day of the period', () => {
    expect(defaultCutOff('2026-10-31', '2026-10-31')).toBe('2026-10-31');
  });
});
