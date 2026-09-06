/**
 * The notification system (inventory Cat.9) — the Solid integration layer that
 * wires the pure modules (transitions / favicon / title / attention) and the PWA
 * modules (register / push / fire) into the running app. Created once by App.
 *
 * Responsibilities:
 *   - register the push service worker + consume the iOS killed-PWA stash at boot;
 *   - self-heal the background push subscription on load (idempotent);
 *   - own the bell toggle (the ONLY Notification.requestPermission site) and its
 *     opt-in/permission state;
 *   - fire foreground OS notifications on each poll's running→awaiting /
 *     running→done transitions (gated by opt-in + permission + roamed prefs + the
 *     per-session away gate — and skipped entirely on a device the server pushes
 *     to, which is the single notifier there);
 *   - tell the server which session THIS device has on screen (notify/focus.ts),
 *     which is how the server applies the same per-session rule to the pushes it
 *     sends, per device rather than per person;
 *   - repaint the tab title + favicon badge from the session list and the
 *     attention latch (the terminal's bell/output signals, cleared on
 *     visibility/focus return);
 *   - expose the settings readouts (permission / subscribed-here) + test actions.
 *
 * Everything push/notification-related is BEST-EFFORT: a dark server (vapid 404),
 * a browser without SW/PushManager, or a denied permission all degrade quietly.
 */
import { createSignal, createEffect, onCleanup, onMount, untrack, type Accessor } from "solid-js";
import {
  applyAttentionSignal,
  clearAttention,
  emptyAttention,
  type AttentionState,
} from "./attention";
import { createFaviconBadger, faviconKind } from "./favicon";
import { composeTitle, type TitleSession } from "./title";
import { applyAppBadge, waitingCount } from "./appbadge";
import { createVisitStore } from "../store/visits";
import { computeTransitions, snapshotStates, type StateMap } from "./transitions";
import { fireNotification } from "./fire";
import { sessionConfirmLabel } from "../types/lobby";
import { notifyOptedIn, setNotifyOptIn } from "./opt-in";
import {
  clearPendingSessions,
  displayedTags,
  navigatedSession,
  readPendingSessions,
  registerServiceWorker,
} from "../pwa/register";
import { pickTap, spentSessions, type StoredRecord, type TapReason } from "../pwa/tap";
import {
  deviceSubscriptionState,
  reportFocus,
  subscribePush,
  testAllDevices,
  unsubscribePush,
  type DeviceSubscriptionState,
} from "../pwa/push";
import { FOCUS_TICK_MS, focusedSession, shouldReport, type FocusReport } from "./focus";
import { track } from "../telemetry/track";
import { ACT_AS } from "../lib/config";

type ToastKind = "info" | "error" | "warning" | "success";
type ToastFn = (message: string, kind: ToastKind) => void;

/** How the header bell should present on this device. */
export type BellMode = "toggle" | "install-hint" | "hidden";

export interface NotificationSystemOptions {
  /** the full poll session list (own + foreign) as a plain snapshot. */
  sessions: Accessor<readonly TitleSession[]>;
  /** the active session name, or null. */
  selected: Accessor<string | null>;
  /** OS user, for the title body fallback. */
  osUser: Accessor<string>;
  /** roamed notify prefs (both default true). */
  notifyPrefs: Accessor<{ onDone: boolean; onAwaiting: boolean }>;
  /** true until the first /sessions poll lands (so the seed isn't the pre-poll empty). */
  loading: Accessor<boolean>;
  /**
   * How many polls have RETURNED a list (store.polls). `loading` cannot stand in
   * for this: it goes false even when /sessions rejected, so a failed first poll
   * looks the same as an empty account. Zero here means the list is not an
   * answer yet and nothing may be derived from it.
   *
   * It also ticks on an unchanged payload, which is what lets the badge repaint
   * every poll instead of only when a session actually changes.
   */
  polls?: Accessor<number>;
  /** surface a message to the app's toast stack. */
  toast: ToastFn;
  /** switch the app to a session (SW tap / boot stash / constructor click). */
  onActivateSession: (session: string) => void;
  /**
   * Override the unseen-done predicate behind the title/favicon badges. Default:
   * the visit store this system owns (store/visits.ts) — the badge counts the
   * sessions that finished since you last looked at them, so viewing one clears
   * it. Injected only by tests.
   */
  isUnseen?: (s: TitleSession) => boolean;
}

