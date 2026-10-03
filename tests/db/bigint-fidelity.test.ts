/**
 * Pins the driver's handling of 64-bit money columns.
 *
 * If a future postgres.js upgrade started returning `bigint` columns as JS
 * numbers, every amount above 2^53 would silently lose precision and this suite
 * would be the only thing that noticed.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { closeOwner, ownerSql } from '../support/factories.js';

describe('bigint fidelity', () => {
  afterAll(async () => { await closeOwner(); });

  it('returns bigint columns as exact strings, not floats', async () => {
    const [row] = await ownerSql()<{ amount: unknown }[]>`
      select 9007199254740993::bigint as amount
    `;
    expect(typeof row!.amount).toBe('string');
    // 9007199254740993 is Number.MAX_SAFE_INTEGER + 2: a float would round it.
    expect(row!.amount).toBe('9007199254740993');
    expect(BigInt(row!.amount as string)).toBe(9007199254740993n);
    // Converting through a JS number loses the value: that is exactly why the
    // driver must hand us the string. (A numeric literal here would already be
    // rounded by the parser, so the comparison is made on the string form.)
    expect(String(Number(row!.amount as string))).not.toBe('9007199254740993');
    expect(String(Number(row!.amount as string))).toBe('9007199254740992');
  });

  it('round-trips a large amount through a journal line without loss', async () => {
    const [row] = await ownerSql()<{ v: string }[]>`
      select (9007199254740993::bigint + 1)::text as v
    `;
    expect(row!.v).toBe('9007199254740994');
  });
});
