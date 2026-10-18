import Link from 'next/link';
import { CONTROL_CLASS, FilterToolbar, ToolbarField } from '@propertyos/ui';
import type { PageSummary } from '@/lib/listing';

/**
 * The controls above a list, and the line below it.
 *
 * A plain GET form, like the report filters: what is being looked at ends up
 * in the URL, so a filtered list can be sent to a colleague or bookmarked, and
 * nothing here needs JavaScript to work.
 *
 * One component for every list so they agree with each other. A product where
 * the search box is in a different place on each screen teaches nothing — and
 * now one strip rather than a card with its own heading, because narrowing a
 * list is not a section of the page.
 */
export function ListToolbar({
  action, query, placeholder, customised, children, scope,
}: {
  /** Where Reset goes: the same list with nothing asked of it. */
  action: string;
  query: string | undefined;
  placeholder: string;
  customised: boolean;
  /** The per-list selects. */
  children?: React.ReactNode;
  /** What the filters currently add up to, in words. */
  scope?: React.ReactNode;
}) {
  return (
    <FilterToolbar
      action={action}
      reset={customised ? action : undefined}
      scope={scope}
    >
      <div className="min-w-[16rem] flex-1">
        <ToolbarField label="Search" htmlFor="list-search">
          <input
            id="list-search"
            type="search"
            name="q"
            defaultValue={query ?? ''}
            placeholder={placeholder}
            className={`w-full ${CONTROL_CLASS}`}
          />
        </ToolbarField>
      </div>
      {children}
    </FilterToolbar>
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
    <ToolbarField label={label} htmlFor={`list-${name}`}>
      <select
        id={`list-${name}`}
        name={name}
        defaultValue={value ?? ''}
        className={CONTROL_CLASS}
      >
        <option value="">{anyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </ToolbarField>
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
  const step = 'inline-flex items-center rounded-[var(--radius-control)] border border-ink-200 '
    + 'bg-surface px-2.5 py-1 font-medium text-ink-700 hover:bg-ink-50';
  return (
    <div className="flex items-center justify-between gap-4 text-[length:var(--text-meta)] text-ink-500">
      <p>{summary.sentence}{summary.filtered ? ' matching your filters' : ''}</p>
      <div className="flex items-center gap-2">
        {summary.previous !== null ? (
          <Link href={href(summary.previous)} className={step}>← Previous</Link>
        ) : null}
        {summary.next !== null ? (
          <Link href={href(summary.next)} className={step}>Next →</Link>
        ) : null}
      </div>
    </div>
  );
}
