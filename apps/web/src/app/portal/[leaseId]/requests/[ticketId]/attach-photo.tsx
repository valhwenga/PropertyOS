'use client';

import { useActionState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { attachRequestPhoto } from '../../actions';

/**
 * A photograph of the problem.
 *
 * The difference between "there is a leak under the sink" and a landlord
 * seeing where the water is going. The schema had allowed this all along — a
 * resident's own upload on their own lease, and an attachment marked
 * resident-visible — and there had never been a control for it.
 *
 * It says what happens next, including the part nobody enjoys writing: with no
 * malware scanner configured the file is stored and held, and NOBODY can open
 * it — not the landlord either — until one is. Offering a cheerful "uploaded!"
 * and a link that refuses would be worse than saying so.
 */
export function AttachPhotoForm({
  leaseId, ticketId, scannerConfigured,
}: {
  leaseId: string; ticketId: string; scannerConfigured: boolean;
}) {
  const [state, action, pending] = useActionState(attachRequestPhoto, null);
  const held = state?.ok && (state as unknown as { quarantined?: boolean }).quarantined;

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold text-ink-900">Add a photograph</h2>
      <p className="mt-1 text-sm text-ink-700">
        A picture of the problem usually saves a visit. JPEG or PNG.
      </p>
      {scannerConfigured ? null : (
        <p className="mt-2 rounded-lg border border-caution-700/25 bg-caution-50 p-3 text-sm text-ink-700">
          <strong>It will be held unopened for now.</strong> No virus scanner is configured on
          this installation, so an uploaded file is stored and nobody can open it — your
          landlord included — until one is. Your request and its description reach them
          either way.
        </p>
      )}

      <form action={action} className="mt-3 space-y-3">
        <input type="hidden" name="leaseId" value={leaseId} />
        <input type="hidden" name="ticketId" value={ticketId} />

        {state && !state.ok ? (
          <ErrorState
            title="That photograph was not attached"
            detail={state.message ?? 'Nothing was uploaded.'}
            correlationId={state.correlationId}
          />
        ) : null}
        {state?.ok ? (
          <p className="text-sm font-medium text-positive-600">
            {held
              ? 'Photograph received. It is held unopened until a scanner is configured.'
              : 'Photograph attached.'}
          </p>
        ) : null}

        <div>
          <label htmlFor="photo" className="block text-sm font-medium text-ink-700">
            Choose a photograph
          </label>
          <input
            id="photo" name="photo" type="file" accept="image/jpeg,image/png" required
            className="mt-1 block w-full text-sm text-ink-700"
          />
        </div>

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Uploading…' : 'Attach the photograph'}
        </Button>
      </form>
    </Card>
  );
}
