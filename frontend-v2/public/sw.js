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
// Push payload (JSON): { title, body, tag: 'tl-<session>', session, badge,
// waiting: { a: [names awaiting], d: [names done] } }.
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
// Contract with pwa/register.ts: db 'tl-notif', store 'pending', ONE RECORD PER
// SESSION keyed by the session name, value { session, ts, tapped }. It was a
// single 'last' slot, and with several notifications outstanding each push
// overwrote the one before it — so tapping the oldest banner routed to the
// newest push's session, or did nothing when that was the session already on
// screen. Measured on Viktor's phone 2026-09-02: three pushes inside 80 s, a
// tap, and a read of `already` because the slot held the session he was on.
// 'last' is still written so a page from an older deploy keeps working.
// Only real awaiting/done pushes carry a session; the session-less /push/test
// payload is skipped so a test push never stashes.
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
                const rec = { session, ts: Date.now(), tapped: !!tapped };
                const store = tx.objectStore('pending');
                // Per-session, so concurrent notifications cannot erase each
                // other, plus the legacy slot for an older page.
                store.put(rec, session);
                store.put(rec, 'last');
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

// Paint the app-icon badge — the count of sessions waiting for the user, drawn
// on the installed app's icon the way an unread count is.
//
// The worker is the writer while no lobby is on screen, which is the case the
// badge exists for. It does NOT trust a server-side total: the server cannot
// know which finished sessions the user has already looked at, so a total
// counted every one of them and any push reset the icon upward. It takes the
// NAMED set from the payload and subtracts what this device has shown
// (badgeFromWaiting, over the IndexedDB store/visits.ts mirrors), arriving at
// the number notify/appbadge.ts would have drawn. See ADR-0015.
//
// Best-effort and silent, like the page's copy: the Badging API is absent on
// most browsers and REJECTS where it exists but the app is not installed.
// The finished sessions this DEVICE has already shown the user.
//
// Written by store/visits.ts (db 'tl-badge', store 'seen', key 'done') whenever
// the unseen set changes. The worker cannot read localStorage, so this is the
// only way it can know what the page knows. An empty answer is the honest
// default: every finished session then counts, which is a number that is too big
// rather than a number that moves under the user.
function readSeenDone() {
    return new Promise((resolve) => {
        let req;
        try { req = indexedDB.open('tl-badge', 1); } catch (e) { resolve([]); return; }
        // Never CREATE the store here: if the page has not written yet there is
        // nothing to read, and an upgrade from the worker would race the page.
        req.onupgradeneeded = () => { try { req.result.createObjectStore('seen'); } catch (e) {} };
        req.onerror = () => resolve([]);
        req.onsuccess = () => {
            const db = req.result;
            try {
                const tx = db.transaction('seen', 'readonly');
                const get = tx.objectStore('seen').get('done');
                const done = () => { try { db.close(); } catch (e) {} };
                tx.oncomplete = () => {
                    done();
                    const v = get.result;
                    resolve(v && Array.isArray(v.names) ? v.names : []);
                };
                tx.onerror = () => { done(); resolve([]); };
                tx.onabort = () => { done(); resolve([]); };
            } catch (e) { try { db.close(); } catch (e2) {} resolve([]); }
        };
    });
}

// How many sessions are waiting, from the named set the server sent minus what
// this device has already shown.
//
// `pushed` is the session this notification is ABOUT. It is dropped from the
// seen set: it just transitioned, so whatever the user read of it is stale and
// it is unread again by definition. That is the same rule the page applies, and
// it is why an already-read session finishing a second time still counts.
async function badgeFromWaiting(waiting, pushed) {
    const awaiting = Array.isArray(waiting.a) ? waiting.a : [];
    const finished = Array.isArray(waiting.d) ? waiting.d : [];
    const seen = new Set(await readSeenDone());
    if (pushed) seen.delete(pushed);
    let n = awaiting.length;
    for (const name of finished) if (!seen.has(name)) n++;
    return n;
}

// Is a lobby window on screen right now?
//
// If one is, the PAGE owns the icon: it has the visit store, so it knows which
// finished sessions you have already read, and the worker's number would paint
// over a smaller, better one. This is the difference the user reported as "once
// a new notification comes, the counter wrongly resets to a bigger number".
//
// The test is focused-or-visible rather than "a window exists". A backgrounded
// PWA is still a window client, and store/lobby.ts parks its poll while the page
// is hidden, so treating any open window as authoritative would leave the badge
// frozen on stale work. A stranded terminal frame is skipped for the same reason
// as in the tap handler: it is not the lobby.
async function lobbyOnScreen() {
    try {
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        return wins.some((c) =>
            !looksLikeTerminal(c.url) && (c.focused || c.visibilityState === 'visible'));
    } catch (e) {
        // Unknowable: assume nothing is on screen, so a real count still lands.
        return false;
    }
}

