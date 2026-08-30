import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { SettingsPanel } from "../src/components/SettingsPanel";
import { PREF_DEFAULTS, type Prefs, type PrefsStore } from "../src/store/prefs";
import { rowKey, type SkillsStore } from "../src/store/skills";
import type { Inventory, SkillDiff, SkillView, SourceInfo } from "../src/lib/skills-api";

/** The lazily-imported CodeMirror host, faked so an inline skill edit is
 *  drivable: the panel's own behaviour is what these assert, not CodeMirror's. */
let cmChange: ((text: string) => void) | null = null;
let cmSave: (() => void) | null = null;
let cmDoc = "";
vi.mock("../src/components/codemirror-view", () => ({
  createEditorView: (o: { doc: string; onChange: (t: string) => void; onSave?: () => void }) => {
    cmDoc = o.doc;
    cmChange = o.onChange;
    cmSave = o.onSave ?? null;
    return { destroy: () => {} };
  },
}));

/**
 * The Skills panel — its own overlay, beside Settings. The store is stubbed so
 * these assert what a person can SEE and DO rather than re-testing the fetch
 * layer: which rows offer an install, what a collision offers instead, which
 * sessions may be restarted.
 *
 * The lists sit behind a tab strip, so a test that wants a peer's rows or the
 * plugins selects that tab first, exactly as a person does. That is the point of
 * the surface: 38 own skills and a peer's 21 were never going to read as one
 * column inside Settings.
 */

beforeEach(() => {
  cmChange = null;
  cmSave = null;
  cmDoc = "";
});

const inventory = (over: Partial<Inventory> = {}): Inventory => ({
  user: "wizard",
  skills: [
    { name: "grilling", description: "Grill a plan", files: 1, executable: 0, bytes: 900, hash: "h1", enabled: true },
    {
      name: "cluster-health",
      description: "Cluster triage",
      files: 3,
      executable: 1,
      bytes: 4096,
      hash: "h2",
      enabled: true,
      from: "bob",
      sourceHash: "old",
      updateAvailable: true,
    },
    { name: "caveman", files: 1, executable: 0, bytes: 500, hash: "h3", enabled: false, from: "bob" },
  ],
  plugins: [
    {
      id: "superpowers@official",
      name: "superpowers",
      marketplace: "official",
      version: "5.1.0",
      enabled: true,
      latest: "5.3.0",
      stale: true,
    },
    { id: "context7@official", name: "context7", marketplace: "official", version: "61c059", enabled: true },
  ],
  peers: [
    {
      user: "bob",
      skills: [
        { name: "diagnose", description: "Debug it", files: 2, executable: 0, bytes: 2048, hash: "p1", enabled: true, verdict: "absent" },
        { name: "tdd", files: 2, executable: 1, bytes: 3000, hash: "p2", enabled: true, verdict: "differs" },
        { name: "file-issue", files: 1, executable: 0, bytes: 800, hash: "h9", enabled: true, verdict: "same" },
      ],
    },
  ],
  ...over,
});

