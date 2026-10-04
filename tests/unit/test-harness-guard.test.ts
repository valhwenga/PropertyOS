import { describe, it, expect } from 'vitest';

/**
 * The test harness drops the database it is pointed at. This pins the guard
 * that decides whether a given name is safe to drop, because getting it wrong
 * destroys real data — which is how the guard came to exist.
 */
function isDisposable(name: string, allowOverride = false): boolean {
  if (allowOverride) return true;
  return /^(propertyos_)?test(_|$)|_test$|^propertyos_test$/.test(name);
}

describe('destructive test harness guard', () => {
  it('accepts names that clearly identify a test database', () => {
    for (const name of ['propertyos_test', 'test', 'test_run', 'propertyos_ci_test', 'anything_test']) {
      expect(isDisposable(name), name).toBe(true);
    }
  });

  it('refuses development, staging and production names', () => {
    for (const name of ['propertyos_dev', 'propertyos', 'propertyos_staging', 'propertyos_prod', 'postgres']) {
      expect(isDisposable(name), name).toBe(false);
    }
  });

  it('allows an explicit, deliberate override', () => {
    expect(isDisposable('propertyos_scratch', true)).toBe(true);
  });
});
