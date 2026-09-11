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
// Push payload: ONE JSON document, read two ways. See readPush below.
// Flat keys, which is all Chrome and Firefox ever see:
//   { title, body, tag: 'tl-<session>', session, badge,
//     waiting: { a: [names awaiting], d: [names done] } }
// plus, for iOS/iPadOS 18.4 and Safari 18.4, the Declarative Web Push envelope
// alongside them: { web_push: 8030, notification: { title, body,
// navigate, tag, app_badge, data: { session, waiting } } }. No "mutable" —
// see readPush for what sending it cost.
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

// The per-installation telemetry id, mirrored where a worker can reach it.
//
// The page mints it once (16 random bytes of hex) and keeps it in localStorage,
// which a service worker cannot read, so telemetry/device.ts also writes it to
// db 'tl-device', store 'meta', key 'id'. Same page-writes/worker-reads
// shape as tl-badge. A separate database from tl-notif on purpose: the worker
// opens tl-notif at version 1, and a new store there would need a version bump
// that this worker's open would then fail, taking the tap stash with it.
//
// Null means the page has not mirrored yet. OMIT the attribute in that case
// rather than minting an id here, which would split one device into two series.
function readDeviceId() {
    return new Promise((resolve) => {
        let req;
        try { req = indexedDB.open('tl-device', 1); } catch (e) { resolve(null); return; }
        // Never CREATE the store from the worker, for the same reason as
        // readSeenDone: an upgrade here would race the page's own write.
        req.onupgradeneeded = () => { try { req.result.createObjectStore('meta'); } catch (e) {} };
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
            const db = req.result;
            try {
                const tx = db.transaction('meta', 'readonly');
                const get = tx.objectStore('meta').get('id');
                const done = (v) => { try { db.close(); } catch (e) {} resolve(v); };
                tx.oncomplete = () => done(typeof get.result === 'string' ? get.result : null);
                tx.onerror = () => done(null);
                tx.onabort = () => done(null);
            } catch (e) { try { db.close(); } catch (e2) {} resolve(null); }
        };
    });
}

// The one place the worker talks to the telemetry intake.
//
// A worker MAY fetch() from a push or click handler (that is a network request,
// not a navigation intercept, see the header). credentials:'same-origin'
// carries the ingress identity header, so this authenticates like the page does.
//
// Every event is stamped with the same tl.device the page stamps, which is what
// lets a stash written here be joined to the read that consumed it in the app:
// without a device dimension one person's phone and laptop are one series.
//
// Best-effort to the point of indifference: any failure resolves, because a
// missing telemetry line must never cost a notification.
function postEvents(events) {
    try {
        return readDeviceId()
            .then((device) => {
                if (device) for (const ev of events) ev.attrs['tl.device'] = device;
                return fetch('/api/sessions/telemetry', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ client: 'sw', build: 'sw', events })
                });
            })
            .then(() => {})
            .catch(() => {});
    } catch (e) {
        return Promise.resolve();
    }
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

// One telemetry line for whether the icon could be drawn.
function reportBadge(kind, count) {
    return postEvents([{ name: 'notify.badge_set', attrs: { 'tl.kind': kind, 'tl.count': count } }]);
}

// Report one fact the page can never see: did the tap record survive being
// written?
//
// This exists because the iOS cold-launch chain had no instrument and no trace.
// A killed PWA fires no notificationclick, so the tapped session reaches the app
// only through stashPendingSession — and if that write fails, every downstream
// fix is pointless and nothing anywhere says so. IndexedDB inside a service
// worker is exactly where a silent failure is plausible.
function reportStash(session, ok) {
    return postEvents([{
        name: 'notify.stash_written',
        attrs: { 'tl.session': session, 'tl.kind': ok ? 'ok' : 'fail' }
    }]);
}

