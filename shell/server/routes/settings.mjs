// Settings routes — BYOK (bring-your-own-key) management. All owner-scoped (requireOwner in index).
// The raw key is accepted on POST, stored ENCRYPTED via byokStore, and NEVER echoed back: responses
// carry only { set, provider, hint }. Nothing here logs the key.
//
//   GET    /api/settings/byok            -> { set, provider?, hint?, created_at? }
//   POST   /api/settings/byok  { key }   -> { set:true, provider, hint }
//   DELETE /api/settings/byok            -> { set:false }

import { getKeyRecord, setKey, clearKey, byokConfigured } from "../lib/byokStore.mjs";

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

export async function handleByokGet(req, res, owner) {
  try {
    send(res, 200, await getKeyRecord(owner.id));
  } catch (e) {
    console.error(`[byok:get] ${e?.stack || e}`);
    send(res, 500, { error: "BYOK settings are temporarily unavailable." });
  }
}

export async function handleByokSave(req, res, body, owner) {
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  const provider = "anthropic"; // only adapter today; a picker is deferred
  if (!key) return send(res, 400, { error: "key is required" });
  // Soft format check — a nudge, not a hard gate (providers can change prefixes).
  if (!key.startsWith("sk-ant-")) {
    return send(res, 400, { error: "expected an Anthropic API key (starts with 'sk-ant-')" });
  }
  if (!byokConfigured()) {
    return send(res, 500, { error: "BYOK storage not configured on the server (set BYOK_ENC_KEY)." });
  }
  try {
    const rec = await setKey(owner.id, key, provider); // returns masked hint only
    send(res, 200, { set: true, provider: rec.provider, hint: rec.hint });
  } catch (e) {
    console.error(`[byok:save] ${e?.stack || e}`);
    send(res, 500, { error: "The API key could not be saved. Please try again." });
  }
}

export async function handleByokClear(req, res, owner) {
  try {
    send(res, 200, await clearKey(owner.id));
  } catch (e) {
    console.error(`[byok:clear] ${e?.stack || e}`);
    send(res, 500, { error: "The API key could not be removed. Please try again." });
  }
}
