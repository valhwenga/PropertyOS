import clsx from 'clsx';
import type { ReactNode } from 'react';

/**
 * Layout patterns built from the primitives.
 *
 * Everything here renders on the server. The interactive pieces — an action
 * menu, a confirmation dialog, the mobile navigation drawer — live in the web
 * app beside the other client components, so importing this barrel never drags
 * a client boundary into a page that does not need one.
 */

/* ------------------------------------------------------------------ Toolbars */

/**
 * A filter strip.
 *
 * One row, controls inline, the applied scope stated in words beside them. The
 * reports page used to put the same controls inside a full card with its own
 * heading, which made choosing a date look like a section of the report rather
 * than a way to change it.
 */
export function FilterToolbar({
  action, children, submitLabel = 'Apply', reset, scope, method = 'get',
}: {
  action: string;
  children: ReactNode;
  submitLabel?: string;
  /** Where "Reset" goes. Omitted when nothing is customised. */
  reset?: string;
  /** What the current filters add up to, in words. */
  scope?: ReactNode;
  method?: 'get' | 'post';
}) {
  return (
    <form
      action={action}
      method={method}
      className="rounded-[var(--radius-card)] border border-ink-100 bg-surface px-3 py-2.5"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        {children}
        {/* Nudged down to sit on the controls' baseline rather than the labels'. */}
        <div className="ml-auto flex items-center gap-2 pt-[1.4rem]">
          <button
            type="submit"
            className="
              inline-flex items-center rounded-[var(--radius-control)] bg-spike-500 px-3 py-1.5
              text-[length:var(--text-table)] font-medium text-white hover:bg-spike-600
            "
          >
            {submitLabel}
          </button>
          {reset ? (
            <a
              href={reset}
              className="
                inline-flex items-center rounded-[var(--radius-control)] border border-ink-200
                px-3 py-1.5 text-[length:var(--text-table)] font-medium text-ink-700 hover:bg-ink-50
              "
            >
              Reset
            </a>
          ) : null}
        </div>
      </div>
      {scope ? (
        <p className="mt-2 border-t border-ink-100 pt-2 text-[length:var(--text-meta)] text-ink-500">
          {scope}
        </p>
      ) : null}
    </form>
  );
}

/** A labelled control inside a toolbar. */
export function ToolbarField({
  label, htmlFor, children, hint,
}: { label: string; htmlFor?: string; children: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <label
        htmlFor={htmlFor}
        className="block text-[length:var(--text-meta)] font-medium text-ink-500"
      >
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {hint ? <p className="mt-0.5 text-[length:var(--text-meta)] text-ink-400">{hint}</p> : null}
    </div>
  );
}

export const CONTROL_CLASS =
  'rounded-[var(--radius-control)] border border-ink-200 bg-surface px-2.5 py-1.5 '
  + 'text-[length:var(--text-table)] text-ink-900';

/* ---------------------------------------------------------------------- Tabs */

export interface TabDefinition {
  key: string;
  label: string;
  href: string;
  /** Shown beside the label. Omitted rather than shown as 0 where a count is unknown. */
  count?: number;
}

/**
 * Section tabs, as links.
 *
 * Links rather than client state: each tab is a real URL, so it can be
 * bookmarked, opened in a new tab and linked to from a dashboard tile with the
 * filter already applied — which several of them are.
 */