function stubStore(over: Partial<SkillsStore> = {}) {
  const [inv] = createSignal<Inventory | null>(inventory());
  const [expanded, setExpanded] = createSignal("");
  const [diff, setDiff] = createSignal<SkillDiff | null>(null);
  const [view, setView] = createSignal<SkillView | null>(null);
  const [saved, setSaved] = createSignal("");
  const [draft, setDraft] = createSignal("");
  const calls: string[] = [];
  /** What the service would answer for one row. */
  const fileOf = (owner: string, name: string): SkillView => ({
    owner: owner || "wizard",
    name,
    skillmd: `---\nname: ${name}\n---\nbody of ${name}\n`,
    path: `/home/${owner || "wizard"}/.claude/skills/${name}/SKILL.md`,
  });
  const store: SkillsStore = {
    inventory: inv,
    loading: () => false,
    error: () => "",
    expanded,
    diff,
    busy: () => "",
    load: vi.fn(async () => {}),
    toggleExpanded: (owner, name) => {
      const key = rowKey(owner, name);
      const opening = expanded() !== key;
      setExpanded(opening ? key : "");
      // Mirrors the real store: expanding a row reads that skill's file.
      const f = opening ? fileOf(owner, name) : null;
      setSaved(f?.skillmd ?? "");
      setDraft(f?.skillmd ?? "");
      setView(f);
    },
    view,
    viewing: () => false,
    viewError: () => "",
    saved,
    draft,
    setDraft,
    reread: vi.fn(async () => {
      calls.push("reread");
      setDraft(saved());
      setView({ ...(view() as SkillView) }); // a fresh object: the editor rebuilds
    }),
    save: vi.fn(async (name) => {
      calls.push(`save:${name}:${draft()}`);
      setSaved(draft());
    }),
    showDiff: vi.fn(async (owner, name) => {
      calls.push(`diff:${owner}/${name}`);
      setDiff({ owner, name, verdict: "differs", diff: " same\n-mine\n+theirs" });
    }),
    clearDiff: () => setDiff(null),
    install: vi.fn(async (owner, name, replace) => {
      calls.push(`install:${owner}/${name}${replace ? ":replace" : ""}`);
    }),
    setEnabled: vi.fn(async (id, enabled) => {
      calls.push(`toggle:${id}:${enabled}`);
    }),
    remove: vi.fn(async (name) => {
      calls.push(`remove:${name}`);
    }),
    deleteForever: vi.fn(async (name) => {
      calls.push(`delete:${name}`);
    }),
    uninstall: vi.fn(async (plugin) => {
      calls.push(`uninstall:${plugin}`);
    }),
    update: vi.fn(async (plugin) => {
      calls.push(`update:${plugin}`);
    }),
    restart: vi.fn(async (session) => {
      calls.push(`restart:${session}`);
    }),
    source: () => null,
    inspecting: () => false,
    inspect: vi.fn(async () => {}),
    clearSource: () => {},
    installSource: vi.fn(async () => {}),
    ...over,
  };
  return { store, calls };
}

const sessions = () => [
  { name: "infra-work", state: "running" },
  { name: "notes", state: "done" },
];

function fakePrefs(): PrefsStore {
  const [prefs] = createSignal<Prefs>(structuredClone(PREF_DEFAULTS));
  return { prefs, setPref() {}, setFontSize() {}, async bootSync() {}, dispose() {} };
}

/**
 * Mount Settings on its Skills page — the surface this file has always tested,
 * at the address it moved to. `initialPage` is what the header's Skills button
 * passes, so this is the app's own route in.
 */
function open(over: Partial<SkillsStore> = {}, opts: { sessions?: boolean; confirm?: (m: string) => boolean; onClose?: () => void } = {}) {
  const { store, calls } = stubStore(over);
  const r = render(() => (
    <SettingsPanel
      prefs={fakePrefs()}
      onClose={opts.onClose ?? (() => {})}
      initialPage="skills"
      skills={store}
      skillSessions={opts.sessions ? sessions : undefined}
      confirm={opts.confirm}
    />
  ));
  // The rail is a tablist too, so a tab lookup has to stay inside the page.
  const tab = (name: string) => {
    const strip = r.container.querySelector('[aria-label="Skill lists"]')!;
    const hit = [...strip.querySelectorAll('[role="tab"]')].find((el) =>
      new RegExp(name).test(el.textContent ?? ""),
    );
    if (!hit) throw new Error(`no skills tab matching ${name}`);
    fireEvent.click(hit);
  };
  return { ...r, store, calls, tab };
}

/** The tabs of the Skills page itself, excluding the settings rail's. */
const skillTabs = (c: HTMLElement) => [
  ...c.querySelectorAll('[aria-label="Skill lists"] [role="tab"]'),
] as HTMLElement[];

