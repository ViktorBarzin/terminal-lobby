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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import type { SlashCommand } from "../src/logic/compose.logic";
import { NewSessionComposer } from "../src/components/NewSessionComposer";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import {
  emptyLayout,
  sessionLabel,
  type Layout,
  type Session,
  type Whoami,
} from "../src/types/lobby";
import { isSessionId } from "../src/lib/session-id";
import { createPrefsStore, PREFS_KEY, type PrefsStore } from "../src/store/prefs";
import type { CommandAvailability } from "../src/lib/new-commands";
import { DRAFTS_KEY, loadDraft, type DraftAttachment } from "../src/store/drafts";
import { toasts } from "../src/store/toast";
import { NEW_SESSION_DRAFT_KEY } from "../src/components/NewSessionComposer";
import { resetPiModels } from "../src/lib/pi-models";

class FakeApi implements LobbyApi {
  /** The rescue's stamp (POST /sessions/{name}/origin). Nothing here drags a
   *  card out of System, so it only has to exist. */
  async setSessionOrigin() {}
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
  delivered: {
    session: string;
    lines: readonly string[];
    awaitReady: boolean;
    tool?: string;
  }[];
  uploads: { files: readonly File[]; session: string }[];
  /** What each upload answers with, in order; the last answer repeats. */
  chips: DraftAttachment[][];
  /** What each delivery answers with, in order; the last answer repeats. */
  results: boolean[];
  /** What the `/` menu's catalogue read answers, and the dirs it was asked for. */
  catalogue: SlashCommand[];
  catalogueOk: boolean;
  catalogueDirs: string[];
}

function mount(
  api: FakeApi,
  available: CommandAvailability = {},
  wire: Wire = emptyWire(),
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
        catalogue={async (dir) => {
          wire.catalogueDirs.push(dir);
          return { commands: wire.catalogue, ok: wire.catalogueOk };
        }}
        upload={async (files, session, opts) => {
          wire.uploads.push({ files, session });
          const i = Math.min(wire.uploads.length - 1, wire.chips.length - 1);
          // Carrying the token across the upload is the real uploader's job
          // (clipboard/attach-files.ts) and the whole reason the send can put
          // the path where the chip was, so the double does it too.
          return (wire.chips[i] ?? []).map((chip, n) => {
            const token = opts?.tokenFor?.(files[n]!, n);
            return token ? { ...chip, token } : chip;
          });
        }}
        deliver={async (o) => {
          wire.delivered.push({
            session: o.session,
            lines: o.lines,
            awaitReady: o.awaitReady ?? false,
            tool: o.tool,
          });
          const i = Math.min(wire.delivered.length - 1, wire.results.length - 1);
          return wire.results[i] ?? true;
        }}
      />
    );
  });
  return { store, prefs, container: utils.container, setPreset, unmount: utils.unmount, wire };
}

const emptyWire = (): Wire => ({
  delivered: [],
  uploads: [],
  chips: [[]],
  results: [true],
  catalogue: [],
  catalogueOk: true,
  catalogueDirs: [],
});

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
  c.querySelector<HTMLTextAreaElement>('[aria-label="Name for the new session"]');
/**
 * The control each choice opens from. The project and the command sit in the
 * strip under the box; the model and the effort share the model button in the
 * box's row, whose sheet carries both (the T3 pass, 2026-09-27).
 */
const OPENER_OF: Record<string, string> = {
  "Project for new session": '.tl-new-strip [data-strip="project"]',
  "Command for new session": '.tl-new-strip [data-strip="command"]',
  "Model for new session": ".tl-model-btn",
  "Effort for new session": ".tl-model-btn",
};
const opener = (c: HTMLElement, label: string) =>
  c.querySelector<HTMLButtonElement>(OPENER_OF[label]!);
/**
 * The list a choice is made from, opening its control first when it is shut.
 * Searched in the whole document: the phone's sheet is drawn into the body.
 */
const pick = (c: HTMLElement, label: string): HTMLElement => {
  const d = opener(c, label)!;
  if (d.getAttribute("aria-expanded") !== "true") fireEvent.click(d);
  return document.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${label}"]`)!;
};
const option = (list: HTMLElement, value: string) =>
  list.querySelector<HTMLButtonElement>(`[role="radio"][data-value="${value}"]`)!;
const values = (list: HTMLElement): (string | null)[] =>
  Array.from(list.querySelectorAll('[role="radio"]')).map((r) => r.getAttribute("data-value"));
/** The row the list marks as chosen, by its value. */
const chosen = (list: HTMLElement): string | null | undefined =>
  list.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute("data-value");
const unusable = (row: HTMLElement): boolean => row.getAttribute("aria-disabled") === "true";
/** Pick a value from a choice's list, the way a click on its row does. */
const choose = (c: HTMLElement, label: string, value: string): void => {
  fireEvent.click(option(pick(c, label), value));
};

const type = (el: HTMLTextAreaElement | HTMLInputElement, text: string) => {
  el.value = text;
  fireEvent.input(el, { target: { value: text } });
};
const enter = (el: HTMLElement) => fireEvent.keyDown(el, { key: "Enter" });

/** What the sidebar would show for a session — the optimistic card included,
 *  which is where a just-created one lives until the first poll knows it. */
const labelOf = (store: LobbyStore, name: string): string =>
  sessionLabel(
    store
      .model()
      .groups.flatMap((g) => g.sessions)
      .find((s) => s.name === name) ?? { name },
  );

