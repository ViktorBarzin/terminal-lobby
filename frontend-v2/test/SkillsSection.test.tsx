import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { SkillsSection } from "../src/components/SkillsSection";
import { rowKey, type SkillsStore } from "../src/store/skills";
import type { Inventory, SkillDiff } from "../src/lib/skills-api";

/**
 * The Skills group of the Settings overlay. The store is stubbed so these assert
 * what a person can SEE and DO — which rows offer an install, what a collision
 * offers instead, which sessions may be restarted — rather than re-testing the
 * fetch layer.
 */

const inventory = (over: Partial<Inventory> = {}): Inventory => ({
  user: "wizard",
  skills: [
    { name: "grilling", files: 1, executable: 0, bytes: 900, hash: "h1", enabled: true },
    {
      name: "cluster-health",
      files: 3,
      executable: 1,
      bytes: 4096,
      hash: "h2",
      enabled: true,
      from: "emo",
      sourceHash: "old",
      updateAvailable: true,
    },
    { name: "caveman", files: 1, executable: 0, bytes: 500, hash: "h3", enabled: false, from: "emo" },
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
      user: "emo",
      skills: [
        { name: "diagnose", files: 2, executable: 0, bytes: 2048, hash: "p1", enabled: true, verdict: "absent" },
        { name: "tdd", files: 2, executable: 1, bytes: 3000, hash: "p2", enabled: true, verdict: "differs" },
        { name: "file-issue", files: 1, executable: 0, bytes: 800, hash: "h9", enabled: true, verdict: "same" },
      ],
    },
  ],
  ...over,
});

function stubStore(over: Partial<SkillsStore> = {}) {
  const [inv, setInv] = createSignal<Inventory | null>(inventory());
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
    update: vi.fn(async (plugin) => {
      calls.push(`update:${plugin}`);
    }),
    restart: vi.fn(async (session) => {
      calls.push(`restart:${session}`);
    }),
    ...over,
  };
  return { store, calls, setInv };
}

const sessions = () => [
  { name: "infra-work", state: "running" },
  { name: "notes", state: "done" },
];

