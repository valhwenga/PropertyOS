import type { Sql } from '@propertyos/db';

/**
 * Sequential, per-organisation document numbers.
 *
 * Uniqueness is guaranteed by the unique index on (organisation_id, number);
 * this helper takes a transaction-scoped advisory lock keyed on the organisation
 * and series so that two concurrent posts cannot pick the same number and one
 * of them fail after doing real work.
 */
export async function nextDocumentNumber(
  tx: Sql,
  organisationId: string,
  series: 'INV' | 'CRN' | 'RCT' | 'LSE' | 'ADJ' | 'TKT' | 'OPB',
): Promise<string> {
  // Two 32-bit keys: a stable hash of the organisation, and of the series.
  await tx`select pg_advisory_xact_lock(hashtext(${organisationId}), hashtext(${series}))`;

  const table =
    series === 'RCT' ? 'receipts' : series === 'LSE' ? 'leases' : series === 'TKT' ? 'maintenance_tickets' : 'charge_documents';
  const column =
    series === 'RCT' ? 'receipt_number' : series === 'LSE' ? 'reference' : series === 'TKT' ? 'reference' : 'document_number';

  const [row] = await tx<{ next: number }[]>`
    select coalesce(max(substring(${tx(column)} from '[0-9]+$')::bigint), 0) + 1 as next
    from ${tx(table)}
    where organisation_id = ${organisationId}::uuid
      and ${tx(column)} like ${`${series}-%`}
  `;
  const next = row?.next ?? 1;
  return `${series}-${String(next).padStart(6, '0')}`;
}