beforeEach(() => {
  localStorage.clear();
  toasts.clear();
  resetPiModels();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

  // An empty box used to create a bare session and send it nothing, on the
  // reading that "just give me a session" is a real instruction. It is also
  // what a stray Enter looks like, and the session it left behind had no
  // prompt to summarise, so it sat in the sidebar reading `New session` with
  // nothing in it (Viktor, 2026-09-12).
  it("refuses an EMPTY box, so nothing is created", async () => {
    const api = new FakeApi();
    const m = mount(api);
    await m.store.refresh();

    enter(field(m.container)!);
    // Whitespace is nothing typed with the shift key down.
    type(field(m.container)!, "   ");
    enter(field(m.container)!);
    await Promise.resolve();

    expect(api.puts).toEqual([]);
    expect(m.store.selected()).toBeNull();
    m.store.dispose();
  });

  it("says so on Send, rather than swallowing the keystroke", async () => {
    const api = new FakeApi();
    const m = mount(api);
    await m.store.refresh();
    const send = () => m.container.querySelector<HTMLButtonElement>(".tl-send")!;

    expect(send().disabled).toBe(true);
    type(field(m.container)!, "Fix the deploy");
    expect(send().disabled).toBe(false);
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
    await waitFor(() => expect(chosen(sel)).toBe("beta"));
    expect(values(sel)).toEqual(["", "alpha", "beta"]);
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

    await waitFor(() => expect(chosen(pick(m.container, "Project for new session"))).toBe(""));
    expect(m.prefs.prefs().session.newProject).toBe("deleted");
    m.store.dispose();
  });

  it("creates into the chosen project and remembers it for next time", async () => {
    const api = new FakeApi();
    withProjects(api);
    const m = mount(api);
    await m.store.refresh();

    choose(m.container, "Project for new session", "alpha");
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
    await waitFor(() => expect(chosen(pick(m.container, "Project for new session"))).toBe("beta"));

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
    await waitFor(() => expect(chosen(pick(m.container, "Project for new session"))).toBe("beta"));
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

    choose(m.container, "Project for new session", "beta");
    await waitFor(() =>
      expect(api.prewarmed).toEqual(["/home/wizard/code/alpha", "/home/wizard/code/beta"]),
    );
    expect(api.released).toEqual(["/home/wizard/code/alpha"]);
    m.store.dispose();
  });

  // The pool only ever claims a slot for the `claude` key (tmux-user-attach),
  // so a slot warmed for any other command is a ~530MB Claude that sits until
  // the server's TTL collects it.
  // Pi is not in this list because it cannot be stored as the command: a
  // stored pi loads as Claude (store/prefs.ts). Moving onto pi in the composer
  // is the next test.
  it("warms nothing when the command is not Claude", async () => {
    for (const newCommand of ["codex", "shell"]) {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ session: { newProject: "alpha", newCommand } }),
      );
      const api = new FakeApi();
      withProjects(api);
      const m = mount(api);
      await m.store.refresh();
      await Promise.resolve();
      expect(api.prewarmed, newCommand).toEqual([]);
      m.store.dispose();
      m.unmount();
    }
  });

  it("hands the slot back when the command moves off Claude, and warms again on the way back", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newProject: "alpha" } }));
    const api = new FakeApi();
    withProjects(api);
    const m = mount(api);
    await m.store.refresh();
    await waitFor(() => expect(api.prewarmed).toEqual(["/home/wizard/code/alpha"]));

    choose(m.container, "Command for new session", "pi");
    await waitFor(() => expect(api.released).toEqual(["/home/wizard/code/alpha"]));

    choose(m.container, "Command for new session", "claude");
    await waitFor(() =>
      expect(api.prewarmed).toEqual(["/home/wizard/code/alpha", "/home/wizard/code/alpha"]),
    );
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
    // create() only STARTS the attach — the terminal's socket still has to
    // connect and reach ttyd — so releasing here reliably wins the race and the
    // create falls back to a cold start.
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
    expect(unusable(option(sel, "codex"))).toBe(true);
    expect(unusable(option(sel, "claude"))).toBe(false);
    expect(unusable(option(sel, "shell"))).toBe(false);
    // And a press on it changes nothing.
    fireEvent.click(option(sel, "codex"));
    expect(m.prefs.prefs().session.newCommand).not.toBe("codex");
    m.store.dispose();
  });

  it("says why, in the option itself", async () => {
    const m = mount(new FakeApi(), { codex: false });
    await m.store.refresh();
    const sel = pick(m.container, "Command for new session");
    expect(option(sel, "codex").textContent).toMatch(/not installed/i);
    // The runnable one says what it is and nothing more: a suffix here would
    // mean the box was offering something it cannot start.
    expect(option(sel, "claude").textContent).toBe("Claude");
    m.store.dispose();
  });

  // A stored preference outlives the tool it names: pick Claude, then run an
  // image without it. Leaving it selected would put the composer back to
  // handing out sessions that die on open.
  it("selects something that runs when the stored preference does not", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newCommand: "claude" } }));
    const m = mount(new FakeApi(), { claude: false, codex: false, pi: false, shell: true });
    await m.store.refresh();
    await waitFor(() => expect(chosen(pick(m.container, "Command for new session"))).toBe("shell"));
    m.store.dispose();
  });

  it("keeps the stored preference when it runs", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newCommand: "codex" } }));
    const m = mount(new FakeApi(), { claude: true, codex: true, shell: true });
    await m.store.refresh();
    await waitFor(() => expect(chosen(pick(m.container, "Command for new session"))).toBe("codex"));
    m.store.dispose();
  });

  // Every failure on the way to an answer arrives as an empty map. None of them
  // may take a working tool away from the user.
  it("disables nothing when the server said nothing", async () => {
    const m = mount(new FakeApi(), {});
    await m.store.refresh();
    const sel = pick(m.container, "Command for new session");
    for (const v of ["claude", "codex", "pi", "shell"]) {
      expect(unusable(option(sel, v)), `${v} disabled`).toBe(false);
    }
    expect(chosen(sel)).toBe("claude");
    m.store.dispose();
  });

  it("binds the dial to the roamed pref", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    choose(m.container, "Command for new session", "codex");
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
    expect(opener(m.container, "Model for new session")).toBeNull();
    m.store.dispose();
  });

  // Prototype 6-shell: the same box, with its + held out of sight so the
  // name field and the round button keep the places they have for a prompt.
  it("holds the + out of sight, keeping its room, since a name takes no files", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newCommand: "shell" } }));
    const m = mount(new FakeApi());
    await m.store.refresh();
    await waitFor(() => expect(nameBox(m.container)).not.toBeNull());
    const held = m.container.querySelector<HTMLElement>(".tl-pill-name .tl-plus")!;
    expect(held).not.toBeNull();
    expect(held.hasAttribute("data-hidden")).toBe(true);
    expect(held.getAttribute("aria-hidden")).toBe("true");
    expect(held.tabIndex).toBe(-1);
    expect(m.container.querySelector(".tl-pill-name")!.getAttribute("data-shape")).toBe("box");
    m.store.dispose();
  });

  it("says in the + where files go before the session exists", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    await waitFor(() => expect(field(m.container)).not.toBeNull());
    expect(m.container.querySelector(".tl-plus")!.getAttribute("title")).toMatch(
      /upload when the session starts/i,
    );
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

  // The box asks for a name rather than a prompt, but it is the same Enter
  // starting the same session, so it holds the same line: nothing typed,
  // nothing created.
  it("refuses an unnamed shell", async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newCommand: "shell" } }));
    const api = new FakeApi();
    const m = mount(api);
    await m.store.refresh();
    await waitFor(() => expect(nameBox(m.container)).not.toBeNull());
    const send = () => m.container.querySelector<HTMLButtonElement>(".tl-send")!;

    expect(send().disabled).toBe(true);
    enter(nameBox(m.container)!);
    type(nameBox(m.container)!, "  ");
    enter(nameBox(m.container)!);
    await Promise.resolve();
    expect(api.puts).toEqual([]);

    type(nameBox(m.container)!, "scratch");
    expect(send().disabled).toBe(false);
    fireEvent.click(send());
    await waitFor(() => expect(api.puts.length).toBe(1));
    m.store.dispose();
  });
});

