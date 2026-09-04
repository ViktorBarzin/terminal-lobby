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
import { createSignal, Show } from "solid-js";
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
import { DRAFTS_KEY, loadDraft, type DraftAttachment } from "../src/store/drafts";
import { toasts } from "../src/store/toast";
import { NEW_SESSION_DRAFT_KEY } from "../src/components/NewSessionComposer";

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
  wire: Wire;
}

/**
 * What the composer did with the prompt after it created the session.
 *
 * Delivery and upload are seams, so every test drives them rather than the
 * network. The ladder they replace is covered on its own in
 * test/first-prompt.test.ts, where the timing is the subject.
 */
interface Wire {
  delivered: { session: string; lines: readonly string[]; awaitReady: boolean }[];
  uploads: { files: readonly File[]; session: string }[];
  /** What each upload answers with, in order; the last answer repeats. */
  chips: DraftAttachment[][];
  /** What each delivery answers with, in order; the last answer repeats. */
  results: boolean[];
}

function mount(
  api: FakeApi,
  available: CommandAvailability = {},
  wire: Wire = { delivered: [], uploads: [], chips: [[]], results: [true] },
): Mounted {
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
        upload={async (files, session) => {
          wire.uploads.push({ files, session });
          const i = Math.min(wire.uploads.length - 1, wire.chips.length - 1);
          return wire.chips[i] ?? [];
        }}
        deliver={async (o) => {
          wire.delivered.push({
            session: o.session,
            lines: o.lines,
            awaitReady: o.awaitReady ?? false,
          });
          const i = Math.min(wire.delivered.length - 1, wire.results.length - 1);
          return wire.results[i] ?? true;
        }}
      />
    );
  });
  return { store, prefs, container: utils.container, setPreset, unmount: utils.unmount, wire };
}

const emptyWire = (): Wire => ({ delivered: [], uploads: [], chips: [[]], results: [true] });

/** Hand a picked file to the composer's tray, the way the file input does. */
const pickFile = (c: HTMLElement, ...files: File[]): void => {
  const input = c.querySelector<HTMLInputElement>("input[type=file]")!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
};

const aFile = (name: string, type = "image/png"): File =>
  new File([new Uint8Array([1, 2, 3])], name, { type });


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

beforeEach(() => {
  localStorage.clear();
  toasts.clear();
});
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

  // The sidebar's + preselects a project for ONE create. Creating into it has
  // to record the choice, or "the next session lands where the last one did"
  // is only true for people who touch the dropdown — and the dropdown is the
  // step the composer exists to remove. Viktor, 2026-09-04: "I just created one
  // new session and it was put in the ungrouped section."
  it("remembers a project the sidebar's + chose, so the NEXT create lands there", async () => {
    const api = new FakeApi();
    withProjects(api);
    const m = mount(api);
    await m.store.refresh();

    m.setPreset("beta");
    await waitFor(() => expect(pick(m.container, "Project for new session").value).toBe("beta"));

    type(field(m.container)!, "Fix the deploy");
    enter(field(m.container)!);
    await waitFor(() => expect(api.puts.length).toBe(1));
    expect(api.puts[0]!.projects.find((p) => p.name === "beta")!.sessions).toHaveLength(1);

    // The create is what makes it the last one, so the preference follows it.
    await waitFor(() => expect(m.prefs.prefs().session.newProject).toBe("beta"));
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

  it("KEEPS the slot even though creating UNMOUNTS the composer", async () => {
    // App shows the composer behind <Show when={!selectedName()}>, so the
    // create's own select() unmounts it and onCleanup(releaseWarm) runs. The
    // create also writes the layout, which sets the layout signal synchronously
    // and re-runs the warm effect while the composer is still there — so
    // without the hand-off flag the cleanup would hand back the slot ttyd is
    // about to claim, and every create into a named project would boot cold.
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newProject: "alpha" } }));
    const api = new FakeApi();
    withProjects(api);
    let store!: LobbyStore;
    const utils = render(() => {
      store = createLobbyStore({ api, autoStart: false, syncHash: false });
      const prefs = createPrefsStore({
        fetchImpl: async () => new Response("{}", { status: 200 }),
      });
      const project = () => prefs.prefs().session.newProject;
      return (
        <Show when={!store.selected()}>
          <NewSessionComposer
            store={store}
            prefs={prefs}
            project={project}
            onProject={() => {}}
            upload={async () => []}
            deliver={async () => true}
          />
        </Show>
      );
    });
    await store.refresh();
    await waitFor(() => expect(api.prewarmed).toEqual(["/home/wizard/code/alpha"]));

    type(field(utils.container)!, "Fix the deploy");
    enter(field(utils.container)!);

    // The composer really is gone — this is the unmount the release rode on.
    await waitFor(() => expect(store.selected()).not.toBeNull());
    await waitFor(() => expect(field(utils.container)).toBeNull());
    await Promise.resolve();
    expect(api.released).toEqual([]);
    // And it did not ask for a second slot on the way out either.
    expect(api.prewarmed).toEqual(["/home/wizard/code/alpha"]);
    store.dispose();
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

