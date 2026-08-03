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
 *     per-session away gate);
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
import {
  computeTransitions,
  snapshotStates,
  type StateMap,
} from "./transitions";
import { fireNotification } from "./fire";
import { notifyOptedIn, setNotifyOptIn } from "./opt-in";
import {
  PENDING_NOTIF_TTL_MS,
  readAndClearPendingSession,
  registerServiceWorker,
} from "../pwa/register";
import {
  deviceSubscriptionState,
  subscribePush,
  testAllDevices,
  unsubscribePush,
  type DeviceSubscriptionState,
} from "../pwa/push";
import { NAME_RE } from "../types/lobby";
import { track } from "../telemetry/track";

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
  /** surface a message to the app's toast stack. */
  toast: ToastFn;
  /** switch the app to a session (SW tap / boot stash / constructor click). */
  onActivateSession: (session: string) => void;
  /** counts a done session as unseen for the title badge (default: all done). */
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
  dispose: () => void;
}

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

  const bellOn = () => optedIn() && permission() === "granted";
  const bellTitle = () =>
    bellOn()
      ? "Notifying you when Claude finishes or needs input on this device (click to disable). Enable on each device you want pushes on."
      : "Notify me when Claude finishes or needs input. Per device + browser — enable on each device you want notified.";

  // ---- service worker + notification-tap handoff -------------------------
  const sw = registerServiceWorker({
    onActivateSession: opts.onActivateSession,
  });
  onCleanup(() => sw.dispose());

  // Boot landing: if iOS cold-launched a KILLED PWA at start_url (no hash, no
  // notificationclick), the SW stashed the tapped session — consume it and land
  // there, but only when fresh and nothing else is already selected.
  onMount(async () => {
    const pending = await readAndClearPendingSession();
    if (
      pending &&
      typeof pending.session === "string" &&
      NAME_RE.test(pending.session) &&
      Date.now() - pending.ts < PENDING_NOTIF_TTL_MS &&
      opts.selected() == null
    ) {
      track("notify.clicked", { "tl.session": pending.session });
      opts.onActivateSession(pending.session);
    }
  });

  // Self-heal the background subscription every load (the desktop-silent fix):
  // subscribePush is idempotent, so a lapsed/rotated endpoint is refreshed
  // whenever the bell is on + permission granted.
  onMount(() => {
    if (notifyOptedIn() && hasNotificationApi && Notification.permission === "granted") {
      void subscribePush();
    }
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
    });
    const hasReg = !!sw.registration();
    for (const f of fires) {
      void fireNotification(f.session, f.kind, {
        hasRegistration: hasReg,
        onActivate: opts.onActivateSession,
      });
    }
  });

  // ---- tab title + favicon badge -----------------------------------------
  const badger = createFaviconBadger();
  createEffect(() => {
    const list = opts.sessions();
    const att = attention();
    badger.apply(faviconKind(list, att.bell));
    if (hasDoc) {
      const user = opts.osUser();
      document.title = composeTitle({
        sessions: list,
        attentionSession: att.session,
        activeSession: opts.selected(),
        osUser: user,
        baseTitle: user ? `tmux sessions (${user})` : "terminal-lobby",
        isUnseen: opts.isUnseen,
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
  const clear = (): void => {
    setAttention((s) => clearAttention(s));
  };
  const onVisibility = (): void => {
    if (hasDoc && !document.hidden) clear();
  };
  onMount(() => {
    if (hasDoc) document.addEventListener("visibilitychange", onVisibility);
    if (hasWin) window.addEventListener("focus", clear);
  });
  onCleanup(() => {
    if (hasDoc) document.removeEventListener("visibilitychange", onVisibility);
    if (hasWin) window.removeEventListener("focus", clear);
  });

  // ---- bell toggle (the ONLY requestPermission site) ---------------------
  const toggleBell = async (): Promise<void> => {
    if (!hasNotificationApi) return; // the button is gated by bellMode
    if (notifyOptedIn() && Notification.permission === "granted") {
      setNotifyOptIn(false);
      setOptedIn(false);
      void unsubscribePush(); // drop this device's background push too
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
    void subscribePush(); // also register for background push (best-effort)
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

  return {
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
    dispose: () => sw.dispose(),
  };
}