describe("<NewSessionComposer> — the model and the effort it starts on", () => {
  it("offers Claude's models and binds the roamed pref", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    const sel = pick(m.container, "Model for new session");
    expect(values(sel)).toEqual([
      "default",
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-opus-5[1m]",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-8",
    ]);
    expect(chosen(sel)).toBe("default");
    fireEvent.click(option(sel, "claude-sonnet-5"));
    expect(m.prefs.prefs().session.newModel).toBe("claude-sonnet-5");
    m.store.dispose();
  });

  it("offers Claude's effort ladder beside it", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    const sel = pick(m.container, "Effort for new session");
    expect(values(sel)).toEqual(["default", "low", "medium", "high", "xhigh", "max", "ultracode"]);
    fireEvent.click(option(sel, "xhigh"));
    expect(m.prefs.prefs().session.newEffort).toBe("xhigh");
    m.store.dispose();
  });

  // The bug this whole change starts from: picking codex left a dropdown
  // offering Opus, Sonnet and Haiku, none of which codex can run.
  it("swaps both lists for codex's own when the command changes", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    choose(m.container, "Command for new session", "codex");

    expect(values(pick(m.container, "Model for new session"))).toEqual([
      "default",
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4-mini",
    ]);
    // The ladders differ at the top step alone: ultracode is Claude's, ultra
    // is codex's, and neither CLI accepts the other's.
    const efforts = values(pick(m.container, "Effort for new session"));
    expect(efforts).toContain("ultra");
    expect(efforts).not.toContain("ultracode");
    m.store.dispose();
  });

  // Each harness remembers its own pick, so switching back and forth does not
  // ask one CLI for the other's model.
  it("keeps each harness's choice separately", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    choose(m.container, "Model for new session", "claude-opus-5");
    choose(m.container, "Command for new session", "codex");
    choose(m.container, "Model for new session", "gpt-5.5");
    choose(m.container, "Command for new session", "claude");

    expect(chosen(pick(m.container, "Model for new session"))).toBe("claude-opus-5");
    expect(m.prefs.prefs().session.newCodexModel).toBe("gpt-5.5");
    m.store.dispose();
  });
});

/**
 * The T3 pass (docs/plans/2026-09-27-text-view-t3-pass.md, prototype states
 * 6-new and 6-shell): the box at full size under a hero line, the model
 * button inside the box, and a strip under it with the project on the left
 * and the command on the right. Each opens its list as a popover with a fine
 * pointer and as a bottom sheet with a coarse one.
 */
