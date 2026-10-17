'use client';

import { useState } from 'react';

/**
 * A value with a copy button.
 *
 * A resident is retyping these into a banking app on the same phone, which is
 * where mistyped account numbers come from. The button copies, says so, and
 * says so to a screen reader as well: the confirmation is in a live region,
 * not only in a colour change.
 *
 * `navigator.clipboard` is unavailable on an insecure origin and can be
 * refused outright, so a failure says "copy it by hand" rather than pretending.
 */
export function CopyField({
  value, label, mono = true,
}: {
  value: string;
  /** What is being copied, for the button's accessible name. */
  label: string;
  mono?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 2500);
  };

  return (
    <div className="flex items-center gap-2">
      <span className={mono ? 'tabular text-sm text-ink-900' : 'text-sm text-ink-900'}>
        {value}
      </span>
      <button
        type="button"
        onClick={copy}
        className="
          min-h-9 rounded-lg border border-ink-200 px-2.5 text-xs font-medium text-ink-700
          hover:bg-ink-50 focus-visible:outline focus-visible:outline-2
          focus-visible:outline-offset-2 focus-visible:outline-spike-500
        "
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
        <span className="sr-only"> {label}</span>
      </button>
      <span aria-live="polite" className="sr-only">
        {state === 'copied' ? `${label} copied` : state === 'failed' ? `${label} could not be copied` : ''}
      </span>
    </div>
  );
}
