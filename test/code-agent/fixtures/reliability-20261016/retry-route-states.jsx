// Model-owned presentation of the route states the platform decides: loading, not_found,
// forbidden and error. The platform says WHICH state the route is in; how each one looks, reads
// and recovers is yours. Replace this file's contents freely.
export default function RouteStates({ state, reason, redirectTo, onRetry }) {
  if (state === "loading") return <p role="status">Loading…</p>;
  if (state === "not_found") return <p role="alert">We could not find that.</p>;
  if (state === "forbidden") {
    return <p role="alert">You need to sign in to view this{redirectTo ? <> — <a href={redirectTo}>sign in</a></> : null}.</p>;
  }
  if (state === "error") return <div role="alert"><p>We could not load this page. Please try again.</p>{onRetry ? <button type="button" onClick={onRetry}>Try again</button> : null}</div>;
  return null;
}
