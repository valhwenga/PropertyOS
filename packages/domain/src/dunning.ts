import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { forbidden, invalid } from './errors';
import { requirePlatformPermission, setAccountStatus } from './platform';

/**
 * Trials that have run out, and invoices nobody has paid.
 *
 * Two holes this closes, both of them revenue. A trial had no end date, so
 * every customer ever provisioned was free until somebody changed a dropdown.
 * And an overdue invoice was counted by an alert, which is not chasing.
 *
 * The division of labour is the same one the rest of this product has settled
 * on: the automatic part is the part that only sends messages, and anything
 * that takes something away from a customer waits for a person.
 *
 *   * `chaseOverdueInvoices` runs on the worker's cadence and records
 *     reminders. A reminder is a message; nobody needs to approve one.
 *   * `suspendForNonPayment` is an operator's decision. Suspension stops a
 *     landlord reaching their own tenancy records, which this product has
 *     refused to automate since ADR 0017, and still does.
 */

export type DunningStep =
  | 'first_reminder' | 'final_notice' | 'suspension_proposed' | 'suspended' | 'written_off';

export interface TrialEnded {
  organisationId: string;
  organisationName: string;
  slug: string;
  planKey: string;
  trialEndsOn: string;
  daysOver: number;
  status: string;
}

export interface OverdueInvoice {
  invoiceId: string;
  invoiceNumber: string;
  organisationId: string;
  organisationName: string;
  slug: string;
  totalMinor: number;
  paidMinor: number;
  currencyCode: string;
  dueDate: string;
  daysOverdue: number;
  organisationStatus: string;
  steps: Array<{ step: DunningStep; takenAt: string; takenByName: string | null; note: string | null }>;
  /** True when the ladder has run out of automatic steps and waits on a person. */
  awaitingDecision: boolean;
  /** True when somebody has already decided: suspended, or chasing stopped. */
  settled: boolean;
}

/** Trials past their end date, which are days of free service nobody chose to give. */
export async function trialsEnded(tx: Sql, authUserId: string): Promise<TrialEnded[]> {
  await requirePlatformPermission(tx, authUserId, 'platform.customers.read');
  const rows = await tx<{
    organisation_id: string; name: string; slug: string; plan_key: string;
    trial_ends_on: string; days_over: number; status: string;
  }[]>`
    select s.organisation_id::text, o.name, o.slug, s.plan_key, s.trial_ends_on::text,
           (current_date - s.trial_ends_on) as days_over, o.status::text
      from subscriptions s
      join organisations o on o.id = s.organisation_id
     where s.status = 'trialing'
       and s.trial_ends_on <= current_date
       and o.status not in ('closed', 'suspended')
     order by s.trial_ends_on
  `;
  return rows.map((row) => ({
    organisationId: row.organisation_id,
    organisationName: row.name,
    slug: row.slug,
    planKey: row.plan_key,
    trialEndsOn: row.trial_ends_on,
    daysOver: Number(row.days_over),
    status: row.status,
  }));
}

async function ladderRows(tx: Sql): Promise<OverdueInvoice[]> {
  const rows = await tx<{
    invoice_id: string; invoice_number: string; organisation_id: string; name: string;
    slug: string; total_minor: string; paid_minor: string | null; currency_code: string;
    due_date: string; days_overdue: number; organisation_status: string;
    steps: Array<{ step: DunningStep; taken_at: string; taken_by_name: string | null; note: string | null }> | null;
  }[]>`
    select i.id::text as invoice_id, i.invoice_number, i.organisation_id::text, o.name, o.slug,
           i.total_minor::text, i.paid_minor::text, i.currency_code, i.due_date::text,
           (current_date - i.due_date) as days_overdue, o.status::text as organisation_status,
           (select coalesce(json_agg(json_build_object(
                     'step', d.step, 'taken_at', d.taken_at::text,
                     'taken_by_name', who.full_name, 'note', d.note
                   ) order by case d.step
                        when 'first_reminder' then 1
                        when 'final_notice' then 2
                        when 'suspension_proposed' then 3
                        when 'suspended' then 4
                        else 5
                      end, d.taken_at), '[]'::json)
              from subscription_dunning_steps d
              left join user_profiles who on who.auth_user_id = d.taken_by
             where d.invoice_id = i.id) as steps
      from subscription_invoices i
      join organisations o on o.id = i.organisation_id
     where i.status = 'issued' and i.due_date < current_date
     order by i.due_date
  `;

  return rows.map((row) => {
    const steps = (row.steps ?? []).map((s) => ({
      step: s.step, takenAt: s.taken_at, takenByName: s.taken_by_name, note: s.note,
    }));
    const taken = new Set(steps.map((s) => s.step));
    return {
      invoiceId: row.invoice_id,
      invoiceNumber: row.invoice_number,
      organisationId: row.organisation_id,
      organisationName: row.name,
      slug: row.slug,
      totalMinor: Number(row.total_minor),
      paidMinor: Number(row.paid_minor ?? 0),
      currencyCode: row.currency_code,
      dueDate: row.due_date,
      daysOverdue: Number(row.days_overdue),
      organisationStatus: row.organisation_status,
      steps,
      awaitingDecision: taken.has('suspension_proposed')
        && !taken.has('suspended') && !taken.has('written_off'),
      settled: taken.has('suspended') || taken.has('written_off'),
    };
  });
}

