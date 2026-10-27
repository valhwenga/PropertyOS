import { Card, PageHeader } from '@propertyos/ui';
import { platformPermissionsOf, platformSettings } from '@propertyos/domain';
import { readPrivilegedAs, requireViewer } from '@/lib/auth';
import { PlatformSettingRow } from './setting-forms';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

/**
 * What the product decides, and who decides it.
 *
 * Every setting here is read by code: the list is declared in a migration
 * rather than created from this screen, because a flag the console could
 * invent would be a flag nothing reads — somebody turns it off, nothing
 * happens, and the next person cannot tell a broken feature from a fictional
 * one.
 *
 * Readable by anybody in the console and changeable with
 * `platform.config.manage`, for the same reason the permission catalogue is:
 * an operator who cannot see that a customer's portal is switched off cannot
 * answer the ticket about it.
 */
export default async function PlatformSettingsPage() {
  const viewer = await requireViewer();
  const { settings, mine } = await readPrivilegedAs(viewer, async (tx) => ({
    settings: await platformSettings(tx, viewer.authUserId),
    mine: await platformPermissionsOf(tx, viewer.authUserId),
  }));

  const canManage = mine.includes('platform.config.manage');
  const features = settings.filter((s) => s.perOrganisation);
  const limits = settings.filter((s) => !s.perOrganisation);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="What the product does, without a deploy. Every setting here is read by code; the list itself is set by a migration, so there are no flags that do nothing."
      />

      {canManage ? null : (
        <Card className="border-info-700/25 bg-info-50 p-4">
          <p className="text-sm text-info-700">
            Your platform role does not include changing configuration, so this page is
            read-only for you. It is shown rather than hidden because the answer to
            &ldquo;why can&rsquo;t their residents sign in?&rdquo; is often on it.
          </p>
        </Card>
      )}

      <section aria-labelledby="features" className="space-y-3">
        <h2 id="features" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Features
        </h2>
        <p className="text-sm text-ink-500">
          Switched on for everybody unless a customer has been given a different answer on
          their own page. Each of these is visible to the customer on their settings screen.
        </p>
        {features.map((setting) => (
          <PlatformSettingRow key={setting.key} setting={setting} canManage={canManage} />
        ))}
      </section>

      <section aria-labelledby="limits" className="space-y-3">
        <h2 id="limits" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Limits
        </h2>
        <p className="text-sm text-ink-500">
          The same for every customer. These were numbers written into the code until this
          screen existed.
        </p>
        {limits.map((setting) => (
          <PlatformSettingRow key={setting.key} setting={setting} canManage={canManage} />
        ))}
      </section>
    </div>
  );
}
