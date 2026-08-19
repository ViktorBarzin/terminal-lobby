import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { SkillsPanel } from "../src/components/SkillsPanel";
import { rowKey, type SkillsStore } from "../src/store/skills";
import type { Inventory, SkillDiff } from "../src/lib/skills-api";

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
  const calls: string[] = [];
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
      setExpanded(expanded() === key ? "" : key);
    },
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
    ...over,
  };
  return { store, calls };
}

const sessions = () => [
  { name: "infra-work", state: "running" },
  { name: "notes", state: "done" },
];

/** open renders the panel and returns the queries plus a tab selector. */
function open(over: Partial<SkillsStore> = {}, opts: { sessions?: boolean; confirm?: (m: string) => boolean; onClose?: () => void } = {}) {
  const { store, calls } = stubStore(over);
  const r = render(() => (
    <SkillsPanel
      skills={store}
      onClose={opts.onClose ?? (() => {})}
      sessions={opts.sessions ? sessions : undefined}
      confirm={opts.confirm}
    />
  ));
  const tab = (name: string) => fireEvent.click(r.getByRole("tab", { name: new RegExp(name) }));
  return { ...r, store, calls, tab };
}

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

  it("is a modal dialog that closes on the ✕, Escape and the backdrop", async () => {
    let closed = 0;
    const { getByLabelText, container } = open({}, { onClose: () => closed++ });
    expect(container.querySelector('[role="dialog"][aria-modal="true"]')).toBeTruthy();

    fireEvent.click(getByLabelText("Close skills"));
    expect(closed).toBe(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(2);

    const backdrop = container.querySelector(".tl-settings-backdrop")!;
    fireEvent.click(backdrop);
    expect(closed).toBe(3);
  });

  it("offers one tab per list, the caller's own first", () => {
    const { getAllByRole } = open({}, { sessions: true });
    expect(getAllByRole("tab").map((t) => t.textContent)).toEqual([
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
    const { tab, getByText, calls } = open();
    tab("bob");
    fireEvent.click(getByText("tdd"));
    fireEvent.click(getByText("View diff"));
    await waitFor(() => expect(calls).toContain("diff:bob/tdd"));
    await waitFor(() => expect(getByText("-mine")).toBeTruthy());
    fireEvent.click(getByText("Replace (backs up mine)"));
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
    expect(getByText("mid-turn")).toBeTruthy();
    expect(getAllByText("Restart")).toHaveLength(1);
    fireEvent.click(getByText("Restart"));
    await waitFor(() => expect(calls).toContain("restart:notes"));
  });

  it("drops the Sessions tab when there are none", () => {
    const { getAllByRole } = open();
    expect(getAllByRole("tab").map((t) => t.textContent)).not.toContain("Sessions");
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
    const { getByText, queryAllByRole } = open({
      inventory: () => null,
      error: () => "Nothing is answering /skills — the skills service is not reachable from here.",
    });
    expect(getByText(/Nothing is answering/)).toBeTruthy();
    expect(queryAllByRole("tab")).toHaveLength(0);
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
