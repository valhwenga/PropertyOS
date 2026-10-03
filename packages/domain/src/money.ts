/**
 * Money handling.
 *
 * Every monetary value in PropertyOS is an integer number of MINOR units
 * (cents for ZAR). Amounts are never stored or arithmetic-ed as binary floating
 * point: `0.1 + 0.2` problems in a rent ledger are not acceptable.
 *
 * Rates (escalation percentages, proration fractions) use explicit decimal
 * arithmetic with a stated rounding rule at the point of use.
 */

export type Minor = bigint;

export interface Currency {
  readonly code: string;
  readonly exponent: number;
  readonly symbol: string;
}

export const ZAR: Currency = { code: 'ZAR', exponent: 2, symbol: 'R' };

const CURRENCIES: Record<string, Currency> = {
  ZAR,
  USD: { code: 'USD', exponent: 2, symbol: '$' },
  EUR: { code: 'EUR', exponent: 2, symbol: '€' },
  GBP: { code: 'GBP', exponent: 2, symbol: '£' },
};

export function currency(code: string): Currency {
  const found = CURRENCIES[code.toUpperCase()];
  if (!found) {
    throw new Error(`Unsupported currency ${code}. Add it explicitly before use.`);
  }
  return found;
}

/** Parses a human-entered major-unit amount ("8000", "8 000.50", "R8,000.50"). */
export function parseMajorToMinor(input: string | number, code = 'ZAR'): Minor {
  const { exponent } = currency(code);
  const raw = String(input).trim().replace(/[\s, ]/g, '').replace(/^[A-Za-z$€£]+/, '');
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`"${input}" is not a valid amount.`);
  }
  const negative = raw.startsWith('-');
  const [whole = '0', fraction = ''] = raw.replace('-', '').split('.');
  if (fraction.length > exponent) {
    throw new Error(
      `"${input}" has more than ${exponent} decimal places, which cannot be represented exactly in ${code}.`,
    );
  }
  const padded = fraction.padEnd(exponent, '0');
  const value = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(padded || '0');
  return negative ? -value : value;
}

/** Renders minor units for display, e.g. 185000n -> "1,850.00". */
export function formatMinor(amount: Minor | string | number, code = 'ZAR'): string {
  const { exponent } = currency(code);
  const value = typeof amount === 'bigint' ? amount : BigInt(amount);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(exponent);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(exponent, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${exponent > 0 ? `.${fraction}` : ''}`;
}

/** Renders with the currency symbol, e.g. "R1,850.00". */
export function formatMoney(amount: Minor | string | number, code = 'ZAR'): string {
  return `${currency(code).symbol}${formatMinor(amount, code)}`;
}

export function toMinor(value: unknown): Minor {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${value} is not a safe integer amount of minor units.`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`Cannot interpret ${JSON.stringify(value)} as minor units.`);
}

/**
 * Prorates an amount by a day fraction.
 *
 * Rounding is half-up on the absolute value at the LINE level, and the
 * numerator/denominator are persisted alongside the result so a statement can
 * reproduce and explain the figure rather than asking the reader to trust it.
 */
export function prorate(fullAmount: Minor, numerator: number, denominator: number): Minor {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new Error('Proration numerator and denominator must be whole days.');
  }
  if (denominator <= 0) throw new Error('Proration denominator must be positive.');
  if (numerator < 0) throw new Error('Proration numerator cannot be negative.');
  if (numerator >= denominator) return fullAmount;

  const n = BigInt(numerator);
  const d = BigInt(denominator);
  const negative = fullAmount < 0n;
  const abs = negative ? -fullAmount : fullAmount;
  // Half-up: (abs*n + d/2) / d, using integer arithmetic throughout.
  const scaled = (abs * n * 2n + d) / (d * 2n);
  return negative ? -scaled : scaled;
}

export function sumMinor(values: Iterable<Minor>): Minor {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}
