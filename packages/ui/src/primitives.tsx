import clsx from 'clsx';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

/* ------------------------------------------------------------------ Surfaces */

export function Card({
  className, children, glass = false, ...rest
}: HTMLAttributes<HTMLDivElement> & { glass?: boolean }) {
  return (
    <div
      {...rest}
      className={clsx(
        'rounded-[var(--radius-card)] shadow-[var(--shadow-card)]',
        // Financial content always sits on an opaque surface so figures stay
        // legible; the glass variant is for overview chrome only.
        glass ? 'glass' : 'bg-white border border-ink-100',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title, description, actions,
}: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">{title}</h1>
        {description ? <p className="mt-1 text-sm text-ink-500">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

/* ------------------------------------------------------------------- Buttons */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary', className, children, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      {...rest}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-spike-500 text-white hover:bg-spike-600',
        variant === 'secondary' && 'border border-ink-200 bg-white text-ink-700 hover:bg-ink-50',
        variant === 'ghost' && 'text-spike-600 hover:bg-spike-50',
        variant === 'danger' && 'bg-critical-700 text-white hover:brightness-110',
        className,
      )}
    >
      {children}
    </button>
  );
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
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        TONE[tone],
      )}
    >
      {glyph ? <span aria-hidden="true" className="font-bold leading-none">{glyph}</span> : null}
      {children}
    </span>
  );
}

/* --------------------------------------------------------------------- Money */

/**
 * Renders a monetary amount.
 *
 * Negative values get an explicit minus AND a colour AND a label, so the sign is
 * never conveyed by colour alone.
 */
export function Money({
  minor, currency = 'ZAR', className, emphasise = false,
}: { minor: string | bigint; currency?: string; className?: string; emphasise?: boolean }) {
  const value = typeof minor === 'bigint' ? minor : BigInt(minor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 100n;
  const cents = (abs % 100n).toString().padStart(2, '0');
  const symbol = currency === 'ZAR' ? 'R' : currency === 'USD' ? '$' : `${currency} `;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return (
    <span
      className={clsx('tabular whitespace-nowrap', emphasise && 'font-semibold',
        negative && 'text-critical-700', className)}
    >
      {negative ? '−' : ''}{symbol}{grouped}.{cents}
      {negative ? <span className="sr-only"> (credit)</span> : null}
    </span>
  );
}

/* --------------------------------------------------------------------- State */

export function EmptyState({
  title, description, action,
}: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[var(--radius-card)] border border-dashed border-ink-200 bg-white px-6 py-14 text-center">
      <p className="text-base font-medium text-ink-900">{title}</p>
      <p className="max-w-md text-sm text-ink-500">{description}</p>
      {action}
    </div>
  );
}

export function ErrorState({ title, detail, correlationId }: {
  title: string; detail: string; correlationId?: string;
}) {
  return (
    <div role="alert" className="rounded-[var(--radius-card)] border border-critical-700/25 bg-critical-50 px-5 py-4">
      <p className="text-sm font-semibold text-critical-700">{title}</p>
      <p className="mt-1 text-sm text-ink-700">{detail}</p>
      {correlationId ? (
        <p className="mt-2 text-xs text-ink-500">
          Reference <span className="tabular">{correlationId}</span> — quote this to support.
        </p>
      ) : null}
    </div>
  );
}

export function PermissionState({ action }: { action: string }) {
  return (
    <div role="status" className="rounded-[var(--radius-card)] border border-ink-200 bg-white px-5 py-4">
      <p className="text-sm font-semibold text-ink-900">You do not have access to this</p>
      <p className="mt-1 text-sm text-ink-500">
        {action} requires a permission your roles do not include. Ask an organisation
        administrator if you need it.
      </p>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={clsx('animate-pulse rounded-md bg-ink-100', className)}
    />
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-9 w-2/5" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}

/* --------------------------------------------------------------------- Table */

export function DataTable({
  caption, head, children, dense = false,
}: { caption: string; head: ReactNode; children: ReactNode; dense?: boolean }) {
  return (
    // Horizontal scroll is contained to the table, never the page.
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-ink-100 bg-white">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-ink-50 text-left text-xs font-semibold uppercase tracking-wide text-ink-500">
          {head}
        </thead>
        <tbody className={clsx('divide-y divide-ink-100', dense ? '[&_td]:py-2' : '[&_td]:py-3')}>
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
    <th scope={scope} className={clsx('px-4 py-2.5 font-semibold', numeric && 'text-right')}>
      {children}
    </th>
  );
}

export function Td({ children, numeric = false, className }: {
  children: ReactNode; numeric?: boolean; className?: string;
}) {
  return <td className={clsx('px-4 align-middle', numeric && 'text-right', className)}>{children}</td>;
}
