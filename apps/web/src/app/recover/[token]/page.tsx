import { Card, PageHeader } from '@propertyos/ui';
import { privilegedSql } from '@propertyos/db/client';
import { describeRecoveryLink, DomainError } from '@propertyos/domain';
import { Wordmark } from '@/components/wordmark';
import { formatDateTime } from '@/lib/format';
import { RecoverLinkForm } from './recover-link-form';

export const metadata = { title: 'Your recovery link' };
export const dynamic = 'force-dynamic';

/**
 * A recovery link, opened.
 *
 * Reads on a privileged connection with the token as the only credential, like
 * `/join/[token]`. Three outcomes, and the page says which: the link is not
 * valid, the link is not valid YET because Spike approved it and the waiting
 * period is still running, or here is the form.
 *
 * The waiting case is the one worth being explicit about. The delay exists so
 * the account holder can stop a recovery they did not ask for, and a page that
 * just said "invalid" would hide the very thing the delay is for.
 */
export default async function RecoveryLinkPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  let link: Awaited<ReturnType<typeof describeRecoveryLink>> | null = null;
  let refusal: string | null = null;
  try {
    const sql = privilegedSql();
    link = await sql.begin(async (tx) => describeRecoveryLink(tx as never, { token }));
  } catch (error) {
    refusal = error instanceof DomainError
      ? error.message
      : 'This link could not be read. Ask for a new one.';
  }

  return (
    <main id="main" className="mx-auto max-w-xl px-4 py-12">
      <div className="mb-8"><Wordmark /></div>

      {refusal || !link ? (
        <>
          <PageHeader title="This link cannot be used" description={refusal ?? ''} />
          <p className="mt-6 text-sm">
            <a href="/recover" className="font-medium text-spike-600 underline underline-offset-2">
              Ask again
            </a>
          </p>
        </>
      ) : !link.live ? (
        <>
          <PageHeader
            title="Not yet"
            description="Spike approved this recovery, and it waits before it works."
          />
          <Card className="mt-6 space-y-2 p-5 text-sm text-ink-700">
            <p>
              This link starts working at{' '}
              <strong className="font-medium text-ink-900">
                {formatDateTime(link.effectiveAt, 'Africa/Johannesburg')}
              </strong>
              . Come back then and it will let you in.
            </p>
            <p>
              The wait is not a formality: it is the window in which you can stop a recovery
              you did not ask for. If this was not you, use the cancel link in the message
              sent to <strong className="font-medium text-ink-900">{link.email}</strong> and
              tell Spike at once.
            </p>
          </Card>
        </>
      ) : (
        <>
          <PageHeader
            title="Set yourself up again"
            description={`For ${link.email}. This link works once.`}
          />
          <div className="mt-6">
            <RecoverLinkForm token={token} lost={link.lost} />
          </div>
        </>
      )}
    </main>
  );
}
