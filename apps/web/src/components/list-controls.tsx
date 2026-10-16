import Link from 'next/link';
import { Card } from '@propertyos/ui';
import type { PageSummary } from '@/lib/listing';

/**
 * The controls above a list, and the line below it.
 *
 * A plain GET form, like the report filters: what is being looked at ends up
 * in the URL, so a filtered list can be sent to a colleague or bookmarked, and
 * nothing here needs JavaScript to work.
 *
 * One component for every list so they agree with each other. A product where
 * the search box is in a different place on each screen teaches nothing.
 */
export function ListToolbar({
  action, query, placeholder, customised, children,
}: {
  /** Where Reset goes: the same list with nothing asked of it. */
  action: string;
  query: string | undefined;
  placeholder: string;
  customised: boolean;
  /** The per-list selects. */
  children?: React.ReactNode;
}) {
  return (
    <Card className="p-4">
      <form method="get" className="flex flex-wrap items-end gap-4">
        <label className="block min-w-[16rem] flex-1 text-sm">
          <span className="mb-1 block font-medium text-ink-700">Search</span>
          <input
            type="search"
            name="q"
            defaultValue={query ?? ''}
            placeholder={placeholder}
            className="w-full rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-sm"
          />
        </label>
        {children}
        <div className="flex items-center gap-2">
          <button
            type="submit"
            className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white"
          >
            Apply
          </button>
          {customised ? (
            <Link href={action} className="text-sm text-ink-500 hover:underline">Reset</Link>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

/** A select in the toolbar, with its own "any" option. */
export function ListSelect({
  name, label, value, options, anyLabel,
}: {
  name: string;
  label: string;
  value: string | undefined;
  options: ReadonlyArray<{ value: string; label: string }>;
  anyLabel: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-ink-700">{label}</span>
      <select
        name={name}
        defaultValue={value ?? ''}
        className="rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-sm"
      >
        <option value="">{anyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

/**
 * How much of the set is on screen, and how to see the rest.
 *
 * Shown even on a single page, because "47 records" is the sentence that tells
 * somebody the list is complete. The documents list used to stop at 200 rows
 * in silence, which looks exactly like having 200 documents.
 */
export function PageBar({
  summary, href,
}: {
  summary: PageSummary;
  /** Builds the link for a page number, carrying every other filter. */
  href: (page: number) => string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm text-ink-500">
      <p>{summary.sentence}{summary.filtered ? ' matching your filters' : ''}</p>
      <div className="flex items-center gap-3">
        {summary.previous !== null ? (
          <Link href={href(summary.previous)} className="hover:underline">← Previous</Link>
        ) : null}
        {summary.next !== null ? (
          <Link href={href(summary.next)} className="hover:underline">Next →</Link>
        ) : null}
      </div>
    </div>
  );
}
