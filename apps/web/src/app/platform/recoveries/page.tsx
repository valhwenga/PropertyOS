import { Card, EmptyState, PageHeader } from '@propertyos/ui';
import { listRecoveryRequests, platformPermissionsOf, platformSettings } from '@propertyos/domain';
import { readAs, requireViewer } from '@/lib/auth';
import { SpikeRecovery } from './recovery-forms';

export const metadata = { title: 'Locked out' };
export const dynamic = 'force-dynamic';

/**
 * People locked out of their own accounts, where Spike is the only one who can
 * help.
 *
 * Read through `readAs` and NOT `readPrivilegedAs`, unlike most of this
 * console. The policies on `recovery_requests` hide every request a customer's
 * own administrator could decide, and reading privileged would lift that away
 * and show an operator every locked-out person on the platform. The list query
 * says the same rule a second time for the same reason.
 *
 * So an empty page here is the normal state, and a good one: it means everybody
 * who is locked out has a colleague who can let them back in.
 */
export default async function PlatformRecoveriesPage() {
  const viewer = await requireViewer();

  const { requests, mine, settings } = await readAs(viewer, async (tx) => ({
    requests: await listRecoveryRequests(tx, {
      includeSettled: true, onlyWithoutAnAdministrator: true,
    }),
    mine: await platformPermissionsOf(tx, viewer.authUserId),
    settings: await platformSettings(tx, viewer.authUserId),
  }));

  const canDecide = mine.includes('platform.customers.recover');
  const delaySetting = settings.find((s) => s.key === 'recovery.spike_delay_hours');
  const delayHours = Number(delaySetting?.effectiveValue ?? 24);
  const baseUrl = process.env.APP_BASE_URL ?? '';

  const waiting = requests.filter((r) => r.status === 'open');
  const settled = requests.filter((r) => r.status !== 'open');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Locked out"
        description="People who cannot sign in and have nobody at their own organisation who can let them back in."
      />

      <Card className="space-y-2 p-4 text-sm text-ink-700">
        <p className="font-medium text-ink-900">Why this page is usually empty.</p>
        <p>
          A request only reaches Spike when the person has no colleague holding{' '}
          <span className="tabular">membership.manage</span>. While somebody at their own
          organisation can decide it, this console cannot see the request at all — not
          filtered out of a list, not visible and refused: not readable.
        </p>
        <p>
          Approving one here waits {delayHours} hour{delayHours === 1 ? '' : 's'} before the
          link works, and the account holder can stop it in that window. That wait is the
          only thing protecting somebody from an operator who has been talked into this, so
          the one thing that must not be skipped is telling them it is running.
        </p>
        {process.env.AUTH_PROVIDER === 'supabase' ? (
          <p className="rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2 text-critical-700">
            <strong className="font-semibold">Not usable in this deployment.</strong>{' '}
            Credentials are held by Supabase Auth, which a recovery link does not reach.
            Approving one would produce a link that changes nothing.
          </p>
        ) : null}
      </Card>

      <section aria-labelledby="waiting" className="space-y-3">
        <h2 id="waiting" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Waiting on a decision
        </h2>
        {waiting.length === 0 ? (
          <EmptyState
            title="Nobody is waiting"
            description="Everybody locked out right now has somebody of their own who can help them."
          />
        ) : (
          waiting.map((request) => (
            <SpikeRecovery
              key={request.id} request={request} baseUrl={baseUrl}
              canDecide={canDecide} delayHours={delayHours}
            />
          ))
        )}
      </section>

      {settled.length > 0 ? (
        <section aria-labelledby="settled" className="space-y-3">
          <h2 id="settled" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Decided
          </h2>
          {settled.map((request) => (
            <SpikeRecovery
              key={request.id} request={request} baseUrl={baseUrl}
              canDecide={false} delayHours={delayHours}
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}
