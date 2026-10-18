'use client';

import { useRouter } from 'next/navigation';
import { useId } from 'react';
import { Icons } from './icons';
import { splitEnvironmentLabel } from './environment-label';

/**
 * Which organisation you are looking at, and the way to another.
 *
 * A native `<select>` rather than a bespoke menu: it is keyboard-operable and
 * screen-reader-correct without any work, it behaves like the platform's own
 * control on a phone, and the list is short. Changing it navigates to the same
 * console for the chosen organisation.
 *
 * Someone who belongs to exactly one organisation gets a plain line instead of
 * a control that can only choose what is already chosen.
 */
export function OrganisationSwitcher({
  current, organisations,
}: {
  current: string;
  organisations: Array<{ slug: string; name: string }>;
}) {
  const router = useRouter();
  const id = useId();
  const here = organisations.find((o) => o.slug === current);
  const label = splitEnvironmentLabel(here?.name ?? '').name;

  if (organisations.length <= 1) {
    return (
      <div className="border-y border-ink-100 px-4 py-2.5 lg:border-t-0">
        <p className="truncate text-[length:var(--text-table)] font-semibold text-ink-900">
          {label || 'Organisation'}
        </p>
      </div>
    );
  }

  return (
    <div className="relative border-y border-ink-100 px-3 py-2 lg:border-t-0">
      <label htmlFor={id} className="sr-only">Organisation</label>
      <select
        id={id}
        value={current}
        onChange={(event) => router.push(`/app/${event.target.value}`)}
        className="
          w-full appearance-none rounded-[var(--radius-control)] border border-ink-200
          bg-surface py-1.5 pl-2.5 pr-8 text-[length:var(--text-table)] font-semibold
          text-ink-900 hover:bg-ink-50
        "
      >
        {organisations.map((organisation) => (
          <option key={organisation.slug} value={organisation.slug}>
            {splitEnvironmentLabel(organisation.name).name}
          </option>
        ))}
      </select>
      <Icons.chevronDown
        className="pointer-events-none absolute right-5 top-1/2 size-4 -translate-y-1/2 text-ink-400"
      />
    </div>
  );
}