describe("<NewSessionComposer> — the first prompt", () => {
  const created = (api: FakeApi): string => api.puts[0]!.ungrouped[0]!;

  it("sends what you typed to the session it just created", async () => {
    const api = new FakeApi();
    const w = emptyWire();
    const m = mount(api, {}, w);
    await m.store.refresh();

    type(field(m.container)!, "Fix the deploy\nit 500s on the second push");
    enter(field(m.container)!);

    await waitFor(() => expect(w.delivered.length).toBe(1));
    expect(w.delivered[0]).toEqual({
      session: created(api),
      lines: ["Fix the deploy\nit 500s on the second push"],
      awaitReady: true,
    });
    m.store.dispose();
  });

  it("puts the model ahead of the prompt, so it decides who answers", async () => {
    const api = new FakeApi();
    const w = emptyWire();
    const m = mount(api, {}, w);
    await m.store.refresh();
    fireEvent.change(pick(m.container, "Model for new session"), { target: { value: "sonnet" } });

    type(field(m.container)!, "Fix the deploy");
    enter(field(m.container)!);

    await waitFor(() => expect(w.delivered.length).toBe(1));
    // Verified against Claude Code 2.1.260 on 2026-09-04: `/model sonnet` SETS
    // the model, it does not open the picker.
    expect(w.delivered[0]!.lines).toEqual(["/model sonnet", "Fix the deploy"]);
    m.store.dispose();
  });

  it("sends no model line on the default, which is the absence of a choice", async () => {
    const api = new FakeApi();
    const w = emptyWire();
    const m = mount(api, {}, w);
    await m.store.refresh();

    type(field(m.container)!, "Fix the deploy");
    enter(field(m.container)!);

    await waitFor(() => expect(w.delivered.length).toBe(1));
    expect(w.delivered[0]!.lines).toEqual(["Fix the deploy"]);
    m.store.dispose();
  });

  it("keeps /model away from codex, which would read it as prose", async () => {
    const api = new FakeApi();
    const w = emptyWire();
    const m = mount(api, {}, w);
    await m.store.refresh();
    fireEvent.change(pick(m.container, "Model for new session"), { target: { value: "haiku" } });
    fireEvent.change(pick(m.container, "Command for new session"), { target: { value: "codex" } });

    type(field(m.container)!, "Fix the deploy");
    enter(field(m.container)!);

    await waitFor(() => expect(w.delivered.length).toBe(1));
    expect(w.delivered[0]!.lines).toEqual(["Fix the deploy"]);
    m.store.dispose();
  });

  it("applies a picked model even when the box is empty", async () => {
    const api = new FakeApi();
    const w = emptyWire();
    const m = mount(api, {}, w);
    await m.store.refresh();
    fireEvent.change(pick(m.container, "Model for new session"), { target: { value: "opus" } });

    enter(field(m.container)!);

    await waitFor(() => expect(w.delivered.length).toBe(1));
    expect(w.delivered[0]!.lines).toEqual(["/model opus"]);
    m.store.dispose();
  });

  it("sends nothing at all for an empty box on the default model", async () => {
    const api = new FakeApi();
    const w = emptyWire();
    const m = mount(api, {}, w);
    await m.store.refresh();

    enter(field(m.container)!);

    await waitFor(() => expect(w.delivered.length).toBe(1));
    expect(w.delivered[0]!.lines).toEqual([]);
    m.store.dispose();
  });

  it("sends nothing to a shell, which has no conversation to prompt", async () => {
    const api = new FakeApi();
    const w = emptyWire();
    const m = mount(api, {}, w);
    await m.store.refresh();
    fireEvent.change(pick(m.container, "Command for new session"), { target: { value: "shell" } });

    type(nameBox(m.container)!, "scratch");
    fireEvent.keyDown(nameBox(m.container)!, { key: "Enter" });

    await waitFor(() => expect(api.puts.length).toBe(1));
    expect(w.delivered).toEqual([]);
    expect(w.uploads).toEqual([]);
    m.store.dispose();
  });

  it("asks the server to wait for Claude's pane before injecting", async () => {
    const api = new FakeApi();
    const w = emptyWire();
    const m = mount(api, {}, w);
    await m.store.refresh();
    type(field(m.container)!, "Fix the deploy");
    enter(field(m.container)!);

    // A session tmux has just made takes send-keys seconds before the Claude in
    // it reads any, and that window loses the prompt with every layer reporting
    // success. session-events holds the injection until the pane can take it.
    await waitFor(() => expect(w.delivered.length).toBe(1));
    expect(w.delivered[0]!.awaitReady).toBe(true);
    m.store.dispose();
  });

  it("does not ask codex to wait for a prompt character it never draws", async () => {
    const api = new FakeApi();
    const w = emptyWire();
    const m = mount(api, {}, w);
    await m.store.refresh();
    fireEvent.change(pick(m.container, "Command for new session"), { target: { value: "codex" } });
    type(field(m.container)!, "Fix the deploy");
    enter(field(m.container)!);

    await waitFor(() => expect(w.delivered.length).toBe(1));
    expect(w.delivered[0]!.awaitReady).toBe(false);
    m.store.dispose();
  });
});