/** Every overdue invoice and how far the chasing has got. */
export async function overdueLadder(tx: Sql, authUserId: string): Promise<OverdueInvoice[]> {
  await requirePlatformPermission(tx, authUserId, 'platform.billing.manage');
  return ladderRows(tx);
}

/** What a customer can see of being chased. Being chased unknowingly is how a
 *  suspension arrives as a surprise. */
export async function organisationDunningSteps(
  tx: Sql,
  organisationId: string,
): Promise<Array<{ invoiceNumber: string; step: DunningStep; takenAt: string }>> {
  const rows = await tx<{ invoice_number: string; step: DunningStep; taken_at: string }[]>`
    select i.invoice_number, d.step, d.taken_at::text
      from subscription_dunning_steps d
      join subscription_invoices i on i.id = d.invoice_id
     where d.organisation_id = ${organisationId}::uuid
       and i.status = 'issued'
     order by d.taken_at desc
     limit 20
  `;
  return rows.map((r) => ({
    invoiceNumber: r.invoice_number, step: r.step, takenAt: r.taken_at,
  }));
}

export interface ChaseOutcome {
  reminders: number;
  finalNotices: number;
  proposed: number;
  /** Invoices that paid themselves off since the last pass: chasing stops. */
  resolved: number;
}

/**
 * The automatic part, for the worker.
 *
 * Takes no actor: there is nobody signed in and the pass is not somebody's
 * action. It records steps and queues messages, and it cannot suspend
 * anybody — the furthest it goes is writing down that suspension is the next
 * thing somebody could decide.
 *
 * Every step is keyed `(invoice_id, step)` in the database, so a pass that
 * runs every five minutes cannot send four reminders an hour. The uniqueness
 * does that rather than this function remembering.
 *
 * It takes **one step per invoice per day**, the earliest one that is due.
 * Not every step whose threshold has passed: the first pass over an existing
 * backlog would then send a reminder and a final notice in the same minute and
 * propose a suspension, which is three contradictory messages from a product
 * that had simply not been watching. One step a day means a sixty-day-old debt
 * climbs the ladder over three days, in order, the way it would have if
 * somebody had been chasing all along.
 */
export async function chaseOverdueInvoices(tx: Sql): Promise<ChaseOutcome> {
  const [thresholds] = await tx<{ first: number; final: number; suspend: number }[]>`
    select app.setting_number('dunning.first_reminder_days') as first,
           app.setting_number('dunning.final_notice_days') as final,
           app.setting_number('dunning.suspend_days') as suspend
  `;
  const first = Number(thresholds?.first ?? 3);
  const final = Number(thresholds?.final ?? 10);
  const suspend = Number(thresholds?.suspend ?? 21);

  const overdue = await ladderRows(tx);
  const outcome: ChaseOutcome = { reminders: 0, finalNotices: 0, proposed: 0, resolved: 0 };

  for (const invoice of overdue) {
    if (invoice.settled) continue;
    // A customer who is already suspended or closed is not chased further:
    // the lever has been pulled and sending them reminders is noise.
    if (['suspended', 'closed'].includes(invoice.organisationStatus)) continue;

    const taken = new Set(invoice.steps.map((s) => s.step));
    const outstanding = invoice.totalMinor - invoice.paidMinor;

    // One a day, so a backlog climbs in order rather than all at once.
    const lastStep = invoice.steps[invoice.steps.length - 1];
    if (lastStep && Date.now() - new Date(lastStep.takenAt).getTime() < 86_400_000) continue;

    const stepsDue: Array<{ step: DunningStep; threshold: number }> = [
      { step: 'first_reminder', threshold: first },
      { step: 'final_notice', threshold: final },
      { step: 'suspension_proposed', threshold: suspend },
    ];

    for (const { step, threshold } of stepsDue) {
      if (invoice.daysOverdue < threshold || taken.has(step)) continue;

      let notificationId: string | null = null;

      // The two message steps get a message. The proposal does not: it is for
      // Spike to read, not the customer, and telling somebody "you are about
      // to be suspended" before a person has decided would be a threat the
      // product made up by itself.
      if (step !== 'suspension_proposed') {
        const [recipient] = await tx<{ auth_user_id: string; email: string }[]>`
          select m.auth_user_id::text, u.email
            from memberships m
            join auth.users u on u.id = m.auth_user_id
            join membership_roles mr on mr.membership_id = m.id
            join role_permissions rp on rp.role_key = mr.role_key
           where m.organisation_id = ${invoice.organisationId}::uuid
             and m.status = 'active'
             and rp.permission_key = 'organisation.settings.manage'
             and u.email not like 'destroyed-%@invalid'
           limit 1
        `;
        if (recipient) {
          const [notice] = await tx<{ id: string }[]>`
            insert into notifications (
              organisation_id, channel, recipient_user_id, recipient_email, title, subject,
              body, status
            ) values (
              ${invoice.organisationId}::uuid, 'email', ${recipient.auth_user_id}::uuid,
              ${recipient.email},
              ${step === 'first_reminder' ? 'Your Spike invoice is overdue' : 'Final notice'},
              ${`${invoice.invoiceNumber} is ${invoice.daysOverdue} days overdue`},
              ${step === 'first_reminder'
                ? `Invoice ${invoice.invoiceNumber} was due on ${invoice.dueDate} and `
                  + `${outstanding} is still outstanding. You can pay it from your `
                  + 'subscription settings, or by transfer quoting the invoice number.'
                : `Invoice ${invoice.invoiceNumber} has been outstanding since `
                  + `${invoice.dueDate}. If it is not settled, access to the console may be `
                  + 'suspended. Your records are not deleted and the resident portal is not '
                  + 'affected.'},
              'queued'
            )
            returning id::text
          `;
          notificationId = notice?.id ?? null;
        }
      }

      await tx`
        insert into subscription_dunning_steps (
          invoice_id, organisation_id, step, days_overdue, notification_id
        ) values (
          ${invoice.invoiceId}::uuid, ${invoice.organisationId}::uuid, ${step},
          ${invoice.daysOverdue}, ${notificationId}::uuid
        )
        on conflict (invoice_id, step) do nothing
      `;

      if (step === 'first_reminder') outcome.reminders += 1;
      else if (step === 'final_notice') outcome.finalNotices += 1;
      else outcome.proposed += 1;

      break; // One step, then leave this invoice until tomorrow.
    }
  }

  return outcome;
}

