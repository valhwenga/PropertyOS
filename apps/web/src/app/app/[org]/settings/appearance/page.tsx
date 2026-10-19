import Link from 'next/link';
import { Disclosure, PageHeader, Panel, PermissionState } from '@propertyos/ui';
import {
  BRAND_ACCENTS, BRAND_TYPEFACES, getBranding, hasPermission,
} from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { AppearanceForm, LogoForm } from './appearance-form';

export const metadata = { title: 'Appearance' };
export const dynamic = 'force-dynamic';

/**
 * How this organisation looks, to its own staff and to its residents.
 *
 * What is deliberately NOT here: a colour picker, a font upload, a layout
 * chooser. Each would let an administrator produce a console that fails
 * contrast, downloads an untrusted binary, or hides the figures somebody needs
 * to do their job — and the person who pays for that is usually not the person
 * who chose it.
 */
export default async function AppearancePage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const context = await requireOperator(org);

  const { branding, mayManage } = await readAs(context.viewer, async (tx) => ({
    branding: await getBranding(tx, context.organisationId),
    mayManage: await hasPermission(tx, context.organisationId, 'organisation.settings.manage'),
  }));

  return (
    <div className="space-y-5">
      <Link
        href={`/app/${org}/settings`}
        className="text-[length:var(--text-table)] text-spike-600 hover:underline"
      >
        ← Settings
      </Link>

      <PageHeader
        title="Appearance"
        description="Your accent colour, typeface and logo. Applied across this console and the resident portal."
      />

      {!mayManage ? (
        <PermissionState action="change this organisation’s settings" />
      ) : (
        <>
          <Panel title="Colour and type" titleId="colour-and-type">
            <div className="p-4">
              <AppearanceForm
                org={org}
                branding={branding}
                accents={BRAND_ACCENTS}
                typefaces={BRAND_TYPEFACES}
              />
            </div>
          </Panel>

          <Panel
            title="Logo"
            titleId="logo-panel"
            description="Shown in the sidebar here, and at the top of your residents’ portal."
          >
            <div className="p-4">
              <LogoForm org={org} branding={branding} />
            </div>
          </Panel>
        </>
      )}

      <Disclosure summary="What this does and does not change">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            The accent and typeface apply to every page of this console and to the portal your
            residents sign in to. They are the organisation&rsquo;s, not yours: a colleague sees
            what you choose.
          </li>
          <li>
            Light and dark are a separate, personal choice, on{' '}
            <Link href="/account" className="text-spike-600 hover:underline">your profile</Link>.
            Each accent has its own dark palette, so both themes stay readable.
          </li>
          <li>
            Generated documents — lease agreements, statement PDFs — are deliberately unchanged.
            They are legal records, their layout is fixed, and no logo is drawn onto one.
          </li>
          <li>
            Every change is recorded in the audit trail, with who made it and when.
          </li>
        </ul>
      </Disclosure>
    </div>
  );
}
