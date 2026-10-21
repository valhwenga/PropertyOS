import { Card, PageHeader } from '@propertyos/ui';
import { BackLink } from '@/components/back-link';
import { requireOperator } from '@/lib/auth';
import { DocumentImportForm } from './import-form';

export const metadata = { title: 'Bring your documents across' };
export const dynamic = 'force-dynamic';

/**
 * Step 8 of the import order, which had no path at all.
 *
 * A landlord arriving with four hundred lease PDFs and ID copies had to attach
 * them one at a time from each lease screen, which nobody does — so the
 * contracts stay in a folder on a laptop and the product holds leases with no
 * lease agreement in them.
 */
export default async function DocumentImportPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  await requireOperator(org);

  return (
    <div className="space-y-5">
      <BackLink href={`/app/${org}/onboarding`} label="Import your portfolio" />

      <PageHeader
        title="Bring your documents across"
        description="Signed leases, identity documents and inspection reports you already hold."
      />

      <Card className="border-info-700/25 bg-info-50 p-4">
        <p className="text-sm font-semibold text-info-700">How this places a file</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink-700">
          <li>
            By the <strong>name of the file</strong>: a lease reference such as
            <span className="font-mono"> LSE-000007</span>, or a property code.
          </li>
          <li>
            A name that mentions two leases is <strong>reported, not guessed at</strong> —
            filing a tenant&rsquo;s ID copy against the wrong tenancy is a mistake nobody
            finds for a year.
          </li>
          <li>Every file is checked, scanned and stored privately, one kind per batch.</li>
        </ul>
      </Card>

      <DocumentImportForm org={org} scannerConfigured={Boolean(process.env.MALWARE_SCANNER)} />
    </div>
  );
}