describe("<NewSessionComposer> — the box, the hero and the strip", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A coarse pointer, as `(pointer: coarse)` answers on a phone. */
  const coarse = (): void => {
    vi.stubGlobal(
      "matchMedia",
      (q: string) =>
        ({
          matches: q.includes("coarse"),
          media: q,
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    );
  };
  const withAlpha = (api: FakeApi): void => {
    api.layoutVal = {
      ...emptyLayout(),
      projects: [{ name: "alpha", sessions: [], dir: "/home/wizard/code/alpha" }],
    };
  };
  const hero = (c: HTMLElement) => c.querySelector<HTMLElement>(".tl-new-hero");
  const strip = (c: HTMLElement) => c.querySelector<HTMLElement>(".tl-new-strip");

  it("asks what to build in the project, in the hero and the placeholder", async () => {
    const api = new FakeApi();
    withAlpha(api);
    const m = mount(api);
    await m.store.refresh();
    m.setPreset("alpha");
    await waitFor(() =>
      expect(hero(m.container)!.textContent).toBe("What should we build in alpha?"),
    );
    // The project in its own span, drawn muted.
    expect(hero(m.container)!.querySelector("span")!.textContent).toBe("alpha");
    expect(field(m.container)!.placeholder).toBe("What should Claude do in alpha?");
    m.store.dispose();
  });

  it("names the CLI the command starts in the placeholder", async () => {
    const api = new FakeApi();
    withAlpha(api);
    const m = mount(api);
    await m.store.refresh();
    m.setPreset("alpha");
    choose(m.container, "Command for new session", "codex");
    await waitFor(() =>
      expect(field(m.container)!.placeholder).toBe("What should Codex do in alpha?"),
    );
    m.store.dispose();
  });

  // Ungrouped is not a place; "build in Ungrouped" would read as one.
  it("drops the project from the words when there is none", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    expect(hero(m.container)!.textContent).toBe("What should we build?");
    expect(field(m.container)!.placeholder).toBe("What should Claude do?");
    m.store.dispose();
  });

  it("draws the box at full size on a phone, not the folded pill", async () => {
    coarse();
    const m = mount(new FakeApi());
    await m.store.refresh();
    expect(m.container.querySelector(".tl-pill")!.getAttribute("data-shape")).toBe("box");
    m.store.dispose();
  });

  it("puts the model button inside the box, beside the +", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    const box = m.container.querySelector(".tl-pill")!;
    expect(box.querySelector(".tl-box-tools .tl-model-btn")).not.toBeNull();
    expect(box.querySelector(".tl-plus")).not.toBeNull();
    m.store.dispose();
  });

  it("puts the project left and the command right, in a strip under the box", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    const s = strip(m.container)!;
    expect(s).not.toBeNull();
    // Under the box: the strip follows the box's wrapper.
    expect(s.previousElementSibling!.classList.contains("tl-pillwrap")).toBe(true);
    const ids = Array.from(s.querySelectorAll("button")).map((b) => b.getAttribute("data-strip"));
    expect(ids).toEqual(["project", "command"]);
    expect(opener(m.container, "Project for new session")!.textContent).toContain("Ungrouped");
    expect(opener(m.container, "Command for new session")!.textContent).toContain("claude");
    m.store.dispose();
  });

  it("keeps each control's accessible name, followed by what it is set to", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    choose(m.container, "Model for new session", "claude-opus-5-5");
    choose(m.container, "Effort for new session", "high");
    expect(opener(m.container, "Project for new session")!.getAttribute("aria-label")).toBe(
      "Project for new session: Ungrouped",
    );
    expect(opener(m.container, "Command for new session")!.getAttribute("aria-label")).toBe(
      "Command for new session: Claude",
    );
    const model = opener(m.container, "Model for new session")!;
    expect(model.getAttribute("aria-label")).toBe("Model for new session: Opus 5.5 · High");
    // The name on the button, as T3 draws it; the exact slug in its title.
    expect(model.textContent).toBe("Opus 5.5");
    expect(model.title).toContain("claude-opus-5-5");
    m.store.dispose();
  });

  it("reads Default on the model button until a model is chosen", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    expect(opener(m.container, "Model for new session")!.textContent).toBe("Default");
    m.store.dispose();
  });

  it("opens the project list from the strip as a popover on a desktop", async () => {
    const api = new FakeApi();
    withAlpha(api);
    const m = mount(api);
    await m.store.refresh();
    const list = pick(m.container, "Project for new session");
    expect(list.closest(".tl-strip-pop")).not.toBeNull();
    expect(opener(m.container, "Project for new session")!.getAttribute("aria-expanded")).toBe(
      "true",
    );
    fireEvent.click(option(list, "alpha"));
    expect(m.container.querySelector(".tl-strip-pop")).toBeNull();
    expect(m.prefs.prefs().session.newProject).toBe("alpha");
    m.store.dispose();
  });

  it("opens the command list from the strip as a popover on a desktop", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    const list = pick(m.container, "Command for new session");
    expect(list.closest(".tl-strip-pop")).not.toBeNull();
    fireEvent.click(option(list, "codex"));
    expect(m.container.querySelector(".tl-strip-pop")).toBeNull();
    m.store.dispose();
  });

  it("opens only one list at a time", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    pick(m.container, "Project for new session");
    pick(m.container, "Command for new session");
    expect(m.container.querySelectorAll(".tl-strip-pop")).toHaveLength(1);
    expect(
      document.querySelector('[aria-label="Project for new session"][role="radiogroup"]'),
    ).toBeNull();
    m.store.dispose();
  });

  it("closes a list on Escape and gives the focus back to its button", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    pick(m.container, "Command for new session");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(m.container.querySelector(".tl-strip-pop")).toBeNull();
    expect(document.activeElement).toBe(opener(m.container, "Command for new session"));
    m.store.dispose();
  });

  it("opens the strip's lists as a bottom sheet on a phone, which a pick puts away", async () => {
    coarse();
    const api = new FakeApi();
    withAlpha(api);
    const m = mount(api);
    await m.store.refresh();
    const list = pick(m.container, "Project for new session");
    expect(list.closest(".tl-ms-sheet")).not.toBeNull();
    expect(m.container.querySelector(".tl-strip-pop")).toBeNull();
    fireEvent.click(option(list, "alpha"));
    expect(document.querySelector(".tl-ms-sheet")).toBeNull();
    expect(m.prefs.prefs().session.newProject).toBe("alpha");
    m.store.dispose();
  });

  // Model and effort are usually picked together, and a sheet that closed
  // after each would mean two trips. A pick here writes a preference and
  // types into nothing, so there is no pane to hand back to.
  it("keeps the phone's model sheet up after a pick, so a second choice needs no second visit", async () => {
    coarse();
    const m = mount(new FakeApi());
    await m.store.refresh();
    fireEvent.click(option(pick(m.container, "Model for new session"), "claude-sonnet-5"));
    fireEvent.click(option(pick(m.container, "Effort for new session"), "low"));
    expect(document.querySelector(".tl-ms-sheet")).not.toBeNull();
    expect(m.prefs.prefs().session.newModel).toBe("claude-sonnet-5");
    expect(m.prefs.prefs().session.newEffort).toBe("low");
    m.store.dispose();
  });

  it("puts the model popover away after a pick on a desktop", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    choose(m.container, "Model for new session", "claude-sonnet-5");
    expect(document.querySelector(".tl-ms-pop")).toBeNull();
    m.store.dispose();
  });

  // A session that does not exist has no mode to walk and no context used.
  it("gives the model sheet Model and Effort only", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    pick(m.container, "Model for new session");
    const pop = document.querySelector(".tl-ms-pop")!;
    expect(pop.querySelector('[aria-label="Permission mode"]')).toBeNull();
    expect(pop.querySelector(".tl-ms-ctx")).toBeNull();
    const heads = Array.from(pop.querySelectorAll(".tl-ms-h")).map(
      (h) => h.firstChild?.textContent,
    );
    expect(heads).toEqual(["Model", "Effort"]);
    m.store.dispose();
  });

  it("says Haiku 4.5 has one effort level rather than offering a control", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    choose(m.container, "Model for new session", "claude-haiku-4-5-20251001");
    pick(m.container, "Model for new session");
    const pop = document.querySelector(".tl-ms-pop")!;
    expect(pop.querySelector(".tl-ms-seg")).toBeNull();
    expect(pop.querySelector(".tl-ms-none")!.textContent).toBe("Haiku 4.5 has one effort level.");
    m.store.dispose();
  });

  // The composer scrolls (overflow-y: auto), so a popover inside it was cut
  // off at the composer's top, under the session bar. It is drawn over the
  // page now, capped at the window's room above the box.
  it("draws the model popover over the page, capped at the room above the box", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    const at = (top: number) => (): DOMRect =>
      ({ top, bottom: top + 108, left: 340, right: 1100, width: 760, height: 108 }) as DOMRect;
    m.container.querySelector<HTMLElement>(".tl-new-composer")!.getBoundingClientRect = at(80);
    m.container.querySelector<HTMLElement>(".tl-pill")!.getBoundingClientRect = at(402);
    fireEvent.click(opener(m.container, "Model for new session")!);
    const pop = document.querySelector<HTMLElement>(".tl-ms-pop")!;
    expect(m.container.querySelector(".tl-new-composer")!.contains(pop)).toBe(false);
    expect(pop.style.maxHeight).toBe(`${402 - 16}px`);
    m.store.dispose();
  });

  // Max is offered and lasts the one session it was picked for
  // (resetOneSessionEffort in store/prefs.ts). The sheet says so before the
  // pick rather than after the next session starts on high.
  it("offers max for one session, and says so", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    choose(m.container, "Effort for new session", "max");
    expect(m.prefs.prefs().session.newEffort).toBe("max");
    pick(m.container, "Effort for new session");
    const pop = document.querySelector(".tl-ms-pop")!;
    expect(pop.querySelector(".tl-ms-note")?.textContent).toMatch(/this one session/i);
    m.store.dispose();
  });

  it("keeps ultracode on a model with xhigh", async () => {
    const m = mount(new FakeApi());
    await m.store.refresh();
    choose(m.container, "Model for new session", "claude-sonnet-5");
    expect(values(pick(m.container, "Effort for new session"))).toContain("ultracode");
    m.store.dispose();
  });
});

