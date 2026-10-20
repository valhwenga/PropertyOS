/**
 * What a charge can be for.
 *
 * A list rather than free text, for the same reason an accent is a list: the
 * category decides which income account is credited, and a tenant querying
 * "what is this R385.80" is entitled to an answer more specific than "utility".
 * Municipal wording is used where a municipality uses it — a Cape Town or
 * Johannesburg account says *domestic effluent*, not *sewerage*, and a tenant
 * holding that account beside this invoice should see the same words.
 *
 * `measured` marks the categories that normally come from a meter. It drives
 * nothing in the ledger; it tells a form which fields to offer and an invoice
 * which lines are expected to show their arithmetic.
 */

export interface ChargeCategory {
  key: string;
  label: string;
  /** What the invoice prints as the line's heading when nothing else is given. */
  defaultDescription: string;
  /** Normally read off a meter, so the form offers readings and a tariff. */
  measured: boolean;
  /** The unit a form should suggest. Only meaningful where `measured`. */
  unit?: string;
}

export const CHARGE_CATEGORIES: readonly ChargeCategory[] = [
  { key: 'rent', label: 'Rent', defaultDescription: 'Monthly rent', measured: false },
  {
    key: 'utility_water', label: 'Water',
    defaultDescription: 'Water consumption', measured: true, unit: 'kl',
  },
  {
    key: 'utility_electricity', label: 'Electricity',
    defaultDescription: 'Electricity consumption', measured: true, unit: 'kWh',
  },
  {
    key: 'utility_sewerage', label: 'Sewerage (domestic effluent)',
    defaultDescription: 'Sewerage / domestic effluent', measured: true, unit: 'kl',
  },
  {
    key: 'utility_refuse', label: 'Refuse removal',
    defaultDescription: 'Refuse removal', measured: false,
  },
  {
    key: 'utility_gas', label: 'Gas',
    defaultDescription: 'Gas consumption', measured: true, unit: 'm³',
  },
  {
    key: 'utility_other', label: 'Other municipal recovery',
    defaultDescription: 'Municipal recovery', measured: false,
  },
  { key: 'parking', label: 'Parking', defaultDescription: 'Parking bay', measured: false },
  { key: 'levy', label: 'Levy', defaultDescription: 'Body corporate levy', measured: false },
  {
    key: 'admin_fee', label: 'Administration fee',
    defaultDescription: 'Administration fee', measured: false,
  },
  {
    key: 'late_fee', label: 'Late payment charge',
    defaultDescription: 'Late payment charge', measured: false,
  },
  {
    key: 'repairs_recovery', label: 'Repairs recovered',
    defaultDescription: 'Repair recovered from tenant', measured: false,
  },
  { key: 'insurance', label: 'Insurance', defaultDescription: 'Insurance', measured: false },
  { key: 'adjustment', label: 'Adjustment', defaultDescription: 'Adjustment', measured: false },
  { key: 'other', label: 'Other', defaultDescription: 'Other charge', measured: false },
] as const;

/**
 * Keys that exist in data but are not offered for new charges.
 *
 * `utility_fixed` was what a schedule used before utilities had names, and
 * `opening_balance` is written by the import. Both must still be readable and
 * must still have a label, because an invoice that says "utility_fixed" to a
 * tenant is an invoice that leaked a column name.
 */
const LEGACY_LABELS: Record<string, string> = {
  utility_fixed: 'Utilities',
  opening_balance: 'Balance brought forward',
};

const BY_KEY = new Map(CHARGE_CATEGORIES.map((category) => [category.key, category]));

/** The words a tenant sees. Never the key, whatever the key turns out to be. */
export function chargeCategoryLabel(key: string | null | undefined): string {
  if (!key) return 'Charge';
  return BY_KEY.get(key)?.label
    ?? LEGACY_LABELS[key]
    // An unknown key is still shown as words rather than as an identifier:
    // "utility_borehole" reads as "Utility borehole", not as a bug.
    ?? key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export function chargeCategoryByKey(key: string | null | undefined): ChargeCategory | null {
  return key ? BY_KEY.get(key) ?? null : null;
}

/** The categories a landlord may raise a charge under today. */
export const CHARGE_CATEGORY_KEYS = CHARGE_CATEGORIES.map((category) => category.key);
