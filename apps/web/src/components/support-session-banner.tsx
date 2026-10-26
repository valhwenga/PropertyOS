import { Icons } from './icons';

/**
 * The line that must never be missable: these are somebody else's records.
 *
 * Rendered by the console shell rather than by a page, so it is on every
 * screen an operator can reach under a session — a banner on the landing page
 * alone is a banner nobody sees after the first click.
 *
 * It states the four things that make this access legitimate: whose records
 * these are, what the session may change, when it ends on its own, and that
 * the customer sees the same session on their own screen and can end it. If
 * any of those stops being true, the operator should be able to tell from
 * here rather than from a support ticket a week later.
 */
export function SupportSessionBanner({
  organisationName, expiresAt, scopeNames, timeZone,
}: {
  organisationName: string;
  expiresAt: string;
  /** The customer's own words for what they allowed, not permission keys. */
  scopeNames: string[];
  timeZone: string;
}) {
  const ends = new Intl.DateTimeFormat('en-ZA', {
    dateStyle: 'medium', timeStyle: 'short', timeZone,
  }).format(new Date(expiresAt));

  return (
    <div
      role="status"
      className="
        mb-4 flex flex-wrap items-start gap-3 rounded-[var(--radius-card)]
        border border-caution-700/30 bg-caution-50 px-4 py-3
      "
    >
      <Icons.support className="mt-0.5 size-4 shrink-0 text-caution-700" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold text-caution-700">
          You are in {organisationName}&apos;s account on a support session
        </p>
        <p className="mt-0.5 text-ink-700">
          {scopeNames.length === 0 ? (
            <>
              You can read their records and change nothing. The session ends {ends}.
            </>
          ) : (
            <>
              They have allowed you to change: <strong>{scopeNames.join(', ')}</strong>. Nothing
              else, and never their bank details, money, members or identity documents. The
              session ends {ends}.
            </>
          )}
        </p>
        <p className="mt-0.5 text-xs text-ink-500">
          Everything you do here is recorded against this session and is visible to them on
          their own support access screen, where they can end it at any moment.
        </p>
      </div>
    </div>
  );
}
