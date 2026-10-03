/** Presentation helpers. No business logic lives here. */

export function formatDate(value: string | Date, timeZone = 'Africa/Johannesburg'): string {
  const date = typeof value === 'string' ? new Date(`${value.slice(0, 10)}T12:00:00Z`) : value;
  return new Intl.DateTimeFormat('en-ZA', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone,
  }).format(date);
}

export function formatDateTime(value: string | Date, timeZone = 'Africa/Johannesburg'): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat('en-ZA', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone, hour12: false,
  }).format(date);
}

export function daysOverdue(dueDate: string): number {
  const due = Date.parse(`${dueDate.slice(0, 10)}T00:00:00Z`);
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.max(0, Math.floor((today - due) / 86_400_000));
}

export function ageingBucket(dueDate: string): string {
  const days = daysOverdue(dueDate);
  if (days === 0) return 'Not yet due';
  if (days <= 30) return '1–30 days';
  if (days <= 60) return '31–60 days';
  if (days <= 90) return '61–90 days';
  return 'Over 90 days';
}
