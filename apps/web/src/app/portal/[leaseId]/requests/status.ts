import type { StatusTone } from '@propertyos/ui';

/**
 * The ticket's state, in the resident's words.
 *
 * Mapped one-for-one onto `ticket_status`, which is the only place a state
 * comes from. "Awaiting approval" is the landlord approving a quotation, and a
 * resident is entitled to know that is what the wait is; the amount, the
 * contractor's price and who approves it are not theirs to see and are not
 * here.
 */
export const REQUEST_STATUS: Record<string, { tone: StatusTone; glyph: string; label: string }> = {
  submitted:             { tone: 'caution',  glyph: '◐', label: 'Received' },
  triaged:               { tone: 'caution',  glyph: '◐', label: 'Under review' },
  awaiting_approval:     { tone: 'caution',  glyph: '◐', label: 'Awaiting approval' },
  assigned:              { tone: 'info',     glyph: '◆', label: 'Scheduled' },
  in_progress:           { tone: 'info',     glyph: '◆', label: 'In progress' },
  awaiting_confirmation: { tone: 'info',     glyph: '◆', label: 'Waiting on you' },
  on_hold:               { tone: 'neutral',  glyph: '❙', label: 'On hold' },
  resolved:              { tone: 'positive', glyph: '✓', label: 'Resolved' },
  closed:                { tone: 'neutral',  glyph: '■', label: 'Closed' },
  cancelled:             { tone: 'neutral',  glyph: '✕', label: 'Cancelled' },
};

export function requestStatus(status: string) {
  return REQUEST_STATUS[status]
    ?? { tone: 'neutral' as StatusTone, glyph: '○', label: status.replace(/_/g, ' ') };
}

export const OPEN_STATES = [
  'submitted', 'triaged', 'awaiting_approval', 'assigned', 'in_progress', 'awaiting_confirmation',
  'on_hold',
];

/**
 * A title from the description.
 *
 * There is no title column — a resident types one description and nothing
 * else. Rather than adding a field and asking them for more, the first
 * sentence or so becomes the heading and the whole description stays below it
 * on the request's own page.
 */
export function requestTitle(description: string): string {
  const firstSentence = description.split(/(?<=[.!?])\s/)[0] ?? description;
  const title = firstSentence.length > 70 ? `${firstSentence.slice(0, 67).trimEnd()}…` : firstSentence;
  return title.replace(/\s+/g, ' ').trim();
}

/**
 * Priority, as the resident should read it.
 *
 * The manager's assessment where there is one, because that is what drives the
 * queue; the resident's own urgency until then. Shown only when it is high
 * enough to mean something — a "normal" badge on every card is furniture.
 */
export function requestPriority(
  urgency: string, triaged: string | null,
): { label: string; tone: StatusTone } | null {
  const effective = triaged ?? urgency;
  if (effective === 'emergency') return { label: 'Emergency', tone: 'critical' };
  if (effective === 'high') return { label: 'High priority', tone: 'caution' };
  return null;
}
