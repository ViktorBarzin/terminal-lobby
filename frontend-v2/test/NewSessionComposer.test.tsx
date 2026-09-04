/**
 * The new-session composer: you type what you want to do, press Enter, and the
 * session is created.
 *
 * Naming left the critical path entirely (ADR-0019, docs/plans/2026-09-04-
 * prompt-first-sessions-design.md). What it replaced was a box that refused to
 * be empty, so a name had to be chosen before the session existed — which is
 * before there was any work to name it after.
 *
 * The command-availability cases came from CreateSessionRow.availability.test.tsx
 * with the row they tested; the behaviour they pin (a command with nothing
 * behind it hands back a session that dies on open) is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { NewSessionComposer } from "../src/components/NewSessionComposer";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import { emptyLayout, sessionLabel, type Layout, type Session, type Whoami } from "../src/types/lobby";
import { isSessionId } from "../src/lib/session-id";
import {
  createPrefsStore,
  PREFS_KEY,
  type PrefsStore,
} from "../src/store/prefs";
import type { CommandAvailability } from "../src/lib/new-commands";

class FakeApi implements LobbyApi {
  whoamiVal: Whoami = { authentik: "wiz", osUser: "wizard" };
  sessionsVal: Session[] = [];
  layoutVal: Layout = emptyLayout();
  puts: Layout[] = [];
  prewarmed: string[] = [];
  released: string[] = [];
  titles: [string, string][] = [];
  async prewarm(dir: string) {
    this.prewarmed.push(dir);
  }
  async releasePrewarm(dir: string) {
    this.released.push(dir);
  }
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
  async setSessionTitle(name: string, title: string) {
    this.titles.push([name, title]);
    throw new ApiError(404, "not up yet");
  }
  async restoreSessions() {}
  async listSnapshots() {
    return { snapshots: [], memAvailableMb: -1, perSessionMb: 550 };
  }
  async getSnapshot() {
    return [];
  }
}

interface Mounted {
  store: LobbyStore;
  prefs: PrefsStore;
  container: HTMLElement;
  setPreset: (name: string | null) => void;
  unmount: () => void;
}

function mount(api: FakeApi, available: CommandAvailability = {}): Mounted {
  let store!: LobbyStore;
  let prefs!: PrefsStore;
  const [preset, setPreset] = createSignal<string | null>(null);
  const utils = render(() => {
    store = createLobbyStore({ api, autoStart: false, syncHash: false });
    prefs = createPrefsStore({ fetchImpl: async () => new Response("{}", { status: 200 }) });
    const project = () => {
      const want = preset() ?? prefs.prefs().session.newProject;
      return store.layout().projects.some((p) => p.name === want) ? want : "";
    };
    return (
      <NewSessionComposer
        store={store}
        prefs={prefs}
        available={() => available}
        project={project}
        onProject={(name) => {
          setPreset(name);
          prefs.setPref({ session: { newProject: name } });
        }}
      />
    );
  });
  return { store, prefs, container: utils.container, setPreset, unmount: utils.unmount };
}

const field = (c: HTMLElement) =>
  c.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt for a new session"]');
const nameBox = (c: HTMLElement) =>
  c.querySelector<HTMLInputElement>('input[aria-label="Name for the new session"]');
const pick = (c: HTMLElement, label: string) =>
  c.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
const option = (sel: HTMLSelectElement, value: string) =>
  Array.from(sel.options).find((o) => o.value === value)!;

const type = (el: HTMLTextAreaElement | HTMLInputElement, text: string) => {
  el.value = text;
  fireEvent.input(el, { target: { value: text } });
};
const enter = (el: HTMLElement) => fireEvent.keyDown(el, { key: "Enter" });

/** What the sidebar would show for a session — the optimistic card included,
 *  which is where a just-created one lives until the first poll knows it. */