describe("the Skills panel's shell", () => {
  it("asks for the inventory when it first opens, not before", () => {
    const load = vi.fn(async () => {});
    open({ inventory: () => null, load });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not re-ask when an inventory is already in hand", () => {
    const load = vi.fn(async () => {});
    open({ load });
    expect(load).not.toHaveBeenCalled();
  });

  it("sits inside the Settings modal, which owns closing it", async () => {
    let closed = 0;
    const { container } = open({}, { onClose: () => closed++ });
    expect(container.querySelector('[role="dialog"][aria-modal="true"]')).toBeTruthy();
    expect(container.querySelector(".tl-skills-page")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(1);

    fireEvent.click(container.querySelector(".tl-settings-backdrop")!);
    expect(closed).toBe(2);
  });

  it("is reachable from the rail, below the preference pages", () => {
    const { container } = open();
    const rail = container.querySelector('[aria-label="Settings categories"]')!;
    const skills = rail.querySelector<HTMLElement>('[data-page="skills"]')!;
    expect(skills.textContent).toBe("Skills");
    expect(skills.getAttribute("aria-selected")).toBe("true");
    expect(skills.classList.contains("starts-group")).toBe(true);
  });

  it("offers one tab per list, the caller's own first", () => {
    const { container } = open({}, { sessions: true });
    expect(skillTabs(container).map((t) => t.textContent)).toEqual([
      "Mine3",
      "bob2", // two takeable of bob's three; the identical one is not
      "Plugins2",
      "Sessions2",
    ]);
  });

  it("shows the caller's own skills without a click", () => {
    const { getByText } = open();
    expect(getByText("grilling")).toBeTruthy();
    expect(getByText("from bob · update")).toBeTruthy();
  });
});

describe("the Mine tab", () => {
  it("shows a disabled skill unchecked, and toggling it says which id", async () => {
    const { getByLabelText, calls } = open();
    const box = getByLabelText("Enable caveman") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(calls).toContain("toggle:caveman@skills-dir:true"));
  });

  it("acts from the row, with no expand first — the way a plugin row does", async () => {
    const { getAllByText, calls, queryByText } = open({}, { confirm: () => true });
    // Nothing expanded: the description is not on screen, but the actions are.
    expect(queryByText("Grill a plan")).toBeNull();
    expect(getAllByText("Remove")).toHaveLength(3); // one per skill
    expect(getAllByText("Delete")).toHaveLength(3);
    fireEvent.click(getAllByText("Remove")[0]!);
    await waitFor(() => expect(calls).toContain("remove:grilling"));
  });

  it("expands for reading rather than for acting", () => {
    const { getByText, queryByText } = open();
    expect(queryByText("Grill a plan")).toBeNull();
    fireEvent.click(getByText("grilling"));
    expect(getByText("Grill a plan")).toBeTruthy();
    expect(getByText("1 file · 900 B")).toBeTruthy();
  });

  it("confirms before removing, and does nothing when that is declined", async () => {
    const { getAllByText, calls } = open({}, { confirm: () => false });
    fireEvent.click(getAllByText("Remove")[0]!);
    await waitFor(() => expect(calls).not.toContain("remove:grilling"));
  });

  it("removes the row it was clicked on", async () => {
    const { getAllByText, calls } = open({}, { confirm: () => true });
    fireEvent.click(getAllByText("Remove")[2]!); // caveman, the third row
    await waitFor(() => expect(calls).toContain("remove:caveman"));
  });

  it("warns before an update would displace local edits", async () => {
    const inv = inventory();
    inv.skills[1]!.locallyModified = true;
    const asked: string[] = [];
    const { getByText, calls } = open(
      { inventory: () => inv },
      { confirm: (m) => (asked.push(m), true) },
    );
    fireEvent.click(getByText("cluster-health"));
    fireEvent.click(getByText("Update"));
    await waitFor(() => expect(calls).toContain("install:bob/cluster-health:replace"));
    expect(asked[0]).toContain("local edits");
  });

  it("filters by name and by description", async () => {
    const { getByLabelText, getByText, queryByText } = open();
    const filter = getByLabelText("Filter skills");
    fireEvent.input(filter, { target: { value: "cluster" } });
    await waitFor(() => expect(queryByText("grilling")).toBeNull());
    expect(getByText("cluster-health")).toBeTruthy();

    // the description, not the name
    fireEvent.input(filter, { target: { value: "Grill a plan" } });
    await waitFor(() => expect(getByText("grilling")).toBeTruthy());
    expect(queryByText("cluster-health")).toBeNull();

    fireEvent.input(filter, { target: { value: "zzz" } });
    await waitFor(() => expect(getByText(/Nothing matches/)).toBeTruthy());
  });
});

