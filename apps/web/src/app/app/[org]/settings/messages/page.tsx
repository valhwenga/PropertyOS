import Link from 'next/link';
import { BackLink } from '@/components/back-link';
import { Disclosure, PageHeader, Panel, PermissionState } from '@propertyos/ui';
import {
  getInvoiceMessageTemplate, hasPermission, INVOICE_MESSAGE_FIELDS,
} from '@propertyos/domain';
import { resolveEmailAdapter } from '@propertyos/integrations';
import { readAs, requireOperator } from '@/lib/auth';
import { MessageForm } from './message-form';

export const metadata = { title: 'Message to residents' };
export const dynamic = 'force-dynamic';

/**
 * What a resident reads when an invoice is sent.
 *
 * In the landlord's voice, not Spike's: a letting agency and somebody letting
 * one flat do not write the same email. The fields the product fills in are
 * listed beside the editor and nothing else is accepted — a message that goes
 * out with "{{tenant.name}}" in it tells a resident that nobody checked.
 */
export default async function MessagesPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const context = await requireOperator(org);

  const { template, mayManage } = await readAs(context.viewer, async (tx) => ({
    template: await getInvoiceMessageTemplate(tx, context.organisationId),
    mayManage: await hasPermission(tx, context.organisationId, 'organisation.settings.manage'),
  }));

  const adapter = resolveEmailAdapter();
  const providerConfigured = adapter.name !== 'sink';

  return (
    <div className="space-y-5">
      <BackLink href={`/app/${org}/settings`} label="Settings" />

      <PageHeader
        title="Message to residents"
        description="The covering message sent with an invoice, in your own words."
        meta={
          <>
            <span>{template.customised ? 'Your wording' : 'The product’s default wording'}</span>
            <span aria-hidden="true">·</span>
            <Link
              href={`/app/${org}/billing/invoices`}
              className="text-spike-600 hover:underline"
            >
              Sending invoices
            </Link>
          </>
        }
      />

      {!providerConfigured ? (
        <p className="
          rounded-[var(--radius-card)] border border-caution-700/25 bg-caution-50 px-4 py-3
          text-[length:var(--text-table)] text-ink-700
        ">
          <strong className="font-semibold text-caution-700">
            No email provider is configured.
          </strong>{' '}
          You can write and save this message, and invoices can be queued, but nothing will be
          delivered until a provider is set up. Each attempt is recorded as &ldquo;not
          delivered&rdquo; with that reason rather than shown as sent.
        </p>
      ) : null}

      {!mayManage ? (
        <PermissionState action="change this organisation’s settings" />
      ) : (
        <Panel title="The message" titleId="message">
          <div className="p-4">
            <MessageForm
              org={org}
              subject={template.subject}
              body={template.body}
              fields={INVOICE_MESSAGE_FIELDS}
              customised={template.customised}
              updatedAt={template.updatedAt}
              updatedByName={template.updatedByName}
            />
          </div>
        </Panel>
      )}

      <Disclosure summary="What this message can and cannot say">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            The fields beside the editor are facts already on the invoice — the number, the
            period, the amount, the due date. Nothing here can assert something the ledger does
            not already say.
          </li>
          <li>
            The message is written into each email at the moment you send, so editing it
            afterwards cannot change what a resident has already received.
          </li>
          <li>
            It goes to the <strong>primary resident</strong> on the lease. A co-lessee with
            portal access sees the same invoice in the portal; they are not separately emailed.
          </li>
          <li>
            There is no attachment. The message carries the figures and a link to the
            resident&rsquo;s own statement, which stays correct as payments arrive — a PDF
            attached today would be wrong by next week.
          </li>
        </ul>
      </Disclosure>
    </div>
  );
}