describe("<NewSessionComposer> — a new shell", () => {
  const shellPref = (): void =>
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newCommand: "shell" } }));

  it("asks for a name in the hero and the box", async () => {
    shellPref();
    const api = new FakeApi();
    api.layoutVal = {
      ...emptyLayout(),
      projects: [{ name: "alpha", sessions: [], dir: "/home/wizard/code/alpha" }],
    };
    const m = mount(api);
    await m.store.refresh();
    m.setPreset("alpha");
    await waitFor(() =>
      expect(m.container.querySelector(".tl-new-hero")!.textContent).toBe("Name a shell in alpha"),
    );
    expect(nameBox(m.container)!.placeholder).toBe("Name this shell…");
    m.store.dispose();
  });

  it("hides the + by visibility and leaves the model button out", async () => {
    shellPref();
    const m = mount(new FakeApi());
    await m.store.refresh();
    await waitFor(() => expect(nameBox(m.container)).not.toBeNull());
    expect(m.container.querySelector(".tl-pill-name .tl-plus")!.hasAttribute("data-hidden")).toBe(
      true,
    );
    expect(m.container.querySelector(".tl-model-btn")).toBeNull();
    m.store.dispose();
  });

  it("keeps the strip, so the command can be changed back", async () => {
    shellPref();
    const m = mount(new FakeApi());
    await m.store.refresh();
    await waitFor(() => expect(nameBox(m.container)).not.toBeNull());
    expect(opener(m.container, "Command for new session")!.textContent).toContain("shell");
    choose(m.container, "Command for new session", "claude");
    await waitFor(() => expect(field(m.container)).not.toBeNull());
    m.store.dispose();
  });

  it("keeps a pasted newline out of a name", async () => {
    shellPref();
    const m = mount(new FakeApi());
    await m.store.refresh();
    await waitFor(() => expect(nameBox(m.container)).not.toBeNull());
    type(nameBox(m.container)!, "one\ntwo");
    expect(nameBox(m.container)!.value).toBe("one two");
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

  // The model and the effort leave by a different door now: they are flags on
  // the process the attach starts, read out of the preference this row writes
  // (lib/terminal-url.ts, App.newLaunch). So what the composer owes them is a
  // written preference, and the prompt path owes them nothing at all.
  it("sends the prompt and nothing else, whatever the model row says", async () => {
    const api = new FakeApi();
    const w = emptyWire();
    const m = mount(api, {}, w);
    await m.store.refresh();
    choose(m.container, "Model for new session", "claude-sonnet-5");
    choose(m.container, "Effort for new session", "high");

    type(field(m.container)!, "Fix the deploy");
    enter(field(m.container)!);

    await waitFor(() => expect(w.delivered.length).toBe(1));
    // No `/model` line. It used to lead the prompt, and it both cost a round
    // trip and showed up as a command in a conversation nobody had started.
    expect(w.delivered[0]!.lines).toEqual(["Fix the deploy"]);
    expect(m.prefs.prefs().session.newModel).toBe("claude-sonnet-5");
    expect(m.prefs.prefs().session.newEffort).toBe("high");
    m.store.dispose();
  });

  it("writes codex's choice under codex's own keys", async () => {
    const api = new FakeApi();
    const w = emptyWire();
    const m = mount(api, {}, w);
    await m.store.refresh();
    choose(m.container, "Model for new session", "claude-haiku-4-5-20251001");
    choose(m.container, "Command for new session", "codex");
    choose(m.container, "Model for new session", "gpt-5.6-luna");

    type(field(m.container)!, "Fix the deploy");
    enter(field(m.container)!);

    await waitFor(() => expect(w.delivered.length).toBe(1));
    expect(m.prefs.prefs().session.newCodexModel).toBe("gpt-5.6-luna");
    // Claude's own choice is untouched beside it.
    expect(m.prefs.prefs().session.newModel).toBe("claude-haiku-4-5-20251001");
    m.store.dispose();
  });

  it("sends nothing to a shell, which has no conversation to prompt", async () => {
    const api = new FakeApi();
    const w = emptyWire();
    const m = mount(api, {}, w);
    await m.store.refresh();
    choose(m.container, "Command for new session", "shell");

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
    choose(m.container, "Command for new session", "codex");
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
    await waitFor(() => expect(m.container.querySelector(".tl-inline-chip")).not.toBeNull());
    expect(w.uploads).toEqual([]);
    m.store.dispose();
  });

  // The box may not be empty, and a held file is not empty: a screenshot on
  // its own says what it is about, and it leaves as the path it uploaded to.
  it("takes a held file as the whole of it", async () => {
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
    await waitFor(() => expect(m.container.querySelector(".tl-inline-chip")).not.toBeNull());
    expect(m.container.querySelector<HTMLButtonElement>(".tl-send")!.disabled).toBe(false);
    enter(field(m.container)!);

    await waitFor(() => expect(w.delivered.length).toBe(1));
    expect(w.delivered[0]!.lines).toEqual(["/var/lib/clipboard-store/wizard/s/shot-a1.png"]);
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

    type(field(m.container)!, "what is wrong here?");
    pickFile(m.container, aFile("shot.png"));
    await waitFor(() => expect(m.container.querySelector(".tl-inline-chip")).not.toBeNull());
    enter(field(m.container)!);

    await waitFor(() => expect(w.delivered.length).toBe(1));
    const id = created(api);
    expect(w.uploads.length).toBe(1);
    expect(w.uploads[0]!.session).toBe(id);
    expect(w.uploads[0]!.files.map((f) => f.name)).toEqual(["shot.png"]);
    // The path lands where the chip was — the upload only happens once the
    // session exists, so the token is what held its place until then.
    expect(w.delivered[0]!.lines).toEqual([
      "what is wrong here? /var/lib/clipboard-store/wizard/s/shot-a1.png",
    ]);
    m.store.dispose();
  });

  it("uploads nothing when the composer is abandoned", async () => {
    const api = new FakeApi();
    const w = emptyWire();
    const m = mount(api, {}, w);
    await m.store.refresh();

    pickFile(m.container, aFile("shot.png"));
    await waitFor(() => expect(m.container.querySelector(".tl-inline-chip")).not.toBeNull());
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
    await waitFor(() => expect(m.container.querySelector(".tl-inline-chip")).not.toBeNull());

    // A File does not survive JSON, so restoring one would be a chip pointing
    // at nothing. The half that CAN persist still does — the token goes with
    // the text, and `anchorRestored` cuts it out on the way back in, since by
    // then there is no file behind it.
    const saved = loadDraft(NEW_SESSION_DRAFT_KEY)!;
    expect(saved.attachments).toEqual([]);
    expect(saved.text).toBe("what is wrong here? [img: shot.png] ");
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
    expect(
      toasts
        .toasts()
        .map((t) => t.message)
        .join(" "),
    ).toContain("waiting in the composer");
    m.store.dispose();
  });
});

