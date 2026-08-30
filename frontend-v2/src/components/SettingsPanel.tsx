import {
  For,
  Show,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type Component,
} from "solid-js";
import { toasts } from "../store/toast";
import { THEMES, THEME_LABELS, setTheme, theme } from "../theme/theme";
import {
  BOLD_WEIGHTS,
  CURSOR_STYLES,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LETTER_SPACING_MAX,
  LETTER_SPACING_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  NEW_COMMANDS,
  WHEEL_SPEEDS,
  type BoldWeight,
  type CursorStyle,
  type NewCommand,
  type PrefsStore,
  type WheelSpeed,
} from "../store/prefs";
import {
  clearLocalData,
  flowControlWanted,
  setFlowControlEnabled,
} from "../store/device-prefs";
import { diagnosticsWanted, setDiagnosticsEnabled } from "../telemetry/diag";
import {
  readStoredTier,
  readTierPreference,
  writeTierPreference,
  type TierPreference,
} from "../diagnostics/connection";
import {
  aggregate,
  commitResetSince,
  formatBytes,
  readStore,
  resetStore,
  type Bucket,
  type PeriodKey,
  type UsageAggregate,
} from "../diagnostics/usage";
import {
  currentNetwork,
  networkIsStale,
  onNetworkChange,
  refreshNetwork,
  type NetworkInfo,
} from "../diagnostics/network";
import type { NotificationSystem } from "../notify/notifications";
import { installDialogFocus, wrapTab } from "../lib/focus-trap";

/** What each bucket is called on screen. Feature names rather than endpoints,
 *  because the breakdown exists to be acted on. */
const BUCKET_LABEL: Record<Bucket, string> = {
  term: "Terminal",
  app: "App code",
  text: "Text view",
  files: "Files & images",
  api: "API",
};

/** What Settings needs to render the act-as picker. Absent for a non-admin. */
export interface ActAsControl {
  /** Mapped OS users this caller may act as (already excludes themselves). */
  users: Accessor<string[]>;
  /** The user currently being acted as, "" when it is your own lobby. */
  current: Accessor<string>;
  /** Switch to a user, or "" to return to your own lobby. Navigates. */
  switchTo: (osUser: string) => void;
}

/**
 * Settings overlay (feature-inventory §6 + the §1 9-theme grid). Three groups:
 *   - Theme: a 9-button grid picker, per-DEVICE (`tmux-theme`), NOT roamed.
 *   - Terminal font size: an A−/A+ stepper, clamped [6,22], ROAMED + dual-written
 *     to the legacy device key so the embedded ttyd terminal page picks it up.
 *   - Session + notifications: the roamed prefs (newCommand, notify.*) via /prefs.
 * Closes on the ✕, a backdrop click, or Escape (focus returns to the opener).
 */