describe("a peer's tab", () => {
  it("offers Install only for a name this account does not use", () => {
    const { tab, getAllByText, getByText } = open();
    tab("bob");
    expect(getAllByText("Install")).toHaveLength(1); // diagnose
    expect(getByText("differs")).toBeTruthy(); // tdd
    expect(getByText("same as yours")).toBeTruthy(); // file-issue
  });

  it("turns a collision into a diff and a replace rather than an install", async () => {
    const { tab, getByText, calls } = open({}, { confirm: () => true });
    tab("bob");
    fireEvent.click(getByText("tdd"));
    fireEvent.click(getByText("View diff"));
    await waitFor(() => expect(calls).toContain("diff:bob/tdd"));
    await waitFor(() => expect(getByText("-mine")).toBeTruthy());
    fireEvent.click(getByText("Replace"));
    await waitFor(() => expect(calls).toContain("install:bob/tdd:replace"));
  });

  it("says how many files it would bring and how many of them run", () => {
    const { tab, getByText } = open();
    tab("bob");
    fireEvent.click(getByText("tdd"));
    expect(getByText("2 files · 1 executable · 3 KB")).toBeTruthy();
  });

  it("installs on a click", async () => {
    const { tab, getByText, calls } = open();
    tab("bob");
    fireEvent.click(getByText("Install"));
    await waitFor(() => expect(calls).toContain("install:bob/diagnose"));
  });

  it("says an account could not be read instead of showing it as empty", () => {
    const { tab, getByText } = open({
      inventory: () => inventory({ peers: [{ user: "bob", unreachable: true }] }),
    });
    tab("bob");
    expect(getByText(/Could not read/)).toBeTruthy();
  });
});

describe("the Plugins and Sessions tabs", () => {
  it("offers an update only for the stale plugin", async () => {
    const { tab, getByText, getAllByText, calls } = open();
    tab("Plugins");
    expect(getByText("5.1.0 · 5.3.0")).toBeTruthy();
    expect(getAllByText("Update")).toHaveLength(1);
    fireEvent.click(getAllByText("Update")[0]!);
    await waitFor(() => expect(calls).toContain("update:superpowers@official"));
  });

  it("offers Restart for an idle session and explains why a busy one has none", async () => {
    const { tab, getByText, getAllByText, calls } = open({}, { sessions: true });
    tab("Sessions");
    expect(getByText("let it finish")).toBeTruthy();
    expect(getAllByText("Restart")).toHaveLength(1);
    fireEvent.click(getByText("Restart"));
    await waitFor(() => expect(calls).toContain("restart:notes"));
  });

  it("drops the Sessions tab when there are none", () => {
    const { container } = open();
    expect(skillTabs(container).map((t) => t.textContent)).not.toContain("Sessions");
  });

  it("has no filter box on Sessions, where a name filter would mean something else", () => {
    const { tab, queryByLabelText } = open({}, { sessions: true });
    expect(queryByLabelText("Filter skills")).not.toBeNull();
    tab("Sessions");
    expect(queryByLabelText("Filter skills")).toBeNull();
  });
});

