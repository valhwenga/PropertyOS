'use client';

import { useId, useState } from 'react';

/**
 * Which properties the report covers.
 *
 * A scrolling list of checkboxes with a box above it that narrows the list.
 * The checkboxes are all rendered on the server and only hidden by the filter,
 * so the control still works with no JavaScript — the search box is the part
 * that needs it, and a search box that cannot search is better missing than
 * inert.
 *
 * Nothing ticked means every property, which is stated rather than implied:
 * an empty selection and "all" look identical otherwise.
 */
export function PropertyFilter({
  properties, chosen,
}: {
  properties: Array<{ id: string; name: string; status: string }>;
  chosen: string[];
}) {
  const [query, setQuery] = useState('');
  const id = useId();
  const picked = new Set(chosen);
  const needle = query.trim().toLowerCase();

  return (
    <div className="min-w-[15rem]">
      <label
        htmlFor={id}
        className="block text-[length:var(--text-meta)] font-medium text-ink-500"
      >
        Properties
      </label>
      <div className="mt-1 w-full rounded-[var(--radius-control)] border border-ink-200 bg-surface">
        <input
          id={id}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${properties.length} properties`}
          className="
            w-full rounded-t-[var(--radius-control)] border-b border-ink-100 bg-transparent
            px-2.5 py-1.5 text-[length:var(--text-table)] text-ink-900
          "
        />
        <div className="max-h-24 space-y-0.5 overflow-y-auto px-2.5 py-1.5">
          {properties.map((property) => {
            const hidden = needle !== '' && !property.name.toLowerCase().includes(needle);
            return (
              <label
                key={property.id}
                hidden={hidden}
                className="flex items-center gap-2 text-[length:var(--text-table)] text-ink-700"
              >
                <input
                  type="checkbox"
                  name="property"
                  value={property.id}
                  defaultChecked={picked.has(property.id)}
                />
                <span className="truncate">{property.name}</span>
                {property.status !== 'active' ? (
                  <span className="text-[length:var(--text-meta)] text-ink-400">
                    ({property.status})
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}
