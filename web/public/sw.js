/* Push only. Market pages and transactions never depend on a service-worker cache. */
function stableNotificationTag(payload, url) {
  const kind = typeof payload.kind === "string" ? payload.kind : "alert";
  const input = `${kind}\n${url}\n${payload.title}\n${payload.body}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `stonkhouse-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

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
    icon: "/icon-192.png",
    badge: "/notification-badge.png",
    tag: stableNotificationTag(payload, url),
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
