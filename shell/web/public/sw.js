// Thrallo notification service worker (Phase 22). Web push only — the app itself never
// caches through this worker, so deploys stay instant.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "Thrallo", body: event.data?.text() || "" }; }
  event.waitUntil(self.registration.showNotification(data.title || "Thrallo", {
    body: data.body || "",
    tag: data.tag || "thrallo",
    icon: "/favicon.svg",
    data: { url: data.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Return to the conversation if a Thrallo tab exists; open the target otherwise.
    const own = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (own && (!url || url === "/" || new URL(url, self.location.origin).origin === self.location.origin)) {
      await own.focus();
      return;
    }
    await self.clients.openWindow(url || "/");
  })());
});
