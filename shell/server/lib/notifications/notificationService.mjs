// The notification dispatch service (Platform Architecture 5): one notifyOwner() call,
// per-channel adapters behind it. Channels degrade gracefully — an unconfigured channel is
// simply skipped — and notifications only fire when the user is actually AWAY (nobody
// streaming the conversation), so an open tab never double-announces what the thread
// already shows.

import { serviceClient } from "../supabase.mjs";
import { optionalEnv } from "../env.mjs";
import { sendWebPush } from "./webPush.mjs";
import { recordNotification } from "./notificationHistory.mjs";

const vapidConfigured = () => !!(optionalEnv("THRALLO_VAPID_PUBLIC_KEY") && optionalEnv("THRALLO_VAPID_PRIVATE_KEY"));
const resendConfigured = () => !!optionalEnv("THRALLO_RESEND_KEY");

export function notificationChannels() {
  return {
    webpush: vapidConfigured(),
    email: resendConfigured(),
  };
}

export function vapidPublicKey() {
  return optionalEnv("THRALLO_VAPID_PUBLIC_KEY") || null;
}

export async function saveSubscription(ownerId, subscription) {
  const endpoint = String(subscription?.endpoint || "");
  const keys = subscription?.keys || {};
  if (!/^https:\/\//.test(endpoint) || !keys.p256dh || !keys.auth) {
    const error = new Error("A valid push subscription is required.");
    error.status = 400;
    throw error;
  }
  const { error } = await serviceClient().from("ca_push_subscriptions").upsert({
    owner: ownerId, endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, disabled_at: null,
  }, { onConflict: "endpoint" });
  if (error) throw new Error(error.message);
  return { saved: true };
}

export async function removeSubscription(ownerId, endpoint) {
  await serviceClient().from("ca_push_subscriptions")
    .delete().eq("owner", ownerId).eq("endpoint", String(endpoint || ""));
  return { removed: true };
}

// notifyOwner: fire-and-forget from event sites; failures log, never throw into the caller.
export async function notifyOwner(ownerId, { title, body, url = null, tag = "thrallo" }, { fetchImpl = fetch, record = recordNotification } = {}) {
  const results = { webpush: 0, email: 0, recorded: false };
  // Recorded FIRST, and independently of the channels. Web push needs a subscription and email
  // needs Resend; a customer with neither used to receive nothing at all and had no way to find
  // out afterwards. The history is the one channel that always exists.
  try {
    results.recorded = !!(await record(ownerId, { title, body, url, tag }));
  } catch (error) {
    console.error(`[notify:history] ${error.message}`);
  }
  try {
    if (vapidConfigured()) {
      const { data: subs } = await serviceClient().from("ca_push_subscriptions")
        .select("endpoint, keys").eq("owner", ownerId).is("disabled_at", null);
      const vapid = {
        publicKey: optionalEnv("THRALLO_VAPID_PUBLIC_KEY"),
        privateKey: optionalEnv("THRALLO_VAPID_PRIVATE_KEY"),
        subject: optionalEnv("THRALLO_VAPID_SUBJECT", "mailto:support@thrallo.com"),
      };
      for (const sub of subs || []) {
        try {
          const out = await sendWebPush({
            subscription: { endpoint: sub.endpoint, keys: sub.keys },
            payload: { title, body, url, tag },
            vapid, fetchImpl,
          });
          if (out.ok) {
            results.webpush += 1;
            await serviceClient().from("ca_push_subscriptions")
              .update({ last_ok_at: new Date().toISOString() }).eq("endpoint", sub.endpoint);
          } else if (out.gone) {
            await serviceClient().from("ca_push_subscriptions")
              .update({ disabled_at: new Date().toISOString() }).eq("endpoint", sub.endpoint);
          }
        } catch (error) {
          console.error(`[notify:webpush] ${error.message}`);
        }
      }
    }
    if (resendConfigured()) {
      results.email += await sendEmail(ownerId, { title, body, url, fetchImpl });
    }
  } catch (error) {
    console.error(`[notify] ${error.message}`);
  }
  return results;
}

// Away-aware variant: if anyone is streaming the conversation right now, the thread itself
// is the notification — skip the channels entirely.
export async function notifyOwnerIfAway(ownerId, conversationId, note) {
  try {
    const { conversationStore } = await import("../conversationStore.mjs");
    const watchers = conversationStore().bus?.listenerCount?.(`conversation:${conversationId}`) || 0;
    if (watchers > 0) return { skipped: "watching" };
  } catch { /* away detection best-effort */ }
  return notifyOwner(ownerId, note);
}

async function sendEmail(ownerId, { title, body, url, fetchImpl }) {
  try {
    const { data } = await serviceClient().auth.admin.getUserById(ownerId);
    const email = data?.user?.email;
    if (!email) return 0;
    const from = optionalEnv("THRALLO_RESEND_FROM", "Thrallo <notify@thrallo.com>");
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${optionalEnv("THRALLO_RESEND_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to: [email], subject: title,
        text: `${body}${url ? `\n\n${url}` : ""}`,
      }),
    });
    return res.ok ? 1 : 0;
  } catch (error) {
    console.error(`[notify:email] ${error.message}`);
    return 0;
  }
}
