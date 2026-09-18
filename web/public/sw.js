/* Push only. Market pages and transactions never depend on a service-worker cache. */
self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch { return; }
  if (!payload || typeof payload.title !== "string" || typeof payload.body !== "string") return;
  let url = "/";
  try {
    const parsed = new URL(payload.url, self.location.origin);
    if (parsed.origin === self.location.origin) url = parsed.pathname + parsed.search + parsed.hash;
  } catch { /* The app root is the safe fallback. */ }
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    data: { url },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data?.url || "/";
  const url = new URL(path, self.location.origin).href;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = clients.find((client) => client.url === url);
    if (open) return open.focus();
    return self.clients.openWindow(url);
  })());
});