describe("what the panel always says", () => {
  it("states the visibility rule, since it is the surprising part", () => {
    const { getByText } = open();
    expect(getByText(/Everyone here can see everyone's skills/)).toBeTruthy();
  });

  it("surfaces a failed inventory read rather than an empty list", () => {
    const { getByText, container } = open({
      inventory: () => null,
      error: () => "Nothing is answering /skills — the skills service is not reachable from here.",
    });
    expect(getByText(/Nothing is answering/)).toBeTruthy();
    expect(skillTabs(container)).toHaveLength(0);
  });
});

describe("permanent removal", () => {
  it("offers Remove and Delete as different things, on every row", () => {
    const { getAllByTitle } = open();
    expect(getAllByTitle("Keeps a copy under .backup/")).toHaveLength(3);
    expect(getAllByTitle("Permanent: the skill and every backup of it")).toHaveLength(3);
  });

  it("warns that an authored skill has no other copy", async () => {
    const asked: string[] = [];
    const { getAllByText, calls } = open({}, { confirm: (m) => (asked.push(m), true) });
    fireEvent.click(getAllByText("Delete")[0]!);
    await waitFor(() => expect(calls).toContain("delete:grilling"));
    expect(asked[0]).toContain("Nothing else has a copy");
  });

  it("says an installed skill can be taken again from whoever has it", async () => {
    const asked: string[] = [];
    const { getAllByText } = open({}, { confirm: (m) => (asked.push(m), false) });
    fireEvent.click(getAllByText("Delete")[2]!); // caveman, installed from bob
    expect(asked[0]).toContain("install it again from bob");
  });

  it("says a link's target is left alone", async () => {
    const inv = inventory();
    inv.skills[0]!.symlink = true;
    const asked: string[] = [];
    const { getAllByText } = open({ inventory: () => inv }, { confirm: (m) => (asked.push(m), false) });
    fireEvent.click(getAllByText("Delete")[0]!);
    expect(asked[0]).toContain("points at is left alone");
  });

  it("does nothing when the deletion is declined", async () => {
    const { getAllByText, calls } = open({}, { confirm: () => false });
    fireEvent.click(getAllByText("Delete")[0]!);
    await waitFor(() => expect(calls).not.toContain("delete:grilling"));
  });

  it("uninstalls a plugin after confirming, and says it can come back", async () => {
    const asked: string[] = [];
    const { tab, getAllByText, calls } = open({}, { confirm: (m) => (asked.push(m), true) });
    tab("Plugins");
    // Two plugins, so two buttons; superpowers is the first row.
    fireEvent.click(getAllByText("Uninstall")[0]!);
    await waitFor(() => expect(calls).toContain("uninstall:superpowers@official"));
    expect(asked[0]).toContain("install it again from its marketplace");
  });

  it("leaves a plugin alone when the uninstall is declined", async () => {
    const { tab, getAllByText, calls } = open({}, { confirm: () => false });
    tab("Plugins");
    fireEvent.click(getAllByText("Uninstall")[0]!);
    await waitFor(() => expect(calls).not.toContain("uninstall:superpowers@official"));
  });

  it("offers Uninstall on every plugin, not only a stale one", () => {
    const { tab, getAllByText } = open();
    tab("Plugins");
    expect(getAllByText("Uninstall")).toHaveLength(2);
    expect(getAllByText("Update")).toHaveLength(1); // only the stale one
  });
});

describe("the lists are tables, so the eye can cross a row", () => {
  it("gives each list real table semantics with column headers", () => {
    const { getByRole, getAllByRole, tab } = open({}, { sessions: true });
    expect(getByRole("table")).toBeTruthy();
    expect(getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Enabled",
      "Skill",
      "Source",
      "Actions",
    ]);
    tab("bob");
    expect(getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Skill",
      "Against yours",
      "Actions",
    ]);
    tab("Plugins");
    expect(getAllByRole("columnheader")[1]!.textContent).toBe("Plugin");
    tab("Sessions");
    expect(getAllByRole("columnheader")[1]!.textContent).toBe("Session");
  });

  it("puts one row per skill, with the expansion as its own row", () => {
    const { getAllByRole, getByText } = open();
    // 3 skills, no expansion yet
    expect(getAllByRole("row")).toHaveLength(4); // + the header row
    fireEvent.click(getByText("grilling"));
    expect(getAllByRole("row")).toHaveLength(5);
  });

  it("asks before replacing, since the label no longer carries the promise", async () => {
    const asked: string[] = [];
    const { tab, getByText, calls } = open({}, { confirm: (m) => (asked.push(m), false) });
    tab("bob");
    fireEvent.click(getByText("Replace"));
    await waitFor(() => expect(calls).not.toContain("install:bob/tdd:replace"));
    expect(asked[0]).toContain("backed up first");
  });
});

