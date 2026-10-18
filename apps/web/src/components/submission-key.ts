'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * One key per intended submission.
 *
 * A form that posts the same key twice is one intent submitted twice — a
 * double-click, a resubmitted request after a connection drop, a browser
 * replaying what it thinks failed — and the server answers both with the same
 * record. A form that posts a new key is a new intent.
 *
 * So the key is generated when the form mounts and regenerated once a
 * submission has succeeded, because what the operator types next is a
 * different record rather than a retry of the last one. That matters here more
 * than it would elsewhere: two identical payments on the same day for the same
 * amount are an ordinary thing in letting, and the product must be able to
 * record both.
 */
export function useSubmissionKey(succeeded: boolean): string {
  const [key, setKey] = useState(() => crypto.randomUUID());
  const previous = useRef(succeeded);

  useEffect(() => {
    if (succeeded && !previous.current) setKey(crypto.randomUUID());
    previous.current = succeeded;
  }, [succeeded]);

  return key;
}
