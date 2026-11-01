/**
 * New session with Claude in T3 (docs/plans/2026-10-31-t3-hosts-claude-design.md,
 * "New, rename, archive", decisions 3 and 4).
 *
 * Where Claude starts is a per-user setting, defaulting to what the box says
 * for that user. Send in T3 goes to POST /sessions/t3 and opens the thread the
 * way a T3 row opens, with no tmux card, claim or attach. The strip always
 * offers the other place for one session. Codex, pi and shells are unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { NewSessionComposer } from "../src/components/NewSessionComposer";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import {
  ApiError,
  type ClaimRequest,
  type LobbyApi,
  type T3Created,
  type T3CreateRequest,
} from "../src/lib/lobby-api";
import { emptyLayout, type Layout, type Session, type Whoami } from "../src/types/lobby";
import { createPrefsStore, type PrefsStore } from "../src/store/prefs";
import { closeT3Sheet, t3Sheet } from "../src/lib/t3-open";
import { toasts } from "../src/store/toast";
import { resetPiModels } from "../src/lib/pi-models";

class FakeApi implements LobbyApi {
  whoamiVal: Whoami = { authentik: "wiz", osUser: "wizard", t3: true, claudeBackend: "t3" };
  sessionsVal: Session[] = [];
  layoutVal: Layout = {
    ...emptyLayout(),
    projects: [{ name: "lobby", sessions: [], dir: "/home/wizard/code/lobby" }],
  };
  puts: Layout[] = [];
  created: T3CreateRequest[] = [];
  refuse: ApiError | null = null;
  async setSessionOrigin() {}
  async prewarm() {}
  async releasePrewarm() {}
  async whoami() {
    return this.whoamiVal;
  }
  async listSessions() {
    return this.sessionsVal;
  }
  async getLayout() {
    return this.layoutVal;
  }
  async putLayout(l: Layout) {
    this.puts.push(l);
    this.layoutVal = l;
  }
  async killSession() {}
  async setSessionTitle() {}
  async restoreSessions() {}
  async listSnapshots() {
    return { snapshots: [], memAvailableMb: -1, perSessionMb: 550 };
  }
  async getSnapshot() {
    return [];
  }
  async createT3Session(body: T3CreateRequest): Promise<T3Created> {
    if (this.refuse) throw this.refuse;
    this.created.push(body);
    return {
      name: "t3_abcdefghijkl",
      url: "https://t3.example.test/env/mcp%3A9",
      appUrl: "t3code://threads/env/mcp:9",
      threadId: "mcp:9",
    };
  }
}

interface Mounted {
  store: LobbyStore;
  prefs: PrefsStore;
  container: HTMLElement;
  claims: ClaimRequest[];
  delivered: string[];
}

function mount(api: FakeApi, project = ""): Mounted {
  let store!: LobbyStore;
  let prefs!: PrefsStore;
  const claims: ClaimRequest[] = [];
  const delivered: string[] = [];
  const utils = render(() => {
    store = createLobbyStore({ api, autoStart: false, syncHash: false });
    prefs = createPrefsStore({ fetchImpl: async () => new Response("{}", { status: 200 }) });
    return (
      <NewSessionComposer
        store={store}
        prefs={prefs}
        available={() => ({})}
        project={() => project}
        onProject={() => {}}
        catalogue={async () => ({ commands: [], ok: true })}
        claim={async (body) => {
          claims.push(body);
          return { claimed: true, found: "claimed" };
        }}
        report={() => {}}
        deliver={async (o) => {
          delivered.push(o.session);
          return true;
        }}
      />
    );
  });
  return { store, prefs, container: utils.container, claims, delivered };
}

const field = (c: HTMLElement) =>
  c.querySelector<HTMLTextAreaElement>("textarea.tl-composer-input:not(.tl-new-name)")!;
const type = (el: HTMLTextAreaElement, text: string) => {
  el.value = text;
  fireEvent.input(el, { target: { value: text } });
};
const send = (c: HTMLElement, text: string) => {
  type(field(c), text);
  fireEvent.keyDown(field(c), { key: "Enter" });
};
const commandList = (c: HTMLElement): HTMLElement => {
  const btn = c.querySelector<HTMLButtonElement>('.tl-new-strip [data-strip="command"]')!;
  if (btn.getAttribute("aria-expanded") !== "true") fireEvent.click(btn);
  return document.querySelector<HTMLElement>(
    '[role="radiogroup"][aria-label="Command for new session"]',
  )!;
};
const values = (list: HTMLElement) =>
  [...list.querySelectorAll('[role="radio"]')].map((r) => r.getAttribute("data-value"));
const chosen = (list: HTMLElement) =>
  list.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute("data-value");
const row = (list: HTMLElement, v: string) =>
  list.querySelector<HTMLElement>(`[role="radio"][data-value="${v}"]`)!;

/** A device with a mouse (true) or a touch screen (false). */
function pointer(fine: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (q: string) =>
      ({
        matches: q.includes("fine") ? fine : q.includes("coarse") ? !fine : false,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

/** window.open, answering a tab the test can read back. */
function tabs() {
  const opened: { args: unknown[]; tab: { location: { href: string }; close: () => void } }[] = [];
  vi.stubGlobal("open", (...args: unknown[]) => {
    const tab = { location: { href: String(args[0]) }, close: vi.fn(), opener: window };
    opened.push({ args, tab });
    return tab;
  });
  return opened;
}

beforeEach(() => {
  localStorage.clear();
  toasts.clear();
  resetPiModels();
  pointer(true);
});
afterEach(() => {
  cleanup();
  closeT3Sheet();
  vi.unstubAllGlobals();
});

describe("<NewSessionComposer> — Claude in T3", () => {
  it("starts the prompt in T3 when T3 is the user's default, and opens it in a tab", async () => {
    const api = new FakeApi();
    const opened = tabs();
    const m = mount(api, "lobby");
    await m.store.refresh();

    send(m.container, "Fix the login page\nit 500s");

    await waitFor(() => expect(api.created).toHaveLength(1));
    expect(api.created[0]).toEqual({
      dir: "/home/wizard/code/lobby",
      prompt: "Fix the login page\nit 500s",
      model: "",
      effort: "",
      project: "lobby",
    });
    // The tab was opened blank on the press and sent to the thread after.
    expect(opened).toHaveLength(1);
    expect(opened[0]!.args[0]).toBe("about:blank");
    await waitFor(() =>
      expect(opened[0]!.tab.location.href).toBe("https://t3.example.test/env/mcp%3A9"),
    );
    // No tmux card, no claim, no first-prompt delivery, nothing selected.
    expect(api.puts).toHaveLength(0);
    expect(m.claims).toHaveLength(0);
    expect(m.delivered).toHaveLength(0);
    expect(m.store.selected()).toBeNull();
    m.store.dispose();
  });

  it("offers the app or the browser on a touch screen instead of a tab", async () => {
    pointer(false);
    const api = new FakeApi();
    const opened = tabs();
    const m = mount(api);
    await m.store.refresh();
    // A phone's Enter is a newline; the round button sends.
    type(field(m.container), "hello");
    fireEvent.click(m.container.querySelector<HTMLButtonElement>(".tl-pill .tl-send")!);
    await waitFor(() => expect(t3Sheet()).not.toBeNull());
    expect(t3Sheet()).toMatchObject({
      url: "https://t3.example.test/env/mcp%3A9",
      appUrl: "t3code://threads/env/mcp:9",
      title: "hello",
    });
    expect(opened).toHaveLength(0);
    m.store.dispose();
  });

  it("sends the chosen model and effort, ultracode as xhigh", async () => {
    const api = new FakeApi();
    tabs();
    const m = mount(api);
    await m.store.refresh();
    m.prefs.setPref({ session: { newModel: "claude-sonnet-5", newEffort: "ultracode" } });
    send(m.container, "go");
    await waitFor(() => expect(api.created).toHaveLength(1));
    expect(api.created[0]).toMatchObject({ model: "claude-sonnet-5", effort: "xhigh" });
    m.store.dispose();
  });

  it("closes the reserved tab and keeps the prompt when T3 refuses", async () => {
    const api = new FakeApi();
    api.refuse = new ApiError(502, "T3 did not answer: connection refused");
    const opened = tabs();
    const m = mount(api);
    await m.store.refresh();
    send(m.container, "keep me");
    await waitFor(() => expect(opened[0]?.tab.close).toHaveBeenCalled());
    expect(field(m.container).value).toBe("keep me");
    m.store.dispose();
  });

  it("starts a tmux Claude when the user's default is the terminal", async () => {
    const api = new FakeApi();
    api.whoamiVal = { ...api.whoamiVal, claudeBackend: "tmux" };
    const m = mount(api);
    await m.store.refresh();
    send(m.container, "in a terminal");
    await waitFor(() => expect(m.store.selected()).not.toBeNull());
    expect(api.created).toHaveLength(0);
    expect(api.puts).toHaveLength(1);
    m.store.dispose();
  });

  it("follows the user's own setting over the box's default", async () => {
    const api = new FakeApi();
    api.whoamiVal = { ...api.whoamiVal, claudeBackend: "tmux" };
    tabs();
    const m = mount(api);
    await m.store.refresh();
    m.prefs.setPref({ session: { claudeBackend: "t3" } });
    send(m.container, "in T3 please");
    await waitFor(() => expect(api.created).toHaveLength(1));
    m.store.dispose();
  });

  it("never starts in T3 for a user with no T3, whatever the setting says", async () => {
    const api = new FakeApi();
    api.whoamiVal = { authentik: "emo", osUser: "emo" };
    const m = mount(api);
    await m.store.refresh();
    m.prefs.setPref({ session: { claudeBackend: "t3" } });
    expect(values(commandList(m.container))).toEqual(["claude", "codex", "pi", "shell"]);
    send(m.container, "here");
    await waitFor(() => expect(m.store.selected()).not.toBeNull());
    expect(api.created).toHaveLength(0);
    m.store.dispose();
  });

  it("lists Claude in T3 and Claude in Terminal, the default marked as such", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    const list = commandList(m.container);
    expect(values(list)).toEqual(["claude:t3", "claude:tmux", "codex", "pi", "shell"]);
    expect(chosen(list)).toBe("claude:t3");
    expect(row(list, "claude:t3").textContent).toContain("Your default");
    expect(row(list, "claude:tmux").textContent).toContain("This session only");
    const strip = m.container.querySelector('.tl-new-strip [data-strip="command"]')!;
    expect(strip.getAttribute("aria-label")).toBe("Command for new session: Claude in T3");
    m.store.dispose();
  });

  it("starts one tmux Claude from the strip without changing the setting", async () => {
    const api = new FakeApi();
    const m = mount(api);
    await m.store.refresh();
    fireEvent.click(row(commandList(m.container), "claude:tmux"));
    expect(m.prefs.prefs().session.claudeBackend).toBe("");
    expect(chosen(commandList(m.container))).toBe("claude:tmux");
    send(m.container, "this once in a terminal");
    await waitFor(() => expect(m.store.selected()).not.toBeNull());
    expect(api.created).toHaveLength(0);
    m.store.dispose();
  });

  it("starts one T3 Claude from the strip when the default is the terminal", async () => {
    const api = new FakeApi();
    api.whoamiVal = { ...api.whoamiVal, claudeBackend: "tmux" };
    tabs();
    const m = mount(api);
    await m.store.refresh();
    const list = commandList(m.container);
    expect(chosen(list)).toBe("claude:tmux");
    fireEvent.click(row(list, "claude:t3"));
    send(m.container, "this once in T3");
    await waitFor(() => expect(api.created).toHaveLength(1));
    // The one-session pick is spent: the next one is the default again.
    await waitFor(() => expect(chosen(commandList(m.container))).toBe("claude:tmux"));
    m.store.dispose();
  });

  it("leaves codex where it was", async () => {
    const api = new FakeApi();
    const m = mount(api);
    await m.store.refresh();
    fireEvent.click(row(commandList(m.container), "codex"));
    send(m.container, "codex this");
    await waitFor(() => expect(m.store.selected()).not.toBeNull());
    expect(api.created).toHaveLength(0);
    m.store.dispose();
  });
});