// The `/` menu. The live composer reads its catalogue off the SESSION, and this
// one has no session — which is why it silently offered the built-ins alone and
// none of your skills. Viktor, 2026-09-06: "i dont see the skills being auto
// suggested when typing / in the new sesion promot".
describe("<NewSessionComposer> — the / menu", () => {
  const withProjects = (api: FakeApi): void => {
    api.layoutVal = {
      ...emptyLayout(),
      projects: [
        { name: "alpha", sessions: [], dir: "/home/wizard/code/alpha" },
        { name: "beta", sessions: [], dir: "/home/wizard/code/beta" },
      ],
    };
  };

  const skill = (name: string): SlashCommand => ({
    name,
    description: `does ${name}`,
    source: "skill",
  });

  it("offers a skill from the catalogue, not just the built-ins", async () => {
    const api = new FakeApi();
    withProjects(api);
    const m = mount(api);
    m.wire.catalogue.push(skill("/publish-page"));
    await m.store.refresh();
    await waitFor(() => expect(m.wire.catalogueDirs.length).toBeGreaterThan(0));

    type(field(m.container)!, "/publi");
    await waitFor(() =>
      expect(m.container.querySelector(".tl-complete")?.textContent).toContain("/publish-page"),
    );
    m.store.dispose();
  });

  it("asks for the SELECTED project's directory, since half the answer is that dir", async () => {
    const api = new FakeApi();
    withProjects(api);
    const m = mount(api);
    await m.store.refresh();
    await waitFor(() => expect(m.wire.catalogueDirs.length).toBeGreaterThan(0));

    const before = m.wire.catalogueDirs.length;
    choose(m.container, "Project for new session", "alpha");
    // A different project is a different .claude/skills, so it re-reads.
    await waitFor(() => expect(m.wire.catalogueDirs.length).toBeGreaterThan(before));
    m.store.dispose();
  });
});

/**
 * Paste and drop on the new-session screen.
 *
 * The image clipboard (clipboard/attach.ts) is installed by SessionView and
 * gated on that session being ON SCREEN. On this screen none is — App renders
 * this composer only while nothing is selected — so a pasted screenshot was
 * handled by nobody at all and the gesture did nothing. Viktor, 2026-09-06:
 * "uploading image (via paste) on new session screen doesn't work".
 *
 * Reproduced against a local build before the fix: a paste carrying an 8x8 PNG
 * onto the focused field left `.tl-plus-item` at 0.
 *
 * Both intakes land in the same memory-only tray the Attach button fills —
 * there is no session to upload into until Enter is pressed.
 */
