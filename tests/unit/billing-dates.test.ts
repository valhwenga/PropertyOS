import { describe, it, expect } from 'vitest';
import { resolveDueDate } from '@propertyos/domain';

describe('billing due dates', () => {
  it('uses the configured day when the month is long enough', () => {
    expect(resolveDueDate('2026-01-01', 1)).toBe('2026-01-01');
    expect(resolveDueDate('2026-01-01', 25)).toBe('2026-01-25');
  });

  it('resolves a day beyond the month length to the last day', () => {
    // "A monthly billing day beyond the month's last day resolves to the last
    // day under the chosen policy."
    expect(resolveDueDate('2026-02-01', 31)).toBe('2026-02-28');
    expect(resolveDueDate('2026-04-01', 31)).toBe('2026-04-30');
    expect(resolveDueDate('2026-06-01', 31)).toBe('2026-06-30');
  });

  it('handles leap years', () => {
    expect(resolveDueDate('2028-02-01', 31)).toBe('2028-02-29');
    expect(resolveDueDate('2028-02-01', 29)).toBe('2028-02-29');
    expect(resolveDueDate('2026-02-01', 29)).toBe('2026-02-28');
  });

  it('keeps December and January correct', () => {
    expect(resolveDueDate('2026-12-01', 31)).toBe('2026-12-31');
    expect(resolveDueDate('2026-01-01', 31)).toBe('2026-01-31');
  });
});
