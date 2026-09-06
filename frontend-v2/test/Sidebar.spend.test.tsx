import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { onCleanup } from "solid-js";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { Sidebar } from "../src/components/Sidebar";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import type { LobbyApi } from "../src/lib/lobby-api";
import { createPrefsStore, type PrefsStore } from "../src/store/prefs";
import { emptyLayout, type Layout, type Session, type Whoami } from "../src/types/lobby";
import type { AgentSpend } from "../src/lib/agent-spend";

/**
 * The figure in the sidebar footer: what the session you are attached to has
 * consumed, without opening Settings.
 *
 * It follows the ATTACHED session's tool because that is the number being spent
 * right now. Claude Code computes dollars, so it shows today's; a ChatGPT plan
 * reports none, so Codex shows how much of its tighter limit is gone. A plain
 * shell spends nothing measurable and gets no figure at all — and asks the
 * server for nothing either, which matters on a box that has never run an
 * agent.
 */

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: Math.floor(Date.now() / 1000) - 30,
  created: 1000,
  owner: "wizard",
  ...over,
});

class FakeApi implements LobbyApi {
  whoamiVal: Whoami = { authentik: "wiz", osUser: "wizard" };
  sessionsVal: Session[] = [];
  layoutVal: Layout = emptyLayout();
  async prewarm(_dir: string) {}
  async releasePrewarm(_dir: string) {}
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
    this.layoutVal = l;
  }
  async killSession(n: string) {
    this.sessionsVal = this.sessionsVal.filter((s) => s.name !== n);
  }
  async setSessionTitle() {}
  async restoreSessions() {}
  async listSnapshots() {
    return { snapshots: [], memAvailableMb: -1, perSessionMb: 550 };
  }
  async getSnapshot() {
    return [];
  }
}

const soon = () => Math.floor(Date.now() / 1000) + 3600;

const claudeToday = (costUsd: number): AgentSpend => ({
  period: "today",
  claude: {
    costUsd,
    tokens: { input: 58794, output: 12, cacheRead: 27254, cacheCreation: 31538 },
    models: [],
    sessions: [],
  },
});

const codexNow = (): AgentSpend => ({
  period: "today",
  codex: {
    plan: "plus",
    windows: [
      { label: "5-hour limit", windowMinutes: 300, usedPercent: 4, resetsAtSec: soon() },
      { label: "weekly limit", windowMinutes: 10080, usedPercent: 31, resetsAtSec: soon() },
    ],
    sessions: [],
  },
});

/** Answer /agent-spend with one document; every URL asked for is recorded. */
function stubSpend(doc: AgentSpend): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify(doc), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
  return urls;
}

function mount(api: LobbyApi, onOpenSpend: () => void) {
  let store!: LobbyStore;
  let prefs!: PrefsStore;
  const utils = render(() => {
    store = createLobbyStore({ api, autoStart: false, syncHash: false });
    prefs = createPrefsStore({
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      putDebounceMs: 10_000,
    });
    onCleanup(() => prefs.dispose());
    return <Sidebar store={store} prefs={prefs} onOpenSpend={onOpenSpend} />;
  });
  return { ...utils, store: store!, prefs: prefs! };
}

/** Bring the sidebar up with one session of `tool`, attached. */
async function attached(tool: Session["tool"], doc: AgentSpend, onOpen = () => {}) {
  const api = new FakeApi();
  api.sessionsVal = [sess("agent", { tool })];
  api.layoutVal = { ...emptyLayout(), ungrouped: ["agent"] };
  const urls = stubSpend(doc);
  const m = mount(api, onOpen);
  await m.store.refresh();
  m.store.select("agent");
  return { ...m, urls };
}

const figure = (c: HTMLElement) => c.querySelector<HTMLButtonElement>(".tl-foot-spend");

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the sidebar spend figure", () => {
  it("shows today's dollars while a Claude session is attached", async () => {
    const { container, store } = await attached("claude", claudeToday(4.12));
    await waitFor(() => expect(figure(container)?.textContent).toBe("$4.12"));
    store.dispose();
  });

  it("shows the tighter limit while a Codex session is attached", async () => {
    const { container, store } = await attached("codex", codexNow());
    await waitFor(() => expect(figure(container)?.textContent).toBe("31%"));
    store.dispose();
  });

  it("reads today, whoever is being acted as", async () => {
    const { urls, store } = await attached("claude", claudeToday(4.12));
    await waitFor(() => expect(urls.length).toBeGreaterThan(0));
    expect(urls[0]).toContain("/agent-spend?period=today");
    store.dispose();
  });

  it("shows nothing, and asks nothing, for a plain shell", async () => {
    const { container, urls, store } = await attached("shell", claudeToday(4.12));
    await Promise.resolve();
    expect(figure(container)).toBeNull();
    expect(urls).toEqual([]);
    store.dispose();
  });

  it("shows nothing, and asks nothing, when no session is attached", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("agent", { tool: "claude" })];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["agent"] };
    const urls = stubSpend(claudeToday(4.12));
    const { container, store } = mount(api, () => {});
    await store.refresh();
    expect(figure(container)).toBeNull();
    expect(urls).toEqual([]);
    store.dispose();
  });

  it("goes away when the attached session does", async () => {
    const { container, store } = await attached("claude", claudeToday(4.12));
    await waitFor(() => expect(figure(container)).not.toBeNull());
    store.deselect();
    await waitFor(() => expect(figure(container)).toBeNull());
    store.dispose();
  });

  it("opens the spend page when tapped", async () => {
    const opened: number[] = [];
    const { container, store } = await attached("claude", claudeToday(4.12), () => opened.push(1));
    await waitFor(() => expect(figure(container)).not.toBeNull());
    fireEvent.click(figure(container)!);
    expect(opened).toHaveLength(1);
    store.dispose();
  });

  it("reads once for a run of polls rather than once per poll", async () => {
    const { urls, store } = await attached("claude", claudeToday(4.12));
    await waitFor(() => expect(urls.length).toBe(1));
    for (let i = 0; i < 4; i++) await store.refresh();
    expect(urls.length).toBe(1);
    store.dispose();
  });

  it("says nothing rather than an error when the read fails", async () => {
    const api = new FakeApi();
    api.sessionsVal = [sess("agent", { tool: "claude" })];
    api.layoutVal = { ...emptyLayout(), ungrouped: ["agent"] };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("nope", { status: 500 }))),
    );
    const { container, store } = mount(api, () => {});
    await store.refresh();
    store.select("agent");
    await Promise.resolve();
    await waitFor(() => expect(figure(container)).toBeNull());
    store.dispose();
  });
});
