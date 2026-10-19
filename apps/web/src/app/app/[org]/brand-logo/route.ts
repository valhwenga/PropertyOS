import { NextResponse } from 'next/server';
import { getLogo } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * The organisation's own logo, for the people who work in it.
 *
 * Authorised like every other page in the console: the slug is resolved
 * against the caller's memberships, and the bytes are read under their own
 * row-level security. A logo is not a secret, but "not a secret" is not a
 * reason to serve one organisation's file to another organisation's staff.
 *
 * The content type comes from what the database recorded when the file was
 * validated — never from the upload's own claim — and the response is sent
 * with `nosniff` and a `default-src 'none'` policy so that a file which
 * somehow got past the parser still cannot be rendered as a document.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ org: string }> },
) {
  const { org } = await params;
  const context = await requireOperator(org);
  const logo = await readAs(context.viewer, (tx) => getLogo(tx, context.organisationId));
  if (!logo) return new NextResponse('No logo', { status: 404 });

  return new NextResponse(Buffer.from(logo.bytes) as unknown as BodyInit, {
    headers: {
      'Content-Type': logo.mime,
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      // Private: it is one customer's asset behind their own session. The
      // version in the query string is what makes a change appear at once.
      'Cache-Control': 'private, max-age=300',
    },
  });
}