export const SettingsPanel: Component<{
  prefs: PrefsStore;
  onClose: () => void;
  /** the keybinding layer's opt-in toggle (per-device, not roamed). */
  keybindings?: {
    enabled: Accessor<boolean>;
    setEnabled: (on: boolean) => void;
    /** platform label for the Alt/Option modifier, for the exemption note. */
    altLabel?: string;
  };
  /** the PWA notification system (per-device readouts + test actions). */
  notifications?: NotificationSystem;
  /** the admin act-as picker. Supplied only when the CALLER administers this
   *  box; absent for everyone else, so the section does not render at all. */
  actAs?: ActAsControl;
  /** confirm seam for Clear local data (tests inject it). */
  confirm?: (message: string) => boolean;
  /** reload seam for Clear local data (tests inject it). */
  onCleared?: () => void;
}> = (props) => {
  let dialogEl: HTMLDivElement | undefined;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
      return;
    }
    if (e.key === "Tab" && dialogEl) wrapTab(e, dialogEl);
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  // The focus half of the contract in the header comment.
  installDialogFocus(() => dialogEl);
  // Fill the "Subscribed here" readout once the panel opens (async: it compares
  // this browser's live push endpoint against the server's stored list).
  onMount(() => void props.notifications?.refreshDeviceState());

  const fontSize = () => props.prefs.prefs().fontSize;
  const newCommand = () => props.prefs.prefs().session.newCommand;
  const notify = () => props.prefs.prefs().notify;
  const sidebar = () => props.prefs.prefs().sidebar;
  const p = () => props.prefs.prefs();

  // Per-BROWSER switches: signals rather than derived values, because their
  // truth lives in localStorage and nothing else re-renders this panel when it
  // changes. Seeded once on open.
  const [flowOn, setFlowOn] = createSignal(flowControlWanted());
  const [diagOn, setDiagOn] = createSignal(diagnosticsWanted());
  const [alsoRoamed, setAlsoRoamed] = createSignal(false);
  const [clearing, setClearing] = createSignal(false);

  // Data used. Read once on open rather than tracked live: the counters move on
  // a 60s window, and a panel that reflowed while being read would be worse
  // than one that is a minute stale.
  // Which period the breakdown is scoped to, and which network narrows it
  // further. One selection drives the whole section: there is no control fixed
  // to a period nobody picked.
  const [period, setPeriod] = createSignal<PeriodKey>("thisMonth");
  const [net, setNet] = createSignal<string | null>(null);
  const [usage, setUsage] = createSignal<UsageAggregate>(
    aggregate(readStore(), new Date(), "thisMonth", null),
  );
  // The network is live, unlike the counters: it is the one thing on this panel
  // a person opens Settings to check after landing somewhere, and it changes
  // under them rather than on their input.
  const [network, setNetwork] = createSignal<NetworkInfo | null>(currentNetwork());
  const [tier, setTier] = createSignal<TierPreference>(readTierPreference());
  // What the link actually measured last time, which is a different question
  // from what the pin asks for — and the only thing on screen that answers
  // "why am I in light mode?". connection.ts persists the verdict, not the
  // sample behind it, so the throughput and round trip are not available here.
  const measured = readStoredTier();

  const refreshUsage = () => setUsage(aggregate(readStore(), new Date(), period(), net()));
  const pickPeriod = (p: PeriodKey) => {
    setPeriod(p);
    // A network selected in one period may carry nothing in another, and a
    // breakdown of nothing reads as a bug. Start each period at all networks.
    setNet(null);
    refreshUsage();
  };
  const pickNet = (id: string) => {
    setNet(net() === id ? null : id); // tapping the selected row clears it
    refreshUsage();
  };
  const widest = () => Math.max(...usage().buckets.map((b) => b.bytes), 0);
  const widestNet = () => Math.max(...usage().networks.map((n) => n.bytes), 0);
  const netBarWidth = (bytes: number) =>
    widestNet() > 0 ? `${(bytes / widestNet()) * 100}%` : "0%";
  /** What the bucket bars are showing, spelled out rather than left implied. */
  const scopeLabel = (): string => {
    const p = usage().periods.find((r) => r.key === usage().period);
    const chosen = usage().networks.find((n) => n.id === usage().net);
    return `${p?.label ?? ""} · ${chosen ? chosen.label : "all networks"}`;
  };

  /** How the current network reads on screen: the operator and, when it is
   *  known, the country — which is what tells someone they are somewhere
   *  else. */
  const networkName = (): string => {
    const n = network();
    if (!n) return "Checking this network…";
    if (n.net === "lan") return "Home network";
    const label = n.label || (n.net.startsWith("as") ? n.net.toUpperCase() : "This network");
    return n.cc ? `${label} (${n.cc})` : label;
  };

  const doResetSince = async (): Promise<void> => {
    await commitResetSince();
    refreshUsage();
  };

  // Opening Settings is a moment worth re-asking the server: it is the one
  // interaction that means "tell me about this connection".
  onMount(() => {
    void refreshNetwork({ force: true });
    onCleanup(onNetworkChange((info) => setNetwork(info)));
  });
  const barWidth = (bytes: number) => (widest() > 0 ? `${(bytes / widest()) * 100}%` : "0%");

  const confirmFn = () => props.confirm ?? ((m: string) => window.confirm(m));

  const doClear = async (): Promise<void> => {
    const ok = confirmFn()(
      "Clear this browser's terminal-lobby data (theme, font size, sidebar " +
        "layout, gestures, notification opt-in)" +
        (alsoRoamed()
          ? " AND reset the settings that roam to your other devices"
          : "") +
        ", then reload?\n\nYour tmux sessions are not affected.",
    );
    if (!ok) return;
    setClearing(true);
    await clearLocalData({
      alsoRoamed: alsoRoamed(),
      onError: (m) => toasts.push({ kind: "error", message: m }),
      ...(props.onCleared ? { reload: props.onCleared } : {}),
    });
  };

  return (
    <div
      class="tl-settings-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        ref={dialogEl}
        class="tl-settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabindex="-1"
      >
        <div class="tl-settings-head">
          <span class="tl-settings-title">Settings</span>
          <button
            type="button"
            class="tl-icon-btn"
            aria-label="Close settings"
            title="Close"
            onClick={() => props.onClose()}
          >
            ✕
          </button>
        </div>

        <Show when={props.actAs}>
          {(ctl) => (
            <section class="tl-settings-group tl-actas-group">
              <div class="tl-settings-label">Act as user</div>
              <select
                class="tl-settings-select"
                aria-label="Act as another user"
                value={ctl().current()}
                onChange={(e) => ctl().switchTo(e.currentTarget.value)}
              >
                <option value="">— myself —</option>
                <For each={ctl().users()}>
                  {(u) => <option value={u}>{u}</option>}
                </For>
              </select>
              <div class="tl-settings-hint">
                This tab becomes that user: their sessions, files and terminal,
                with full read-write access as them. Your other tabs are
                unaffected. Every switch is recorded.
              </div>
            </section>
          )}
        </Show>

        <section class="tl-settings-group">
          <div class="tl-settings-label">Theme</div>
          <div class="tl-theme-grid">
            <For each={THEMES}>
              {(t) => (
                <button
                  type="button"
                  class="tl-theme-swatch"
                  classList={{ active: theme() === t }}
                  aria-pressed={theme() === t}
                  onClick={() => setTheme(t)}
                >
                  {THEME_LABELS[t] ?? t}
                </button>
              )}
            </For>
          </div>
          <div class="tl-settings-hint">This device only.</div>
        </section>

        <section class="tl-settings-group">
          <div class="tl-settings-label">Terminal font size</div>
          <div class="tl-fontsize">
            <button
              type="button"
              class="tl-fontsize-btn"
              aria-label="Smaller font"
              title="Smaller"
              disabled={fontSize() <= FONT_SIZE_MIN}
              onClick={() => props.prefs.setFontSize(fontSize() - 1)}
            >
              A−
            </button>
            <span class="tl-fontsize-value" aria-live="polite">
              {fontSize()}px
            </span>
            <button
              type="button"
              class="tl-fontsize-btn"
              aria-label="Larger font"
              title="Larger"
              disabled={fontSize() >= FONT_SIZE_MAX}
              onClick={() => props.prefs.setFontSize(fontSize() + 1)}
            >
              A+
            </button>
          </div>
        </section>

        {/* Terminal rendering. Every row here is roamed and read by the
            terminal page from the shared-origin prefs doc, so a change applies
            to the live terminal without a reload. */}
        <section class="tl-settings-group">
          <div class="tl-settings-label">Terminal text</div>

          <label class="tl-settings-range">
            <span>Line height</span>
            <input
              type="range"
              min={LINE_HEIGHT_MIN}
              max={LINE_HEIGHT_MAX}
              step="0.05"
              value={p().lineHeight}
              aria-label="Line height"
              onInput={(e) =>
                props.prefs.setPref({ lineHeight: Number(e.currentTarget.value) })
              }
            />
            <b class="tl-settings-num">{p().lineHeight.toFixed(2)}</b>
          </label>

          <label class="tl-settings-range">
            <span>Letter spacing</span>
            <input
              type="range"
              min={LETTER_SPACING_MIN}
              max={LETTER_SPACING_MAX}
              step="0.1"
              value={p().letterSpacing}
              aria-label="Letter spacing"
              onInput={(e) =>
                props.prefs.setPref({ letterSpacing: Number(e.currentTarget.value) })
              }
            />
            <b class="tl-settings-num">{p().letterSpacing.toFixed(1)}px</b>
          </label>

          <div class="tl-settings-seg-row">
            <span>Bold weight</span>
            <div class="tl-settings-seg">
              <For each={BOLD_WEIGHTS}>
                {(w) => (
                  <button
                    type="button"
                    classList={{ active: p().fontWeightBold === w }}
                    aria-pressed={p().fontWeightBold === w}
                    onClick={() =>
                      props.prefs.setPref({ fontWeightBold: w as BoldWeight })
                    }
                  >
                    {w}
                  </button>
                )}
              </For>
            </div>
          </div>
        </section>

        <section class="tl-settings-group">
          <div class="tl-settings-label">Cursor</div>
          <div class="tl-settings-seg-row">
            <span>Shape</span>
            <div class="tl-settings-seg">
              <For each={CURSOR_STYLES}>
                {(c) => (
                  <button
                    type="button"
                    classList={{ active: p().cursorStyle === c }}
                    aria-pressed={p().cursorStyle === c}
                    onClick={() =>
                      props.prefs.setPref({ cursorStyle: c as CursorStyle })
                    }
                  >
                    {c}
                  </button>
                )}
              </For>
            </div>
          </div>
          <label class="tl-settings-check">
            <input
              type="checkbox"
              checked={p().cursorBlink}
              onChange={(e) =>
                props.prefs.setPref({ cursorBlink: e.currentTarget.checked })
              }
            />
            <span>Blink</span>
          </label>
        </section>

        <section class="tl-settings-group">
          <div class="tl-settings-label">Scrolling &amp; links</div>
          <label class="tl-settings-check">
            <input
              type="checkbox"
              checked={p().gestures.wheelSmooth}
              onChange={(e) =>
                props.prefs.setPref({
                  gestures: { wheelSmooth: e.currentTarget.checked },
                })
              }
            />
            <span>Smooth mouse-wheel scrolling</span>
          </label>
          <div class="tl-settings-seg-row">
            <span>Scroll speed</span>
            <div class="tl-settings-seg">
              <For each={WHEEL_SPEEDS}>
                {(s) => (
                  <button
                    type="button"
                    classList={{ active: p().gestures.wheelSpeed === s }}
                    aria-pressed={p().gestures.wheelSpeed === s}
                    disabled={!p().gestures.wheelSmooth}
                    onClick={() =>
                      props.prefs.setPref({
                        gestures: { wheelSpeed: s as WheelSpeed },
                      })
                    }
                  >
                    {s}×
                  </button>
                )}
              </For>
            </div>
          </div>
          <div class="tl-settings-hint">
            Speed applies to the smooth scroller, so it does nothing while that
            is off.
          </div>
          <label class="tl-settings-check">
            <input
              type="checkbox"
              checked={p().links.copyChip}
              onChange={(e) =>
                props.prefs.setPref({ links: { copyChip: e.currentTarget.checked } })
              }
            />
            <span>Copy button on terminal links</span>
          </label>
        </section>

        <section class="tl-settings-group">
          <div class="tl-settings-label">Session list</div>
          <label class="tl-settings-check">
            <input
              type="checkbox"
              checked={sidebar().showLastActive}
              onChange={(e) =>
                props.prefs.setPref({
                  sidebar: { showLastActive: e.currentTarget.checked },
                })
              }
            />
            <span>Show when each session was last driven</span>
          </label>
          <div class="tl-settings-hint">
            The last time someone was attached to it and able to type — watching
            a session does not move this. Roams across your devices. A running
            session still shows its live timer instead, which counts the turn in
            flight.
          </div>
        </section>

        <section class="tl-settings-group">
          <div class="tl-settings-label">New session runs</div>
          <select
            class="tl-settings-select"
            aria-label="Command for a new session"
            value={newCommand()}
            onChange={(e) =>
              props.prefs.setPref({
                session: { newCommand: e.currentTarget.value as NewCommand },
              })
            }
          >
            <For each={NEW_COMMANDS}>{(c) => <option value={c}>{c}</option>}</For>
          </select>
          <div class="tl-settings-hint">
            Applies to newly created sessions only.
          </div>
        </section>

        <Show when={props.keybindings}>
          {(kb) => (
            <section class="tl-settings-group">
              <div class="tl-settings-label">Keyboard</div>
              <label class="tl-settings-check">
                <input
                  type="checkbox"
                  checked={kb().enabled()}
                  onChange={(e) => kb().setEnabled(e.currentTarget.checked)}
                />
                <span>App shortcuts (Alt+1–0, Ctrl+Shift+K, dev-flow chords)</span>
              </label>
              {/* Four chords outlive this checkbox and the label used to imply
                  otherwise: the always-on kill chord (KB_ALWAYS_BINDINGS), the
                  bare "/" and "?" help openers, which are a shell window
                  listener rather than a table binding, and the view toggle,
                  which SessionView and term.html each register outside the
                  gate. Name all of them where the switch is.
                  App passes altLabel only, and it is "Option" exactly on Mac
                  (bindings.logic.ts altLabel), so the Ctrl/Cmd label follows
                  from it without new plumbing. */}
              <div class="tl-settings-hint">
                This device only. Press <kbd>/</kbd> for the full list. Four chords
                stay always on: <kbd>/</kbd> and <kbd>?</kbd> (this list),{" "}
                <kbd>{kb().altLabel ?? "Alt"}+Shift+Backspace</kbd> (kill the attached
                session, asks first) and{" "}
                <kbd>{kb().altLabel === "Option" ? "Cmd" : "Ctrl"}+J</kbd> (toggle
                text / terminal view).
              </div>
            </section>
          )}
        </Show>

        <section class="tl-settings-group">
          <div class="tl-settings-label">Notifications</div>
          <label class="tl-settings-check">
            <input
              type="checkbox"
              checked={notify().onDone}
              onChange={(e) =>
                props.prefs.setPref({
                  notify: { onDone: e.currentTarget.checked },
                })
              }
            />
            <span>When a session finishes</span>
          </label>
          <label class="tl-settings-check">
            <input
              type="checkbox"
              checked={notify().onAwaiting}
              onChange={(e) =>
                props.prefs.setPref({
                  notify: { onAwaiting: e.currentTarget.checked },
                })
              }
            />
            <span>When a session needs input</span>
          </label>
          <Show when={props.notifications}>
            {(n) => (
              <>
                <div class="tl-settings-readouts">
                  <div class="tl-settings-readout">
                    <span>Permission</span>
                    <b>
                      {n().permission() === "granted"
                        ? "granted"
                        : n().permission() === "denied"
                          ? "denied"
                          : n().permission() === "unsupported"
                            ? "unsupported"
                            : "not set"}
                    </b>
                  </div>
                  <div class="tl-settings-readout">
                    <span>Subscribed here</span>
                    <b>{n().deviceState()}</b>
                  </div>
                  <div class="tl-settings-readout">
                    <span>Bell</span>
                    <b>{n().bellOn() ? "on" : "off"}</b>
                  </div>
                </div>
                <div class="tl-settings-btnrow">
                  <button
                    type="button"
                    class="tl-settings-btn"
                    title="Show a notification on THIS device only — no server. If nothing appears while permission is granted, your OS/browser is blocking notifications for this site."
                    onClick={() => void n().testHere()}
                  >
                    Test this device
                  </button>
                  <button
                    type="button"
                    class="tl-settings-btn"
                    title="Send a real push through the server to EVERY device registered under your account (phones included)."
                    onClick={() => void n().testAll()}
                  >
                    Test all devices
                  </button>
                </div>
                <div class="tl-settings-hint">
                  Push is per device + browser — enable the bell on each device
                  you want notified.
                </div>
              </>
            )}
          </Show>
        </section>

        {/* Per-BROWSER switches. Deliberately not roamed: flow control exists
            to rescue a wedged stream on the machine that is wedged, and
            diagnostics is a consent given by the person at this keyboard. */}
        <section class="tl-settings-group">
          <div class="tl-settings-label">This browser</div>
          <label class="tl-settings-check">
            <input
              type="checkbox"
              checked={flowOn()}
              onChange={(e) => {
                setFlowControlEnabled(e.currentTarget.checked);
                setFlowOn(e.currentTarget.checked);
              }}
            />
            <span>Terminal flow control</span>
          </label>
          <div class="tl-settings-hint">
            Back-pressure that pauses a session flooding output. Turning it off
            releases a stream that is stuck paused — the terminal picks the
            change up immediately, no reload.
          </div>
          <label class="tl-settings-check">
            <input
              type="checkbox"
              checked={diagOn()}
              onChange={(e) => {
                setDiagnosticsEnabled(e.currentTarget.checked);
                setDiagOn(e.currentTarget.checked);
              }}
            />
            <span>Send diagnostics</span>
          </label>
          <div class="tl-settings-hint">
            Lobby timings, failures and device info. Never terminal contents,
            keystrokes or session names.
          </div>
        </section>

        {/* Data used — wire bytes for THIS browser profile. The terminal runs in
            an iframe with its own socket, so its share arrives by postMessage
            and is folded into the same store this reads. */}
        <section class="tl-settings-group tl-netusage">
          <div class="tl-settings-label">Data used</div>
          {/* Periods first, one selectable row each. The selection scopes
              everything below it, so "what did July cost me, where, and on
              what" is one tap and no second control. */}
          <div class="tl-netusage-periods" role="radiogroup" aria-label="Period">
            <For each={usage().periods}>
              {(p) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={usage().period === p.key}
                  class="tl-netusage-period"
                  classList={{ "is-on": usage().period === p.key }}
                  onClick={() => pickPeriod(p.key)}
                >
                  <span class="tl-netusage-name">{p.label}</span>
                  <span class="tl-netusage-bytes">{formatBytes(p.bytes)}</span>
                </button>
              )}
            </For>
            <div class="tl-netusage-sincerow">
              <button
                type="button"
                class="tl-settings-btn"
                onClick={() => void doResetSince()}
              >
                Reset this period
              </button>
            </div>
          </div>

          {/* Where the bytes went. Networks are NAMED, never categorised: the
              server identifies the operator exactly and the reader knows which
              row is their SIM, which no heuristic on an operator's name does. */}
          <div class="tl-settings-label tl-netusage-sub">Where</div>
          <Show
            when={usage().networks.length > 0}
            fallback={<div class="tl-settings-hint">Nothing counted in this period yet.</div>}
          >
            <div class="tl-netusage-breakdown">
              <For each={usage().networks}>
                {(n) => (
                  <div
                    class="tl-netusage-row"
                    classList={{
                      "is-on": usage().net === n.id,
                      "is-tappable": n.selectable,
                    }}
                    onClick={() => n.selectable && pickNet(n.id)}
                  >
                    <span class="tl-netusage-name">{n.label}</span>
                    <span class="tl-netusage-bytes">{formatBytes(n.bytes)}</span>
                    <span class="tl-netusage-bar" aria-hidden="true">
                      <span style={{ width: netBarWidth(n.bytes) }} />
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <div class="tl-settings-label tl-netusage-sub">What</div>
          <div class="tl-netusage-scope">{scopeLabel()}</div>
          <div class="tl-netusage-breakdown">
            <For each={usage().buckets}>
              {(b) => (
                <div class="tl-netusage-row">
                  <span class="tl-netusage-name">{BUCKET_LABEL[b.key]}</span>
                  <span class="tl-netusage-bytes">
                    <Show when={b.modelled}>
                      <span class="tl-netusage-approx" aria-label="estimated">
                        ≈
                      </span>{" "}
                    </Show>
                    {formatBytes(b.bytes)}
                  </span>
                  <span class="tl-netusage-bar" aria-hidden="true">
                    <span style={{ width: barWidth(b.bytes) }} />
                  </span>
                </div>
              )}
            </For>
          </div>

          <div class="tl-settings-hint">
            ≈ Compressed streams. The browser cannot measure these directly, so
            they are modelled by compressing the same data the same way.
          </div>

          {/* Which network you are on right now — what you glance at after
              landing somewhere. Read-only: nothing here needs correcting. */}
          <div class="tl-netusage-current">
            <span class="tl-netusage-netname">{networkName()}</span>
            <Show when={network() && networkIsStale()}>
              <span class="tl-netusage-stalemark">not confirmed</span>
            </Show>
          </div>
          <div class="tl-settings-hint">
            {network()?.source === "lan"
              ? "This device is on the house's own network."
              : "Named from the address your requests arrive from. Traffic counted while that is unconfirmed is listed as Unknown network."}
          </div>

          <fieldset class="tl-netusage-tier">
            <legend>Experience on this device</legend>
            <For each={["auto", "full", "slow"] as const}>
              {(value) => (
                <label>
                  <input
                    type="radio"
                    name="tl-conn-tier"
                    value={value}
                    checked={tier() === value}
                    onChange={() => {
                      writeTierPreference(value);
                      setTier(value);
                    }}
                  />
                  <span>{value === "auto" ? "Auto" : value === "full" ? "Full" : "Light"}</span>
                </label>
              )}
            </For>
          </fieldset>
          <div class="tl-settings-hint">
            {measured
              ? `Last measured: ${measured === "slow" ? "light" : "full"}.`
              : "This link is not measured yet."}{" "}
            Light trims what a session opens with. Auto measures this link on
            every load and applies the verdict to the next one.
          </div>

          <div class="tl-settings-btnrow">
            <button
              type="button"
              class="tl-settings-btn"
              onClick={() => {
                resetStore();
                refreshUsage();
              }}
            >
              Reset counters
            </button>
          </div>
          <div class="tl-settings-hint">
            {diagOn()
              ? "Counted on this device. Bytes that crossed the link, after compression."
              : "Counted on this device only. Nothing is sent while diagnostics are off."}
          </div>
        </section>

        <section class="tl-settings-group">
          <div class="tl-settings-label">Advanced</div>
          <label class="tl-settings-check">
            <input
              type="checkbox"
              checked={alsoRoamed()}
              onChange={(e) => setAlsoRoamed(e.currentTarget.checked)}
            />
            <span>Also reset settings that roam to your other devices</span>
          </label>
          <div class="tl-settings-btnrow">
            <button
              type="button"
              class="tl-settings-btn tl-settings-btn-danger"
              disabled={clearing()}
              onClick={() => void doClear()}
            >
              Clear local data
            </button>
          </div>
          <div class="tl-settings-hint">
            Removes this browser's saved theme, font size, sidebar layout,
            gestures and notification opt-in, then reloads. Your tmux sessions
            are not affected.
          </div>
        </section>
      </div>
    </div>
  );
};
