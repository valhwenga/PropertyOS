import clsx from 'clsx';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

/* ------------------------------------------------------------------ Surfaces */

/**
 * A content surface.
 *
 * Used for a summary, a panel or a form — NOT as the default wrapper for every
 * section on a page. When everything is a rounded card with a shadow, nothing
 * on the page is more important than anything else, which is the state this
 * interface was in. Records belong in a table, tasks in a list, filters in a
 * toolbar.
 */
export function Card({
  className, children, glass = false, ...rest
}: HTMLAttributes<HTMLDivElement> & { glass?: boolean }) {
  return (
    <div
      {...rest}
      className={clsx(
        'rounded-[var(--radius-card)] border border-ink-100 bg-surface',
        glass ? 'shadow-[var(--shadow-raised)]' : 'shadow-[var(--shadow-card)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The heading above a section of a page.
 *
 * Sentence case at 17px, not a small uppercase label. Uppercase is reserved for
 * the navigation group labels and the occasional piece of compact metadata,
 * where a word or two in caps reads as a category rather than as shouting.
 */
export function SectionHeading({
  id, children, action, description,
}: { id?: string; children: ReactNode; action?: ReactNode; description?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <div className="min-w-0">
        <h2 id={id} className="text-[length:var(--text-section)] font-semibold text-ink-900">
          {children}
        </h2>
        {description ? (
          <p className="mt-0.5 text-[length:var(--text-meta)] text-ink-500">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * The page header.
 *
 * One title, an optional sentence of context, an optional strip of filters or
 * reporting period, and ONE dominant action. Secondary actions sit beside it in
 * a quieter style or inside an action menu; two equally loud buttons is a
 * choice the reader has to make before they can start.
 */
export function PageHeader({
  title, description, actions, meta, toolbar,
}: {
  title: string;
  description?: string;
  /** The dominant action, and any secondary ones, right-aligned on desktop. */
  actions?: ReactNode;
  /** Period, scope, cut-off — the qualifications that make the page readable. */
  meta?: ReactNode;
  /** Filters that belong to the page rather than to one section. */
  toolbar?: ReactNode;
}) {
  return (
    <header className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[length:var(--text-page-title)] font-bold leading-tight tracking-tight text-ink-900">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 max-w-2xl text-[length:var(--text-body)] text-ink-500">{description}</p>
          ) : null}
          {meta ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-meta)] text-ink-500">
              {meta}
            </div>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {toolbar}
    </header>
  );
}

/* ------------------------------------------------------------------- Buttons */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] '
  + 'px-3.5 py-2 text-[length:var(--text-table)] font-medium transition-colors '
  + 'disabled:cursor-not-allowed disabled:opacity-50';

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-spike-500 text-white hover:bg-spike-600 shadow-[var(--shadow-card)]',
  secondary: 'border border-ink-200 bg-surface text-ink-700 hover:bg-ink-50',
  ghost: 'text-ink-700 hover:bg-ink-100',
  danger: 'bg-critical-700 text-white hover:brightness-110',
};

export function Button({
  variant = 'secondary', className, children, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button {...rest} className={clsx(BUTTON_BASE, BUTTON_VARIANT[variant], className)}>
      {children}
    </button>
  );
}

/** The same shapes for a link that acts as an action. */
export function buttonClass(variant: ButtonVariant = 'secondary', className?: string): string {
  return clsx(BUTTON_BASE, BUTTON_VARIANT[variant], className);
}

/* -------------------------------------------------------------------- Status */

export type StatusTone = 'neutral' | 'positive' | 'caution' | 'critical' | 'info';

const TONE: Record<StatusTone, string> = {
  neutral:  'bg-ink-100 text-ink-700 border-ink-200',
  positive: 'bg-positive-50 text-positive-600 border-positive-600/25',
  caution:  'bg-caution-50 text-caution-700 border-caution-700/25',
  critical: 'bg-critical-50 text-critical-700 border-critical-700/25',
  info:     'bg-info-50 text-info-700 border-info-700/25',
};

/**
 * A status indicator.
 *
 * Colour is never the only signal: every badge carries a text label, and the
 * shape glyph gives a third, non-colour cue for overdue / failed / approved.
 */
export function StatusBadge({
  tone = 'neutral', children, glyph,
}: { tone?: StatusTone; children: ReactNode; glyph?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5',
        'text-[length:var(--text-meta)] font-medium leading-5',
        TONE[tone],
      )}
    >
      {glyph ? <span aria-hidden="true" className="text-[0.7em] leading-none">{glyph}</span> : null}
      {children}
    </span>
  );
}

/* --------------------------------------------------------------------- Money */

/**
 * Renders a monetary amount.
 *
 * `tone` says what a negative figure MEANS, because in this product it means
 * different things in different columns. On a statement a negative running
 * balance is the resident in credit — good news, and not red. On an arrears
 * column a figure is overdue debt. Colouring every minus sign red taught the
 * reader nothing except that red is everywhere.
 *
 * The sign is never carried by colour alone: there is an explicit minus, and
 * a screen-reader word for the credit case.
 */
export function Money({
  minor, currency = 'ZAR', className, emphasise = false, tone = 'auto',
}: {
  minor: string | bigint;
  currency?: string;
  className?: string;
  emphasise?: boolean;
  /**
   * 'auto'    — negative reads as a credit (neutral green), positive is plain.
   * 'debt'    — a positive figure is money owed; emphasise it when it is.
   * 'plain'   — no colour at all. For ordinary transaction amounts.
   */
  tone?: 'auto' | 'debt' | 'plain';
}) {
  const value = typeof minor === 'bigint' ? minor : BigInt(minor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 100n;
  const cents = (abs % 100n).toString().padStart(2, '0');
  const symbol = currency === 'ZAR' ? 'R' : currency === 'USD' ? '$' : `${currency} `;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  const colour =
    tone === 'plain' ? undefined
      : tone === 'debt' ? (value > 0n ? 'text-ink-900' : 'text-ink-500')
        : negative ? 'text-positive-600' : undefined;

  return (
    <span
      className={clsx('tabular whitespace-nowrap', emphasise && 'font-semibold', colour, className)}
    >
      {negative ? '−' : ''}{symbol}{grouped}.{cents}
      {negative ? <span className="sr-only"> (credit)</span> : null}
    </span>
  );
}

/* --------------------------------------------------------------------- State */

/**
 * Nothing to show, and what to do about it.
 *
 * Deliberately compact. A full-height panel with a large heading for every
 * empty section turns a quiet day into a page of billboards; the reader needs
 * one line telling them whether this is "nothing has happened yet", "everything
 * here is done" or "your filter excluded everything".
 */
export function EmptyState({
  title, description, action, compact = false,
}: { title: string; description: string; action?: ReactNode; compact?: boolean }) {
  return (
    <div
      className={clsx(
        'rounded-[var(--radius-card)] border border-dashed border-ink-200 bg-surface text-center',
        compact ? 'px-4 py-6' : 'px-6 py-10',
      )}
    >
      <p className="text-[length:var(--text-body)] font-medium text-ink-900">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-[length:var(--text-table)] text-ink-500">{description}</p>
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ title, detail, correlationId }: {
  title: string; detail: string; correlationId?: string;
}) {
  return (
    <div role="alert" className="rounded-[var(--radius-card)] border border-critical-700/25 bg-critical-50 px-4 py-3">
      <p className="text-[length:var(--text-table)] font-semibold text-critical-700">{title}</p>
      <p className="mt-1 text-[length:var(--text-table)] text-ink-700">{detail}</p>
      {correlationId ? (
        <p className="mt-2 text-[length:var(--text-meta)] text-ink-500">
          Reference <span className="technical">{correlationId}</span> — quote this to support.
        </p>
      ) : null}
    </div>
  );
}

export function PermissionState({ action }: { action: string }) {
  return (
    <div role="status" className="rounded-[var(--radius-card)] border border-ink-200 bg-surface px-4 py-3">
      <p className="text-[length:var(--text-table)] font-semibold text-ink-900">
        You do not have access to this
      </p>
      <p className="mt-1 text-[length:var(--text-table)] text-ink-500">
        {action} requires a permission your roles do not include. Ask an organisation
        administrator if you need it.
      </p>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={clsx('animate-pulse rounded-md bg-ink-100', className)} />
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-4">
      <span className="sr-only">{label}</span>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
      </div>
      <div className="grid gap-4 lg:grid-cols-5">
        <Skeleton className="h-64 w-full lg:col-span-3" />
        <Skeleton className="h-64 w-full lg:col-span-2" />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- Metric */

/**
 * A headline figure.
 *
 * `href` is REQUIRED: every figure must open the records it was computed from,
 * with the same filters applied. A number nobody can drill into is a number
 * nobody can check.
 *
 * The qualification is one short line. Anything longer belongs in the
 * "How this is calculated" disclosure beside the section, not under every tile.
 */
export function MetricCard({
  label, href, value, qualification, footnote, tone = 'default',
}: {
  label: string;
  href: string;
  value: ReactNode;
  qualification?: ReactNode;
  footnote?: ReactNode;
  tone?: 'default' | 'attention';
}) {
  return (
    <a
      href={href}
      className={clsx(
        'group flex flex-col gap-1 rounded-[var(--radius-card)] border bg-surface p-4',
        'shadow-[var(--shadow-card)] transition-colors hover:border-ink-200 hover:bg-ink-50/40',
        tone === 'attention' ? 'border-caution-700/30' : 'border-ink-100',
      )}
    >
      <span className="text-[length:var(--text-meta)] font-medium text-ink-500">{label}</span>
      <span className="font-display text-[length:var(--text-metric)] font-bold leading-none tracking-tight text-ink-900">
        {value}
      </span>
      {qualification ? (
        <span className="text-[length:var(--text-meta)] text-ink-500">{qualification}</span>
      ) : null}
      {footnote ? (
        <span className="mt-auto pt-1 text-[length:var(--text-meta)] text-ink-400">{footnote}</span>
      ) : null}
    </a>
  );
}

/* ---------------------------------------------------------------- Disclosure */

/**
 * "How this is calculated", and anything else that is essential once and noise
 * every other time.
 *
 * The definitions in this product matter — collected is not banked, lease
 * status is not occupancy — and they used to occupy a permanent panel above
 * the figures they described. Closed by default, open by a click, and still
 * printed in the CSV export where they travel with the numbers.
 */
export function Disclosure({
  summary, children, className, defaultOpen = false,
}: { summary: string; children: ReactNode; className?: string; defaultOpen?: boolean }) {
  return (
    <details
      open={defaultOpen}
      className={clsx(
        'group rounded-[var(--radius-card)] border border-ink-100 bg-surface',
        className,
      )}
    >
      <summary
        className="
          flex cursor-pointer list-none items-center gap-2 px-4 py-2.5
          text-[length:var(--text-table)] font-medium text-ink-700
          hover:bg-ink-50 rounded-[var(--radius-card)]
        "
      >
        <span
          aria-hidden="true"
          className="text-ink-400 transition-transform group-open:rotate-90"
        >
          ›
        </span>
        {summary}
      </summary>
      <div className="border-t border-ink-100 px-4 py-3 text-[length:var(--text-table)] text-ink-700">
        {children}
      </div>
    </details>
  );
}

/* --------------------------------------------------------------------- Table */

export function DataTable({
  caption, head, children, dense = false, stickyHead = false, minWidth = '40rem',
}: {
  caption: string;
  head: ReactNode;
  children: ReactNode;
  dense?: boolean;
  /** For long reports: the header stays put while the rows scroll. */
  stickyHead?: boolean;
  minWidth?: string;
}) {
  return (
    // Horizontal scroll is contained to the table, never the page.
    <div
      className={clsx(
        'overflow-x-auto rounded-[var(--radius-card)] border border-ink-100 bg-surface',
        stickyHead && 'max-h-[70vh] overflow-y-auto',
      )}
    >
      <table
        className="w-full border-collapse text-[length:var(--text-table)]"
        style={{ minWidth }}
      >
        <caption className="sr-only">{caption}</caption>
        <thead
          className={clsx(
            'border-b border-ink-100 bg-ink-50/70 text-left text-[length:var(--text-meta)]',
            'font-semibold text-ink-500',
            stickyHead && 'sticky top-0 z-10',
          )}
        >
          {head}
        </thead>
        <tbody className={clsx('divide-y divide-ink-100', dense ? '[&_td]:py-2' : '[&_td]:py-2.5')}>
          {children}
        </tbody>
      </table>
    </div>
  );
}

export function Th({ children, numeric = false, scope = 'col' }: {
  children: ReactNode; numeric?: boolean; scope?: 'col' | 'row';
}) {
  return (
    <th scope={scope} className={clsx('px-3 py-2 font-semibold', numeric && 'text-right')}>
      {children}
    </th>
  );
}

export function Td({ children, numeric = false, className }: {
  children: ReactNode; numeric?: boolean; className?: string;
}) {
  return (
    <td className={clsx('px-3 align-middle', numeric && 'text-right tabular', className)}>
      {children}
    </td>
  );
}

/**
 * The totals line under a report. Scoped by a label, never a bare sum.
 *
 * `span` covers the columns the label runs across, so the figures stay under
 * the columns they total instead of sliding one cell left.
 */
export function TotalRow({
  label, children, span = 1,
}: { label: string; children: ReactNode; span?: number }) {
  return (
    <tr className="border-t-2 border-ink-200 bg-ink-50/70 font-semibold text-ink-900">
      <th scope="row" colSpan={span} className="px-3 py-2 text-left font-semibold">
        {label}
      </th>
      {children}
    </tr>
  );
}
