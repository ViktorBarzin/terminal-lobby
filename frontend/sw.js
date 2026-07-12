// terminal-lobby push service worker (Notifications Parts 1 & 2).
//
// PUSH-ONLY BY DESIGN. There is deliberately NO 'fetch' EVENT handler and
// NO install/precache caching in this worker. A worker that intercepts the
// fetch event would start serving the app from a stale Cache Storage copy
// across deploys — the very staleness the no-store/ETag index revalidation
// exists to avoid — so a 'fetch' listener is FORBIDDEN here. (Calling
// fetch() from a push/pushsubscriptionchange handler is fine and NOT that:
// it makes a network request, it does not intercept navigation.) This worker
// exists ONLY to show Web Push notifications, route a click back into the
// app, and keep the server's subscription list current across browser key
// rotations.
//
// Push payload (JSON): { title, body, tag: 'tl-<session>', session }.
// Coalescing is by tag ONLY — a re-fire for the same session REPLACES
// the visible notification; `renotify` is intentionally omitted so a
// repeat never re-alerts the user (tripit-proven).
//
// These endpoints ride the same /api/sessions/ tmux-api prefix the page uses.
const VAPID_PUBLIC_API = '/api/sessions/push/vapid-public';
const PUSH_SUBS_API = '/api/sessions/push-subscriptions';

function urlB64ToUint8Array(base64url) {
    const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
    const b64 = (base64url + pad).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

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

// The browser can rotate a push subscription on its own (key refresh); when
// it does, the old endpoint stops working. Re-subscribe with the server's
// VAPID key and PUT the fresh subscription so background push keeps working
// without waiting for the user to reopen the app. Best-effort: if the server
// is dark (vapid-public 404) or re-subscribe fails, the page's bell re-subscribes
// on next open, and the server prunes the dead endpoint on its next 404/410.
self.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil((async () => {
        try {
            const resp = await fetch(VAPID_PUBLIC_API, { credentials: 'same-origin' });
            if (!resp.ok) return;
            const key = (await resp.text()).trim();
            if (!key) return;
            const sub = await self.registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlB64ToUint8Array(key)
            });
            await fetch(PUSH_SUBS_API, {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sub.toJSON ? sub.toJSON() : sub)
            });
            // Drop the superseded endpoint if the event surfaced it.
            const old = event.oldSubscription;
            if (old && old.endpoint && old.endpoint !== sub.endpoint) {
                await fetch(PUSH_SUBS_API, {
                    method: 'DELETE',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ endpoint: old.endpoint })
                });
            }
        } catch (e) { /* best-effort; page re-subscribe + server prune are the backstop */ }
    })());
});