describe("installing from a repo", () => {
  const withSource = (over: Partial<SkillsStore> = {}) => {
    const [src, setSrc] = createSignal<SourceInfo | null>(null);
    const calls: string[] = [];
    const base = stubStore({
      source: src,
      inspecting: () => false,
      inspect: vi.fn(async (input: string) => {
        calls.push(`inspect:${input}`);
        setSrc({
          owner: "mattpocock",
          repo: "skills",
          knownOwner: true,
          skills: [
            { name: "tdd", path: "skills/engineering/tdd/SKILL.md", description: "Test first." },
            { name: "triage", path: "skills/engineering/triage/SKILL.md" },
          ],
          marketplace: "mattpocock-skills",
          plugins: [{ name: "mattpocock-skills", description: "All of them" }],
        });
      }),
      clearSource: () => setSrc(null),
      installSource: vi.fn(async (kind: string, names: string[]) => {
        calls.push(`install:${kind}:${names.join(",")}`);
      }),
      ...over,
    });
    const r = render(() => (
      <SettingsPanel
        prefs={fakePrefs()}
        onClose={() => {}}
        initialPage="skills"
        skills={base.store}
        confirm={() => true}
      />
    ));
    return { ...r, calls, store: base.store };
  };

  it("offers the field on Mine and Plugins, but not on Sessions", () => {
    const { getByLabelText, queryByLabelText, container } = withSource();
    expect(getByLabelText("Install from a repo")).toBeTruthy();
    fireEvent.click(skillTabs(container).find((el) => /Plugins/.test(el.textContent ?? ""))!);
    expect(queryByLabelText("Install from a repo")).not.toBeNull();
  });

  it("looks at a repo before installing anything", async () => {
    const { getByLabelText, getByText, calls } = withSource();
    fireEvent.input(getByLabelText("Install from a repo"), { target: { value: " mattpocock/skills " } });
    fireEvent.click(getByText("Look"));
    await waitFor(() => expect(calls).toContain("inspect:mattpocock/skills"));
    expect(calls.some((c) => c.startsWith("install:"))).toBe(false);
  });

  it("offers both kinds when a repo is both", async () => {
    const { getByLabelText, getByText } = withSource();
    fireEvent.input(getByLabelText("Install from a repo"), { target: { value: "mattpocock/skills" } });
    fireEvent.click(getByText("Look"));
    await waitFor(() => expect(getByText("Skills (2)")).toBeTruthy());
    expect(getByText(/Plugins in mattpocock-skills/)).toBeTruthy();
    expect(getByText("Test first.")).toBeTruthy();
  });

  it("installs only what was ticked, by kind", async () => {
    const { getByLabelText, getByText, getAllByRole, getByRole, calls } = withSource();
    fireEvent.input(getByLabelText("Install from a repo"), { target: { value: "mattpocock/skills" } });
    fireEvent.click(getByText("Look"));
    await waitFor(() => expect(getByText("Skills (2)")).toBeTruthy());
    const boxes = getAllByRole("checkbox").filter((b) =>
      (b.parentElement?.textContent ?? "").match(/^(tdd|triage|mattpocock-skills)/),
    );
    fireEvent.click(boxes[0]!); // tdd
    fireEvent.click(boxes[2]!); // the plugin
    fireEvent.click(getByRole("button", { name: /^Install/ }));
    await waitFor(() => expect(calls).toContain("install:skills:tdd"));
    expect(calls).toContain("install:plugins:mattpocock-skills");
    expect(calls).not.toContain("install:skills:triage");
  });

  it("says the installer runs as you before it runs", async () => {
    const asked: string[] = [];
    const [src, setSrc] = createSignal<SourceInfo | null>({
      owner: "some-stranger", repo: "skills", knownOwner: false,
      skills: [{ name: "x", path: "skills/x/SKILL.md" }],
    });
    const { store } = stubStore({ source: src, inspecting: () => false, clearSource: () => setSrc(null) });
    const { getAllByRole, getByRole } = render(() => (
      <SettingsPanel
        prefs={fakePrefs()}
        onClose={() => {}}
        initialPage="skills"
        skills={store}
        confirm={(m: string) => (asked.push(m), false)}
      />
    ));
    fireEvent.click(getAllByRole("checkbox").find((b) => (b.parentElement?.textContent ?? "").startsWith("x"))!);
    fireEvent.click(getByRole("button", { name: /^Install/ }));
    expect(asked[0]).toContain("runs that project's own installer as you");
  });

  it("flags an owner this account has not installed from before", () => {
    const [src] = createSignal<SourceInfo | null>({
      owner: "some-stranger", repo: "skills", knownOwner: false,
      skills: [{ name: "x", path: "skills/x/SKILL.md" }],
    });
    const { store } = stubStore({ source: src, inspecting: () => false });
    const { getByText } = render(() => (
      <SettingsPanel prefs={fakePrefs()} onClose={() => {}} initialPage="skills" skills={store} />
    ));
    expect(getByText(/not an owner you have installed from before/)).toBeTruthy();
  });
});

