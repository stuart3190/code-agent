// Sharing a published site.
//
// `navigator.share()` is the real thing: on a phone it opens the OS share sheet, so the link goes
// straight to Messages, Mail or Slack; on Chrome and Edge desktop it does the same. Everywhere else
// it does not exist, and the honest fallback is the clipboard — with the caller told which happened
// so the button can say "Shared" or "Copied" rather than guessing.
//
// Lives here rather than inside the publish panel because Phase 5's project cards will want the
// same behaviour, and a second copy is how two surfaces come to disagree.

/**
 * Share a URL, falling back to the clipboard.
 *
 * Returns "shared", "copied", or "dismissed" — never throws for the ordinary case of someone
 * closing the share sheet, which is a decision rather than a failure.
 */
export async function shareUrl(url, title = "") {
  const address = String(url || "");
  if (!address) return "dismissed";

  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({ title: title || undefined, url: address });
      return "shared";
    } catch (error) {
      // AbortError is the user closing the sheet. Falling back to a clipboard copy there would put
      // something on their clipboard they did not ask for.
      if (error?.name === "AbortError") return "dismissed";
      // Anything else (permission policy, an unsupported payload) falls through to the clipboard.
    }
  }

  await navigator.clipboard.writeText(address);
  return "copied";
}
