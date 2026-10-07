/**
 * Lists the per-field reasons a command refused.
 *
 * `command` already returns fieldErrors, but a form that renders only the
 * summary says "correct the highlighted fields" while highlighting nothing —
 * which is how a rejected lease looked until this existed.
 */
export function FieldErrors({ errors }: { errors?: Record<string, string[]> }) {
  const entries = Object.entries(errors ?? {}).filter(([, messages]) => messages.length > 0);
  if (entries.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-sm text-critical-700">
      {entries.map(([field, messages]) => (
        <li key={field}>
          <span className="font-medium capitalize">{field.replace(/([A-Z])/g, ' $1').trim()}</span>
          {': '}
          {messages.join(' ')}
        </li>
      ))}
    </ul>
  );
}