export interface NotificationSystem {
  /** how the bell should render (computed once for this device). */
  bellMode: BellMode;
  /** whether the bell is lit (opted in AND permission granted). */
  bellOn: Accessor<boolean>;
  /** the bell button's title/tooltip. */
  bellTitle: Accessor<string>;
  /** toggle notifications on/off (requests permission when turning on). */
  toggleBell: () => Promise<void>;
  /** the iOS "Add to Home Screen" guidance (bellMode === 'install-hint'). */
  showInstallHint: () => void;
  /** from the terminal: a bell, or output while nobody could see it. */
  onTerminalAttention: (kind: "bell" | "output", session: string | null) => void;
  /** current OS permission (settings readout). */
  permission: Accessor<NotificationPermission | "unsupported">;
  /** whether this device is registered for background push on the server. */
  deviceState: Accessor<DeviceSubscriptionState | "checking">;
  /** re-run the self-diagnosis (settings panel opens). */
  refreshDeviceState: () => Promise<void>;
  /** show a local notification to exercise the browser→OS chain. */
  testHere: () => Promise<void>;
  /** fan a real push to every registered device (server). */
  testAll: () => Promise<void>;
  /**
   * Has this session finished since you last looked at it?
   *
   * The sidebar's own answer to the number on the app icon: the badge counts
   * this set, so the list has to be able to point at its members. It reads
   * `revision` INTERNALLY, which is what makes a caller in JSX repaint when the
   * set changes — a visit that clears unseen usually moves nothing else, so a
   * card reading a plain predicate would sit at its mount value. No loop:
   * `revision` bumps only when the unseen set actually changes.
   */
  isUnseen: (s: TitleSession) => boolean;
  dispose: () => void;
}

/** How stale a push-delivery answer may get before a foregrounded tab re-checks. */
const PUSH_RECHECK_MS = 5 * 60 * 1000;

const hasDoc = typeof document !== "undefined";
const hasWin = typeof window !== "undefined";
const hasNav = typeof navigator !== "undefined";
const hasNotificationApi = typeof Notification !== "undefined";

/** document.hidden || !document.hasFocus() — the away gate. */
function away(): boolean {
  return hasDoc && (document.hidden || !document.hasFocus());
}

function computeBellMode(): BellMode {
  if (hasNotificationApi) return "toggle";
  if (!hasNav) return "hidden";
  const iOS =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const nav = navigator as Navigator & { standalone?: boolean };
  const standalone =
    (hasWin && window.matchMedia?.("(display-mode: standalone)").matches) ||
    nav.standalone === true;
  if (iOS && !standalone && !(hasWin && "PushManager" in window)) {
    return "install-hint";
  }
  return "hidden";
}

