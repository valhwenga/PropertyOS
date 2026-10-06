'use client';

import { useState } from 'react';
import { formatDayMonthYear, parseDayMonthYear } from '@propertyos/domain/dates';

/**
 * A date field that reads dd/mm/yyyy whoever is looking at it.
 *
 * `<input type="date">` renders in the BROWSER's locale, so the same screen
 * showed mm/dd/yyyy to one person and dd/mm/yyyy to another with no way for the
 * page to choose. This is a plain text field, so the format is ours and matches
 * every date the product prints.
 *
 * The cost is the native picker, which on a phone is a real loss. Where that
 * matters more than the format, `type="date"` is still the right control — the
 * value it submits is ISO either way, and the server accepts both.
 */
export function DateField({
  name, label, value, hint, required = false, max, className,
}: {
  name: string;
  label: string;
  value?: string | null;
  hint?: string;
  required?: boolean;
  /** An ISO date the entry must not exceed, e.g. today. */
  max?: string;
  className?: string;
}) {
  const [text, setText] = useState(formatDayMonthYear(value) ?? '');
  const parsed = parseDayMonthYear(text);
  const blank = text.trim() === '';
  const tooLate = Boolean(max && parsed && parsed > max);
  const valid = (blank && !required) || (parsed !== null && !tooLate);

  return (
    <div className={className ?? 'space-y-1.5'}>
      <label htmlFor={name} className="block text-xs font-medium text-ink-700">{label}</label>
      <input
        id={name} name={name} value={text} onChange={(e) => setText(e.target.value)}
        inputMode="numeric" placeholder="dd/mm/yyyy" autoComplete="off"
        required={required} aria-invalid={!valid}
        className={`w-full rounded-lg border px-2.5 py-1.5 text-sm ${
          valid ? 'border-ink-200' : 'border-critical-700 bg-critical-50'
        }`}
      />
      {!valid ? (
        <p className="text-xs text-critical-700">
          {tooLate
            ? `That date is in the future. The latest allowed is ${formatDayMonthYear(max)}.`
            : 'Use dd/mm/yyyy, for example 31/10/2026.'}
        </p>
      ) : hint ? (
        <p className="text-xs text-ink-500">{hint}</p>
      ) : null}
    </div>
  );
}
