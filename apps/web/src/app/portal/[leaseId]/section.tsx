/**
 * The two bits of furniture every portal section uses.
 *
 * Shared so five pages cannot drift into five slightly different headings and
 * five slightly different label-and-value rows.
 */
export function SectionHeading({ id, children, action }: {
  id: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  // Stacked on a narrow screen: a heading and an action side by side at 390px
  // leaves each of them two words a line.
  return (
    <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <h2 id={id} className="text-sm font-semibold uppercase tracking-wide text-ink-500">
        {children}
      </h2>
      {action}
    </div>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3">
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="text-sm font-medium text-ink-900">{children}</dd>
    </div>
  );
}
