/**
 * Text wordmark.
 *
 * No approved Spike logo mark exists, so none is invented. This is a typographic
 * wordmark only; swap it for the official asset when brand sign-off lands.
 */
export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 font-semibold tracking-tight">
      <span className="text-spike-500">Spike</span>
      {compact ? null : <span className="text-ink-900">PropertyOS</span>}
    </span>
  );
}
