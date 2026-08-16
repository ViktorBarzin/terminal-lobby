import { For, Show, onCleanup, onMount, type Accessor, type Component } from "solid-js";
import { THEMES, THEME_LABELS, setTheme, theme } from "../theme/theme";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  NEW_COMMANDS,
  type NewCommand,
  type PrefsStore,
} from "../store/prefs";
import type { NotificationSystem } from "../notify/notifications";

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
            <span>Show when each session was last active</span>
          </label>
          <div class="tl-settings-hint">
            Roams across your devices. A running session still shows its live
            timer, which counts the turn in flight rather than telling you when
            it last did something.
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
      </div>
    </div>
  );
};