const labelOf = (store: LobbyStore, name: string): string =>
  sessionLabel(
    store.model().groups.flatMap((g) => g.sessions).find((s) => s.name === name) ?? { name },
  );

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("<NewSessionComposer> — creating from a prompt", () => {
  it("creates a session from what you typed, with no name asked for", async () => {
    const api = new FakeApi();
    const m = mount(api);
    await m.store.refresh();

    type(field(m.container)!, "Fix the deploy\nit 500s on the second push");
    enter(field(m.container)!);

    await waitFor(() => expect(m.store.selected()).not.toBeNull());
    expect(api.puts.length).toBe(1);
    const id = api.puts[0]!.ungrouped[0]!;
    expect(isSessionId(id)).toBe(true);
    expect(m.store.selected()?.name).toBe(id);
    // Until Claude's summary lands, the card reads the prompt's first line.
    expect(labelOf(m.store, id)).toBe("Fix the deploy");
    m.store.dispose();
  });

  it("creates from an EMPTY box, which is the whole point of the change", async () => {
    const api = new FakeApi();
    const m = mount(api);
    await m.store.refresh();

    enter(field(m.container)!);

    await waitFor(() => expect(api.puts.length).toBe(1));
    expect(m.store.toast()).toBeNull();
    expect(labelOf(m.store, api.puts[0]!.ungrouped[0]!)).toBe("New session");
    m.store.dispose();
  });

  it("clears the field after a create, so the next prompt starts empty", async () => {
    const api = new FakeApi();
    const m = mount(api);
    await m.store.refresh();

    type(field(m.container)!, "Fix the deploy");
    enter(field(m.container)!);
    await waitFor(() => expect(api.puts.length).toBe(1));
    expect(field(m.container)!.value).toBe("");
    m.store.dispose();
  });

  it("Shift+Enter writes a newline instead of creating", async () => {
    const api = new FakeApi();
    const m = mount(api);
    await m.store.refresh();

    type(field(m.container)!, "line one");
    fireEvent.keyDown(field(m.container)!, { key: "Enter", shiftKey: true });
    await Promise.resolve();
    expect(api.puts.length).toBe(0);
    m.store.dispose();
  });
});

describe("<NewSessionComposer> — the project it creates in", () => {
  const withProjects = (api: FakeApi): void => {
    api.layoutVal = {
      ...emptyLayout(),
      projects: [
        { name: "alpha", sessions: [], dir: "/home/wizard/code/alpha" },
        { name: "beta", sessions: [], dir: "/home/wizard/code/beta" },
      ],
    };
  };

  it("offers Ungrouped and every project, and starts on the roamed preference", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newProject: "beta" } }));
    const api = new FakeApi();
    withProjects(api);
    const m = mount(api);
    await m.store.refresh();

    const sel = pick(m.container, "Project for new session");
    await waitFor(() => expect(sel.value).toBe("beta"));
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(["", "alpha", "beta"]);
    m.store.dispose();
  });

  it("falls back to Ungrouped when the remembered project is gone", async () => {
    // Deleting a project must not send the next create into a group that no
    // longer exists; the PREF is left alone, so recreating it brings it back.
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newProject: "deleted" } }));
    const api = new FakeApi();
    withProjects(api);
    const m = mount(api);
    await m.store.refresh();

    await waitFor(() => expect(pick(m.container, "Project for new session").value).toBe(""));
    expect(m.prefs.prefs().session.newProject).toBe("deleted");
    m.store.dispose();
  });

  it("creates into the chosen project and remembers it for next time", async () => {
    const api = new FakeApi();
    withProjects(api);
    const m = mount(api);
    await m.store.refresh();

    fireEvent.change(pick(m.container, "Project for new session"), { target: { value: "alpha" } });
    expect(m.prefs.prefs().session.newProject).toBe("alpha");

    type(field(m.container)!, "Fix the deploy");
    enter(field(m.container)!);
    await waitFor(() => expect(api.puts.length).toBe(1));
    const put = api.puts[0]!;
    expect(put.projects.find((p) => p.name === "alpha")!.sessions).toHaveLength(1);
    expect(put.ungrouped).toEqual([]);
    m.store.dispose();
  });

  it("follows the project the sidebar's + preselected", async () => {
    const api = new FakeApi();
    withProjects(api);
    const m = mount(api);
    await m.store.refresh();

    m.setPreset("beta");
    await waitFor(() => expect(pick(m.container, "Project for new session").value).toBe("beta"));
    m.store.dispose();
  });
});

