import type { Sql } from '@propertyos/db';
import type { Minor } from './money';
import { recordAudit } from './audit';
import { DomainError, invalid } from './errors';
import { requirePermission } from './permissions';

/**
 * How many people have to agree before money moves.
 *
 * §4 asks for two-person approval, configurable, for larger customers. The
 * shape that follows from "configurable" is a policy per money action with a
 * threshold, because the honest answer to "should two people approve this?"
 * is "it depends how much it is".
 *
 * The rules this module enforces, in the order they bite:
 *
 *  1. The actor holds the permission for the action. Checked by the command
 *     that calls in here, because it is that command's permission, not this
 *     module's.
 *  2. Nobody signs twice. Enforced by a unique index, so two tabs and a double
 *     click cannot produce a second signature.
 *  3. Where two signatures are required, the person who prepared the thing is
 *     not one of them. Below that, the preparer rule is each flow's own
 *     business — deposits have always enforced it, and switching it on
 *     everywhere by default would stop a one-person landlord approving their
 *     own supplier invoice, which is their whole business.
 *
 * Nothing here posts anything. It answers "is this authorised yet", and the
 * caller does the work when the answer is yes.
 */

export type ApprovalActionKey =
  | 'deposit.payout'
  | 'expense.approve'
  | 'maintenance.quote.approve';

export type ApprovalSubjectTable =
  | 'deposit_payout_requests'
  | 'expenses'
  | 'maintenance_quotes';

export interface ApprovalAction {
  key: ApprovalActionKey;
  subjectTable: ApprovalSubjectTable;
  label: string;
  description: string;
}

/** The three money actions a second signature can be demanded for. */
export const APPROVAL_ACTIONS: readonly ApprovalAction[] = [
  {
    key: 'deposit.payout',
    subjectTable: 'deposit_payout_requests',
    label: 'Deposit deductions, refunds and transfers',
    description:
      'Money leaving a resident’s deposit. The person who raised the request can never be '
      + 'an approver, whatever this is set to.',
  },
  {
    key: 'expense.approve',
    subjectTable: 'expenses',
    label: 'Supplier costs',
    description:
      'Posting a drafted cost to the ledger, which is what makes it a payable.',
  },
  {
    key: 'maintenance.quote.approve',
    subjectTable: 'maintenance_quotes',
    label: 'Maintenance quotations',
    description:
      'Approving a quotation issues a work order with a spending ceiling, which commits '
      + 'the money before any invoice arrives.',
  },
] as const;

export interface ApprovalPolicy {
  actionKey: ApprovalActionKey;
  approvalsRequired: 1 | 2;
  thresholdMinor: bigint;
  updatedAt: string | null;
  updatedByName: string | null;
}

export interface ApprovalSignature {
  signedBy: string;
  signedByName: string | null;
  signedAt: string;
  note: string | null;
}

export interface ApprovalProgress {
  /** True when the action may proceed now. */
  satisfied: boolean;
  required: number;
  signatures: ApprovalSignature[];
}

const DEFAULT_POLICY = { approvalsRequired: 1 as const, thresholdMinor: 0n };

/* ---------------------------------------------------------------- the policy */

/** Every action's current rule, defaults included for the ones never set. */
export async function listApprovalPolicies(
  tx: Sql, organisationId: string,
): Promise<ApprovalPolicy[]> {
  const rows = await tx<
    { action_key: string; approvals_required: number; threshold_minor: string;
      updated_at: string | null; updated_by_name: string | null }[]
  >`
    select p.action_key, p.approvals_required, p.threshold_minor::text,
           p.updated_at::text, u.full_name as updated_by_name
      from approval_policies p
      left join user_profiles u on u.auth_user_id = p.updated_by
     where p.organisation_id = ${organisationId}::uuid
  `;
  const stored = new Map(rows.map((r) => [r.action_key, r]));
  return APPROVAL_ACTIONS.map((action) => {
    const row = stored.get(action.key);
    return {
      actionKey: action.key,
      approvalsRequired: (row?.approvals_required === 2 ? 2 : 1) as 1 | 2,
      thresholdMinor: BigInt(row?.threshold_minor ?? '0'),
      updatedAt: row?.updated_at ?? null,
      updatedByName: row?.updated_by_name ?? null,
    };
  });
}