describe("<NewSessionComposer> — pasted and dropped files", () => {
  const created = (api: FakeApi): string => api.puts[0]!.ungrouped[0]!;

  /** A document-level paste carrying one image, as a browser delivers it. */
  const pasteImage = (f: File): Event => {
    const e = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", {
      value: { items: [{ type: f.type, getAsFile: () => f }] },
    });
    document.dispatchEvent(e);
    return e;
  };

  /** A window-level drop carrying files, as a browser delivers it. */
  const dropFiles = (...files: File[]): Event => {
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { files } });
    window.dispatchEvent(e);
    return e;
  };

  const chipText = (c: HTMLElement): string[] =>
    [...c.querySelectorAll(".tl-inline-chip")].map((el) => el.textContent ?? "");

  it("holds a pasted image, the way it holds a picked one", async () => {
    const api = new FakeApi();
    const w = emptyWire();
    const m = mount(api, {}, w);
    await m.store.refresh();

    pasteImage(aFile("pasted.png"));
    await waitFor(() => expect(m.container.querySelector(".tl-inline-chip")).not.toBeNull());
    expect(w.uploads).toEqual([]); // nothing to upload into yet
    m.store.dispose();
  });

  it("sends the pasted image up with the prompt when the session is created", async () => {
    const api = new FakeApi();
    const w = emptyWire();
    w.chips = [
      [
        {
          path: "/var/lib/clipboard-store/wizard/s/pasted-a1.png",
          name: "pasted-a1.png",
          kind: "image",
        },
      ],
    ];
    const m = mount(api, {}, w);
    await m.store.refresh();

    type(field(m.container)!, "what is wrong here?");
    pasteImage(aFile("pasted.png"));
    await waitFor(() => expect(m.container.querySelector(".tl-inline-chip")).not.toBeNull());
    enter(field(m.container)!);

    await waitFor(() => expect(w.delivered.length).toBe(1));
    expect(w.uploads.length).toBe(1);
    expect(w.uploads[0]!.session).toBe(created(api));
    expect(w.uploads[0]!.files.map((f) => f.name)).toEqual(["pasted.png"]);
    expect(w.delivered[0]!.lines).toEqual([
      "what is wrong here? /var/lib/clipboard-store/wizard/s/pasted-a1.png",
    ]);
    m.store.dispose();
  });

  it("holds dropped files too, images and documents alike", async () => {
    const api = new FakeApi();
    const m = mount(api, {}, emptyWire());
    await m.store.refresh();

    const e = dropFiles(aFile("shot.png"), aFile("notes.txt", "text/plain"));
    await waitFor(() =>
      expect(chipText(m.container)).toEqual(["[img: shot.png]", "[file: notes.txt]"]),
    );
    // Without this the browser navigates away to the dropped file.
    expect(e.defaultPrevented).toBe(true);
    m.store.dispose();
  });

  it("lets a text paste through to the field it landed in", async () => {
    const api = new FakeApi();
    const m = mount(api, {}, emptyWire());
    await m.store.refresh();

    const e = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", {
      value: { items: [{ type: "text/plain", getAsFile: () => null }] },
    });
    document.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(false);
    expect(m.container.querySelector(".tl-plus-item")).toBeNull();
    m.store.dispose();
  });

  it("declines the gesture while the box is naming a shell, which has no tray", async () => {
    const api = new FakeApi();
    const m = mount(api, {}, emptyWire());
    await m.store.refresh();
    choose(m.container, "Command for new session", "shell");
    await waitFor(() => expect(nameBox(m.container)).not.toBeNull());

    const e = pasteImage(aFile("pasted.png"));
    // Nowhere to put it: better to leave the paste to the browser than to
    // swallow it into a tray that is not on screen.
    expect(e.defaultPrevented).toBe(false);
    expect(m.container.querySelector(".tl-plus-item")).toBeNull();
    m.store.dispose();
  });
});

/**
 * Pi, the third harness (docs/plans/2026-09-25-pi-harness-design.md).
 *
 * Its models are not written down anywhere in the frontend: pi lists them per
 * user, and tmux-api serves that list as GET /pi-models (ADR-0032). So the
 * model menu fills from that answer, the thinking menu offers pi's seven
 * levels, and the first prompt asks the server to wait for pi by name.
 */
