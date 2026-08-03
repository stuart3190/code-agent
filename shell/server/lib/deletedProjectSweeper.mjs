// Recently Deleted cleanup: permanently deletes projects whose 7-day recovery window has
// expired. Runs the same audited cascade as Delete Now; every permanent deletion is logged.

import { purgeExpiredDeletedConversations } from "./conversationDelete.mjs";

let timer = null;

function provisiond() {
  if (!process.env.PROVISIOND_URL || !process.env.PROVISIOND_TOKEN) return null;
  return async (route, body = null, method = "POST") => {
    const res = await fetch(`${process.env.PROVISIOND_URL}${route}`, {
      method,
      headers: {
        ...(body !== null ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${process.env.PROVISIOND_TOKEN}`,
      },
      body: body !== null ? JSON.stringify(body) : undefined,
    });
    // Parsed, not the raw Response: teardown needs to READ the answer to verify a site is gone,
    // and the previous contract made "it returned 200 having done nothing" indistinguishable
    // from success.
    return res.json().catch(() => ({}));
  };
}

export async function sweepDeletedProjects() {
  const { serviceClient } = await import("./supabase.mjs");
  let client = null;
  try { client = serviceClient(); } catch { client = null; }
  return purgeExpiredDeletedConversations({ client, provisiond: provisiond() });
}

export function startDeletedProjectSweeper() {
  if (timer) return;
  const interval = Math.max(Number(process.env.DELETED_SWEEP_MS || 60 * 60_000), 60_000);
  timer = setInterval(() => {
    sweepDeletedProjects()
      .then(({ purged, failed }) => {
        if (purged || failed) console.log(`[cleanup] expired projects purged=${purged} failed=${failed}`);
      })
      .catch((error) => console.error("[cleanup] deleted-project sweep:", error));
  }, interval);
  timer.unref?.();
}

export function stopDeletedProjectSweeper() {
  if (timer) clearInterval(timer);
  timer = null;
}
