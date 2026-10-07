'use client';

import { useActionState } from 'react';
import { markAllReadAction, markNoticeReadAction } from '../actions';

export function MarkRead({ id }: { id: string }) {
  const [, action, pending] = useActionState(markNoticeReadAction, null);
  return (
    <form action={action}>
      <input type="hidden" name="notificationId" value={id} />
      <button type="submit" disabled={pending}
              className="text-xs text-ink-500 hover:underline disabled:opacity-50">
        {pending ? 'Marking…' : 'Mark read'}
      </button>
    </form>
  );
}

export function MarkAllRead({ count }: { count: number }) {
  const [, action, pending] = useActionState(markAllReadAction, null);
  return (
    <form action={action}>
      <button type="submit" disabled={pending}
              className="rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-sm text-ink-700 disabled:opacity-50">
        {pending ? 'Marking…' : `Mark all ${count} read`}
      </button>
    </form>
  );
}
