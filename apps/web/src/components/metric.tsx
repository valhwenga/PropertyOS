import Link from 'next/link';
import type { ReactNode } from 'react';
import { Money } from '@propertyos/ui';

/**
 * A dashboard metric tile.
 *
 * `href` is REQUIRED: every headline figure must open the records it was
 * computed from, with the same filters applied. A number nobody can drill into
 * is a number nobody can check.
 */
export function MetricTile({
  label, href, children, qualification, tone = 'default',
}: {
  label: string;
  href: string;
  children: ReactNode;
  qualification?: string;
  tone?: 'default' | 'attention';
}) {
  return (
    <Link
      href={href}
      className={[
        'group flex flex-col gap-1 rounded-[var(--radius-card)] border bg-white p-4',
        'shadow-[var(--shadow-card)] transition-colors hover:border-spike-300',
        tone === 'attention' ? 'border-caution-700/30' : 'border-ink-100',
      ].join(' ')}
    >
      <span className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</span>
      <span className="text-2xl font-semibold text-ink-900">{children}</span>
      {qualification ? (
        <span className="text-xs text-ink-400">{qualification}</span>
      ) : null}
      <span className="mt-1 text-xs font-medium text-spike-600 group-hover:underline">
        View records →
      </span>
    </Link>
  );
}

export function MoneyMetric({
  label, minor, href, currency = 'ZAR', qualification, tone,
}: {
  label: string; minor: string | bigint; href: string;
  currency?: string; qualification?: string; tone?: 'default' | 'attention';
}) {
  return (
    <MetricTile label={label} href={href} qualification={qualification} tone={tone}>
      <Money minor={minor} currency={currency} />
    </MetricTile>
  );
}