/** Sets the rule for one action. */
export async function setApprovalPolicy(
  tx: Sql, organisationId: string, actorUserId: string,
  input: { actionKey: string; approvalsRequired: number; thresholdMinor: Minor },
): Promise<void> {
  await requirePermission(tx, organisationId, 'organisation.settings.manage');

  const action = APPROVAL_ACTIONS.find((a) => a.key === input.actionKey);
  if (!action) throw invalid('That is not an action two-person approval applies to.');
  if (input.approvalsRequired !== 1 && input.approvalsRequired !== 2) {
    throw invalid('An action needs one approver or two.');
  }
  const threshold = BigInt(input.thresholdMinor);
  if (threshold < 0n) throw invalid('A threshold cannot be negative.');
  // A threshold is meaningless with one approver: everything needs one anyway,
  // and storing a number nobody reads is how a setting starts lying.
  const stored = input.approvalsRequired === 2 ? threshold : 0n;

  await tx`
    insert into approval_policies (
      organisation_id, action_key, approvals_required, threshold_minor, updated_by)
    values (
      ${organisationId}::uuid, ${action.key}, ${input.approvalsRequired},
      ${stored.toString()}, ${actorUserId}::uuid)
    on conflict (organisation_id, action_key) do update set
      approvals_required = excluded.approvals_required,
      threshold_minor = excluded.threshold_minor,
      updated_at = now(), updated_by = excluded.updated_by
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'approval_policy.updated', resourceType: 'organisation',
    resourceId: organisationId,
    after: {
      actionKey: action.key,
      approvalsRequired: input.approvalsRequired,
      thresholdMinor: stored.toString(),
    },
  });
}

/**
 * How many signatures this particular amount needs.
 *
 * Read inside the approving transaction, so a policy changed a moment ago
 * applies to the decision being made now rather than to the next one.
 */
export async function approvalsRequiredFor(
  tx: Sql, organisationId: string, actionKey: ApprovalActionKey, amountMinor: Minor,
): Promise<number> {
  const [row] = await tx<{ approvals_required: number; threshold_minor: string }[]>`
    select approvals_required, threshold_minor::text
      from approval_policies
     where organisation_id = ${organisationId}::uuid and action_key = ${actionKey}
  `;
  if (!row || row.approvals_required < 2) return DEFAULT_POLICY.approvalsRequired;
  return BigInt(amountMinor) >= BigInt(row.threshold_minor) ? row.approvals_required : 1;
}

/* ------------------------------------------------------------- the signatures */

/** Who has approved this subject so far. */
export async function listApprovalSignatures(
  tx: Sql, organisationId: string,
  subjectTable: ApprovalSubjectTable, subjectId: string,
): Promise<ApprovalSignature[]> {
  const rows = await tx<
    { signed_by: string; signed_by_name: string | null; signed_at: string; note: string | null }[]
  >`
    select s.signed_by, u.full_name as signed_by_name, s.signed_at::text, s.note
      from approval_signatures s
      left join user_profiles u on u.auth_user_id = s.signed_by
     where s.organisation_id = ${organisationId}::uuid
       and s.subject_table = ${subjectTable}
       and s.subject_id = ${subjectId}::uuid
     order by s.signed_at
  `;
  return rows.map((r) => ({
    signedBy: r.signed_by,
    signedByName: r.signed_by_name,
    signedAt: r.signed_at,
    note: r.note,
  }));
}

/**
 * Records this person's approval and says whether that is enough.
 *
 * Called inside the command that will do the work, in its transaction: if the
 * work then fails, the signature rolls back with it, because a signature on
 * something that did not happen is worse than no signature at all.
 */
export async function recordApproval(
  tx: Sql,
  input: {
    organisationId: string;
    actorUserId: string;
    actionKey: ApprovalActionKey;
    subjectTable: ApprovalSubjectTable;
    subjectId: string;
    amountMinor: Minor;
    /** Whoever prepared or requested it, where the flow records one. */
    preparedBy?: string | null;
    note?: string | null;
  },
): Promise<ApprovalProgress> {
  const required = await approvalsRequiredFor(
    tx, input.organisationId, input.actionKey, input.amountMinor,
  );

  // Segregation, where two signatures are demanded. The flows that enforce it
  // at one signature — deposits — do so themselves and say so in their own
  // words, which are better words than this module could write for them.
  if (required > 1 && input.preparedBy && input.preparedBy === input.actorUserId) {
    throw new DomainError(
      'forbidden',
      'This needs two approvers, and you prepared it. Two other people must approve it.',
    );
  }

  const existing = await listApprovalSignatures(
    tx, input.organisationId, input.subjectTable, input.subjectId,
  );
  if (existing.some((s) => s.signedBy === input.actorUserId)) {
    throw new DomainError(
      'conflict',
      'You have already approved this. A second approval has to come from somebody else.',
    );
  }

  await tx`
    insert into approval_signatures (
      organisation_id, action_key, subject_table, subject_id, signed_by, note)
    values (
      ${input.organisationId}::uuid, ${input.actionKey}, ${input.subjectTable},
      ${input.subjectId}::uuid, ${input.actorUserId}::uuid, ${input.note ?? null})
  `;

  const signatures = [
    ...existing,
    {
      signedBy: input.actorUserId,
      signedByName: null,
      signedAt: new Date().toISOString(),
      note: input.note ?? null,
    },
  ];
  return { satisfied: signatures.length >= required, required, signatures };
}

/**
 * Signatures for a set of subjects, grouped by subject.
 *
 * One query for a queue of them, so a list of twenty pending items does not
 * become twenty-one round trips.
 */
export async function signaturesBySubject(
  tx: Sql, organisationId: string,
  subjectTable: ApprovalSubjectTable, subjectIds: string[],
): Promise<Map<string, ApprovalSignature[]>> {
  const grouped = new Map<string, ApprovalSignature[]>();
  if (subjectIds.length === 0) return grouped;

  const rows = await tx<
    { subject_id: string; signed_by: string; signed_by_name: string | null;
      signed_at: string; note: string | null }[]
  >`
    select s.subject_id, s.signed_by, u.full_name as signed_by_name,
           s.signed_at::text, s.note
      from approval_signatures s
      left join user_profiles u on u.auth_user_id = s.signed_by
     where s.organisation_id = ${organisationId}::uuid
       and s.subject_table = ${subjectTable}
       and s.subject_id = any(${subjectIds}::uuid[])
     order by s.signed_at
  `;
  for (const row of rows) {
    const list = grouped.get(row.subject_id) ?? [];
    list.push({
      signedBy: row.signed_by,
      signedByName: row.signed_by_name,
      signedAt: row.signed_at,
      note: row.note,
    });
    grouped.set(row.subject_id, list);
  }
  return grouped;
}

/**
 * The subjects still waiting for another signature.
 *
 * One query for the approvals queue: anything carrying at least one signature
 * that has not yet been acted on by its own flow is, by definition, waiting
 * for somebody else.
 */
export async function countPartialApprovals(
  tx: Sql, organisationId: string,
): Promise<number> {
  const [row] = await tx<{ total: string }[]>`
    select count(*)::text as total
      from (
        select s.subject_table, s.subject_id, count(*) as signatures
          from approval_signatures s
         where s.organisation_id = ${organisationId}::uuid
         group by s.subject_table, s.subject_id
      ) signed
      join approval_policies p
        on p.organisation_id = ${organisationId}::uuid
       and p.approvals_required > signed.signatures
       and p.action_key = case signed.subject_table
             when 'deposit_payout_requests' then 'deposit.payout'
             when 'expenses' then 'expense.approve'
             else 'maintenance.quote.approve'
           end
  `;
  return Number(row?.total ?? '0');
}