/**
 * Speculative pre-warming, moved here from the sidebar's inline create box.
 *
 * Opening the composer is the earliest moment a session's directory is known,
 * and it is seconds ahead of the prompt being typed — long enough to cover most
 * of Claude's ~2.4s boot, which is 89% of what creating a session used to cost.
 *
 * What is worth pinning is not "does it call the endpoint" but WHEN it hands
 * the slot back, because both mistakes are silent: releasing after a successful
 * create races the attach and loses the benefit exactly when it matters, and
 * never releasing leaves ~530MB per abandoned box.
 */
describe("<NewSessionComposer> — speculative pre-warm", () => {
  const withProjects = (api: FakeApi): void => {
    api.layoutVal = {
      ...emptyLayout(),
      projects: [
        { name: "alpha", sessions: [], dir: "/home/wizard/code/alpha" },
        { name: "beta", sessions: [], dir: "/home/wizard/code/beta" },
        { name: "nodir", sessions: [] },
      ],
    };
  };

  it("warms the selected project's dir as soon as the composer is on screen", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newProject: "alpha" } }));
    const api = new FakeApi();
    withProjects(api);
    const m = mount(api);
    await m.store.refresh();
    await waitFor(() => expect(api.prewarmed).toEqual(["/home/wizard/code/alpha"]));
    m.store.dispose();
  });

  it("hands the old slot back and warms the new one when the project changes", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newProject: "alpha" } }));
    const api = new FakeApi();
    withProjects(api);
    const m = mount(api);
    await m.store.refresh();
    await waitFor(() => expect(api.prewarmed).toEqual(["/home/wizard/code/alpha"]));

    fireEvent.change(pick(m.container, "Project for new session"), { target: { value: "beta" } });
    await waitFor(() => expect(api.prewarmed).toEqual([
      "/home/wizard/code/alpha",
      "/home/wizard/code/beta",
    ]));
    expect(api.released).toEqual(["/home/wizard/code/alpha"]);
    m.store.dispose();
  });

  it("does not warm a project with no dir, since that would warm $HOME", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newProject: "nodir" } }));
    const api = new FakeApi();
    withProjects(api);
    const m = mount(api);
    await m.store.refresh();
    await Promise.resolve();
    expect(api.prewarmed).toEqual([]);
    m.store.dispose();
  });

  it("hands the slot back when the composer goes away with nothing created", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newProject: "alpha" } }));
    const api = new FakeApi();
    withProjects(api);
    const m = mount(api);
    await m.store.refresh();
    await waitFor(() => expect(api.prewarmed.length).toBe(1));

    m.store.dispose();
    m.unmount();
    await waitFor(() => expect(api.released).toEqual(["/home/wizard/code/alpha"]));
  });

  it("KEEPS the slot after a create, for the attach to claim", async () => {
    // create() only STARTS the attach — the iframe still has to connect and
    // reach ttyd — so releasing here reliably wins the race and the create
    // falls back to a cold start.
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newProject: "alpha" } }));
    const api = new FakeApi();
    withProjects(api);
    const m = mount(api);
    await m.store.refresh();
    await waitFor(() => expect(api.prewarmed.length).toBe(1));

    type(field(m.container)!, "Fix the deploy");
    enter(field(m.container)!);
    await waitFor(() => expect(api.puts.length).toBe(1));
    expect(api.released).toEqual([]);
    m.store.dispose();
  });
});

