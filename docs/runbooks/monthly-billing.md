# Runbook — monthly billing cycle

**Who:** finance preparer (preview) and finance approver (post).

## 1. Preview

Billing → select the period → **Preview**. Nothing is posted by a preview.

Review the exception list before anything else:

| Exception | Severity | What to do |
| --- | --- | --- |
| `missing_rent_schedule` | Blocking | An active lease has no rent schedule, so it would be billed nothing. Add the schedule, then preview again. |
| `currency_mismatch` | Blocking | The schedule currency differs from the book currency. Do not bill across currencies. |
| `already_billed` | Warning | This schedule and period are already posted. The line will be skipped — this is the duplicate protection working. |
| `partial_period_not_prorated` | Warning | A part-period will be charged in full because the schedule does not prorate it. Confirm this is intended. |

Check each prorated line: the preview shows the numerator and denominator
(for example 16/31 days) so you can verify the arithmetic before approving.

**A run with any blocking exception cannot be posted.** This is enforced, not a
convention.

## 2. Post

Posting quotes the preview version you approved. If the underlying data changed
since the preview, posting is rejected with `stale_version` — re-preview and
review the current figures.

## 3. If the run fails part way

**Re-run it.** It is safe. A unique index on (schedule, billing period, document
type) means a retry posts exactly one charge per schedule and period; lines that
already posted are reported as skipped. You will never double-bill a resident by
retrying.

## 4. Verify

* The run summary total matches the sum of posted documents.
* Reports → Trial balance nets to zero for the book.
* Spot-check one prorated statement against the day fraction shown.

## 5. If a posted charge is wrong

Do **not** attempt to edit it; the database will refuse. Issue a linked credit
note (Lease → charge → **Credit**) with a reason, then post the corrected charge.
Both documents remain visible and the original history is retained.
