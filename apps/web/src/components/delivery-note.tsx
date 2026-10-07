/**
 * One sentence saying what actually reached the resident.
 *
 * It exists so that every place that notifies someone words the outcome the
 * same way, and so that no place can word it more generously than the truth. An
 * email the adapter did not acknowledge is never described as sent; when the
 * adapter gave a reason — no provider configured, a rejection from the server —
 * that reason is shown, because the operator is the one who can act on it.
 */
export type EmailStatus = 'not attempted' | 'sent' | 'not delivered' | 'no address';

export function DeliveryNote({ inbox, email, emailDetail, nobody }: {
  inbox: number;
  email: EmailStatus;
  emailDetail?: string | null;
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
      {email === 'not delivered'
        ? ` Email was NOT delivered.${emailDetail ? ` ${emailDetail}` : ''}`
        : ''}
    </p>
  );
}