export function createNotificationSystem(opts: NotificationSystemOptions): NotificationSystem {
  const bellMode = computeBellMode();

  const [optedIn, setOptedIn] = createSignal(notifyOptedIn());
  const [permission, setPermission] = createSignal<NotificationPermission | "unsupported">(
    hasNotificationApi ? Notification.permission : "unsupported",
  );
  const [attention, setAttention] = createSignal<AttentionState>(emptyAttention);
  const [deviceState, setDeviceState] = createSignal<DeviceSubscriptionState | "checking">(
    "checking",
  );

  // Is the SERVER notifying this device (a subscription it has actually stored)?
  // While true the page fires NO OS notifications — the server push is the single
  // alert per edge (transitions.ts `pushDelivers`, Viktor's duplicate-banner fix).
  // Server-CONFIRMED, not merely "the browser has a subscription": an endpoint the
  // server pruned or never received would otherwise silence the page with nothing
  // taking its place. Resolved asynchronously — false until the first check lands,
  // which is safe because the first poll after load seeds quietly anyway.
  const [pushDelivers, setPushDelivers] = createSignal(false);
  let lastPushCheck = 0;
  const syncPushDelivery = async (): Promise<void> => {
    lastPushCheck = Date.now();
    setPushDelivers((await deviceSubscriptionState()) === "yes");
  };

  // ---- tell the server what this device is showing -----------------------
  // So the push sender can withhold the session on screen from THIS device and
  // still tell every other one (notify/focus.ts has the why). Only a device the
  // server actually pushes to has anything to report.
  let lastFocus: FocusReport | null = null;
  let focusInFlight = false;
  // Something moved while a report was in the air. One request at a time keeps
  // two POSTs from landing out of order and leaving the server holding the
  // session you just left — but dropping the newer one would do exactly that
  // for a whole tick, so it is deferred rather than lost.
  let focusMovedAgain = false;
  const reportFocusNow = (selected: string | null): void => {
    if (!untrack(pushDelivers)) return;
    if (focusInFlight) {
      focusMovedAgain = true;
      return;
    }
    const next = focusedSession({
      visible: !hasDoc || !document.hidden,
      focused: !hasDoc || document.hasFocus(),
      selected,
    });
    const now = Date.now();
    if (!shouldReport(lastFocus, next, now)) return;
    focusInFlight = true;
    void reportFocus(next).then((ok) => {
      focusInFlight = false;
      // Only a report the server took counts as said. A failed one leaves the
      // record alone so the next tick tries again rather than believing it.
      if (ok) lastFocus = { session: next, at: now };
      if (focusMovedAgain) {
        focusMovedAgain = false;
        reportFocusNow(untrack(opts.selected));
      }
    });
  };

  const bellOn = () => optedIn() && permission() === "granted";
  const bellTitle = () =>
    bellOn()
      ? "Notifying you when Claude finishes or needs input on this device (click to disable). Enable on each device you want pushes on."
      : "Notify me when Claude finishes or needs input. Per device + browser — enable on each device you want notified.";

  // ---- service worker + notification-tap handoff -------------------------
  // The WARM tap (app resident, sw.js postMessage) is tracked here rather than in
  // the SW: a service worker cannot reach the telemetry batcher, and without this
  // event "did my tap land on the right session?" was unanswerable from the
  // journal — the cold/stash path below has always emitted it.
  // A tab acting as someone else takes NEITHER handoff. Push subscriptions
  // resolve the real caller (that carve-out is what keeps a lens from enrolling
  // this browser as one of their devices), so every notification names one of
  // YOUR sessions — and opening your session name inside a lens opens it under
  // THEIR identity. Your own tab still receives the tap; the cold stash is left
  // unread rather than cleared so it is still there for it.
  const lens = ACT_AS !== "";

  const sw = registerServiceWorker({
    onActivateSession: (name) => {
      // Refusing rather than swallowing: the worker takes silence as "not a
      // lobby" and posts the switch to the next window, and the record stays
      // put for the reader's own tab to route on.
      if (lens) return false;
      track("notify.clicked", { "tl.session": name });
      opts.onActivateSession(name);
      return true;
    },
  });
  onCleanup(() => sw.dispose());

  // Boot landing: iOS cold-launches a KILLED PWA without firing
  // notificationclick, so the tapped session arrives only as the stash sw.js
  // wrote at push time. Consume it and land there.
  //
  // It used to defer to any selection the URL already carried, which sounded
  // careful and was the bug Viktor reported on 2026-09-02: an installed PWA does
  // NOT reliably come back on start_url. iOS restores it at the URL it was last
  // showing, so `selected()` was the session he had been reading BEFORE the
  // notification, the stash was discarded, and the tap landed him back where he
  // already was. Reproduced: notification for `issues`, restored at
  // `trip-casia`, landed on `trip-casia`.
  //
  // So the stash wins. `pickTap` (pwa/tap.ts) is the only authority on whether
  // it is worth acting on, and it is tight — a push-time receipt counts for two
  // minutes on its own, an older one only once its banner has gone, which on
  // iOS means it was tapped or dismissed. The tap is why the app is opening; a
  // restored URL is not intent. This also makes the cold path agree with the
  // warm one, where the postMessage switch has always overridden whatever was
  // on screen.
  //
  // The trade-off, stated: deliberately opening a deep link to session B within
  // that window of a push about session A lands on A. One tap corrects it, and
  // the stash is consumed, so it cannot happen twice.
  //
  // Every branch reports. This chain has broken four times, on a platform with
  // no instrument on this network, and each fix was a guess because a rejected
  // tap looked exactly like no tap at all. `notify.stash_read` plus the worker's
  // `notify.stash_written` make the whole path answerable from the journal:
  // no written → the record never survived; written but `stale` → the age gate;
  // written and nothing read → boot never ran; `acted` → it worked.
  //
  // Called at BOOT and again on every return to the foreground. The second
  // caller is the one that matters on iOS, and it is why four earlier fixes all
  // missed. Measured on Viktor's phone, 2026-09-02: tapping a notification for
  // an already-running PWA FOREGROUNDS it without firing notificationclick and
  // without reloading it. So the warm path has no event to act on, the cold path
  // has no boot to run in, and the app simply comes to the front on whatever it
  // was already showing.
  //
  // The journal is what settled it: his taps produced neither notify.clicked nor
  // notify.stash_read while the app was demonstrably alive — terminal.softkey
  // events throughout the window and not one app.loaded among them. The record
  // sw.js writes at push time was the only trace of the tap, and nothing was
  // re-reading it after mount.
  //
  // Same trade-off as at boot, and the same guard: foregrounding by tapping the
  // app ICON within the fresh-receipt window lands on the notified session
  // instead. A push had just arrived, so that is a defensible place to be, and
  // an older receipt whose banner is still on screen is refused.
  // Whether this foregrounding has already reported a verdict that routed
  // nowhere. Cleared on the way out (onLookAway), so the next return reports
  // again. `acted` and `already` need no latch: both consume the record.
  let quietReported = false;

  const landOnStashedTapWith = async (records: readonly StoredRecord[]): Promise<void> => {
    const reason = (r: TapReason): void => void track("notify.stash_read", { "tl.reason": r });
    const now = Date.now();
    // ONE read of the shade, with no tag filter, for the whole decision. Which
    // record was tapped is decided by which banner has GONE: iOS clears the one
    // you tapped and leaves the rest. Deciding and reporting used to be two
    // separate passes over the records, so the journal could say `stale` about a
    // tap that had been refused for another reason entirely.
    // The `?session=` of a Declarative Web Push navigate URL, when the OS opened
    // us on one. iOS 18.4+ dispatches no notificationclick for those, so this
    // query is the only first-hand answer to which banner was tapped; pickTap
    // still refuses it without a live record behind it, so a query left over
    // from an earlier tap cannot route twice.
    const pick = pickTap(records, await displayedTags(), now, navigatedSession());
    // Consume what this launch settled and forget what is genuinely finished
    // with, in ONE write. A receipt whose banner is still on screen is neither:
    // the reader has not tapped it yet, and deleting it is what left the tap
    // minutes later with nothing to route on. Over 72 hours on that build only
    // 30 of 237 stash reads routed, and 44 came back `absent` with 16 of those
    // written inside the window.
    //
    // Awaited, not fired and forgotten: the next wake is queued behind this
    // call, and it must not read a record this one has already acted on.
    const spent = spentSessions(records, now, pick.session);
    if (spent.length) await clearPendingSessions(spent);

    if (pick.session === null) {
      // `stale` (every row past its window) and `untapped` (live rows whose
      // banners are all still on screen, so the app was opened by its icon) are
      // two different diagnoses, and telling them apart is the whole point of
      // reporting.
      //
      // Reported ONCE per return to the foreground. One foregrounding fires
      // visibilitychange, window focus and sometimes pageshow, each of which
      // reads the stash, and a record that routes nowhere survives all three —
      // spentSessions keeps a live receipt whose banner is still up on purpose.
      // Reporting per read would multiply `untapped` and `stale` by however many
      // events that platform happens to fire, which is the one number the six
      // previous attempts at this bug were judged against.
      if (!quietReported) {
        quietReported = true;
        reason(pick.reason);
      }
      return;
    }
    if (opts.selected() === pick.session) {
      reason("already"); // the app is already where the tap wanted
      return;
    }
    reason(pick.reason);
    track("notify.clicked", { "tl.session": pick.session });
    opts.onActivateSession(pick.session);
  };

  /**
   * Read the stash and act on it, if there is anything to act on.
   *
   * `reportAbsent` is boot's alone. Boot distinguishes "the write never landed"
   * from "no tap", which is the question the worker's notify.stash_written is
   * paired with; a wake finding an empty store says nothing, because one
   * foregrounding can fire three of them. The same three are why a verdict that
   * routes nowhere is latched and reported once (landOnStashedTapWith): an empty
   * store costs one getAll and no telemetry, but a surviving record would
   * otherwise report on every read.
   */
  const readAndLand = async (reportAbsent: boolean): Promise<void> => {
    if (lens) return;
    const records = await readPendingSessions();
    if (records.length === 0) {
      if (reportAbsent) track("notify.stash_read", { "tl.reason": "absent" });
      return;
    }
    await landOnStashedTapWith(records);
  };

  /**
   * One read at a time. A single return to the foreground can fire
   * visibilitychange, window focus and pageshow, and two reads racing each other
   * would both see the same record and both route on it. Chaining also means a
   * wake that arrives mid-read sees the store the previous one left behind.
   * `.then(run, run)` so one throw cannot stop every later wake.
   */
  let landing: Promise<void> = Promise.resolve();
  const landOnStashedTap = (reportAbsent = false): Promise<void> => {
    if (lens) return landing;
    const run = () => readAndLand(reportAbsent);
    landing = landing.then(run, run);
    return landing;
  };

  onMount(() => void landOnStashedTap(true));

  // Self-heal the background subscription every load (the desktop-silent fix):
  // subscribePush is idempotent, so a lapsed/rotated endpoint is refreshed
  // whenever the bell is on + permission granted. The delivery check runs AFTER
  // it, so a device that just re-registered is recognised as push-backed on this
  // very load (checking first would read "no" and re-open the double-alert
  // window for a whole session).
  onMount(async () => {
    if (notifyOptedIn() && hasNotificationApi && Notification.permission === "granted") {
      await subscribePush();
    }
    await syncPushDelivery();
  });

  // ---- foreground transition notifications -------------------------------
  // Advance the snapshot on EVERY poll (even while gated out) so opting in later
  // doesn't replay a backlog. Gate firing behind loading (so the seed is the
  // first real poll, not the pre-poll empty list) + opt-in + permission.
  let prevStates: StateMap | null = null;
  createEffect(() => {
    if (opts.loading()) return; // wait for the first poll (tracked)
    const list = opts.sessions(); // tracked — the effect re-runs per poll
    const snap = snapshotStates(list);
    const prev = prevStates;
    prevStates = snap;
    if (prev === null) return; // first post-load snapshot seeds quietly
    // all-or-nothing browser gates (untracked — not reactive deps)
    if (!untrack(optedIn) || !hasNotificationApi || Notification.permission !== "granted") {
      return;
    }
    const prefs = untrack(opts.notifyPrefs);
    const fires = computeTransitions(prev, list, {
      away: away(),
      activeSession: untrack(opts.selected),
      onAwaiting: prefs.onAwaiting,
      onDone: prefs.onDone,
      pushDelivers: untrack(pushDelivers),
    });
    const hasReg = !!sw.registration();
    for (const f of fires) {
      // One event per page-fired notification: paired with the server's "sent
      // <kind>" log line, the journal shows at a glance whether an edge alerted
      // once or twice on a device.
      track("notify.shown", { "tl.kind": hasReg ? "sw" : "page" });
      // The banner reads the title; the name only addresses it. A session that
      // has left the list between the poll and here has nothing but its name,
      // which is what sessionConfirmLabel answers for an untitled one anyway.
      const s = list.find((x) => x.name === f.session);
      void fireNotification(f.session, sessionConfirmLabel(s ?? { name: f.session }), f.kind, {
        hasRegistration: hasReg,
        onActivate: opts.onActivateSession,
      });
    }
  });

  // ---- tab title + favicon badge -----------------------------------------
  // Both badges count the sessions that finished since the user last LOOKED at
  // them, off one shared predicate — the visit store is owned here (rather than
  // handed in) because this system already sees every poll and the selection,
  // which is exactly what a visit is made of.
  const visits = createVisitStore();
  const isUnseen = opts.isUnseen ?? ((s: TitleSession) => visits.isUnseen(s));
  // Visit records are keyed by tmux's session id, so a rename carries itself.
  // A `tl:session-renamed` listener used to patch them by name, and it only
  // ever fired for a rename made in THIS tab: one from a second tab, the phone,
  // or a shell looked like a session vanishing and a stranger arriving, so the
  // visit was pruned and work you had already read came back unread. A title
  // carries the tmux name with it again (ADR-0022), so renames are ordinary
  // rather than rare, and keying by tmux's session id — which a rename does not
  // change — is what makes that a non-event here.
  // Report whether the icon could actually be drawn, ONCE per distinct outcome.
  // The paint is best-effort and silent, which also meant nobody could tell a
  // drawn badge from a missing API — and on iOS that is the whole question,
  // since the Badging API may not exist inside a service worker, where the
  // badge matters most. Deduped because this runs on every poll.
  let lastBadgeReport = "";
  const reportBadge = (kind: "ok" | "unsupported" | "failed", count: number): void => {
    const key = kind + ":" + (count > 0 ? "n" : "0");
    if (key === lastBadgeReport) return;
    lastBadgeReport = key;
    track("notify.badge_set", { "tl.kind": kind, "tl.count": count });
  };

  const badger = createFaviconBadger();

  /**
   * The visit store and the app icon, driven by POLLS rather than by changes to
   * the list. Two reasons they cannot ride the title/favicon effect below.
   *
   * `polls() === 0` is the only honest test for "the list is an answer". The
   * previous gate read `loading`, which goes false even when /sessions rejected,
   * so opening the app on a dead link folded an EMPTY list into the visit store
   * (deleting every seen record) and then cleared a badge that was correctly
   * showing outstanding work.
   *
   * And reading `polls` makes this run on EVERY poll, not only when the payload
   * differs. `setSessions(reconcile(...))` deliberately writes nothing when a
   * poll is unchanged, so a badge painted too high by a push used to stand until
   * some unrelated field moved — measured at zero repaints across 35 s of live
   * polling. Repainting the same number costs nothing.
   */
  createEffect(() => {
    if ((opts.polls?.() ?? 1) === 0) return; // nothing known yet
    const list = opts.sessions();
    const active = opts.selected();
    visits.revision(); // re-run when an out-of-band stamp changes the set
    // Fold this poll in BEFORE painting: the session on screen is seen by the
    // time its badge would be drawn. Stamping inside the effect is safe —
    // `revision` only bumps when the unseen set actually changes, so this
    // settles after one extra pass instead of looping.
    visits.observe(list, active);
    applyAppBadge(waitingCount(list, isUnseen, opts.osUser()), undefined, reportBadge);
  });

  createEffect(() => {
    const list = opts.sessions();
    const active = opts.selected();
    const att = attention();
    visits.revision(); // repaint when an out-of-band stamp changes the set
    badger.apply(faviconKind(list, att.bell, isUnseen));
    if (hasDoc) {
      const user = opts.osUser();
      document.title = composeTitle({
        sessions: list,
        attentionSession: att.session,
        activeSession: active,
        osUser: user,
        baseTitle: user ? `tmux sessions (${user})` : "terminal-lobby",
        isUnseen,
      });
    }
  });

  // ---- attention latch (from the terminal) -------------------------------
  const onTerminalAttention = (kind: "bell" | "output", session: string | null): void => {
    setAttention((s) =>
      applyAttentionSignal(s, {
        kind,
        session,
        away: away(),
        activeSession: opts.selected(),
      }),
    );
  };
  // Coming back to the tab is a LOOK: it drops the attention latch AND marks the
  // session on screen seen, so a finished-session badge clears immediately
  // rather than at the next poll (up to 5s of a badge for something you are
  // already staring at).
  const onLook = (): void => {
    setAttention((s) => clearAttention(s));
    visits.stamp(untrack(opts.selected));
    reportFocusNow(untrack(opts.selected));
    // A tap that iOS turned into a plain foreground, with no notificationclick
    // and no reload, leaves its only trace in the stash. Every way back into the
    // app has to look for it: this handler runs for window focus, which a
    // foregrounding can fire on its own without visibilitychange, and that
    // return read nothing at all. The reads are serialised and an empty store
    // costs one getAll and no telemetry, so extra callers are cheap.
    void landOnStashedTap();
  };
  // A blur is a look-away: on the desktop the window can stay visible behind
  // another one, and reading a session there is not reading it.
  const onLookAway = (): void => {
    quietReported = false; // the next return to the app is a new question
    reportFocusNow(untrack(opts.selected));
  };
  const onVisibility = (): void => {
    if (!hasDoc || document.hidden) {
      onLookAway(); // going away is announced, not waited out
      return;
    }
    onLook(); // which is also where the stash is read
    // Re-confirm on return-to-foreground (throttled): a long-lived tab whose
    // endpoint the server pruned would otherwise stay silent forever, believing
    // push still covers it.
    if (Date.now() - lastPushCheck > PUSH_RECHECK_MS) void syncPushDelivery();
  };
  // The session on screen changed, or this device just learned the server pushes
  // to it. Both are things to say at once; the tick below only covers the case
  // with no event at all, a page left open on one session for hours.
  createEffect(() => {
    const delivers = pushDelivers(); // tracked
    const selected = opts.selected(); // tracked
    if (!delivers) return;
    reportFocusNow(selected);
  });
  // A bfcache restore fires pageshow and nothing else, which on iOS is a
  // plausible way back into a resident PWA. It is not a LOOK (no attention latch
  // to drop, no focus to report yet), only another place a pending tap can be
  // sitting.
  const onPageShow = (): void => void landOnStashedTap();
  let focusTimer: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    if (hasDoc) document.addEventListener("visibilitychange", onVisibility);
    if (hasWin) window.addEventListener("focus", onLook);
    if (hasWin) window.addEventListener("pageshow", onPageShow);
    if (hasWin) window.addEventListener("blur", onLookAway);
    focusTimer = setInterval(() => reportFocusNow(untrack(opts.selected)), FOCUS_TICK_MS);
  });
  onCleanup(() => {
    if (hasDoc) document.removeEventListener("visibilitychange", onVisibility);
    if (hasWin) window.removeEventListener("focus", onLook);
    if (hasWin) window.removeEventListener("pageshow", onPageShow);
    if (hasWin) window.removeEventListener("blur", onLookAway);
    if (focusTimer !== undefined) clearInterval(focusTimer);
  });

  // ---- bell toggle (the ONLY requestPermission site) ---------------------
  const toggleBell = async (): Promise<void> => {
    if (!hasNotificationApi) return; // the button is gated by bellMode
    if (notifyOptedIn() && Notification.permission === "granted") {
      setNotifyOptIn(false);
      setOptedIn(false);
      // Drop this device's background push too, then re-read delivery: with the
      // subscription gone the page path takes over again (it is gated by the
      // opt-in that just went off, so this only matters on a later re-enable).
      void unsubscribePush().then(syncPushDelivery);
      return;
    }
    let perm = Notification.permission;
    if (perm === "default") {
      try {
        perm = await Notification.requestPermission();
      } catch {
        perm = Notification.permission;
      }
    }
    setPermission(perm);
    if (perm !== "granted") {
      opts.toast("Notifications are blocked in the browser settings", "error");
      return;
    }
    // Confirm SOMETHING can actually deliver before enabling a toggle that
    // would otherwise show nothing (e.g. Android before the /sw.js route lands).
    if (!sw.deliverable()) {
      opts.toast("Notifications are not supported in this browser", "error");
      return;
    }
    setNotifyOptIn(true);
    setOptedIn(true);
    opts.toast("You'll be notified when a session needs input", "success");
    // Register for background push (best-effort), then re-read delivery so this
    // device hands OS notifications over to the server straight away.
    void subscribePush().then(syncPushDelivery);
  };

  const showInstallHint = (): void => {
    opts.toast(
      'On iPhone/iPad: tap Share, then "Add to Home Screen", open the installed app, and enable notifications there.',
      "info",
    );
  };

  // ---- settings readouts + tests -----------------------------------------
  const refreshDeviceState = async (): Promise<void> => {
    setDeviceState("checking");
    setDeviceState(await deviceSubscriptionState());
  };

  const testHere = async (): Promise<void> => {
    if (!hasNotificationApi) {
      opts.toast("This browser has no Notification API", "error");
      return;
    }
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    setPermission(perm);
    if (perm !== "granted") {
      opts.toast(
        `Notification permission is "${perm}" — allow notifications for this site in the browser`,
        "error",
      );
      return;
    }
    const title = "Test — this device";
    const o: NotificationOptions = {
      body: "If you can read this outside the tab, the OS chain works.",
      tag: "tl-test-here",
    };
    let shown = false;
    try {
      const reg = hasNav ? await navigator.serviceWorker?.getRegistration() : undefined;
      track("notify.shown", { "tl.kind": reg?.showNotification ? "sw" : "page" });
      if (reg?.showNotification) {
        await reg.showNotification(title, o);
        shown = true;
      }
    } catch {
      /* fall through to constructor */
    }
    if (!shown) {
      try {
        new Notification(title, o);
        shown = true;
      } catch {
        /* refused */
      }
    }
    opts.toast(
      shown
        ? "Shown. Nothing on screen? Your OS/browser is hiding notifications for this site (Focus/DND, banners off)."
        : "The browser refused to show it — check site notification settings.",
      shown ? "info" : "error",
    );
  };

  const testAll = async (): Promise<void> => {
    const r = await testAllDevices();
    if (!r.ok) {
      opts.toast(
        r.status
          ? `Test push failed (server ${r.status})`
          : "Test push failed — is the app online?",
        "error",
      );
      return;
    }
    if (r.sent > 0) {
      opts.toast(
        `Push accepted for ${r.sent} registered device${r.sent === 1 ? "" : "s"}` +
          (r.pruned ? ` — pruned ${r.pruned} stale` : ""),
        "success",
      );
    } else {
      opts.toast(
        "No devices subscribed. Enable the bell on each device you want pushes on.",
        "info",
      );
    }
  };

  /** The predicate the sidebar reads. See NotificationSystem.isUnseen. */
  const isUnseenReactive = (sn: TitleSession): boolean => {
    visits.revision();
    return isUnseen(sn);
  };

  return {
    isUnseen: isUnseenReactive,
    bellMode,
    bellOn,
    bellTitle,
    toggleBell,
    showInstallHint,
    onTerminalAttention,
    permission,
    deviceState,
    refreshDeviceState,
    testHere,
    testAll,
    dispose: () => {
      sw.dispose();
    },
  };
}
