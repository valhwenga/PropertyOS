import { LoadingState } from '@propertyos/ui';

/**
 * The resident's equivalent of the console boundary.
 *
 * A resident's statement is the heaviest read in the portal — charges,
 * receipts, allocations and the running balance — and it is often opened on a
 * phone on a slow connection. Shapes, never figures: a placeholder balance
 * that the real one then contradicts would be read as a change in what they
 * owe.
 */
export default function Loading() {
  return <LoadingState label="Loading your tenancy" />;
}