// paintBadge, but only when no lobby is on screen to do it better.
//
// `count` may be a number or a promise of one, so the caller can start the work
// without awaiting it ahead of showNotification.
async function badgeIfHidden(count) {
    if (await lobbyOnScreen()) return;
    await paintBadge(await count);
}

function paintBadge(count) {
    // Report the outcome. This is the one place the answer matters and the one
    // place nobody could see it: iOS may not expose the Badging API inside a
    // service worker at all, and the worker is the only writer while the app is
    // shut — which is the case the badge exists for. `unsupported` from here is
    // the finding, not a failure to handle.
    let kind = 'ok';
    try {
        const nav = self.navigator;
        if (!nav || !nav.setAppBadge || !nav.clearAppBadge) {
            return reportBadge('unsupported', count);
        }
        const done = count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge();
        return Promise.resolve(done)
            .then(() => reportBadge('ok', count))
            .catch(() => reportBadge('failed', count));
    } catch (e) {
        kind = 'failed';
        return reportBadge(kind, count);
    }
}

// One telemetry line for whether the icon could be drawn. Same intake and the
// same indifference to failure as reportStash.
function reportBadge(kind, count) {
    try {
        return fetch('/api/sessions/telemetry', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client: 'sw',
                build: 'sw',
                events: [{ name: 'notify.badge_set', attrs: { 'tl.kind': kind, 'tl.count': count } }]
            })
        }).then(() => {}).catch(() => {});
    } catch (e) {
        return Promise.resolve();
    }
}

// Report one fact the page can never see: did the tap record survive being
// written?
//
// This exists because the iOS cold-launch chain had no instrument and no trace.
// A killed PWA fires no notificationclick, so the tapped session reaches the app
// only through stashPendingSession — and if that write fails, every downstream
// fix is pointless and nothing anywhere says so. IndexedDB inside a service
// worker is exactly where a silent failure is plausible.
//
// A worker MAY fetch() from a push handler (that is a network request, not a
// navigation intercept — see the header). credentials:'same-origin' carries the
// ingress identity header, so this authenticates like the page does.
//
// Best-effort to the point of indifference: any failure resolves, because a
// missing telemetry line must never cost a notification.
function reportStash(session, ok) {
    try {
        return fetch('/api/sessions/telemetry', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client: 'sw',
                build: 'sw',
                events: [{
                    name: 'notify.stash_written',
                    attrs: { 'tl.session': session, 'tl.kind': ok ? 'ok' : 'fail' }
                }]
            })
        }).then(() => {}).catch(() => {});
    } catch (e) {
        return Promise.resolve();
    }
}

// Did the record actually land? stashPendingSession resolves on success AND on
// every failure it swallows, so it cannot answer this itself. Read the value
// back: that is the only claim worth reporting.
function verifyStash(session) {
    return new Promise((resolve) => {
        let req;
        try { req = indexedDB.open('tl-notif', 1); } catch (e) { resolve(false); return; }
        req.onupgradeneeded = () => { try { req.result.createObjectStore('pending'); } catch (e) {} };
        req.onerror = () => resolve(false);
        req.onsuccess = () => {
            const db = req.result;
            try {
                const tx = db.transaction('pending', 'readonly');
                const get = tx.objectStore('pending').get(session);
                const done = (v) => { try { db.close(); } catch (e) {} resolve(v); };
                tx.oncomplete = () => done(!!(get.result && get.result.session === session));
                tx.onerror = () => done(false);
                tx.onabort = () => done(false);
            } catch (e) { try { db.close(); } catch (e2) {} resolve(false); }
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
        if (data.session) {
            // Chain the report onto the write so it records the real outcome,
            // and keep BOTH off showNotification's path.
            tasks.push(
                stashPendingSession(data.session, false)
                    .then(() => verifyStash(data.session))
                    .then((ok) => reportStash(data.session, ok))
            );
        }
        // Same rule as the stash: the badge is a courtesy and must never gate or
        // delay showNotification (iOS revokes permission if a push shows nothing).
        // showNotification was CALLED on the line above, so its promise is
        // already in flight and the client lookup inside badgeIfHidden cannot
        // hold it up.
        // Prefer the NAMED set: it lets this device subtract what it has already
        // shown, so the number matches what the page would have drawn. `badge`
        // is the fallback for a payload over the name cap, and for a server that
        // predates `waiting`.
        if (data.waiting) {
            tasks.push(badgeIfHidden(badgeFromWaiting(data.waiting, data.session)));
        } else if (typeof data.badge === 'number') {
            tasks.push(badgeIfHidden(data.badge));
        }
        await Promise.allSettled(tasks);
    })());
});

