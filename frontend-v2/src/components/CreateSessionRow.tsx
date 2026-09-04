import { createSignal, For, onCleanup, onMount, type Component } from "solid-js";
import type { LobbyStore } from "../store/lobby";
import type { NewCommand, PrefsStore } from "../store/prefs";
import { MAX_TITLE_RUNES } from "../lib/title";
import {
  canRun,
  COMMAND_LABELS,
  effectiveCommand,
  NEW_SESSION_COMMANDS as COMMANDS,
  type CommandAvailability,
} from "../lib/new-commands";

/**
 * The new-session row (inventory Cat.2 "Create session"): a title input + a
 * command dropdown + Create. Enter submits. A create that did not land keeps
 * the typed text, so it can be sent again.
 *
 * The box takes a TITLE — any text, any script. The session's tmux name is a
 * minted id that never appears here and never moves (ADR-0019), so two
 * sessions may carry the same title and nothing collides.
 *
 * The dropdown is a view of the ROAMED `session.newCommand` pref — the same
 * value the Settings panel binds and the only one the terminal attach reads
 * (App → SessionView → TerminalView → terminalUrl's arg2), so the choice made
 * here is the choice that runs, and it follows the user across devices.
 * `default` is a valid backing value for launcher accounts: it is reflected as
 * the first command that runs without being written back, so only a real change
 * overwrites it.
 *
 * `available` says which commands this box can actually start. One it cannot is
 * greyed out and labelled, because the alternative is offering it and handing
 * back a session that closes the moment it opens. A command the server said
 * nothing about stays enabled, so nothing here can take away a working tool.
 */
export const CreateSessionRow: Component<{
  store: LobbyStore;
  prefs: PrefsStore;
  available?: () => CommandAvailability;
}> = (props) => {
  const [name, setName] = createSignal("");
  const avail = (): CommandAvailability => props.available?.() ?? {};
  const cmd = (): NewCommand =>
    effectiveCommand(props.prefs.prefs().session.newCommand, avail(), COMMANDS);
  let inputEl: HTMLInputElement | undefined;

  // The session.new command (Alt+Shift+N / palette "New session") focuses this
  // box. App un-collapses the sidebar and dispatches this event.
  const onFocusReq = () => queueMicrotask(() => inputEl?.focus());
  onMount(() => window.addEventListener("tl:focus-new-session", onFocusReq));
  onCleanup(() => window.removeEventListener("tl:focus-new-session", onFocusReq));

  const submit = async () => {
    const n = name().trim();
    if (!n) return;
    const ok = await props.store.create(n, "");
    if (ok) setName(""); // a create that failed keeps its text to retry with
  };

  return (
    <div class="tl-new-row">
      <input
        ref={inputEl}
        class="tl-new-input"
        placeholder="new session…"
        value={name()}
        maxlength={MAX_TITLE_RUNES}
        aria-label="New session name"
        onInput={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />
      <select
        class="tl-new-cmd"
        aria-label="Command for new session"
        value={cmd()}
        onChange={(e) =>
          props.prefs.setPref({ session: { newCommand: e.currentTarget.value as NewCommand } })
        }
      >
        <For each={COMMANDS}>
          {(c) => (
            <option value={c} disabled={!canRun(c, avail())}>
              {COMMAND_LABELS[c]}
              {canRun(c, avail()) ? "" : " (not installed)"}
            </option>
          )}
        </For>
      </select>
      <button class="tl-new-btn" onClick={() => void submit()}>
        Create
      </button>
    </div>
  );
};
