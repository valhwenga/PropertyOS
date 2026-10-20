import Link from 'next/link';
import { Disclosure, PageHeader, Panel, PermissionState } from '@propertyos/ui';
import {
  BRAND_ACCENTS, BRAND_TYPEFACES, getBranding, hasPermission, INVOICE_TEMPLATES,
} from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { AppearanceForm, LogoForm } from './appearance-form';
import { InvoiceDesignForm } from './invoice-design-form';

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
            description="Shown in the sidebar here, at the top of your residents’ portal, on their statements, as the browser tab’s icon, and on your own sign-in page."
          >
            <div className="p-4">
              <LogoForm org={org} branding={branding} />
            </div>
          </Panel>

          <Panel
            title="Invoice design"
            titleId="invoice-design"
            description="Which layout your tenants receive. Every design carries the payment reference, the due date and your own details."
          >
            <div className="p-4">
              <InvoiceDesignForm org={org} branding={branding} templates={INVOICE_TEMPLATES} />
            </div>
          </Panel>

          <Panel
            title="Your sign-in page"
            titleId="sign-in-page"
            description="A bookmark for your staff that opens in your colours rather than ours."
          >
            <div className="space-y-2 p-4">
              <p className="text-[length:var(--text-table)] text-ink-700">
                <code className="rounded bg-ink-50 px-1.5 py-0.5">/sign-in/{org}</code>
              </p>
              <p className="text-[length:var(--text-meta)] text-ink-500">
                It accepts exactly the same credentials as the ordinary sign-in page and lets
                nobody in who could not sign in there — it only looks different. The page shows
                your logo and accent and deliberately not your name, and an address that matches
                no organisation shows the plain page rather than an error, so the URL cannot be
                used to work out who uses this product.
              </p>
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
            Invoices are issued in the design you choose above, with your logo, your accent,
            your registered details, the property and the payment reference your tenant must
            quote. Changing the design changes invoices generated from then on; a PDF
            somebody already downloaded is not rewritten.
          </li>
          <li>
            Statement PDFs carry your logo in the header, with your registered name in words
            beneath it, and the attribution to this product moves to one small line at the
            foot of the page. Where there is no logo, or where the file cannot be embedded,
            your name takes its place: a statement is never left ungenerated over a mark.
          </li>
          <li>
            Lease agreements are deliberately unchanged. They are the signed record of an
            agreement, their layout is fixed, and nothing decorative is drawn onto one.
          </li>
          <li>
            Every change is recorded in the audit trail, with who made it and when.
          </li>
        </ul>
      </Disclosure>
    </div>
  );
}