describe("<NewSessionComposer> — pi", () => {
  const OPUS = "anthropic/claude-opus-5";
  const MINI = "openai/gpt-5.4-mini";
  const row = (ref: string) => {
    const [provider, id] = ref.split("/");
    return { ref, provider, id, thinking: true };
  };

  /** Answer GET /pi-models with `body`; count how often it was asked. */
  function servePiModels(body: unknown): { asked: () => number } {
    let asked = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/pi-models")) {
          asked += 1;
          return new Response(JSON.stringify(body), { status: 200 });
        }
        return new Response("", { status: 404 });
      }),
    );
    return { asked: () => asked };
  }

  // Picked in the composer, as a person does. A stored pi is not a default any
  // more (store/prefs.ts, oneSessionCleared): it loads as Claude.
  const choosePi = (m: { container: HTMLElement }) =>
    choose(m.container, "Command for new session", "pi");
  const hint = (c: HTMLElement) => c.querySelector(".tl-new-hint");

  it("offers pi between codex and the shell, named like the others", async () => {
    servePiModels({ signedIn: true, models: [] });
    const m = mount(new FakeApi());
    await m.store.refresh();
    const sel = pick(m.container, "Command for new session");
    expect(values(sel)).toEqual(["claude", "codex", "pi", "shell"]);
    expect(option(sel, "pi").querySelector(".tl-ms-name")?.textContent).toBe("Pi");
    m.store.dispose();
  });

  it("disables pi on a box that cannot run it, and says why", async () => {
    const m = mount(new FakeApi(), { pi: false });
    await m.store.refresh();
    const sel = pick(m.container, "Command for new session");
    expect(unusable(option(sel, "pi"))).toBe(true);
    expect(option(sel, "pi").textContent).toMatch(/not installed/i);
    m.store.dispose();
  });

  it("fills the model menu from pi's own list, after the default", async () => {
    servePiModels({ signedIn: true, models: [row(OPUS), row(MINI)] });
    const m = mount(new FakeApi());
    choosePi(m);
    await m.store.refresh();
    await waitFor(() =>
      expect(values(pick(m.container, "Model for new session"))).toEqual(["default", OPUS, MINI]),
    );
    // A reference is already unmistakably a model, so it is its own name.
    expect(
      option(pick(m.container, "Model for new session"), OPUS).querySelector(".tl-ms-name")
        ?.textContent,
    ).toBe(OPUS);
    expect(hint(m.container)).toBeNull();
    m.store.dispose();
  });

  // Opening the composer is the moment a person is about to choose, so that is
  // when the list is read again: a provider signed into since the page loaded
  // shows up without a reload.
  it("reads the list again each time it opens with pi chosen", async () => {
    const served = servePiModels({ signedIn: true, models: [row(OPUS)] });
    const first = mount(new FakeApi());
    choosePi(first);
    await first.store.refresh();
    await waitFor(() => expect(served.asked()).toBe(1));
    first.store.dispose();
    first.unmount();

    const second = mount(new FakeApi());
    choosePi(second);
    await second.store.refresh();
    await waitFor(() => expect(served.asked()).toBe(2));
    second.store.dispose();
  });

  // Each read costs the server a login shell running pi.
  it("asks nothing until pi is the command, then asks once", async () => {
    const served = servePiModels({ signedIn: true, models: [row(OPUS)] });
    const m = mount(new FakeApi());
    await m.store.refresh();
    await Promise.resolve();
    expect(served.asked()).toBe(0);

    choose(m.container, "Command for new session", "pi");
    await waitFor(() => expect(served.asked()).toBe(1));
    // Picking a model writes a preference, and that is not a reason to ask again.
    await waitFor(() => expect(values(pick(m.container, "Model for new session"))).toContain(OPUS));
    choose(m.container, "Model for new session", OPUS);
    await Promise.resolve();
    expect(served.asked()).toBe(1);
    m.store.dispose();
  });

  it("offers only the default to someone who has not signed pi in, and says how", async () => {
    servePiModels({ signedIn: false, models: [] });
    const m = mount(new FakeApi());
    choosePi(m);
    await m.store.refresh();
    await waitFor(() => expect(hint(m.container)).not.toBeNull());
    expect(values(pick(m.container, "Model for new session"))).toEqual(["default"]);
    expect(hint(m.container)!.textContent).toMatch(/\/login/);
    m.store.dispose();
  });

  // A list that could not be read is not a sign-in problem, and a hint sending
  // somebody off to /login for it would be a wild goose chase.
  it("does not blame the sign-in when the list could not be read", async () => {
    servePiModels({ signedIn: false, models: [], error: "pi --list-models timed out" });
    const m = mount(new FakeApi());
    choosePi(m);
    await m.store.refresh();
    await waitFor(() =>
      expect(pick(m.container, "Model for new session").getAttribute("title")).toMatch(/timed out/),
    );
    expect(hint(m.container)).toBeNull();
    m.store.dispose();
  });

  it("drops the hint once pi is no longer the command", async () => {
    servePiModels({ signedIn: false, models: [] });
    const m = mount(new FakeApi());
    choosePi(m);
    await m.store.refresh();
    await waitFor(() => expect(hint(m.container)).not.toBeNull());
    choose(m.container, "Command for new session", "claude");
    expect(hint(m.container)).toBeNull();
    m.store.dispose();
  });

  it("offers pi's seven thinking levels", async () => {
    servePiModels({ signedIn: true, models: [] });
    const m = mount(new FakeApi());
    choosePi(m);
    await m.store.refresh();
    const sel = pick(m.container, "Effort for new session");
    expect(values(sel)).toEqual([
      "default",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    // The segmented control writes each level as pi's own word, as the live
    // sheet does, and says it in full in the title.
    expect(option(sel, "high").textContent).toBe("high");
    expect(option(sel, "off").title).toBe("Off");
    m.store.dispose();
  });

  it("writes pi's choice under pi's own keys, leaving Claude's alone", async () => {
    servePiModels({ signedIn: true, models: [row(OPUS), row(MINI)] });
    const m = mount(new FakeApi());
    await m.store.refresh();
    choose(m.container, "Model for new session", "claude-sonnet-5");
    choose(m.container, "Command for new session", "pi");
    await waitFor(() => expect(values(pick(m.container, "Model for new session"))).toContain(MINI));
    choose(m.container, "Model for new session", MINI);
    choose(m.container, "Effort for new session", "minimal");

    expect(m.prefs.prefs().session.newPiModel).toBe(MINI);
    expect(m.prefs.prefs().session.newPiEffort).toBe("minimal");
    expect(m.prefs.prefs().session.newModel).toBe("claude-sonnet-5");

    // And back: Claude's menu still shows Claude's pick.
    choose(m.container, "Command for new session", "claude");
    expect(chosen(pick(m.container, "Model for new session"))).toBe("claude-sonnet-5");
    m.store.dispose();
  });

  // The attach launches on the stored pick whatever the menu shows, so the menu
  // has to show it too, even before the list arrives or after pi stopped
  // listing it. A blank or a "default" there would be a menu that disagrees
  // with what starts.
  it("shows a stored pick that the list does not carry", async () => {
    servePiModels({ signedIn: true, models: [row(MINI)] });
    localStorage.setItem(PREFS_KEY, JSON.stringify({ session: { newPiModel: OPUS } }));
    const m = mount(new FakeApi());
    choosePi(m);
    await m.store.refresh();
    await waitFor(() => expect(values(pick(m.container, "Model for new session"))).toContain(MINI));
    const sel = pick(m.container, "Model for new session");
    expect(values(sel)).toContain(OPUS);
    expect(chosen(sel)).toBe(OPUS);
    m.store.dispose();
  });

  it("asks the server to wait for pi, and says it is pi", async () => {
    servePiModels({ signedIn: true, models: [] });
    const api = new FakeApi();
    const w = emptyWire();
    const m = mount(api, {}, w);
    choosePi(m);
    await m.store.refresh();
    type(field(m.container)!, "Fix the deploy");
    enter(field(m.container)!);

    await waitFor(() => expect(w.delivered.length).toBe(1));
    expect(w.delivered[0]).toEqual({
      session: api.puts[0]!.ungrouped[0]!,
      lines: ["Fix the deploy"],
      awaitReady: true,
      tool: "pi",
    });
    m.store.dispose();
  });

  it("names no harness on a Claude session's first prompt", async () => {
    const w = emptyWire();
    const m = mount(new FakeApi(), {}, w);
    await m.store.refresh();
    type(field(m.container)!, "Fix the deploy");
    enter(field(m.container)!);
    await waitFor(() => expect(w.delivered.length).toBe(1));
    expect(w.delivered[0]!.tool).toBeUndefined();
    m.store.dispose();
  });
});
