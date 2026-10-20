import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Card, DataTable, Disclosure, Figure, Money, PageHeader, Panel, StatusBadge, Tabs,
  Td, Th, buttonClass,
} from '@propertyos/ui';
import { CONTROL_CLASS } from '@propertyos/ui';
import {
  buildStatement, CHARGE_CATEGORIES, DomainError, escalationsDue, hasPermission,
  listChargeSchedules, listInvoicesForLease, listLeaseAgreementGenerations,
  listLeaseLifecycleEvents, listLeaseTemplates, minorToMajorInput,
} from '@propertyos/domain';
import { loadPortalAccess } from '@/lib/operations-queries';
import { todayIn } from '@/lib/today';
import { AgreementPanel } from './agreement/agreement-panel';
import { ChargePanel } from './charge-panel';
import { CreditNoteForm } from './credit-note-form';
import { SchedulePanel } from './schedule-panel';
import { LifecyclePanel } from './lifecycle/lifecycle-panel';
import { PortalAccessPanel } from './portal-panel';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';

export const metadata = { title: 'Lease account' };
export const dynamic = 'force-dynamic';

export default async function LeaseDetailPage({
  params, searchParams,
}: {
  params: Promise<{ org: string; leaseId: string }>;
  searchParams: Promise<{ cutOff?: string; tab?: string }>;
}) {
  const { org, leaseId } = await params;
  const { cutOff, tab } = await searchParams;
  const context = await requireOperator(org);
  const cut = cutOff ?? new Date().toISOString().slice(0, 10);

  const data = await readAs(context.viewer, async (tx) => {
    const [lease] = await tx<
      { id: string; reference: string; status: string; start_date: string; end_date: string | null;
        rent_minor: string; currency_code: string; unit_label: string; resident_name: string;
        deposit_required_minor: string; execution_exception_reason: string | null }[]
    >`
      select l.id, l.reference, l.status::text, l.start_date::text, l.end_date::text,
             l.rent_minor::text, l.currency_code, l.deposit_required_minor::text,
             l.execution_exception_reason,
             p.name || ' / ' || u.code as unit_label,
             coalesce(rp.first_name || ' ' || rp.last_name, '—') as resident_name
      from leases l
      join properties p on p.id = l.property_id
      join units u on u.id = l.unit_id
      left join lease_parties lp on lp.lease_id = l.id and lp.role = 'primary_resident' and lp.removed_on is null
      left join resident_profiles rp on rp.id = lp.resident_id
      where l.id = ${leaseId}::uuid and l.organisation_id = ${context.organisationId}::uuid
    `;
    if (!lease) return null;

    const parties = await tx<{ name: string; role: string; can_view_financials: boolean }[]>`
      select rp.first_name || ' ' || rp.last_name as name, lp.role::text, lp.can_view_financials
      from lease_parties lp
      join resident_profiles rp on rp.id = lp.resident_id
      where lp.lease_id = ${leaseId}::uuid and lp.removed_on is null
      order by lp.role
    `;

    const templates = await listLeaseTemplates(tx, context.organisationId);
    const generations = await listLeaseAgreementGenerations(tx, context.organisationId, leaseId);
    const lifecycle = await listLeaseLifecycleEvents(tx, context.organisationId, leaseId);
    const [terms] = await tx<Record<string, string | null>[]>`
      select parking_bays, max_occupants::text, permanent_vehicles::text,
             smoking_allowed::text, pets_allowed::text, pets_detail,
             admin_fee_minor::text, credit_check_fee_minor::text, inspection_fee_minor::text,
             cancellation_penalty_months::text,
             arrear_interest_monthly_percent::text, arrear_interest_annual_cap_percent::text,
             renewal_option_months::text, renewal_notice_months::text,
             payment_method::text, place_of_payment, jurisdiction_court,
             key_return_at::text, surcharge_detail, special_conditions,
             deposit_refund_days::text, defects_notice_days::text,
             maintenance_callout_fee_minor::text, early_cancellation_cap_minor::text,
             named_occupants, payment_reference, complaints_threshold::text,
             refund_account_holder, refund_bank_name, refund_branch_code,
             -- Only the last four digits. The sealed number is never read back
             -- to a screen; the form shows them as a placeholder so the operator
             -- can see an account is on file without the number being on it.
             refund_account_number_last4
        from lease_agreement_terms
       where lease_id = ${leaseId}::uuid and organisation_id = ${context.organisationId}::uuid
    `;

    try {
      const statement = await buildStatement(tx, context.organisationId, { leaseId, cutOff: cut });
      return {
        lease, parties, statement, templates, generations, lifecycle,
        terms: terms ?? {},
        portalParties: await loadPortalAccess(tx, context.organisationId, leaseId),
        canManageResidents: await hasPermission(
          tx, context.organisationId, 'resident.manage',
        ),
        // Raising a charge is posting to the ledger, so it takes the same
        // permission a billing run does.
        canPostCharges: await hasPermission(tx, context.organisationId, 'billing.post'),
        canAdjustCharges: await hasPermission(tx, context.organisationId, 'charge.adjust'),
        canChangeTerms: await hasPermission(tx, context.organisationId, 'lease.activate'),
        // What this lease bills every month, and whether the escalation its
        // own agreement promises has fallen due without being applied.
        schedules: await listChargeSchedules(
          tx, context.organisationId, leaseId, todayIn(context.timeZone),
        ),
        escalation: (await escalationsDue(tx, context.organisationId, {
          leaseId, today: todayIn(context.timeZone),
        }))[0] ?? null,
        // The documents themselves, as the tenant sees them. An operator
        // answering "what did you send me" should be able to open the same
        // file rather than describing it.
        documents: await listInvoicesForLease(tx, leaseId, 24),
      };
    } catch (error) {
      if (error instanceof DomainError && error.code === 'not_found') return null;
      throw error;
    }
  });

  if (!data) notFound();
  const { lease, parties, statement } = data;

  const base = `/app/${org}/leases/${leaseId}`;
  const current = tab === 'agreement' || tab === 'parties' || tab === 'history' ? tab : 'account';
  const tabHref = (key: string) =>
    `${base}?${key === 'account' ? '' : `tab=${key}&`}cutOff=${cut}`;
  const statusTone = lease.status === 'active'
    ? 'positive'
    : lease.status === 'draft' || lease.status === 'pending_activation'
      ? 'neutral'
      : lease.status === 'notice_given' || lease.status === 'holdover'
        ? 'caution'
        : 'neutral';

  return (
    <div className="space-y-5">
      <PageHeader
        // The person and the unit first: a reference identifies the record,
        // but nobody opens this page looking for a reference.
        title={lease.resident_name}
        description={lease.unit_label}
        meta={
          <>
            <span className="technical">{lease.reference}</span>
            <StatusBadge tone={statusTone}>
              <span className="capitalize">{lease.status.replace(/_/g, ' ')}</span>
            </StatusBadge>
            <span>
              {formatDate(lease.start_date, context.timeZone)} –{' '}
              {lease.end_date ? formatDate(lease.end_date, context.timeZone) : 'open ended'}
            </span>
          </>
        }
        actions={
          <>
            <a
              href={`${base}/statement.pdf?cutOff=${cut}`}
              className={buttonClass('secondary')}
            >
              Download PDF
            </a>
            <a
              href={`${base}/statement.csv?cutOff=${cut}`}
              className={buttonClass('secondary')}
            >
              Export CSV
            </a>
            <Link
              href={`/app/${org}/reconciliation?lease=${leaseId}`}
              className={buttonClass('primary')}
            >
              Record a receipt
            </Link>
          </>
        }
      />

      {/* Summary. Receivable, credit and deposit are shown as three SEPARATE
          figures, because conflating them is how a resident gets told they owe
          nothing when they do. */}
      <Panel title="Account summary" titleId="account-summary">
        <dl className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-4">
          <Figure
            label="Closing receivable"
            value={
              <Money
                minor={statement.closingReceivableMinor} currency={statement.currencyCode}
                tone="auto"
              />
            }
            hint={
              statement.closingReceivableMinor < 0n
                ? `In credit as at ${formatDate(cut, context.timeZone)}`
                : `Owed as at ${formatDate(cut, context.timeZone)}`
            }
          />
          <Figure
            label="Unapplied credit"
            value={
              <Money
                minor={statement.unappliedCreditMinor} currency={statement.currencyCode}
                tone="plain"
              />
            }
            hint="Overpayment held, not yet applied to a charge"
          />
          <Figure
            label="Deposit held"
            value={
              <Money
                minor={statement.depositHeldMinor} currency={statement.currencyCode}
                tone="plain"
              />
            }
            hint={
              <>
                A separate liability. It does not reduce the receivable.
                {/* The full history — receipts, interest, every deduction with
                    the reason recorded for it — as the document the tenant
                    gets at the end of the lease. */}
                {statement.depositHeldMinor !== 0n ? (
                  <>
                    {' '}
                    <a href={`${base}/deposit.pdf`} className="text-spike-600 hover:underline">
                      Deposit statement (PDF)
                    </a>
                  </>
                ) : null}
              </>
            }
          />
          <Figure
            label="Contracted rent"
            value={<Money minor={lease.rent_minor} currency={lease.currency_code} tone="plain" />}
            hint="Per month, before any utilities or recoveries"
          />
        </dl>
      </Panel>

      {statement.pendingEvidence.length > 0 ? (
        <Card className="border-caution-700/25 bg-caution-50 p-4">
          <p className="text-[length:var(--text-table)] font-semibold text-caution-700">
            {statement.pendingEvidence.length} proof of payment awaiting verification
          </p>
          <p className="mt-1 text-[length:var(--text-table)] text-ink-700">
            The resident has uploaded evidence totalling{' '}
            <Money
              minor={statement.pendingEvidence.reduce((s, e) => s + e.claimedAmountMinor, 0n)}
              currency={statement.currencyCode}
              tone="plain"
            />
            . This has <strong>not</strong> reduced the balance above and will not until the funds
            are confirmed against the bank record and a receipt is created.
          </p>
          <Link
            href={`/app/${org}/reconciliation?filter=evidence&lease=${leaseId}`}
            className="mt-2 inline-block text-[length:var(--text-table)] font-medium text-spike-600 hover:underline"
          >
            Review the evidence →
          </Link>
        </Card>
      ) : null}

      {lease.execution_exception_reason ? (
        <Card className="border-info-700/25 bg-info-50 p-4">
          <p className="text-[length:var(--text-table)] font-semibold text-info-700">
            Activated without an attached contract
          </p>
          <p className="mt-1 text-[length:var(--text-table)] text-ink-700">
            {lease.execution_exception_reason}
          </p>
        </Card>
      ) : null}

      {/* Four tabs, each backed by data this page already loads and a route
          that already exists. The cut-off travels with them, so moving between
          tabs never silently re-dates the statement. */}
      <Tabs
        label="Lease sections"
        current={current}
        tabs={[
          { key: 'account', label: 'Account', href: tabHref('account') },
          { key: 'agreement', label: 'Agreement', href: tabHref('agreement') },
          { key: 'parties', label: 'Parties', href: tabHref('parties'), count: parties.length },
          { key: 'history', label: 'History', href: tabHref('history'), count: data.lifecycle.length },
        ]}
      />

      {current === 'account' ? (
        <section aria-labelledby="statement-heading" className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2
              id="statement-heading"
              className="text-[length:var(--text-section)] font-semibold text-ink-900"
            >
              Statement
            </h2>
            {/* The statement runs from the start of the lease to a date you
                choose. There is no "from", because the exported PDF and CSV
                take a cut-off only, and a screen that could be narrowed where
                the file could not would be a scope the export silently
                widened. */}
            <form method="get" className="flex items-end gap-2">
              <label
                htmlFor="cutOff"
                className="text-[length:var(--text-meta)] font-medium text-ink-500"
              >
                Everything to
                <input
                  id="cutOff" type="date" name="cutOff" defaultValue={cut}
                  className={`ml-2 ${CONTROL_CLASS}`}
                />
              </label>
              <button type="submit" className={buttonClass('secondary')}>Show</button>
            </form>
          </div>

          <DataTable
            caption={`Statement for lease ${lease.reference} to ${formatDate(cut, context.timeZone)}`}
            stickyHead
            minWidth="48rem"
            head={
              <tr>
                <Th>Date</Th><Th>Reference</Th><Th>Description</Th>
                <Th numeric>Debit</Th><Th numeric>Credit</Th><Th numeric>Balance</Th>
              </tr>
            }
          >
            <tr className="bg-ink-50/60">
              <Td className="text-ink-500">—</Td>
              <Td className="text-ink-500">—</Td>
              <Td className="font-medium">
                Opening balance
                <span className="ml-2 text-[length:var(--text-meta)] text-ink-400">
                  ({statement.openingBalanceSource === 'prior_activity'
                    ? 'from posted activity before this window'
                    : 'no prior activity'})
                </span>
              </Td>
              <Td numeric className="text-ink-300">—</Td>
              <Td numeric className="text-ink-300">—</Td>
              <Td numeric>
                <Money minor={statement.openingBalanceMinor} currency={statement.currencyCode} />
              </Td>
            </tr>

            {statement.lines.map((line, index) => (
              <tr key={`${line.reference}-${index}`}>
                <Td className="whitespace-nowrap text-ink-500">
                  {formatDate(line.entryDate, context.timeZone)}
                </Td>
                <Td className="technical whitespace-nowrap text-ink-500">{line.reference}</Td>
                <Td>
                  {line.description}
                  {line.kind === 'allocation' ? (
                    <span className="ml-2 text-[length:var(--text-meta)] text-ink-400">
                      payment applied
                    </span>
                  ) : null}
                </Td>
                <Td numeric>
                  {line.debitMinor > 0n
                    ? <Money minor={line.debitMinor} currency={statement.currencyCode} tone="plain" />
                    : <span className="text-ink-300">—</span>}
                </Td>
                <Td numeric>
                  {line.creditMinor > 0n
                    ? <Money minor={line.creditMinor} currency={statement.currencyCode} tone="plain" />
                    : <span className="text-ink-300">—</span>}
                </Td>
                {/* The running balance is the one figure where the sign means
                    something: below zero the resident is in credit, and it is
                    labelled as such rather than printed in red. */}
                <Td numeric>
                  <Money minor={line.runningBalanceMinor} currency={statement.currencyCode} />
                </Td>
              </tr>
            ))}

            <tr className="border-t-2 border-ink-200 bg-ink-50/70 font-semibold text-ink-900">
              <th scope="row" colSpan={3} className="px-3 py-2 text-left font-semibold">
                {statement.closingReceivableMinor < 0n
                  ? 'Closing balance — in credit'
                  : 'Closing receivable'}
              </th>
              <Td numeric> </Td><Td numeric> </Td>
              <Td numeric>
                <Money
                  minor={statement.closingReceivableMinor} currency={statement.currencyCode}
                  emphasise
                />
              </Td>
            </tr>
          </DataTable>

          <Disclosure summary="How this statement is put together">
            <ul className="list-disc space-y-1 pl-5">
              <li>
                Generated {formatDate(statement.generatedAt, context.timeZone)}, cut off{' '}
                {formatDate(cut, context.timeZone)}. Every line traces to a posted charge or a
                live allocation.
              </li>
              <li>
                On one day, charges are listed before the payments applied to them, so the
                running balance follows the order the accounting happened in rather than the
                order entries were captured.
              </li>
              <li>
                Deposits and unverified payment evidence are excluded from this balance; both
                are shown separately above.
              </li>
              <li>The PDF and CSV cover exactly this period and these lines.</li>
            </ul>
          </Disclosure>
        </section>
      ) : null}

      {current === 'account' && data.canChangeTerms ? (
        <Panel
          title="What this lease bills every month"
          titleId="recurring-charges"
          description="The rent and anything else that recurs. A change keeps its own dates, so what was billed before stays readable as it was billed."
        >
          <SchedulePanel
            org={org}
            leaseId={leaseId}
            schedules={data.schedules}
            categories={CHARGE_CATEGORIES}
            escalation={data.escalation}
            today={todayIn(context.timeZone)}
            currencySymbol={lease.currency_code === 'ZAR' ? 'R' : lease.currency_code}
            currencyCode={lease.currency_code}
          />
        </Panel>
      ) : null}

      {current === 'account' && data.documents.length > 0 ? (
        <Panel
          title="Documents issued"
          titleId="documents-issued"
          description="The invoices and credit notes this tenant can download, in the design chosen in Settings → Appearance."
        >
          <ul className="divide-y divide-ink-100">
            {data.documents.map((document) => (
              <li
                key={document.documentId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
              >
                <a
                  href={`${base.replace(`/leases/${leaseId}`, '')}/billing/invoices/${document.documentId}/invoice.pdf`}
                  className="technical text-[length:var(--text-table)] font-medium text-spike-600 hover:underline"
                >
                  {document.documentNumber}
                </a>
                {document.kind === 'credit_note' ? (
                  <StatusBadge tone="positive">Credit note</StatusBadge>
                ) : null}
                {/* The same words the document itself uses, so a list and a
                    PDF never describe one state two ways. */}
                {document.reversed ? (
                  <StatusBadge tone="caution">Credited in full</StatusBadge>
                ) : null}
                <span className="text-[length:var(--text-meta)] text-ink-500">
                  issued {formatDate(document.issueDate, context.timeZone)} · due{' '}
                  {formatDate(document.dueDate, context.timeZone)}
                </span>
                <span className="ml-auto tabular text-[length:var(--text-table)] text-ink-700">
                  <Money
                    minor={document.totalMinor < 0n ? -document.totalMinor : document.totalMinor}
                    currency={document.currencyCode}
                    tone="plain"
                  />
                </span>
                {/* A posted document cannot be edited, which is correct and
                    left an operator with nowhere to go when a charge was
                    wrong. A credit note is how a correction is made visible
                    rather than hidden. */}
                {data.canAdjustCharges && document.kind === 'invoice'
                  && document.remainingCreditableMinor > 0n ? (
                    <CreditNoteForm
                      org={org}
                      leaseId={leaseId}
                      documentId={document.documentId}
                      documentNumber={document.documentNumber}
                      category={document.primaryCategory}
                      remainingMajor={minorToMajorInput(
                        document.remainingCreditableMinor, document.currencyCode,
                      )}
                      today={todayIn(context.timeZone)}
                      currencySymbol={lease.currency_code === 'ZAR' ? 'R' : lease.currency_code}
                    />
                  ) : null}
                {document.creditedMinor > 0n && !document.reversed ? (
                  <span className="text-[length:var(--text-meta)] text-caution-700">
                    <Money
                      minor={document.creditedMinor} currency={document.currencyCode} tone="plain"
                    />{' '}
                    credited back
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {current === 'account' && data.canPostCharges ? (
        <Panel
          title="Raise a charge"
          titleId="raise-a-charge"
          description="Water, electricity, sewerage, refuse or anything else this tenant owes outside the monthly rent. It posts to the ledger and appears on their next invoice."
        >
          <ChargePanel
            org={org}
            leaseId={leaseId}
            categories={CHARGE_CATEGORIES}
            today={todayIn(context.timeZone)}
            currencySymbol={lease.currency_code === 'ZAR' ? 'R' : lease.currency_code}
          />
        </Panel>
      ) : null}

      {current === 'parties' ? (
        <div className="space-y-5">
          <Panel
            title="Lease parties"
            titleId="parties-heading"
            description="Joint parties share a single rent receivable. Adding a co-lessee never creates a second rent charge."
          >
            <ul className="divide-y divide-ink-100">
              {parties.map((p) => (
                <li
                  key={`${p.name}-${p.role}`}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-[length:var(--text-table)] font-medium text-ink-900">
                      {p.name}
                    </p>
                    <p className="text-[length:var(--text-meta)] capitalize text-ink-500">
                      {p.role.replace(/_/g, ' ')}
                    </p>
                  </div>
                  {/* Joint parties share ONE rent receivable; the badge makes
                      that explicit so nobody expects a second invoice. */}
                  {p.can_view_financials
                    ? <StatusBadge tone="info">Sees shared financials</StatusBadge>
                    : <StatusBadge tone="neutral">No financial access</StatusBadge>}
                </li>
              ))}
            </ul>
          </Panel>

          {/* The portal invitation commands have existed since §8 with no screen
              at all: an operator could not invite a resident, and a resident could
              not have redeemed a link if one had been issued. */}
          <PortalAccessPanel
            org={org}
            leaseId={leaseId}
            baseUrl={process.env.APP_BASE_URL ?? ''}
            canManage={data.canManageResidents}
            parties={data.portalParties.map((party) => ({
              residentId: party.resident_id,
              name: party.name,
              email: party.email,
              role: party.role,
              canViewFinancials: party.can_view_financials,
              portalLinkId: party.portal_link_id,
              status: party.status,
              invitedEmail: party.invited_email,
              expiresAt: party.expires_at,
              lapsed: party.lapsed,
            }))}
          />
        </div>
      ) : null}

      {current === 'history' ? (
        /* The reason a term changed is part of the lease's story, so it sits
           with the lease rather than in an audit log nobody opens. */
        <LifecyclePanel
          org={org}
          leaseId={leaseId}
          status={data.lease.status}
          endDateDisplay={data.lease.end_date ? formatDate(data.lease.end_date, context.timeZone) : null}
          events={data.lifecycle.map((e) => ({
            id: e.id, kind: e.kind, reason: e.reason, recordedBy: e.recordedBy,
            effectiveDateDisplay: formatDate(e.effectiveDate, context.timeZone),
            previousEndDateDisplay: e.previousEndDate
              ? formatDate(e.previousEndDate, context.timeZone) : null,
            recordedAtDisplay: formatDate(e.recordedAt, context.timeZone),
          }))}
        />
      ) : null}

      {current === 'agreement' ? (
        <AgreementPanel
          org={org}
          leaseId={leaseId}
          templates={data.templates.map((t) => ({
            id: t.id, name: t.name, publishedVersion: t.publishedVersion,
          }))}
          terms={data.terms}
          generations={data.generations}
        />
      ) : null}
    </div>
  );
}
