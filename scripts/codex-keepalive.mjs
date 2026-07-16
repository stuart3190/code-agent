// Codex OAuth keep-alive — forces one token refresh a day so the ChatGPT-sub chain never ages
// out during idle periods (the 2026-07-15 failure: a week of no builds -> refresh token expired
// -> HTTP 401 -> manual `codex login` + scp). Runs on the VPS via buildr-codex-keepalive.timer
// (daily, like buildr-backup); auth.mjs persists the rotated tokens back to ~/.codex/auth.json.
//
//   node scripts/codex-keepalive.mjs

import { forceRefresh } from "../src/providers/auth.mjs";

try {
  const { expiresAt, rotated } = await forceRefresh();
  console.log(`[codex-keepalive] refreshed OK — access token good until ${expiresAt}` +
    `${rotated ? ", refresh token rotated + persisted" : ""}`);
} catch (e) {
  console.error(`[codex-keepalive] FAILED: ${e.message}`);
  console.error("[codex-keepalive] if this keeps failing, run `codex login` and copy auth.json to the VPS.");
  process.exit(1);
}
