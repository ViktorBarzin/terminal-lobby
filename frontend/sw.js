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

// Take over IMMEDIATELY on update. Without these two, a new worker sits in
// 'waiting' until every client of the app is closed — on an installed PWA that
// can be days, so a fix to the notification-tap routing below stays dormant on
// the very device it was written for. Safe here precisely because this worker is
// push-only: with no fetch handler and no Cache Storage, an activating worker
// cannot serve a page anything stale (the reason skipWaiting is risky elsewhere).
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

function urlB64ToUint8Array(base64url) {
    const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
    const b64 = (base64url + pad).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

// Stash the notified session for the iOS killed-PWA cold-launch path. When iOS
// has KILLED the installed PWA (not merely backgrounded), tapping the
// notification cold-launches it at start_url WITHOUT the hash and does NOT fire
// notificationclick — so neither the postMessage switch nor openWindow('/#'+s)
// can route it. The push handler DOES run in the background (it must, to show
// the notification), so it saves the session here; the page reads+consumes it at
// boot to land on the right session. Best-effort: never blocks or breaks
// showNotification (iOS revokes notification permission if a push shows nothing).
// Contract with index.html: db 'tl-notif', store 'pending', key 'last', value
// { session, ts, tapped }. Only real awaiting/done pushes carry a session; the
// session-less /push/test payload is skipped so a test push never stashes.
//
// `tapped` says WHICH of the two writers left the record, and boot trusts them
// differently. A push-time write (tapped:false) is a GUESS — the user may never
// tap it — so boot honours it only for a couple of minutes. A click-time write
// (tapped:true, from notificationclick below) is an explicit intent, so boot
// honours it far longer: the launch it belongs to may be seconds away, and
// landing on the session the user actually tapped is the whole point.
function stashPendingSession(session, tapped) {
    return new Promise((resolve) => {
        let req;
        try { req = indexedDB.open('tl-notif', 1); } catch (e) { resolve(); return; }
        req.onupgradeneeded = () => { try { req.result.createObjectStore('pending'); } catch (e) {} };
        req.onerror = () => resolve();
        req.onsuccess = () => {
            const db = req.result;
            try {
                const tx = db.transaction('pending', 'readwrite');
                tx.objectStore('pending').put({ session, ts: Date.now(), tapped: !!tapped }, 'last');
                // Resolve on complete/error/ABORT: a transaction can abort with
                // no preceding error (storage pressure, forced close), and an
                // unhandled abort would leave this Promise pending forever.
                tx.oncomplete = () => { try { db.close(); } catch (e) {} resolve(); };
                tx.onerror = () => { try { db.close(); } catch (e) {} resolve(); };
                tx.onabort = () => { try { db.close(); } catch (e) {} resolve(); };
            } catch (e) { try { db.close(); } catch (e2) {} resolve(); }
        };
    });
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
    event.waitUntil((async () => {
        // Show the notification and stash the session CONCURRENTLY. iOS revokes
        // notification permission if a push handler shows nothing, so the stash
        // (best-effort, for the killed-PWA cold-launch handoff) must NEVER gate
        // or delay showNotification — kick both off and allSettled so a stalled
        // or aborted stash can't hold up (or reject away) the notification.
        const tasks = [self.registration.showNotification(title, options)];
        if (data.session) tasks.push(stashPendingSession(data.session, false));
        await Promise.allSettled(tasks);
    })());
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    // A real awaiting/done push always carries data.session; the /push/test
    // payload deliberately carries Session:'' so a test tap only FOCUSES the app
    // (it must never switch, nor conjure a 'main' session). So do NOT default to
    // 'main' here — an empty/absent session means "focus only".
    const session = event.notification.data && event.notification.data.session;
    event.waitUntil((async () => {
        // Bring the app to the foreground AND switch it to the notified session.
        // The old handler only did focus()+return, so on a resident mobile PWA —
        // where a window is almost always open — the tap foregrounded the app on
        // whatever session was last shown and never switched: the "resident-PWA
        // focus-without-switch" bug this fixes. The switch is delivered by
        // postMessage to the page's navigator.serviceWorker 'message' listener,
        // NOT WindowClient.navigate(): navigate() needs a CONTROLLED client
        // (rejects on the uncontrolled windows matchAll surfaces right after a
        // fresh SW register/update), has inconsistent hash-fragment semantics
        // (esp. WebKit/iOS), and can reload — tearing down the live terminal
        // iframe + WebSocket. postMessage reaches the page even on an
        // uncontrolled client and even if focus() rejects, and on iOS standalone
        // it is the ONLY reliable warm-path switch (openWindow drops the hash).
        //
        // Target a LOBBY window specifically. The terminal and the docked shell
        // are same-origin '/?arg=<name>' iframes (and a deep-linked terminal can
        // be a top-level '/?arg=' tab) that ALSO surface as window clients but
        // have neither the message listener nor activateSession — both are
        // lobby-only. matchAll returns those nested frames too, and the user is
        // usually viewing a terminal when they background the app, so posting to
        // the first client would hit the terminal and the switch would silently
        // die. Skip any client whose URL carries ?arg=; post to the first (most
        // recently focused) lobby window only — posting to all would hijack every
        // open window onto this session.
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of wins) {
            if (!('focus' in c)) continue;
            // A client is the lobby UNLESS its URL is a real terminal —
            // '/?arg=<valid session name>'. This mirrors the page's own
            // lobby/terminal split (index.html: validArg = arg && NAME_RE.test),
            // so a top-level page carrying a malformed ?arg= still counts as the
            // lobby (and thus can receive the switch).
            let isLobby = true;
            try {
                const arg = new URL(c.url).searchParams.get('arg');
                isLobby = !(arg && /^[a-zA-Z0-9_-]{1,32}$/.test(arg));
            } catch (e) { /* unparseable → treat as lobby */ }
            if (!isLobby) continue;
            try { await c.focus(); } catch (e) { /* switch below regardless — focus() can reject (InvalidAccessError) and is moot for foregrounding on iOS */ }
            if (session) c.postMessage({ type: 'tl-activate-session', session });
            return;
        }
        // No lobby window open — cold start (or only a bare terminal tab). Carry
        // the session in the hash so boot-hash activation attaches it on load; a
        // session-less test tap just opens the lobby. (On iOS a KILLED PWA
        // cold-launches at start_url and can drop this hash — a documented WebKit
        // limitation, not fixable from the click handler.)
        //
        // Re-stash, marked as a tap: this is the branch where the hash can be
        // dropped, and the record left at push time may by now be minutes old and
        // no longer trusted by boot. openWindow is called FIRST and the stash
        // started immediately after — never the other way round: openWindow needs
        // the click's transient activation, which awaiting an IndexedDB write
        // could spend. The write still lands long before a launching page can
        // parse the app and read it. Best-effort throughout (allSettled).
        const opening = self.clients.openWindow
            ? self.clients.openWindow(session ? '/#' + session : '/')
            : Promise.resolve();
        if (session) {
            await Promise.allSettled([stashPendingSession(session, true), opening]);
        } else {
            await opening;
        }
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