describe("the Skills group", () => {
  it("asks for the inventory when it first renders, not before", () => {
    const load = vi.fn(async () => {});
    const { store } = stubStore({ inventory: () => null, load });
    render(() => <SkillsSection skills={store} />);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not re-ask when an inventory is already in hand", () => {
    const load = vi.fn(async () => {});
    const { store } = stubStore({ load });
    render(() => <SkillsSection skills={store} />);
    expect(load).not.toHaveBeenCalled();
  });

  it("lists this account's skills with where each came from", () => {
    const { store } = stubStore();
    const { getByText } = render(() => <SkillsSection skills={store} />);
    expect(getByText("Mine (3)")).toBeTruthy();
    expect(getByText("own")).toBeTruthy();
    expect(getByText("from emo · update")).toBeTruthy();
    expect(getByText("from emo")).toBeTruthy();
  });

  it("shows a disabled skill unchecked, and toggling it says which id", async () => {
    const { store, calls } = stubStore();
    const { getByLabelText } = render(() => <SkillsSection skills={store} />);
    const box = getByLabelText("Enable caveman") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(calls).toContain("toggle:caveman@skills-dir:true"));
  });

  it("offers Install only for a name this account does not use", () => {
    const { store } = stubStore();
    const { getAllByText } = render(() => <SkillsSection skills={store} />);
    // diagnose is absent here; tdd differs and file-issue is identical, so
    // exactly one Install button.
    expect(getAllByText("Install")).toHaveLength(1);
  });

  it("counts what is takeable, leaving the identical skill out", () => {
    const { store } = stubStore();
    const { getByText } = render(() => <SkillsSection skills={store} />);
    expect(getByText(/2 to take/)).toBeTruthy();
  });

  it("turns a collision into a diff and a replace rather than an install", async () => {
    const { store, calls } = stubStore();
    const { getByText, queryByText } = render(() => <SkillsSection skills={store} />);
    fireEvent.click(getByText("tdd"));
    expect(getByText("differs")).toBeTruthy();
    expect(queryByText("Install")).not.toBeNull(); // diagnose still offers one
    fireEvent.click(getByText("View diff"));
    await waitFor(() => expect(calls).toContain("diff:emo/tdd"));
    await waitFor(() => expect(getByText("-mine")).toBeTruthy());
    fireEvent.click(getByText("Replace (backs up mine)"));
    await waitFor(() => expect(calls).toContain("install:emo/tdd:replace"));
  });

  it("says how many files a peer's skill would bring and how many of them run", () => {
    const { store } = stubStore();
    const { getByText } = render(() => <SkillsSection skills={store} />);
    fireEvent.click(getByText("tdd"));
    expect(getByText("2 files · 1 executable · 3 KB")).toBeTruthy();
  });

  it("confirms before removing, and does nothing when that is declined", async () => {
    const { store, calls } = stubStore();
    const { getByText } = render(() => (
      <SkillsSection skills={store} confirm={() => false} />
    ));
    fireEvent.click(getByText("grilling"));
    fireEvent.click(getByText("Remove"));
    await waitFor(() => expect(calls).not.toContain("remove:grilling"));
  });

  it("removes when the confirmation is accepted", async () => {
    const { store, calls } = stubStore();
    const { getByText } = render(() => (
      <SkillsSection skills={store} confirm={() => true} />
    ));
    fireEvent.click(getByText("grilling"));
    fireEvent.click(getByText("Remove"));
    await waitFor(() => expect(calls).toContain("remove:grilling"));
  });

  it("warns before an update would displace local edits", async () => {
    const inv = inventory();
    inv.skills[1].locallyModified = true;
    const { store, calls } = stubStore({ inventory: () => inv });
    const asked: string[] = [];
    const { getByText, getAllByText } = render(() => (
      <SkillsSection
        skills={store}
        confirm={(m) => {
          asked.push(m);
          return true;
        }}
      />
    ));
    fireEvent.click(getByText("cluster-health"));
    fireEvent.click(getAllByText("Update")[0]);
    await waitFor(() => expect(calls).toContain("install:emo/cluster-health:replace"));
    expect(asked[0]).toContain("local edits");
  });

  it("offers a plugin update only for the stale one", async () => {
    const { store, calls } = stubStore();
    const { getByText, getAllByText } = render(() => <SkillsSection skills={store} />);
    expect(getByText("Plugins (2)")).toBeTruthy();
    expect(getByText("5.1.0 · 5.3.0")).toBeTruthy();
    // Only the plugin's: a skill's Update lives inside its expanded row, and
    // nothing is expanded here.
    expect(getAllByText("Update")).toHaveLength(1);
    fireEvent.click(getAllByText("Update")[0]);
    await waitFor(() => expect(calls).toContain("update:superpowers@official"));
  });

  it("offers Restart for an idle session and explains why a busy one has none", async () => {
    const { store, calls } = stubStore();
    const { getByText, getAllByText } = render(() => (
      <SkillsSection skills={store} sessions={sessions} />
    ));
    expect(getByText("mid-turn")).toBeTruthy();
    expect(getAllByText("Restart")).toHaveLength(1);
    fireEvent.click(getByText("Restart"));
    await waitFor(() => expect(calls).toContain("restart:notes"));
  });

  it("says an account could not be read instead of showing it as empty", () => {
    const { store } = stubStore({
      inventory: () => inventory({ peers: [{ user: "emo", unreachable: true }] }),
    });
    const { getByText } = render(() => <SkillsSection skills={store} />);
    expect(getByText(/Could not read emo's skills/)).toBeTruthy();
  });

  it("surfaces a failed inventory read rather than an empty list", () => {
    const { store } = stubStore({
      inventory: () => null,
      error: () => "Could not reach the skills service.",
      load: vi.fn(async () => {}),
    });
    const { getByText, queryByText } = render(() => <SkillsSection skills={store} />);
    expect(getByText("Could not reach the skills service.")).toBeTruthy();
    expect(queryByText(/^Mine/)).toBeNull();
  });

  it("states the visibility rule, since it is the surprising part", () => {
    const { store } = stubStore();
    const { getByText } = render(() => <SkillsSection skills={store} />);
    expect(getByText(/Everyone here can see everyone's skills/)).toBeTruthy();
  });
});