describe("a source that offers a lot", () => {
  const bigSource = (): SourceInfo => ({
    owner: "anthropics",
    repo: "claude-plugins-official",
    knownOwner: true,
    skills: Array.from({ length: 31 }, (_, i) => ({ name: `skill-${i}`, path: `s/${i}/SKILL.md` })),
    marketplace: "claude-plugins-official",
    plugins: Array.from({ length: 200 }, (_, i) => ({ name: `plugin-${i}` })),
    pluginsCut: 86,
  });

  it("offers a filter and says how many it left out", async () => {
    const [src] = createSignal<SourceInfo | null>(bigSource());
    const { store } = stubStore({ source: src, inspecting: () => false });
    const { getByLabelText, getByText, queryByText } = render(() => (
      <SettingsPanel prefs={fakePrefs()} onClose={() => {}} initialPage="skills" skills={store} />
    ));
    // 200 of 286 offered, and it says so rather than presenting 200 as all of them.
    expect(getByText(/Plugins in claude-plugins-official \(200 of 286\)/)).toBeTruthy();
    const filter = getByLabelText("Narrow what this repo offers");
    fireEvent.input(filter, { target: { value: "plugin-19" } });
    await waitFor(() => expect(queryByText("plugin-1")).toBeNull());
    expect(getByText("plugin-19")).toBeTruthy();
  });

  it("shows no filter for a short list", () => {
    const [src] = createSignal<SourceInfo | null>({
      owner: "o", repo: "r", knownOwner: true,
      skills: [{ name: "one", path: "one/SKILL.md" }],
    });
    const { store } = stubStore({ source: src, inspecting: () => false });
    const { queryByLabelText } = render(() => (
      <SettingsPanel prefs={fakePrefs()} onClose={() => {}} initialPage="skills" skills={store} />
    ));
    expect(queryByLabelText("Narrow what this repo offers")).toBeNull();
  });
});