describe("<NewSessionComposer> — attachments", () => {
  const created = (api: FakeApi): string => api.puts[0]!.ungrouped[0]!;

  it("holds a picked file rather than uploading it, because there is no session yet", async () => {
    const api = new FakeApi();
    const w = emptyWire();
    const m = mount(api, {}, w);
    await m.store.refresh();

    pickFile(m.container, aFile("shot.png"));
    await waitFor(() => expect(m.container.querySelector(".tl-tray-item")).not.toBeNull());
    expect(w.uploads).toEqual([]);
    m.store.dispose();
  });

  it("uploads into the new session's bucket, then sends the paths with the prompt", async () => {
    const api = new FakeApi();
    const w = emptyWire();
    w.chips = [
      [
        {
          path: "/var/lib/clipboard-store/wizard/s/shot-a1.png",
          name: "shot-a1.png",
          kind: "image",
        },
      ],
    ];
    const m = mount(api, {}, w);
    await m.store.refresh();

    pickFile(m.container, aFile("shot.png"));
    await waitFor(() => expect(m.container.querySelector(".tl-tray-item")).not.toBeNull());
    type(field(m.container)!, "what is wrong here?");
    enter(field(m.container)!);

    await waitFor(() => expect(w.delivered.length).toBe(1));
    const id = created(api);
    expect(w.uploads.length).toBe(1);
    expect(w.uploads[0]!.session).toBe(id);
    expect(w.uploads[0]!.files.map((f) => f.name)).toEqual(["shot.png"]);
    expect(w.delivered[0]!.lines).toEqual([
      "/var/lib/clipboard-store/wizard/s/shot-a1.png\nwhat is wrong here?",
    ]);
    m.store.dispose();
  });

  it("uploads nothing when the composer is abandoned", async () => {
    const api = new FakeApi();
    const w = emptyWire();
    const m = mount(api, {}, w);
    await m.store.refresh();

    pickFile(m.container, aFile("shot.png"));
    await waitFor(() => expect(m.container.querySelector(".tl-tray-item")).not.toBeNull());
    m.store.dispose();
    m.unmount();

    expect(w.uploads).toEqual([]);
  });

  it("leaves the held files out of the saved draft, keeping the prose", async () => {
    const api = new FakeApi();
    const m = mount(api, {}, emptyWire());
    await m.store.refresh();

    type(field(m.container)!, "what is wrong here?");
    pickFile(m.container, aFile("shot.png"));
    await waitFor(() => expect(m.container.querySelector(".tl-tray-item")).not.toBeNull());

    // A File does not survive JSON, so restoring one would be a chip pointing
    // at nothing. The half that CAN persist still does.
    const saved = loadDraft(NEW_SESSION_DRAFT_KEY)!;
    expect(saved.attachments).toEqual([]);
    expect(saved.text).toBe("what is wrong here?");
    expect(localStorage.getItem(DRAFTS_KEY)).not.toContain("held:");
    m.store.dispose();
  });

  it("parks the prompt in the new session's composer when delivery fails", async () => {
    const api = new FakeApi();
    const w = emptyWire();
    w.results = [false];
    const m = mount(api, {}, w);
    await m.store.refresh();

    type(field(m.container)!, "Fix the deploy");
    enter(field(m.container)!);

    // The session exists and is what the person is looking at, so the text goes
    // into ITS field rather than back into one that has been unmounted.
    await waitFor(() => expect(loadDraft(created(api))?.text).toBe("Fix the deploy"));
    expect(toasts.toasts().map((t) => t.message).join(" ")).toContain("waiting in the composer");
    m.store.dispose();
  });
});
