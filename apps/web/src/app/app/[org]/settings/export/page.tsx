import { Card, PageHeader } from '@propertyos/ui';
import { Icons } from '@/components/icons';
import { BackLink } from '@/components/back-link';
import { hasPermission } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';

export const metadata = { title: 'Export your data' };
export const dynamic = 'force-dynamic';

/**
 * Leaving with your own records.
 *
 * The page says what the archive contains and, more importantly, what it does
 * not, before anybody downloads it and discovers the gap themselves. A manifest
 * of attachments is not the attachments; the last four digits of an identity
 * number are not the number.
 */
export default async function ExportPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const context = await requireOperator(org);
  const allowed = await readAs(context.viewer, (tx) =>
    hasPermission(tx, context.organisationId, 'customer.export'));

  return (
    <div className="space-y-6">
      <BackLink href={`/app/${org}/settings`} label="Settings" />

      <PageHeader
        title="Export your data"
        description="Every record this organisation holds, as CSV files you can open anywhere."
      />

      {!allowed ? (
        <Card className="p-5">
          <p className="text-sm text-ink-700">
            Exporting the organisation&rsquo;s records needs the export permission, which an
            organisation administrator holds. One file carries every resident, every lease and
            every amount, so it is a permission of its own rather than part of managing settings.
          </p>
        </Card>
      ) : (
        <>
          <Card className="p-5">
            <h2 className="text-sm font-semibold text-ink-900">What you get</h2>
            <p className="mt-1 text-sm text-ink-700">
              A ZIP archive of RFC 4180 CSV files — portfolios, properties, units, residents,
              lease parties, leases, charge documents and their lines, receipts, allocations,
              deposit accounts and movements, expenses, vendors, and a manifest of every
              attachment. Identifiers join the files to each other, and a README explains each
              one. Amounts are whole cents, so nothing rounds on the way out.
            </p>
            <p className="mt-3 text-sm text-ink-700">
              It is read with <strong>your</strong> permissions: if your access is scoped to
              certain properties, the export covers those properties.
            </p>

            <a
              href={`/app/${org}/settings/export/export.zip`}
              className="mt-4 inline-block rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white"
            >
              <Icons.download className="h-4 w-4" />
              Download the archive
            </a>
            <p className="mt-2 text-xs text-ink-400">
              Large portfolios take a few seconds. The download is recorded in the audit trail
              with your name and the time.
            </p>
          </Card>

          <Card className="border-caution-700/25 bg-caution-50 p-5">
            <h2 className="text-sm font-semibold text-caution-700">What is deliberately not in it</h2>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink-700">
              <li>
                <strong>The attachment files themselves.</strong> The manifest names every
                document with its storage key and SHA-256 so the files can be matched to the
                object store, but the objects are held privately, with their own authorisation
                and virus-scanning rules. An archive is not a way around those.
              </li>
              <li>
                <strong>Full identity and bank account numbers.</strong> They are encrypted at
                rest and readable only one at a time, through a path that records who looked.
                The last four digits are in the export, exactly as on the screens.
              </li>
              <li>
                <strong>Anything outside your own access.</strong> Nothing here lifts the scope
                you work under, and nothing from another organisation is in the file.
              </li>
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