/**
 * Suspending an account because it has not been paid.
 *
 * A person's decision, with the invoice named in the reason so that the
 * suspension and the debt that caused it are one record rather than two
 * unrelated ones. It goes through `setAccountStatus`, so everything that has
 * always been true of suspension stays true: the records are untouched, the
 * resident portal keeps working, billing keeps running, and the customer is
 * told why on the page they are sent to.
 */
export async function suspendForNonPayment(
  tx: Sql,
  authUserId: string,
  params: { invoiceId: string; reason: string },
): Promise<void> {
  const operator = await requirePlatformPermission(tx, authUserId, 'platform.customers.status');
  if (params.reason.trim().length < 5) throw invalid('A suspension needs a reason.');

  const [invoice] = await tx<{
    organisation_id: string; invoice_number: string; days_overdue: number; status: string;
  }[]>`
    select organisation_id::text, invoice_number, (current_date - due_date) as days_overdue,
           status::text
      from subscription_invoices where id = ${params.invoiceId}::uuid
  `;
  if (!invoice) throw invalid('That invoice could not be read.');
  if (invoice.status !== 'issued') {
    throw invalid('That invoice is not outstanding, so there is nothing to suspend for.');
  }

  await setAccountStatus(tx, authUserId, {
    organisationId: invoice.organisation_id,
    status: 'suspended',
    reason: `${params.reason} (${invoice.invoice_number}, ${invoice.days_overdue} days overdue)`,
  });

  const [recorded] = await tx<{ id: string }[]>`
    insert into subscription_dunning_steps (
      invoice_id, organisation_id, step, days_overdue, taken_by, note
    ) values (
      ${params.invoiceId}::uuid, ${invoice.organisation_id}::uuid, 'suspended',
      ${invoice.days_overdue}, ${operator.authUserId}::uuid, ${params.reason}
    )
    on conflict (invoice_id, step) do nothing
    returning id::text
  `;
  if (!recorded) throw forbidden('That account has already been suspended for this invoice.');
}

/**
 * Stopping the chasing without suspending anybody.
 *
 * The case it exists for: the customer rang, it is being sorted out, and
 * nobody wants the ladder climbing in the background. It is not a write-off of
 * the debt — the invoice still says what it says, and voiding it is a separate
 * and deliberate act.
 */
export async function stopChasing(
  tx: Sql,
  authUserId: string,
  params: { invoiceId: string; reason: string },
): Promise<void> {
  const operator = await requirePlatformPermission(tx, authUserId, 'platform.billing.manage');
  if (params.reason.trim().length < 5) throw invalid('Say why the chasing is stopping.');

  const [invoice] = await tx<{ organisation_id: string; days_overdue: number }[]>`
    select organisation_id::text, (current_date - due_date) as days_overdue
      from subscription_invoices where id = ${params.invoiceId}::uuid
  `;
  if (!invoice) throw invalid('That invoice could not be read.');

  await tx`
    insert into subscription_dunning_steps (
      invoice_id, organisation_id, step, days_overdue, taken_by, note
    ) values (
      ${params.invoiceId}::uuid, ${invoice.organisation_id}::uuid, 'written_off',
      ${invoice.days_overdue}, ${operator.authUserId}::uuid, ${params.reason}
    )
    on conflict (invoice_id, step) do nothing
  `;

  await recordAudit(tx, {
    organisationId: invoice.organisation_id,
    actorUserId: operator.authUserId,
    action: 'subscription.dunning.stopped',
    resourceType: 'subscription_invoice',
    resourceId: params.invoiceId,
    reason: params.reason,
    before: null,
    after: { step: 'written_off' },
  });
}
