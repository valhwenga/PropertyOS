import { LoadingState } from '@propertyos/ui';

/**
 * What a tenancy section shows while it is being built.
 *
 * Shapes, never figures. A skeleton balance that the real one then contradicts
 * would be read as a change in what somebody owes — the one kind of flicker a
 * money screen cannot afford.
 */
export default function Loading() {
  return <LoadingState label="Loading your tenancy" />;
}
