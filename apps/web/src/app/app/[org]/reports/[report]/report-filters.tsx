import { CONTROL_CLASS, FilterToolbar, ToolbarField } from '@propertyos/ui';
import { HORIZONS, type ReportShape, type ResolvedReport } from '@/lib/report-shapes';
import { PropertyFilter } from './property-filter';

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
 * the same figures. No JavaScript is required to change a date.
 *
 * Only the controls the report honours are rendered. The shape decides, and
 * the shape is the same one the export route reads, so the file and the screen
 * cannot disagree about what was asked.
 */
export function ReportFiltersForm({
  base, shape, resolved, properties, customised, scope,
}: {
  base: string;
  shape: ReportShape;
  resolved: ResolvedReport;
  properties: Array<{ id: string; name: string; status: string }>;
  /** Whether anything was asked for, so Reset appears only when it does something. */
  customised: boolean;
  /** The applied scope, in words, shown under the controls. */
  scope: string;
}) {
  const { filters } = resolved;
  const chosen = filters.propertyIds ?? [];

  return (
    <div className="space-y-2">
      <FilterToolbar
        action={`${base}/reports/${shape.slug}`}
        reset={customised ? `${base}/reports/${shape.slug}` : undefined}
        scope={scope}
      >
        {shape.period === 'range' ? (
          <>
            <DateField label="From" name="from" value={filters.periodStart} />
            <DateField label="To" name="to" value={filters.periodEnd} />
          </>
        ) : null}

        {shape.period === 'asAt' ? (
          <DateField label="As at" name="asAt" value={filters.asAt ?? ''} />
        ) : null}

        {shape.period === 'horizon' ? (
          <ToolbarField label="Ending within" htmlFor="within">
            <select
              id="within" name="within" defaultValue={String(filters.withinDays)}
              className={CONTROL_CLASS}
            >
              {HORIZONS.map((days) => (
                <option key={days} value={days}>{days} days</option>
              ))}
            </select>
          </ToolbarField>
        ) : null}

        {shape.slug === 'arrears' ? (
          <label className="flex items-center gap-2 pb-1.5 text-[length:var(--text-table)] text-ink-700">
            <input
              type="checkbox" name="overdue" value="true" defaultChecked={filters.overdueOnly}
            />
            {/* The distinction the dashboard tile is counting: this month's
                invoice issued yesterday is outstanding, not arrears. */}
            <span>Past due only</span>
          </label>
        ) : null}

        {shape.period === 'now' ? (
          // Said rather than left blank: a report with no date control has one
          // date, and a reader is entitled to know it is today's.
          <p className="max-w-sm pb-1 text-[length:var(--text-meta)] text-ink-500">
            States the position as the records stand now. It cannot be re-created for a past
            date, so there is no date to choose.
          </p>
        ) : null}

        {shape.property && properties.length > 0 ? (
          <PropertyFilter properties={properties} chosen={chosen} />
        ) : null}
      </FilterToolbar>

      {resolved.ignored ? (
        <p
          role="status"
          className="
            rounded-[var(--radius-control)] border border-caution-700/25 bg-caution-50 px-3 py-2
            text-[length:var(--text-table)] text-caution-700
          "
        >
          This shows the default period: {resolved.ignored} could not be read, so what you
          asked for is not what is below.
        </p>
      ) : null}
    </div>
  );
}

function DateField({ label, name, value }: { label: string; name: string; value: string }) {
  return (
    <ToolbarField label={label} htmlFor={`filter-${name}`}>
      <input
        id={`filter-${name}`} type="date" name={name} defaultValue={value}
        className={CONTROL_CLASS}
      />
    </ToolbarField>
  );
}
