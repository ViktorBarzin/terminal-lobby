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
 *   - repaint the tab title + favicon badge from the session list and the
 *     attention latch (bell/output signals forwarded up from the terminal iframe,
 *     cleared on visibility/focus return);
 *   - expose the settings readouts (permission / subscribed-here) + test actions.
 *
 * Everything push/notification-related is BEST-EFFORT: a dark server (vapid 404),
 * a browser without SW/PushManager, or a denied permission all degrade quietly.
 */
import {
  createSignal,
  createEffect,
  onCleanup,
  onMount,
  untrack,
  type Accessor,
} from "solid-js";
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
import {
  computeTransitions,
  snapshotStates,
  type StateMap,
} from "./transitions";
import { fireNotification } from "./fire";
import { notifyOptedIn, setNotifyOptIn } from "./opt-in";
import {
  readAndClearPendingSession,
  registerServiceWorker,
  stashIsActionable,
} from "../pwa/register";
import {
  deviceSubscriptionState,
  subscribePush,
  testAllDevices,
  unsubscribePush,
  type DeviceSubscriptionState,
} from "../pwa/push";
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
  /** forwarded from the terminal iframe: a bell / output-while-hidden signal. */
  onFrameAttention: (kind: "bell" | "output", session: string | null) => void;
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

export function createNotificationSystem(
  opts: NotificationSystemOptions,
): NotificationSystem {
  const bellMode = computeBellMode();

  const [optedIn, setOptedIn] = createSignal(notifyOptedIn());
  const [permission, setPermission] = createSignal<
    NotificationPermission | "unsupported"
  >(hasNotificationApi ? Notification.permission : "unsupported");
  const [attention, setAttention] = createSignal<AttentionState>(emptyAttention);
  const [deviceState, setDeviceState] = createSignal<
    DeviceSubscriptionState | "checking"
  >("checking");

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
      if (lens) return;
      track("notify.clicked", { "tl.session": name });
      opts.onActivateSession(name);
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
  // So the stash wins. `stashIsActionable` is the only authority on whether it
  // is worth acting on, and it is already tight — a push-time receipt counts for
  // two minutes, an older one only once its banner has gone, which on iOS means
  // it was tapped or dismissed. The tap is why the app is opening; a restored
  // URL is not intent. This also makes the cold path agree with the warm one,
  // where the postMessage switch has always overridden whatever was on screen.
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
  onMount(async () => {
    if (lens) return;
    const pending = await readAndClearPendingSession();
    const reason = (r: string): void => void track("notify.stash_read", { "tl.reason": r });
    if (!pending) {
      reason("absent"); // a plain icon launch, or the write never landed
      return;
    }
    if (!(await stashIsActionable(pending))) {
      reason("stale"); // too old, or its banner is still on screen
      return;
    }
    const session = pending.session;
    if (opts.selected() === session) {
      reason("already"); // the app is already where the tap wanted
      return;
    }
    reason("acted");
    track("notify.clicked", { "tl.session": session });
    opts.onActivateSession(session);
  });

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
    if (
      !untrack(optedIn) ||
      !hasNotificationApi ||
      Notification.permission !== "granted"
    ) {
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
      void fireNotification(f.session, f.kind, {
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
  // Retitling a session renames it, so visit records keyed by the old name have
  // to move or the next poll prunes them as dead — and a completion the user
  // already saw returns as an unseen tick. The lobby store announces the rename
  // rather than calling in, because it is built before this system is.
  // The visit store keys by tmux session id now, so a rename carries itself and
  // the `tl:session-renamed` listener that used to patch it is gone. It only ever
  // fired for a rename made in THIS tab: one from a second tab, the phone, or a
  // shell looked like a session vanishing and a stranger arriving, so the visit
  // was pruned and work you had already read came back unread.
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
    applyAppBadge(waitingCount(list, isUnseen, opts.osUser()));
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

  // ---- attention latch (from the terminal iframe) ------------------------
  const onFrameAttention = (
    kind: "bell" | "output",
    session: string | null,
  ): void => {
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
  };
  const onVisibility = (): void => {
    if (!hasDoc || document.hidden) return;
    onLook();
    // Re-confirm on return-to-foreground (throttled): a long-lived tab whose
    // endpoint the server pruned would otherwise stay silent forever, believing
    // push still covers it.
    if (Date.now() - lastPushCheck > PUSH_RECHECK_MS) void syncPushDelivery();
  };
  onMount(() => {
    if (hasDoc) document.addEventListener("visibilitychange", onVisibility);
    if (hasWin) window.addEventListener("focus", onLook);
  });
  onCleanup(() => {
    if (hasDoc) document.removeEventListener("visibilitychange", onVisibility);
    if (hasWin) window.removeEventListener("focus", onLook);
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
    onFrameAttention,
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
