/**
 * What a first approval looks like when the organisation wants two.
 *
 * The important word is "not": nothing has been paid, posted or issued. An
 * approver who clicks Approve and sees a cheerful confirmation will tell the
 * resident, or the contractor, that it is done — and it is not.
 */
export function ApprovalWaiting({
  done, soFar, required, doneLabel, waitingLabel,
}: {
  /** Whether the action actually happened. */
  done: boolean;
  soFar: number;
  required: number;
  doneLabel: string;
  /** What has NOT happened yet, in this flow's own words. */
  waitingLabel: string;
}) {
  if (done) {
    return (
      <p className="text-[length:var(--text-table)] font-semibold text-positive-600">
        {doneLabel}
      </p>
    );
  }

  return (
    <div
      role="status"
      className="rounded-[var(--radius-control)] border border-caution-700/25 bg-caution-50 px-3 py-2"
    >
      <p className="text-[length:var(--text-table)] font-semibold text-caution-700">
        Your approval is recorded — {soFar} of {required}.
      </p>
      <p className="mt-0.5 text-[length:var(--text-table)] text-ink-700">
        {waitingLabel} Somebody else has to approve it, and it cannot be you.
      </p>
    </div>
  );
}
