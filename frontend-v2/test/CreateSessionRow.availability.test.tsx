import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { CreateSessionRow } from "../src/components/CreateSessionRow";
import { PREF_DEFAULTS, type NewCommand, type Prefs, type PrefsStore } from "../src/store/prefs";
import type { CommandAvailability } from "../src/lib/new-commands";
import type { LobbyStore } from "../src/store/lobby";

afterEach(cleanup);

function fakePrefs(newCommand: NewCommand): PrefsStore {
  const base = structuredClone(PREF_DEFAULTS);
  base.session.newCommand = newCommand;
  const [prefs, setPrefs] = createSignal<Prefs>(base);
  return {
    prefs,
    setPref(patch: { session?: { newCommand?: NewCommand } }) {
      if (patch.session?.newCommand) {
        setPrefs((p) => ({ ...p, session: { ...p.session, newCommand: patch.session!.newCommand! } }));
      }
    },
    setFontSize() {},
    async bootSync() {},
    dispose() {},
  } as unknown as PrefsStore;
}

const fakeStore = () => ({ async create() { return true; } }) as unknown as LobbyStore;

function row(pref: NewCommand, available: CommandAvailability) {
  return render(() => (
    <CreateSessionRow store={fakeStore()} prefs={fakePrefs(pref)} available={() => available} />
  ));
}

const select = (c: HTMLElement) =>
  c.querySelector<HTMLSelectElement>('select[aria-label="Command for new session"]')!;
const option = (c: HTMLElement, value: string) =>
  Array.from(select(c).options).find((o) => o.value === value)!;

describe("the new-session command dropdown reflects what the box can run", () => {
  // The whole point: a command with nothing behind it starts a session that
  // closes immediately and says nothing. Greying it out is what tells the user
  // there is a binary to install first.
  it("disables a command the box cannot run", () => {
    const { container } = row("claude", { claude: true, codex: false, shell: true });
    expect(option(container, "codex").disabled).toBe(true);
    expect(option(container, "claude").disabled).toBe(false);
    expect(option(container, "shell").disabled).toBe(false);
  });

  it("says why, in the option itself", () => {
    const { container } = row("claude", { codex: false });
    expect(option(container, "codex").textContent).toMatch(/not installed/i);
    expect(option(container, "claude").textContent).toBe("Claude");
  });

  // A stored preference outlives the tool it names: pick Claude, then run an
  // image without it. Leaving it selected would put Create back to handing out
  // sessions that die on open.
  it("selects something that runs when the stored preference does not", () => {
    const { container } = row("claude", { claude: false, codex: false, shell: true });
    expect(select(container).value).toBe("shell");
  });

  it("keeps the stored preference when it runs", () => {
    const { container } = row("codex", { claude: true, codex: true, shell: true });
    expect(select(container).value).toBe("codex");
  });

  // Every failure on the way to an answer arrives as an empty map. None of them
  // may take a working tool away from the user.
  it("disables nothing when the server said nothing", () => {
    const { container } = row("claude", {});
    for (const v of ["claude", "codex", "shell"]) {
      expect(option(container, v).disabled, `${v} disabled`).toBe(false);
    }
    expect(select(container).value).toBe("claude");
  });
});
