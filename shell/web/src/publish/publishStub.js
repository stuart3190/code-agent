// PUBLISH — OUT OF SCOPE this session (explicitly). This is the visible seam boundary only: the
// hosting target (static + shared API → live URL) is a deferred decision (build plan Phase 3), so
// nothing is built behind it. The Publish button in the UI is wired to this no-op so the shape is
// present without implying capability.

export async function publish(/* project */) {
  return {
    ok: false,
    stub: true,
    message: "Publish is not built yet — deploy target is a deferred decision (its own session).",
  };
}