describe("<NewSessionComposer> — the command it runs", () => {
  // The whole point: a command with nothing behind it starts a session that
  // closes immediately and says nothing. Greying it out is what tells the user
  // there is a binary to install first.
  it("disables a command the box cannot run", async () => {
    const m = mount(new FakeApi(), { claude: true, codex: false, shell: true });
    await m.store.refresh();
    const sel = pick(m.container, "Command for new session");
    expect(option(sel, "codex").disabled).toBe(true);
    expect(option(sel, "claude").disabled).toBe(false);
    expect(option(sel, "shell").disabled).toBe(false);
    m.store.dispose();
  });

  it("says why, in the option itself", async () => {
    const m = mount(new FakeApi(), { codex: false });
    await m.store.refresh();
    const sel = pick(m.container, "Command for new session");
    expect(option(sel, "codex").textContent).toMatch(/not installed/i);
    expect(option(sel, "claude").textContent).toBe("Claude");
    m.store.dispose();
  });

  // A stored preference outlives the tool it names: pick Claude, then run an
  // image without it. Leaving it selected would put the composer back to
  // handing out sessions that die on open.
  it("selects something that runs when the stored preference does not", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newCommand: "claude" } }));
    const m = mount(new FakeApi(), { claude: false, codex: false, shell: true });
    await m.store.refresh();
    await waitFor(() =>
      expect(pick(m.container, "Command for new session").value).toBe("shell"),
    );
    m.store.dispose();
  });

  it("keeps the stored preference when it runs", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newCommand: "codex" } }));
    const m = mount(new FakeApi(), { claude: true, codex: true, shell: true });
    await m.store.refresh();
    await waitFor(() =>
      expect(pick(m.container, "Command for new session").value).toBe("codex"),
    );
    m.store.dispose();
  });

  // Every failure on the way to an answer arrives as an empty map. None of them
  // may take a working tool away from the user.
  it("disables nothing when the server said nothing", async () => {
    const m = mount(new FakeApi(), {});
    await m.store.refresh();
    const sel = pick(m.container, "Command for new session");
    for (const v of ["claude", "codex", "shell"]) {
      expect(option(sel, v).disabled, `${v} disabled`).toBe(false);
    }
    expect(sel.value).toBe("claude");
    m.store.dispose();
  });

  it("binds the dropdown to the roamed pref", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    fireEvent.change(pick(m.container, "Command for new session"), {
      target: { value: "codex" },
    });
    expect(m.prefs.prefs().session.newCommand).toBe("codex");
    m.store.dispose();
  });
});

describe("<NewSessionComposer> — shell turns the box back into a name box", () => {
  it("swaps the prompt field for a name field", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newCommand: "shell" } }));
    const m = mount(new FakeApi());
    await m.store.refresh();
    await waitFor(() => expect(nameBox(m.container)).not.toBeNull());
    expect(field(m.container)).toBeNull();
    // Nothing summarises a shell, so there is no model to choose either.
    expect(m.container.querySelector('select[aria-label="Model for new session"]')).toBeNull();
    m.store.dispose();
  });

  it("stamps the typed name as the title, because no summary is coming", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newCommand: "shell" } }));
    const api = new FakeApi();
    const m = mount(api);
    await m.store.refresh();
    await waitFor(() => expect(nameBox(m.container)).not.toBeNull());

    type(nameBox(m.container)!, "scratch");
    enter(nameBox(m.container)!);

    await waitFor(() => expect(api.puts.length).toBe(1));
    const id = api.puts[0]!.ungrouped[0]!;
    expect(isSessionId(id)).toBe(true);
    expect(labelOf(m.store, id)).toBe("scratch");
    m.store.dispose();
  });
});

describe("<NewSessionComposer> — the model it starts on", () => {
  it("offers the models and binds the roamed pref", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    const sel = pick(m.container, "Model for new session");
    expect(Array.from(sel.options).map((o) => o.value)).toEqual([
      "default",
      "opus",
      "sonnet",
      "haiku",
    ]);
    expect(sel.value).toBe("default");
    fireEvent.change(sel, { target: { value: "sonnet" } });
    expect(m.prefs.prefs().session.newModel).toBe("sonnet");
    m.store.dispose();
  });
});