// Report which arm the tap took.
//
// The click handler emitted nothing at all, so the only instrument on this path
// was the page's notify.stash_read, which by construction cannot see a tap that
// never reached a page, and that is the failure being fixed here.
//
// tl.kind is one value per arm: 'acked' (a lobby answered the switch), 'posted'
// (every lobby was posted to and none answered inside ACK_MS), 'opened' (no
// lobby was open, so openWindow was called), 'focused' (a session-less test tap,
// foreground only), 'failed' (the chosen arm could not be carried out).
// tl.count is how many window clients matchAll returned. A session-less tap
// omits tl.session rather than sending an empty one.
function reportTap(session, kind, count) {
    const attrs = { 'tl.kind': kind, 'tl.count': count };
    if (session) attrs['tl.session'] = session;
    return postEvents([{ name: 'notify.tap', attrs }]);
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

// One payload, two deliveries, normalised here so nothing below has to know
// which browser it is running on.
//
// Chrome and Firefox do not implement Declarative Web Push at all. They hand
// the whole JSON document to the push event untouched, so event.data.json()
// still yields the flat { title, body, tag, session, badge, waiting } the server
// has always sent, with the declarative envelope sitting alongside as keys they
// ignore.
//
// iOS/iPadOS 18.4 and Safari 18.4 parse the SAME document declaratively (the
// top-level "web_push": 8030 marker) and, with no "mutable" member, draw the
// banner themselves WITHOUT starting this worker. So on iOS the branch below
// normally does not run at all; it stays because an engine that does start a
// worker for a declarative message hands the payload over as event.notification
// with event.data NULL, and reading it costs nothing.
//
// The server used to send "mutable": true to keep this worker in the loop for
// ADR-0015's device-side badge subtraction. That is not what the member means:
// true tells WebKit a REPLACEMENT banner is coming from the worker, and WebKit
// then shows nothing of its own while it waits. The branch below deliberately
// draws no replacement, so between 2026-09-08 and 2026-09-10 Viktor's iPhone
// displayed none of the 58 pushes Apple accepted with a 201. The badge now
// falls back to the payload's app_badge, which is the trade the banner is worth.
//
// event.data is the discriminator rather than the presence of event.notification:
// when the JSON we control is readable, read that.
//
// event.data is the discriminator rather than the presence of event.notification:
// when the JSON we control is readable, read that.
function readPush(event) {
    if (!event.data && event.notification) {
        const n = event.notification;
        const d = n.data && typeof n.data === 'object' ? n.data : {};
        return {
            declarative: true,
            title: n.title || 'Terminal',
            body: n.body || '',
            tag: n.tag || 'tl',
            session: d.session || null,
            waiting: d.waiting || null,
            // app_badge is a sibling of title in the JSON, but WebKit does not
            // put it on the Notification it builds: a Notification carries
            // title, body, tag and data, and the count is exposed on the EVENT
            // instead, as PushEvent.appBadge (WebKit IDL, gated on the
            // DeclarativeWebPush setting). Reading n.app_badge alone found
            // undefined every time and silently dropped the fallback. The
            // payload-shaped read stays behind it because it costs nothing and
            // a future engine may hand the value over that way.
            // Absent leaves the icon unchanged; 0 clears it.
            badge: typeof event.appBadge === 'number'
                ? event.appBadge
                : (typeof n.app_badge === 'number' ? n.app_badge : null)
        };
    }
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
    return {
        declarative: false,
        title: data.title || 'Terminal',
        body: data.body || '',
        tag: data.tag || 'tl',
        session: data.session || null,
        waiting: data.waiting || null,
        badge: typeof data.badge === 'number' ? data.badge : null
    };
}

self.addEventListener('push', (event) => {
    const p = readPush(event);
    event.waitUntil((async () => {
        // Show the notification and stash the session CONCURRENTLY. iOS revokes
        // notification permission if a push handler shows nothing, so the stash
        // (best-effort, for the killed-PWA cold-launch handoff) must NEVER gate
        // or delay showNotification — kick both off and allSettled so a stalled
        // or aborted stash can't hold up (or reject away) the notification.
        const tasks = [];
        if (!p.declarative) {
            // Chrome REQUIRES a notification from every push handler, or it
            // shows its own "site updated in background" notice instead.
            tasks.push(self.registration.showNotification(p.title, {
                body: p.body,
                tag: p.tag,
                icon: '/icon-192.png',
                data: { session: p.session }
            }));
        }
        // Nothing to show on the declarative path: WebKit drew the banner from
        // the payload before this worker was considered, and a showNotification
        // here would REPLACE it — which needs its own valid ABSOLUTE navigate in
        // the options or WebKit throws TypeError, losing the notification and
        // with it the permission. The routing it would have set up travels by
        // the payload's navigate URL instead (notificationclick is never
        // dispatched on the declarative path). This is also why the server must
        // not send "mutable": promising a replacement from here and then drawing
        // none is a push that displays nothing at all.
        if (p.session) {
            // Chain the report onto the write so it records the real outcome,
            // and keep BOTH off showNotification's path.
            tasks.push(
                stashPendingSession(p.session, false)
                    .then(() => verifyStash(p.session))
                    .then((ok) => reportStash(p.session, ok))
            );
        }
        // Same rule as the stash: the badge is a courtesy and must never gate or
        // delay showNotification (iOS revokes permission if a push shows nothing).
        // showNotification was CALLED above, so its promise is already in flight
        // and the client lookup inside badgeIfHidden cannot hold it up.
        // Prefer the NAMED set: it lets this device subtract what it has already
        // shown, so the number matches what the page would have drawn. `badge`
        // is the fallback for a payload over the name cap, for a server that
        // predates `waiting`, and on the declarative path for app_badge.
        // setAppBadge called during the event overrides the payload's app_badge,
        // which is the point: WebKit's number has not had this device's seen set
        // subtracted from it.
        if (p.waiting) {
            tasks.push(badgeIfHidden(badgeFromWaiting(p.waiting, p.session)));
        } else if (p.badge !== null) {
            tasks.push(badgeIfHidden(p.badge));
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
//
// Kept at 400 ms now that a missed acknowledgement is no longer fatal (every
// branch below writes a tap record). Lengthening it would not help the case it
// looks like it should: on iOS the page is not running JS when
// clients.matchAll() resolves, and postMessage to a waking client is DROPPED
// rather than queued (WebKit bug 268797), so no amount of waiting produces a
// reply. It would only add latency per candidate on the browsers that do reply.
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

// notificationclick fires on Chrome, on Android, and on Apple devices below
// iOS/iPadOS 18.4. It is NEVER dispatched on the declarative path: the
// Notifications spec (2.7 steps 5 and 6) says a notification with a navigation
// URL navigates on activation and returns, so on a current iPhone the routing
// happens entirely through the payload's absolute `navigate` URL and this
// handler never runs. It stays for everything else.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    // A real awaiting/done push always carries data.session; the /push/test
    // payload deliberately carries Session:'' so a test tap only FOCUSES the app
    // (it must never switch, nor conjure a 'main' session). So do NOT default to
    // 'main' here — an empty/absent session means "focus only".
    const session = event.notification.data && event.notification.data.session;
    event.waitUntil((async () => {
        // ALWAYS leave a tap record, in every branch, started before any routing.
        //
        // This is the fix for the tap that vanished. Over 7 days of the deployed
        // build, 376 of 795 notify.stash_read reads came back `absent`, with no
        // record at all, and this handler is why: when window clients existed it
        // posted the switch, waited ACK_MS for a reply nobody was awake to send
        // (WebKit bug 268797), and returned having written nothing. The tap left
        // no trace anywhere.
        //
        // STARTED, not awaited: openWindow below needs the click's transient
        // activation, and awaiting an IndexedDB write could spend it. The write
        // still lands long before a launching page can parse the app and read it.
        //
        // Harmless on the paths that already worked: the page consumes the
        // session's record when it acts on the switch message (pwa/register.ts),
        // so a tap that DID land warm cannot route a second time.
        const stashed = session ? stashPendingSession(session, true) : Promise.resolve();
        // 'failed' until an arm completes, so an unexpected throw is reported as
        // what it is rather than as a routed tap.
        let kind = 'failed';
        let count = 0;
        try {
            // Bring the app to the foreground AND switch it to the notified
            // session. A handler that only focused foregrounded a resident PWA on
            // whatever session was last shown and never switched — the original
            // "resident-PWA focus-without-switch" bug. The switch travels by
            // postMessage to the page's navigator.serviceWorker 'message'
            // listener, NOT WindowClient.navigate(): navigate() needs a
            // CONTROLLED client (it rejects on the uncontrolled windows matchAll
            // surfaces right after a fresh register/update), has inconsistent
            // hash-fragment semantics on WebKit, and can reload — tearing down the
            // live terminal and its WebSocket. postMessage reaches an
            // uncontrolled client, survives a rejected focus(), and on iOS
            // standalone is the only reliable warm-path switch, since openWindow
            // drops the hash.
            const wins = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
                .filter((c) => 'focus' in c);
            count = wins.length;
            // A tab still on a pre-deletion lobby build surfaces its terminal
            // iframe here too, and that frame has neither the message listener nor
            // activateSession — both are lobby-only.
            const lobbies = wins.filter((c) => !looksLikeTerminal(c.url));
            // A focused window before a background one: with several lobbies open,
            // the switch belongs to the one the user is actually looking at.
            lobbies.sort((a, b) => (a.focused ? 0 : 1) - (b.focused ? 0 : 1));

            if (lobbies.length) {
                try { await lobbies[0].focus(); } catch (e) { /* focus() can reject (InvalidAccessError) and is moot for foregrounding on iOS; the switch below still stands */ }
                if (!session) {
                    kind = 'focused'; // test tap: foreground, never switch
                } else {
                    // Nobody acknowledging is the NORMAL iPhone case, not a
                    // failure: every lobby has been posted to, an older page half
                    // acts without replying, and the record above covers the rest.
                    // The app is already up, so opening a second window on top of
                    // it would be the worse answer.
                    kind = 'posted';
                    for (const c of lobbies) {
                        if (await deliver(c, session)) { kind = 'acked'; break; }
                    }
                }
            } else {
                // No lobby open — a cold start, or only a stranded terminal frame.
                // Carry the session in the hash so boot-hash activation attaches it
                // on load; a session-less test tap just opens the lobby. (On iOS a
                // KILLED PWA cold-launches at start_url and can drop this hash — a
                // documented WebKit limitation, not fixable from the click handler,
                // and the reason the record above matters most here.)
                if (self.clients.openWindow) {
                    kind = 'opened';
                    await self.clients.openWindow(session ? '/#' + session : '/');
                }
            }
        } catch (e) {
            kind = 'failed';
        }
        // Best-effort tail: neither the record nor the report may reject away the
        // routing that has already happened.
        await Promise.allSettled([stashed, reportTap(session, kind, count)]);
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
            const body = sub.toJSON ? sub.toJSON() : sub;
            // Send the origin too. The server records it per subscription so it
            // can build the ABSOLUTE `navigate` URL Declarative Web Push
            // requires: WebKit parses that URL with no base, so a relative one is
            // a SyntaxError and the whole message is dropped, banner and all. A
            // rotation mints a NEW endpoint, so the store's same-endpoint
            // preservation does not cover it. Without this line the rotated
            // device silently drops back to the flat payload and stops routing
            // taps on iOS.
            //
            // https ONLY, the same test pwa/push.ts secureOrigin applies. The
            // server validates this field strictly (push.go validatePushOrigin)
            // and 400s anything else, which would take the whole subscription
            // PUT with it. http://localhost and http://127.0.0.1 are secure
            // contexts, so a worker DOES run there and a rotation there must
            // still re-subscribe; it simply keeps the flat payload.
            try {
                const loc = self.location;
                if (loc && loc.protocol === 'https:' && loc.origin) body.origin = loc.origin;
            } catch (e) { /* no origin: the server falls back to the flat payload */ }
            const stored = await fetch(PUSH_SUBS_API, {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            // Nothing is retired until the replacement is actually stored. A
            // rejected PUT with the DELETE still running leaves the device with
            // no subscription at all and no background push until someone opens
            // the app; the old endpoint is the one thing still working, and the
            // server prunes it on its own next 404/410 anyway.
            if (!stored || !stored.ok) return;
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
