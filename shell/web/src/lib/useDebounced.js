// A value that settles after typing stops.
//
// Two search boxes needed this and only one had it. Home debounced at 300ms; the log search did
// not, so typing a six-character query fired six API requests AND tore down and reopened the live
// log stream six times. Same idea, one implementation.

import { useEffect, useState } from "react";

/**
 * Mirrors `value`, but only after it has stopped changing for `delay`.
 *
 * The immediate value still drives the input, so typing stays instant; only the work hanging off
 * it waits. Returns the settled value.
 */
export function useDebounced(value, delay = 300) {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    if (settled === value) return undefined;
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
    // `settled` is deliberately absent: including it would restart the timer on every settle and
    // the value would never catch up while someone kept typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, delay]);

  return settled;
}
