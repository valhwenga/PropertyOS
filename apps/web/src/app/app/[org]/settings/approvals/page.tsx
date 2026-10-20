import { BackLink } from '@/components/back-link';
import { Disclosure, PageHeader, Panel, PermissionState } from '@propertyos/ui';
import {
  APPROVAL_ACTIONS, formatMinor, hasPermission, listApprovalPolicies,
} from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { PolicyForm } from './policy-form';

export const metadata = { title: 'Approval rules' };
export const dynamic = 'force-dynamic';

/**
 * How many people have to agree before money moves.
 *
 * The default everywhere is one approver, which is what a one-person landlord
 * needs and what this product did until now. Two is the §4 control for larger
 * customers: two different people, neither of them whoever prepared the thing,
 * above an amount the organisation chooses.
 */
export default async function ApprovalRulesPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const context = await requireOperator(org);

  const { policies, mayManage } = await readAs(context.viewer, async (tx) => ({
    policies: await listApprovalPolicies(tx, context.organisationId),
    mayManage: await hasPermission(tx, context.organisationId, 'organisation.settings.manage'),
  }));

  return (
    <div className="space-y-5">
      <BackLink href={`/app/${org}/settings`} label="Settings" />

      <PageHeader
        title="Approval rules"
        description="Whether one person or two must approve money leaving the business, and above what amount."
      />

      {!mayManage ? (
        <PermissionState action="change this organisation’s settings" />
      ) : (
        <Panel title="Money actions" titleId="money-actions">
          <div className="divide-y divide-ink-100">
            {APPROVAL_ACTIONS.map((action) => {
              const policy = policies.find((p) => p.actionKey === action.key)!;
              return (
                <PolicyForm
                  key={action.key}
                  org={org}
                  actionKey={action.key}
                  label={action.label}
                  description={action.description}
                  approvalsRequired={policy.approvalsRequired}
                  thresholdMajor={
                    policy.thresholdMinor === 0n
                      ? ''
                      : formatMinor(policy.thresholdMinor, context.currencyCode).replace(/,/g, '')
                  }
                  currencyCode={context.currencyCode}
                  updatedAt={policy.updatedAt}
                  updatedByName={policy.updatedByName}
                />
              );
            })}
          </div>
        </Panel>
      )}

      <Disclosure summary="How a second approval works">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            The first approver&rsquo;s decision is recorded and nothing else happens: no
            journal is posted, no work order is issued, no deposit is reduced. The item stays
            in the approvals queue, saying who has already approved it.
          </li>
          <li>
            The second approval has to come from a different person. Approving twice from one
            account is refused by the database, not only by the screen.
          </li>
          <li>
            Where two approvals are required, nobody who prepared or requested the item may
            approve it. A deposit payout enforces that whatever this is set to.
          </li>
          <li>
            Changing a rule applies to the next decision, not to the ones already made. An
            item already carrying one signature needs one more if the rule now says two.
          </li>
          <li>
            Every signature is kept with the item, and every change to these rules is in the
            audit trail.
          </li>
        </ul>
      </Disclosure>
    </div>
  );
}