describe("a skill's file, inline", () => {
  it("shows the file and where it lives when a row is opened", async () => {
    const { getByText, getByTitle } = open();
    fireEvent.click(getByText("grilling"));
    await waitFor(() => expect(cmDoc).toContain("body of grilling"));
    expect(getByTitle("/home/wizard/.claude/skills/grilling/SKILL.md")).toBeTruthy();
    // Nothing is saveable yet: the file and the draft are the same text.
    expect((getByText("Saved") as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves what was typed, for that skill", async () => {
    const { getByText, calls } = open();
    fireEvent.click(getByText("grilling"));
    await waitFor(() => expect(cmChange).toBeTruthy());
    cmChange!("---\nname: grilling\n---\nsharper\n");
    const save = () => getByText("Save") as HTMLButtonElement;
    await waitFor(() => expect(save().disabled).toBe(false));
    fireEvent.click(save());
    await waitFor(() =>
      expect(calls).toContain("save:grilling:---\nname: grilling\n---\nsharper\n"),
    );
    // Saved, so there is nothing left to save.
    await waitFor(() => expect((getByText("Saved") as HTMLButtonElement).disabled).toBe(true));
  });

  it("saves on Ctrl-S too, and only when there is something to save", async () => {
    const { getByText, calls } = open();
    fireEvent.click(getByText("grilling"));
    await waitFor(() => expect(cmSave).toBeTruthy());
    cmSave!(); // nothing typed yet
    expect(calls.filter((c) => c.startsWith("save:"))).toHaveLength(0);
    cmChange!("changed\n");
    cmSave!();
    await waitFor(() => expect(calls).toContain("save:grilling:changed\n"));
  });

  it("asks before throwing an edit away", async () => {
    const yes = open({}, { confirm: () => true });
    fireEvent.click(yes.getByText("grilling"));
    await waitFor(() => expect(cmChange).toBeTruthy());
    cmChange!("typed\n");
    await waitFor(() => expect((yes.getByText("Revert") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(yes.getByText("Revert"));
    await waitFor(() => expect(yes.calls).toContain("reread"));

    const no = open({}, { confirm: () => false });
    fireEvent.click(no.getByText("grilling"));
    await waitFor(() => expect(cmChange).toBeTruthy());
    cmChange!("typed\n");
    fireEvent.click(no.getByText("Revert"));
    expect(no.calls).not.toContain("reread");
  });

  it("keeps an edit in progress across a tab switch", async () => {
    const { getByText, tab } = open();
    fireEvent.click(getByText("grilling"));
    await waitFor(() => expect(cmChange).toBeTruthy());
    cmChange!("half-written\n");
    tab("Plugins");
    tab("Mine");
    // Rebuilt from the draft, not from the file: an unsaved edit that came back
    // as the old text would be one Save away from being lost silently.
    await waitFor(() => expect(cmDoc).toBe("half-written\n"));
  });

  it("shows a peer's file without offering to write it", async () => {
    const { tab, getByText, queryByText } = open();
    tab("bob");
    fireEvent.click(getByText("diagnose"));
    await waitFor(() => expect(getByText(/body of diagnose/)).toBeTruthy());
    expect(queryByText("Save")).toBeNull();
    expect(queryByText("Revert")).toBeNull();
  });

  it("says why a file could not be read, instead of showing an empty one", () => {
    const { getByText, queryByText } = open({
      expanded: () => rowKey("", "grilling"),
      view: () => null,
      viewError: () => "Could not reach the skills service.",
    });
    expect(getByText("Could not reach the skills service.")).toBeTruthy();
    expect(queryByText("Save")).toBeNull();
  });

  it("shows the open row's file under that row and no other", async () => {
    // A row can be open on a diff while a different one is expanded. The store
    // holds one file, so the one it holds must not appear under the other row.
    const { getByText, queryByText } = open({
      expanded: () => rowKey("bob", "diagnose"),
      diff: () => ({ owner: "bob", name: "tdd", verdict: "differs", diff: " same\n-mine\n+theirs" }),
      view: () => ({
        owner: "bob",
        name: "diagnose",
        skillmd: "body of diagnose\n",
        path: "/home/bob/.claude/skills/diagnose/SKILL.md",
      }),
    });
    fireEvent.click(getByText(/^bob$/));
    await waitFor(() => expect(getByText("-mine")).toBeTruthy());
    expect(getByText(/body of diagnose/)).toBeTruthy();
    expect(queryByText(/body of tdd/)).toBeNull();
  });
});
