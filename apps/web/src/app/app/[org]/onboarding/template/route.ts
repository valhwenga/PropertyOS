import { NextResponse } from 'next/server';
import { importTemplate, type ImportKind } from '@propertyos/domain';
import { getViewer } from '@/lib/auth';

const KINDS: ImportKind[] = [
  'properties', 'units', 'residents', 'leases',
  'charge_schedules', 'opening_balances', 'deposits',
];

/**
 * Downloads a CSV template.
 *
 * The template carries an example row and, as leading comment lines, the
 * required columns and the rules — so an operator preparing data in a
 * spreadsheet has the guidance in the file rather than in a tab they closed.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ org: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) return new NextResponse('Unauthorised', { status: 401 });

  const { org } = await context.params;
  if (!viewer.organisations.some((o) => o.slug === org)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const kind = new URL(request.url).searchParams.get('kind') as ImportKind | null;
  if (!kind || !KINDS.includes(kind)) return new NextResponse('Unknown template', { status: 404 });

  const template = importTemplate(kind);
  const guidance = [
    `# PropertyOS import template: ${kind.replace(/_/g, ' ')}`,
    '#',
    ...template.columns.map(
      (c) => `# ${c.name}${c.required ? ' (required)' : ' (optional)'}: ${c.description}`,
    ),
    '#',
    ...template.notes.map((n) => `# NOTE: ${n}`),
    '#',
    '# Delete every line starting with # before uploading.',
    '',
  ].join('\r\n');

  return new NextResponse(guidance + template.csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="propertyos-${kind.replace(/_/g, '-')}-template.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
