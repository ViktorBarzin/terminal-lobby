import { createSignal, onCleanup, onMount, type Component } from "solid-js";
import type { LobbyStore } from "../store/lobby";
import type { NewCommand, PrefsStore } from "../store/prefs";

const COMMANDS: { value: NewCommand; label: string }[] = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "shell", label: "Plain shell" },
];

/**
 * The new-session row (inventory Cat.2 "Create session"): a name input + a
 * command dropdown + Create. Enter submits. Name validation + the live-dup guard
 * live in store.create (which keeps the typed name on a dup by not clearing).
 *
 * The dropdown is a view of the ROAMED `session.newCommand` pref — the same
 * value the Settings panel binds and the only one the terminal attach reads
 * (App → SessionView → TerminalView → terminalUrl's arg2), so the choice made
 * here is the choice that runs, and it follows the user across devices.
 * `default` is a valid backing value for launcher accounts: it is reflected as
 * `claude` without being written back, so only a real change overwrites it.
 */
export const CreateSessionRow: Component<{ store: LobbyStore; prefs: PrefsStore }> = (props) => {
  const [name, setName] = createSignal("");
  const cmd = (): NewCommand => {
    const v = props.prefs.prefs().session.newCommand;
    return COMMANDS.some((c) => c.value === v) ? v : "claude";
  };
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
    if (ok) setName(""); // keep the typed name on failure (dup guard)
  };

  return (
    <div class="tl-new-row">
      <input
        ref={inputEl}
        class="tl-new-input"
        placeholder="new session…"
        value={name()}
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
        {COMMANDS.map((c) => (
          <option value={c.value}>{c.label}</option>
        ))}
      </select>
      <button class="tl-new-btn" onClick={() => void submit()}>
        Create
      </button>
    </div>
  );
};