export function Tabs({
  tabs, current, label,
}: { tabs: TabDefinition[]; current: string; label: string }) {
  return (
    <nav aria-label={label} className="border-b border-ink-100">
      <ul className="-mb-px flex flex-wrap gap-x-1">
        {tabs.map((tab) => {
          const active = tab.key === current;
          return (
            <li key={tab.key}>
              <a
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={clsx(
                  'inline-flex items-center gap-1.5 border-b-2 px-3 py-2',
                  'text-[length:var(--text-table)] font-medium transition-colors',
                  active
                    ? 'border-spike-500 text-ink-900'
                    : 'border-transparent text-ink-500 hover:border-ink-200 hover:text-ink-700',
                )}
              >
                {tab.label}
                {tab.count !== undefined ? (
                  <span
                    className={clsx(
                      'rounded-full px-1.5 py-0.5 text-[length:var(--text-meta)] leading-4 tabular',
                      active ? 'bg-spike-50 text-spike-700' : 'bg-ink-100 text-ink-500',
                    )}
                  >
                    {tab.count}
                  </span>
                ) : null}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/* ------------------------------------------------------------- Task list */

export type TaskPriority = 'urgent' | 'attention' | 'routine';

const PRIORITY_DOT: Record<TaskPriority, string> = {
  urgent: 'bg-critical-700',
  attention: 'bg-caution-700',
  routine: 'bg-ink-300',
};

const PRIORITY_WORD: Record<TaskPriority, string> = {
  urgent: 'Urgent',
  attention: 'Needs attention',
  routine: 'Routine',
};

/**
 * One line of the attention queue.
 *
 * A queue is a list of things to do, so it is laid out as a list: what it is,
 * how many, how old, and the action. Twelve of these as equal cards — each with
 * its own border, shadow and explanatory sentence — is what the overview had,
 * and it made a quiet day and a bad day look identical.
 *
 * An item with nothing in it collapses to a single muted line instead of
 * occupying a card to announce a zero.
 */
export function TaskRow({
  label, count, href, detail, priority = 'routine', actionLabel = 'Open',
}: {
  label: string;
  count: number;
  href: string;
  detail?: ReactNode;
  priority?: TaskPriority;
  actionLabel?: string;
}) {
  const quiet = count === 0;
  return (
    <li>
      <a
        href={href}
        className={clsx(
          'group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-ink-50',
          quiet && 'opacity-70',
        )}
      >
        <span
          aria-hidden="true"
          className={clsx(
            'size-1.5 shrink-0 rounded-full',
            quiet ? 'bg-ink-200' : PRIORITY_DOT[priority],
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[length:var(--text-table)] font-medium text-ink-900">
            {label}
          </span>
          {detail ? (
            <span className="block truncate text-[length:var(--text-meta)] text-ink-500">
              {detail}
            </span>
          ) : null}
        </span>
        {!quiet ? (
          <span className="sr-only">{PRIORITY_WORD[priority]}.</span>
        ) : null}
        <span
          className={clsx(
            'tabular shrink-0 rounded-full px-2 py-0.5 text-[length:var(--text-meta)] font-semibold',
            quiet ? 'text-ink-400' : priority === 'urgent'
              ? 'bg-critical-50 text-critical-700'
              : priority === 'attention'
                ? 'bg-caution-50 text-caution-700'
                : 'bg-ink-100 text-ink-700',
          )}
        >
          {count}
        </span>
        <span
          aria-hidden="true"
          className="shrink-0 text-[length:var(--text-meta)] font-medium text-ink-400 group-hover:text-spike-600"
        >
          {actionLabel} →
        </span>
      </a>
    </li>
  );
}

/** The container for a list of tasks or records inside a panel. */
export function Panel({
  title, titleId, action, children, description, className,
}: {
  title: string;
  titleId?: string;
  action?: ReactNode;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={titleId}
      className={clsx(
        'overflow-hidden rounded-[var(--radius-card)] border border-ink-100 bg-surface',
        'shadow-[var(--shadow-card)]',
        className,
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-ink-100 px-4 py-3">
        <div className="min-w-0">
          <h2
            id={titleId}
            className="text-[length:var(--text-section)] font-semibold text-ink-900"
          >
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 text-[length:var(--text-meta)] text-ink-500">{description}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------ Definition list */

/** A compact label/value pair, for summaries that are not headline metrics. */
export function Figure({
  label, value, hint, numeric = true,
}: { label: string; value: ReactNode; hint?: ReactNode; numeric?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[length:var(--text-meta)] text-ink-500">{label}</dt>
      <dd
        className={clsx(
          'mt-0.5 text-[length:var(--text-body)] font-semibold text-ink-900',
          numeric && 'tabular',
        )}
      >
        {value}
      </dd>
      {hint ? <dd className="text-[length:var(--text-meta)] text-ink-400">{hint}</dd> : null}
    </div>
  );
}
