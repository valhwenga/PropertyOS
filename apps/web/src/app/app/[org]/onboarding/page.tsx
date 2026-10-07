import { Card, PageHeader } from '@propertyos/ui';
import { importTemplate, type ImportKind } from '@propertyos/domain';
import { requireOperator } from '@/lib/auth';
import { ImportWizard } from './import-wizard';

export const metadata = { title: 'Import your portfolio' };

const ORDER: Array<{ kind: ImportKind; label: string; step: number }> = [
  { kind: 'properties', label: 'Properties', step: 1 },
  { kind: 'units', label: 'Units', step: 2 },
  { kind: 'residents', label: 'Residents', step: 3 },
  { kind: 'leases', label: 'Leases', step: 4 },
  { kind: 'charge_schedules', label: 'Extra recurring charges', step: 5 },
  { kind: 'opening_balances', label: 'Opening balances', step: 6 },
  { kind: 'deposits', label: 'Deposits held', step: 7 },
];

export default async function OnboardingPage({
  params, searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ kind?: string }>;
}) {
  const { org } = await params;
  const { kind } = await searchParams;
  await requireOperator(org);

  const selected = (ORDER.find((s) => s.kind === kind)?.kind ?? 'properties') as ImportKind;
  const template = importTemplate(selected);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Import your portfolio"
        description="Import in order: each step references the one before it by the codes you already use."
      />

      <Card className="border-info-700/25 bg-info-50 p-4">
        <p className="text-sm font-semibold text-info-700">How importing works</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink-700">
          <li>Upload a file and PropertyOS checks every row <strong>without saving anything</strong>.</li>
          <li>Any problems are listed by row and column, so you can fix them in your spreadsheet.</li>
          <li>When you import, it is all or nothing. You never have to work out which rows went in.</li>
        </ul>
      </Card>

      <nav aria-label="Import steps">
        <ol className="flex flex-wrap gap-2">
          {ORDER.map((step) => (
            <li key={step.kind}>
              <a
                href={`/app/${org}/onboarding?kind=${step.kind}`}
                aria-current={step.kind === selected ? 'step' : undefined}
                className={[
                  'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                  step.kind === selected
                    ? 'border-spike-500 bg-spike-50 font-medium text-spike-700'
                    : 'border-ink-200 bg-surface text-ink-700 hover:bg-ink-50',
                ].join(' ')}
              >
                <span
                  aria-hidden="true"
                  className={[
                    'flex h-5 w-5 items-center justify-center rounded-full text-xs',
                    step.kind === selected ? 'bg-spike-500 text-white' : 'bg-ink-100 text-ink-500',
                  ].join(' ')}
                >
                  {step.step}
                </span>
                {step.label}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <ImportWizard org={org} kind={selected} />

        <aside className="space-y-4">
          <Card className="p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Columns</h2>
            <dl className="mt-2 space-y-2.5">
              {template.columns.map((column) => (
                <div key={column.name}>
                  <dt className="tabular text-sm font-medium text-ink-900">
                    {column.name}
                    {column.required ? (
                      <span className="ml-1.5 text-xs font-normal text-critical-700">required</span>
                    ) : (
                      <span className="ml-1.5 text-xs font-normal text-ink-400">optional</span>
                    )}
                  </dt>
                  <dd className="text-xs text-ink-500">{column.description}</dd>
                </div>
              ))}
            </dl>
            <a
              href={`/app/${org}/onboarding/template?kind=${selected}`}
              className="mt-4 inline-block rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
            >
              Download template
            </a>
          </Card>

          {template.notes.length > 0 ? (
            <Card className="border-caution-700/25 bg-caution-50 p-4">
              <h2 className="text-sm font-semibold text-caution-700">Before you import</h2>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink-700">
                {template.notes.map((note) => <li key={note}>{note}</li>)}
              </ul>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
