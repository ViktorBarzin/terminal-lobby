import { createSignal, onCleanup, onMount, type Component } from "solid-js";
import type { LobbyStore } from "../store/lobby";

const CMD_KEY = "tl:new-cmd";
const COMMANDS: { value: string; label: string }[] = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "shell", label: "Plain shell" },
];

function loadCmd(): string {
  try {
    const v = localStorage.getItem(CMD_KEY);
    return v && COMMANDS.some((c) => c.value === v) ? v : "claude";
  } catch {
    return "claude";
  }
}

/**
 * The new-session row (inventory Cat.2 "Create session"): a name input + a
 * command dropdown + Create. Enter submits. Name validation + the live-dup guard
 * live in store.create (which keeps the typed name on a dup by not clearing).
 * The chosen command is persisted per-device and forwarded to the terminal
 * attach that actually spawns the tmux session (ttyd `new-session -A`).
 */
export const CreateSessionRow: Component<{ store: LobbyStore }> = (props) => {
  const [name, setName] = createSignal("");
  const [cmd, setCmd] = createSignal(loadCmd());
  let inputEl: HTMLInputElement | undefined;

  // The session.new command (Alt+Shift+N / palette "New session") focuses this
  // box. App un-collapses the sidebar and dispatches this event.
  const onFocusReq = () => queueMicrotask(() => inputEl?.focus());
  onMount(() => window.addEventListener("tl:focus-new-session", onFocusReq));
  onCleanup(() => window.removeEventListener("tl:focus-new-session", onFocusReq));

  const setCommand = (v: string) => {
    setCmd(v);
    try {
      localStorage.setItem(CMD_KEY, v);
    } catch {
      /* no storage */
    }
  };

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
        onChange={(e) => setCommand(e.currentTarget.value)}
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
