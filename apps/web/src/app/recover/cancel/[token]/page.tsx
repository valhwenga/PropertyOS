import { PageHeader } from '@propertyos/ui';
import { Wordmark } from '@/components/wordmark';
import { CancelRecoveryForm } from './cancel-form';

export const metadata = { title: 'Stop a recovery' };
export const dynamic = 'force-dynamic';

/**
 * "This was not me."
 *
 * The page does not look the token up before showing the button, which is
 * deliberate: a page that said "no such recovery" would tell whoever opened it
 * whether a given token was live. The button says what will happen, and the
 * action gives the answer.
 */
export default async function CancelRecoveryPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <main id="main" className="mx-auto max-w-xl px-4 py-12">
      <div className="mb-8"><Wordmark /></div>
      <PageHeader
        title="Stop this recovery"
        description="Somebody asked for a way into your account. If that was not you, stop it here."
      />
      <div className="mt-6"><CancelRecoveryForm cancelToken={token} /></div>
    </main>
  );
}
