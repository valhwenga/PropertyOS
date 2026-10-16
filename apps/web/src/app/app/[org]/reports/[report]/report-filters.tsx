import Link from 'next/link';
import { Card } from '@propertyos/ui';
import { HORIZONS, type ReportShape, type ResolvedReport } from '@/lib/report-shapes';

/**
 * What this report may be asked, as controls.
 *
 * The date controls are `type="date"`, not the product's own dd/mm/yyyy text
 * field. These values end up in the URL, and a link somebody sends a colleague
 * reading `?from=01/02/2026` means two different months to two different
 * people; ISO means one. The native picker is the other half of the trade.
 *
 * A plain GET form: the filters end up in the URL, so a report somebody is
 * looking at can be sent to a colleague or kept as a bookmark and will show
 * the same figures. There is no client component here and no JavaScript is
 * required to change a date.
 *
 * Only the controls the report honours are rendered. The shape decides, and
 * the shape is the same one the export route reads, so the file and the screen
 * cannot disagree about what was asked.
 */
export function ReportFiltersForm({
  base, shape, resolved, properties, customised,
}: {
  base: string;
  shape: ReportShape;
  resolved: ResolvedReport;
  properties: Array<{ id: string; name: string; status: string }>;
  /** Whether anything was asked for, so Reset appears only when it does something. */
  customised: boolean;
}) {
  const { filters } = resolved;
  const chosen = new Set(filters.propertyIds ?? []);

  return (
    <Card className="p-4">
      <form method="get" className="flex flex-wrap items-end gap-4">
        {shape.period === 'range' ? (
          <>
            <Field label="From" name="from" value={filters.periodStart} />
            <Field label="To" name="to" value={filters.periodEnd} />
          </>
        ) : null}

        {shape.period === 'asAt' ? (
          <Field label="As at" name="asAt" value={filters.asAt ?? ''} />
        ) : null}

        {shape.period === 'horizon' ? (
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-ink-700">Ending within</span>
            <select
              name="within"
              defaultValue={String(filters.withinDays)}
              className="rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-sm"
            >
              {HORIZONS.map((days) => (
                <option key={days} value={days}>{days} days</option>
              ))}
            </select>
          </label>
        ) : null}

        {shape.period === 'now' ? (
          // Said rather than left blank: a report with no date control has one
          // date, and a reader is entitled to know it is today's.
          <p className="max-w-sm text-sm text-ink-500">
            This report states the position as the records stand now. It cannot be
            re-created for a past date, so there is no date to choose.
          </p>
        ) : null}

        {shape.property && properties.length > 0 ? (
          <fieldset className="min-w-[14rem]">
            <legend className="mb-1 text-sm font-medium text-ink-700">Properties</legend>
            <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-ink-200 bg-surface px-3 py-2">
              {properties.map((property) => (
                <label key={property.id} className="flex items-center gap-2 text-sm text-ink-700">
                  <input
                    type="checkbox"
                    name="property"
                    value={property.id}
                    defaultChecked={chosen.has(property.id)}
                  />
                  <span className="truncate">{property.name}</span>
                  {property.status !== 'active' ? (
                    <span className="text-xs text-ink-400">({property.status})</span>
                  ) : null}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-ink-400">None ticked means every property.</p>
          </fieldset>
        ) : null}

        {!shape.property ? (
          <p className="max-w-sm text-sm text-ink-500">
            This report covers the whole organisation; see why below.
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <button
            type="submit"
            className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white"
          >
            Apply
          </button>
          {customised ? (
            <Link
              href={`${base}/reports/${shape.slug}`}
              className="text-sm text-ink-500 hover:underline"
            >
              Reset
            </Link>
          ) : null}
        </div>
      </form>

      {resolved.ignored ? (
        <p className="mt-3 rounded-lg bg-caution-50 px-3 py-2 text-sm text-caution-700">
          This shows the default period: {resolved.ignored} could not be read, so what you
          asked for is not what is below.
        </p>
      ) : null}
    </Card>
  );
}

function Field({ label, name, value }: { label: string; name: string; value: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-ink-700">{label}</span>
      <input
        type="date"
        name={name}
        defaultValue={value}
        className="rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-sm"
      />
    </label>
  );
}
