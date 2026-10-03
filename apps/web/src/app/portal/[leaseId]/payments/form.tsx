'use client';

import { useActionState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { submitProofOfPayment } from '../actions';

export function ProofOfPaymentForm({ leaseId }: { leaseId: string }) {
  const [state, action, pending] = useActionState(submitProofOfPayment, null);
  const today = new Date().toISOString().slice(0, 10);

  if (state?.ok) {
    return (
      <Card className="border-positive-600/25 bg-positive-50 p-4">
        <p className="text-sm font-semibold text-positive-600">Thank you</p>
        <p className="mt-1 text-sm text-ink-700">
          We have recorded your payment details. Your balance will update once your landlord
          confirms the funds against their bank record — it has not changed yet.
        </p>
      </Card>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="leaseId" value={leaseId} />

      {state && !state.ok ? (
        <ErrorState
          title="Could not record your payment"
          detail={state.message}
          correlationId={state.correlationId}
        />
      ) : null}

      <div className="space-y-1.5">
        <label htmlFor="amount" className="block text-sm font-medium text-ink-700">
          How much did you pay?
        </label>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="text-base text-ink-500">R</span>
          <input
            id="amount" name="amount" type="text" inputMode="decimal" required
            placeholder="1850.00"
            // A numeric keypad on mobile, and a tall target.
            className="tabular w-full rounded-lg border border-ink-200 px-3 py-3 text-base"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="paidAt" className="block text-sm font-medium text-ink-700">
          When did you pay?
        </label>
        <input
          id="paidAt" name="paidAt" type="date" required max={today} defaultValue={today}
          className="w-full rounded-lg border border-ink-200 px-3 py-3 text-base"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="reference" className="block text-sm font-medium text-ink-700">
          Payment reference <span className="font-normal text-ink-400">(optional)</span>
        </label>
        <input
          id="reference" name="reference" type="text" maxLength={140}
          placeholder="The reference you used on the EFT"
          className="w-full rounded-lg border border-ink-200 px-3 py-3 text-base"
        />
        <p className="text-xs text-ink-400">
          Using the same reference each month helps your landlord match the payment faster.
        </p>
      </div>

      <Button type="submit" variant="primary" className="w-full py-3 text-base" disabled={pending}>
        {pending ? 'Sending…' : 'Record this payment'}
      </Button>
    </form>
  );
}
