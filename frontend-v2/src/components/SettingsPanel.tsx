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
  formatBytes,
  readStore,
  resetStore,
  type Bucket,
  type NetKind,
  type PeriodTotals,
  type UsageAggregate,
  type UsageFilter,
} from "../diagnostics/usage";
import {
  currentNetwork,
  networkOverrides,
  onNetworkChange,
  refreshNetwork,
  type NetOverride,
  type NetworkInfo,
} from "../diagnostics/network";
import type { NotificationSystem } from "../notify/notifications";

/** The filter over the breakdown, in the order the control offers it. */
const USAGE_FILTERS: readonly UsageFilter[] = ["all", "wifi", "cell"];

const FILTER_LABEL: Record<UsageFilter, string> = {
  all: "All",
  wifi: "WiFi",
  cell: "Cellular",
  unknown: "Unattributed",
};

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

  /** Tabbable descendants in DOM order — a disabled A−/A+ drops out on its own. */
  const tabbable = (): HTMLElement[] =>
    dialogEl
      ? [
          ...dialogEl.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ]
      : [];

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
      return;
    }
    // aria-modal="true" tells assistive tech Tab cannot leave this dialog, so
    // it must not: wrap at both ends instead of landing on the app behind.
    if (e.key === "Tab" && dialogEl) {
      const items = tabbable();
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const outside = !dialogEl.contains(active);
      if (!first || !last) {
        e.preventDefault();
        dialogEl.focus();
      } else if (e.shiftKey && (outside || active === first || active === dialogEl)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  // The focus half of the contract in the header comment. Opening moves focus
  // to the dialog itself (tabindex=-1) rather than to the ✕, so Enter doesn't
  // immediately close it and screen readers announce the dialog's label; every
  // close path unmounts the panel, so the restore belongs in onCleanup and
  // covers the ✕, the backdrop and Escape alike.
  let opener: HTMLElement | null = null;
  onMount(() => {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Deferred like the command palette's: the node is in the document by the
    // time the microtask runs.
    queueMicrotask(() => dialogEl?.focus());
  });
  onCleanup(() => {
    if (opener && opener !== document.body && opener.isConnected) opener.focus();
  });
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
  const [filter, setFilter] = createSignal<UsageFilter>("all");
  const [usage, setUsage] = createSignal<UsageAggregate>(
    aggregate(readStore(), new Date(), "all"),
  );
  // The network is live, unlike the counters: it is the one thing on this panel
  // a person opens Settings to check after landing somewhere, and it changes
  // under them rather than on their input.
  const [network, setNetwork] = createSignal<NetworkInfo | null>(currentNetwork());
  const [overrides, setOverrides] = createSignal(networkOverrides());
  const [tier, setTier] = createSignal<TierPreference>(readTierPreference());
  // What the link actually measured last time, which is a different question
  // from what the pin asks for — and the only thing on screen that answers
  // "why am I in light mode?". connection.ts persists the verdict, not the
  // sample behind it, so the throughput and round trip are not available here.
  const measured = readStoredTier();
  const refreshUsage = () => setUsage(aggregate(readStore(), new Date(), filter()));
  const pickFilter = (f: UsageFilter) => {
    setFilter(f);
    refreshUsage();
  };
  const widest = () => Math.max(...usage().buckets.map((b) => b.bytes), 0);
  /** Every period, in the order they are shown, so the table is one loop. Last
   *  month is named rather than called "last month": with four columns there is
   *  no room for both, and a month name is how a bill is labelled anyway. */
  const periods = (): { label: string; totals: PeriodTotals }[] => [
    { label: "Today", totals: usage().today },
    { label: "Last 7 days", totals: usage().last7 },
    { label: "This month", totals: usage().thisMonth },
    { label: usage().lastMonthLabel, totals: usage().lastMonth },
  ];
  /** Bytes nobody could attribute — everything counted before this feature
   *  existed, plus any window whose network the server could not name. Shown
   *  only when there are some, and never folded into WiFi or cellular. */
  const unattributed = () =>
    usage().today.unknown + usage().thisMonth.unknown + usage().lastMonth.unknown;

  /** How the current network reads on screen: the operator and, when it is
   *  known, the country — which is what tells someone they are roaming. */
  const networkName = (): string => {
    const n = network();
    if (!n) return "Checking this network…";
    const label = n.label || (n.net.startsWith("as") ? n.net.toUpperCase() : "This network");
    return n.cc ? `${label} (${n.cc})` : label;
  };
  /** The kind in force for the current network: the person's own answer if they
   *  gave one, else the server's. */
  const networkKind = (): NetKind => {
    const n = network();
    if (!n) return "unknown";
    return overrides()[n.net] ?? n.kind;
  };
  /** Record what this network really is. Kept per network in the roamed prefs,
   *  so it holds on every device and outlives the address. */
  const correctNetwork = (kind: NetOverride): void => {
    const n = network();
    if (!n) return;
    props.prefs.setPref({ netKinds: { ...overrides(), [n.net]: kind } });
    setOverrides(networkOverrides());
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
          {/* One row per period, one column per network kind, with the total
              kept first — it is the figure this panel already answered, and the
              anchor the other two are read against. A table because the
              question this feature exists for, "how much of that was
              cellular", is a comparison, and a comparison wants its numbers
              side by side. */}
          <table class="tl-netusage-totals">
            <thead>
              <tr>
                <th scope="col">
                  <span class="tl-sr-only">Period</span>
                </th>
                <th scope="col">Total</th>
                <th scope="col">WiFi</th>
                <th scope="col">Cellular</th>
              </tr>
            </thead>
            <tbody>
              <For each={periods()}>
                {(p) => (
                  <tr>
                    <th scope="row">{p.label}</th>
                    <td>{formatBytes(p.totals.all)}</td>
                    <td>{formatBytes(p.totals.wifi)}</td>
                    <td>{formatBytes(p.totals.cell)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>

          <Show when={unattributed() > 0}>
            <div class="tl-settings-hint">
              Bytes counted before this device could tell the two apart are in
              the total but in neither column.
            </div>
          </Show>

          {/* The filter narrows the BREAKDOWN only. The four totals above keep
              showing both columns, so switching it never makes a figure a
              person just read appear to move. */}
          <fieldset class="tl-netusage-filter">
            <legend>Breakdown</legend>
            <For each={USAGE_FILTERS}>
              {(value) => (
                <label>
                  <input
                    type="radio"
                    name="tl-usage-filter"
                    value={value}
                    checked={filter() === value}
                    onChange={() => pickFilter(value)}
                  />
                  <span>{FILTER_LABEL[value]}</span>
                </label>
              )}
            </For>
          </fieldset>

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

          {/* Which network you are on right now, and where you correct it. The
              server names the network from the address a request arrives from;
              whether that operator's network is WiFi or cellular is frequently
              not knowable from the name, so this is where you say. */}
          <div class="tl-netusage-current">
            <span class="tl-netusage-netname">{networkName()}</span>
            <label>
              <span class="tl-sr-only">This network is</span>
              <select
                value={networkKind()}
                disabled={!network()}
                onChange={(e) => correctNetwork(e.currentTarget.value as NetOverride)}
              >
                <Show when={networkKind() === "unknown"}>
                  <option value="unknown">Not set</option>
                </Show>
                <option value="wifi">WiFi</option>
                <option value="cell">Cellular</option>
              </select>
            </label>
          </div>
          <div class="tl-settings-hint">
            {network()?.source === "lan"
              ? "On this house's network, so this one is certain."
              : "Set once per network and it is remembered on all your devices."}
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
