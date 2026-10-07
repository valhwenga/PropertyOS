/**
 * One sentence saying what actually reached the resident.
 *
 * It exists so that every place that notifies someone words the outcome the
 * same way, and so that no place can word it more generously than the truth. An
 * email the adapter did not acknowledge is never described as sent; when the
 * adapter gave a reason — no provider configured, a rejection from the server —
 * that reason is shown, because the operator is the one who can act on it.
 */
// Type-only, so nothing from the server library reaches the browser bundle.
// One definition, because two copies of this union would drift.
export type { EmailStatus } from '@/lib/lease-notices';
import type { EmailStatus } from '@/lib/lease-notices';

export function DeliveryNote({ inbox, email, emailDetail, overrodePreference = 0, nobody }: {
  inbox: number;
  email: EmailStatus;
  emailDetail?: string | null;
  /** How many people were emailed against their recorded preference. */
  overrodePreference?: number;
  /** What to say when nobody on the lease has a portal account. */
  nobody: string;
}) {
  if (inbox === 0 && email !== 'sent') {
    return <p className="text-xs text-ink-500">{nobody}</p>;
  }
  const people = inbox === 1 ? '1 person' : `${inbox} people`;
  return (
    <p className="text-xs text-ink-500">
      {`In the inbox of ${people}`}
      {email === 'sent' ? ' and emailed.' : '.'}
      {email === 'no address' ? ' No email address on file, so none was sent.' : ''}
      {email === 'opted out' ? ' They asked not to be emailed, so none was sent.' : ''}
      {email === 'not delivered'
        ? ` Email was NOT delivered.${emailDetail ? ` ${emailDetail}` : ''}`
        : ''}
      {/* Said plainly, because the operator is the one who will hear about it
          if a resident asks why they were emailed after opting out. */}
      {overrodePreference > 0
        ? overrodePreference === 1
          ? ' 1 person had asked not to be emailed and was emailed anyway, because a '
            + 'lease ending is not optional reading.'
          : ` ${overrodePreference} people had asked not to be emailed and were emailed `
            + 'anyway, because a lease ending is not optional reading.'
        : ''}
    </p>
  );
}