// Is this client a stranded TERMINAL PAGE rather than the lobby?
//
// Tested POSITIVELY, and that direction is the point: the lobby is whatever is
// left over, so a page shape nobody anticipated still RECEIVES the switch
// instead of silently swallowing it.
//
// The lobby draws its own terminal now (2026-09-05), in the lobby's own
// document, so a client that is a terminal AND NOT a lobby can only be one
// thing: a tab still holding a pre-deletion lobby build, whose iframe is at
// '/term.html' or at the immutable '/assets/term-<hash>.html'. The hashed copy
// outlives the deploy — postinst prunes /usr/local/share/ttyd/assets with
// `-mtime +14` — so such a tab can keep a working terminal for up to a
// fortnight, and this is what keeps its notification taps routing to the lobby
// above it rather than into a frame with no message listener. Matching the
// PATHNAME alone is what covers it, since the framed attach passed its args out
// of band on iframe.name and left the URL bare.
//
// The '?arg=<name>' query is deliberately NOT matched. It was the second shape
// while a terminal could be deep-linked, and it is now a trap: the SPA carries
// its session in the HASH ('/#<name>'), so any lobby URL that ever picks up an
// '?arg=' — an old bookmark, or a server-side redirect off /term.html that
// preserved the query — would be classified as a terminal, dropped from the
// candidate list below, and the tap would stop switching session. Nothing the
// lobby serves puts 'arg' in its own query.
function looksLikeTerminal(url) {
    let u;
    try { u = new URL(url); } catch (e) { return false; }
    return /(^|\/)term(-[0-9a-f]+)?\.html$/.test(u.pathname);
}

// How long a client gets to say it took the switch.
const ACK_MS = 400;

// Hand the switch to one client and find out whether it LANDED.
//
// The page answers on the MessagePort sent with the message (pwa/register.ts),
// so a client that stays silent for ACK_MS is not a lobby, or is gone, and the
// next candidate gets its turn. Deciding which client is the lobby from its URL
// alone has now failed twice, both times because something unrelated changed a
// URL; the acknowledgement is what makes this self-correcting. A misjudged
// candidate costs ACK_MS, not a dead notification.
//
// A page too old to acknowledge still ACTS on the message — the listener has
// shipped since July and only the reply is new — so a false negative here
// re-posts to the other lobbies rather than losing the tap.
function deliver(client, session) {
    const msg = { type: 'tl-activate-session', session };
    return new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
        let ch = null;
        try { ch = new MessageChannel(); } catch (e) { ch = null; }
        if (!ch) { // no MessageChannel: post blind and assume nothing
            try { client.postMessage(msg); } catch (e) { /* client gone */ }
            finish(false);
            return;
        }
        ch.port1.onmessage = () => finish(true);
        try { client.postMessage(msg, [ch.port2]); } catch (e) { finish(false); return; }
        setTimeout(() => finish(false), ACK_MS);
    });
}

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    // A real awaiting/done push always carries data.session; the /push/test
    // payload deliberately carries Session:'' so a test tap only FOCUSES the app
    // (it must never switch, nor conjure a 'main' session). So do NOT default to
    // 'main' here — an empty/absent session means "focus only".
    const session = event.notification.data && event.notification.data.session;
    event.waitUntil((async () => {
        // Bring the app to the foreground AND switch it to the notified session.
        // A handler that only focused foregrounded a resident PWA on whatever
        // session was last shown and never switched — the original
        // "resident-PWA focus-without-switch" bug. The switch travels by
        // postMessage to the page's navigator.serviceWorker 'message' listener,
        // NOT WindowClient.navigate(): navigate() needs a CONTROLLED client
        // (it rejects on the uncontrolled windows matchAll surfaces right after
        // a fresh register/update), has inconsistent hash-fragment semantics on
        // WebKit, and can reload — tearing down the live terminal and its
        // WebSocket. postMessage reaches an uncontrolled client, survives a
        // rejected focus(), and on iOS standalone is the only reliable warm-path
        // switch, since openWindow drops the hash.
        const wins = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
            .filter((c) => 'focus' in c);
        // A tab still on a pre-deletion lobby build surfaces its terminal iframe
        // here too, and that frame has neither the message listener nor
        // activateSession — both are lobby-only.
        const lobbies = wins.filter((c) => !looksLikeTerminal(c.url));
        // A focused window before a background one: with several lobbies open,
        // the switch belongs to the one the user is actually looking at.
        lobbies.sort((a, b) => (a.focused ? 0 : 1) - (b.focused ? 0 : 1));

        if (lobbies.length) {
            try { await lobbies[0].focus(); } catch (e) { /* focus() can reject (InvalidAccessError) and is moot for foregrounding on iOS; the switch below still stands */ }
            if (!session) return; // test tap: foreground, never switch
            for (const c of lobbies) {
                if (await deliver(c, session)) return;
            }
            // Nobody acknowledged, but every lobby has now been posted to and an
            // older page half acts without replying. The app is already up, so
            // opening a second window on top of it would be the worse answer.
            return;
        }

        // No lobby open — a cold start, or only a stranded terminal frame. Carry the
        // session in the hash so boot-hash activation attaches it on load; a
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
