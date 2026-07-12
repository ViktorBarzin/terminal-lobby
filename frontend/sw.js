// terminal-lobby push service worker (Item 4 — Notifications Part 1).
//
// PUSH-ONLY BY DESIGN. There is deliberately NO 'fetch' handler and NO
// install/precache caching in this worker. A service worker that
// intercepts fetch would start serving the app from a stale Cache
// Storage copy across deploys — the very staleness the no-store/ETag
// index revalidation exists to avoid — so a fetch handler is FORBIDDEN
// here. This worker exists ONLY to show Web Push notifications and to
// route a click back into the app when the tab is closed/backgrounded.
//
// Push payload (JSON): { title, body, tag: 'tl-<session>', session }.
// Coalescing is by tag ONLY — a re-fire for the same session REPLACES
// the visible notification; `renotify` is intentionally omitted so a
// repeat never re-alerts the user (tripit-proven).

self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
    const title = data.title || 'Terminal';
    const options = {
        body: data.body || '',
        tag: data.tag || 'tl',
        icon: '/icon-192.png',
        data: { session: data.session || null }
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const session = (event.notification.data && event.notification.data.session) || 'main';
    event.waitUntil((async () => {
        // Focus an already-open app window (all app clients live under the
        // worker's '/' scope) rather than spawning a duplicate; only open
        // a new one if nothing is running.
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of wins) {
            if ('focus' in c) {
                try { await c.focus(); return; } catch (e) { /* try the next */ }
            }
        }
        if (self.clients.openWindow) await self.clients.openWindow('/#' + session);
    })());
});
