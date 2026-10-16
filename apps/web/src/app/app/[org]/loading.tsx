import { LoadingState } from '@propertyos/ui';

/**
 * What the console shows while a page is being built on the server.
 *
 * Every page here is `force-dynamic` and several run half a dozen queries, so
 * a slow one meant the browser sat on the previous page with nothing happening
 * — a person clicks Reports, sees no change, and clicks it again. This is the
 * nearest boundary for the whole console: a section with a heavier page of its
 * own can add one beside it, and will be used instead.
 *
 * It deliberately shows shapes rather than headings or numbers. A skeleton
 * that draws a figure the real page may contradict is a worse lie than a blank
 * screen, and in a product about money it is the wrong kind of lie entirely.
 */
export default function Loading() {
  return <LoadingState label="Loading this page" />;
}
