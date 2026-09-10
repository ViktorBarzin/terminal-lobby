/**
 * Undoing a RETITLE, which is the one action on the stack that cannot promise
 * to put the world back exactly.
 *
 * The title is restored exactly. The NAME may not be: tmux-api derives the
 * tmux name from the title (tmux-api/session_mutate.go:183 →
 * name_from_title.go derivedNameFor) and hands a collision the next free `-N`,
 * so undoing a title can land the session under a name it never had. That is
 * what the fake server below models, and it is why nothing in the handler
 * looks a session up by the name the entry was pushed with and stops there.
 *
 * Three ways to find the session again, in the order the handler tries them:
 * tmux's own session id, which a rename does not change (types/lobby.ts:41);
 * the name, for a server that supplies no id; and the birth name the server
 * records for a session renamed away from a minted id (`bornAs`). On top of
 * those, the stack rewrites the name under an entry when a rename lands while
 * it is waiting (`carry`, store/undo.ts UndoEntryBase). That is the path that
 * saves an entry about a session with no id and no birth name, so it has a
 * case of its own.
 */
import { createRoot, createSignal } from "solid-js";
import { describe, expect, it, onTestFinished } from "vitest";
import { ApiError, type LobbyApi } from "../src/lib/lobby-api";
import { createLobbyStore, type LobbyStore } from "../src/store/lobby";
import { createUndoStore, type UndoResult, type UndoStore } from "../src/store/undo";
import { titleUndoHandlers, type TitleUndoPorts } from "../src/store/undo.titles";
import {
  emptyLayout,
  type Layout,
  type Session,
  type Snapshot,
  type SnapshotRow,
  type Whoami,
} from "../src/types/lobby";

/**
 * The name a title produces, cut down to what these cases need: the server
 * slugs the title and gives a collision the next free `-N`, and leaves a
 * session that already answers to what its title derives exactly where it is
 * (name_from_title.go isDerivedFrom, which is what keeps the rule a fixed
 * point). null means nothing moves.
 *
 * A double that never suffixed would test the easy half of this file only.
 */
function derive(title: string, taken: readonly string[], own: string): string | null {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base === "") return null; // an emoji-only title, or none: no name to derive
  const busy = new Set(taken.filter((n) => n !== own));
  for (let n = 1; ; n++) {
    const next = n === 1 ? base : `${base}-${n}`;
    if (busy.has(next)) continue;
    return next === own ? null : next;
  }
}

interface World {
  stack: UndoStore;
  ports: TitleUndoPorts;
  /** Every title write that reached the fake server, oldest first. */
  writes: Array<{ name: string; title: string }>;
  /** The list as a poll hands it back. */
  live(): Session[];
  /** The row with this tmux session id, wherever the name has got to. */
  byId(id: string): Session | undefined;
  titleOf(name: string): string | undefined;
  /** A retitle somebody else made, landing on the next poll. */
  meddle(name: string, title: string): void;
  /** `tmux rename-session` at a shell: the name moves, the title does not. */
  renameRow(from: string, to: string): void;
  /** Killed on another device. */
  vanish(name: string): void;
  /** Make the next write fail, as a 500 from tmux-api does. */
  breakWrite(): void;
}

/**
 * A session table and a title endpoint that both live in this test.
 *
 * `bornAs` is deliberately never invented here. The server records it only for
 * a session renamed away from a MINTED id (types/lobby.ts:48), and these rows
 * are already named, so the case that needs one builds it by hand.
 */
function world(rows: Session[]): World {
  let live = rows;
  let broken = false;
  const writes: Array<{ name: string; title: string }> = [];

  /** Stamp the title, then move the name the way the server moves it. */
  function apply(name: string, title: string): void {
    const next =
      title === ""
        ? null
        : derive(
            title,
            live.map((s) => s.name),
            name,
          );
    live = live.map((s) =>
      s.name === name ? { ...s, title, ...(next ? { name: next } : null) } : s,
    );
  }

  const ports: TitleUndoPorts = {
    sessions: () => live,
    me: () => "wizard",
    setTitle: async (name, title) => {
      if (broken) {
        broken = false;
        return false;
      }
      // The store's own path returns false for a 404 as well, having toasted
      // "Session no longer exists" (store/lobby.ts applyTitle).
      if (!live.some((s) => s.name === name)) return false;
      writes.push({ name, title });
      apply(name, title);
      return true;
    },
  };

  return {
    stack: createUndoStore({
      storage: null,
      now: () => 1_700_000_000_000,
      handlers: titleUndoHandlers(ports),
    }),
    ports,
    writes,
    live: () => live,
    byId: (id) => live.find((s) => s.id === id),
    titleOf: (name) => live.find((s) => s.name === name)?.title,
    meddle: (name, title) => apply(name, title),
    renameRow: (from, to) => {
      live = live.map((s) => (s.name === from ? { ...s, name: to } : s));
    },
    vanish: (name) => {
      live = live.filter((s) => s.name !== name);
    },
    breakWrite: () => {
      broken = true;
    },
  };
}

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: 1000,
  created: 1000,
  owner: "wizard",
  ...over,
});

const expectOk = async (r: Promise<UndoResult>): Promise<void> => {
  expect(await r).toEqual({ ok: true });
};

const expectRefusal = async (r: Promise<UndoResult>, why: RegExp): Promise<void> => {
  const out = await r;
  expect(out.ok).toBe(false);
  expect(out.ok === false ? out.reason : null).toMatch(why);
};

/**
 * The action, performed the way store/lobby.ts performs it: read the title and
 * the id BEFORE the write, then push with the name the session has AFTER it,
 * since the write is what moves the name.
 */
async function retitle(w: World, name: string, title: string): Promise<void> {
  const was = w.live().find((s) => s.name === name);
  if (!(await w.ports.setTitle(name, title))) return;
  // Found the way the store finds it (nameAfterTitle): the id, then the birth
  // name, then nothing, which leaves the name the retitle was made against.
  const now =
    (was?.id ? w.byId(was.id) : undefined) ??
    (was?.bornAs ? w.live().find((s) => s.bornAs === was.bornAs) : undefined);
  w.stack.push({
    kind: "title",
    session: now?.name ?? name,
    ...(was?.id ? { id: was.id } : null),
    before: was?.title ?? "",
    after: title,
  });
}

describe("undoing a retitle — round trip", () => {
  it("puts the old title back, and the new one back on redo", async () => {
    const w = world([sess("deploy-the-thing", { id: "$1", title: "Deploy the thing" })]);
    await retitle(w, "deploy-the-thing", "Fix the deploy");
    expect(w.titleOf("fix-the-deploy")).toBe("Fix the deploy");

    await expectOk(w.stack.undo());
    expect(w.titleOf("deploy-the-thing")).toBe("Deploy the thing");

    await expectOk(w.stack.redo());
    expect(w.titleOf("fix-the-deploy")).toBe("Fix the deploy");
  });

  it("clears the title back to the bare name when there was none before", async () => {
    // An empty `before` is a real instruction, not a missing value: it is the
    // state every session that predates titles sits in, and emptying the
    // rename box is how a person asks for it back (store/lobby.ts clearTitle).
    const w = world([sess("k7m2q9x4tp0v", { id: "$1" })]);
    await retitle(w, "k7m2q9x4tp0v", "Fix the deploy");
    expect(w.titleOf("fix-the-deploy")).toBe("Fix the deploy");

    await expectOk(w.stack.undo());
    expect(w.writes.at(-1)).toEqual({ name: "fix-the-deploy", title: "" });
    expect(w.byId("$1")?.title).toBe("");
    // Clearing a title derives nothing, so the name it acquired stays put.
    // A name invented for a running session would be worse than a stale one.
    expect(w.byId("$1")?.name).toBe("fix-the-deploy");
  });

  it("undoes a clear, which is the same entry with an empty `after`", async () => {
    const w = world([sess("deploy-the-thing", { id: "$1", title: "Deploy the thing" })]);
    await retitle(w, "deploy-the-thing", "");
    expect(w.titleOf("deploy-the-thing")).toBe("");

    await expectOk(w.stack.undo());
    expect(w.titleOf("deploy-the-thing")).toBe("Deploy the thing");
    await expectOk(w.stack.redo());
    expect(w.titleOf("deploy-the-thing")).toBe("");
  });

  it("restores the title exactly even when the name cannot come back", async () => {
    // A sibling took the name the old title derives while this entry waited,
    // so the undo lands the session on `deploy-the-thing-2`. The title is the
    // part that is promised; the name is the server's to decide.
    const w = world([
      sess("deploy-the-thing", { id: "$1", title: "Deploy the thing" }),
      sess("beta", { id: "$2" }),
    ]);
    await retitle(w, "deploy-the-thing", "Fix the deploy");
    w.meddle("beta", "Deploy the thing"); // beta is now `deploy-the-thing`

    await expectOk(w.stack.undo());
    expect(w.byId("$1")).toMatchObject({ name: "deploy-the-thing-2", title: "Deploy the thing" });
    expect(w.byId("$2")?.name).toBe("deploy-the-thing");

    // And the redo still finds it, because the entry is keyed by the id rather
    // than by a name the undo itself moved.
    await expectOk(w.stack.redo());
    expect(w.byId("$1")).toMatchObject({ name: "fix-the-deploy", title: "Fix the deploy" });
  });
});

describe("undoing a retitle — finding the session again", () => {
  it("finds it by id when its name has moved on", async () => {
    // Somebody renamed the session at a shell while the entry waited, so
    // nothing in the live list answers to the name it was pushed with. The id
    // is the one field a rename does not change.
    const w = world([sess("deploy-the-thing", { id: "$1", title: "Deploy the thing" })]);
    await retitle(w, "deploy-the-thing", "Fix the deploy");
    w.renameRow("fix-the-deploy", "renamed-at-a-shell");

    await expectOk(w.stack.undo());
    expect(w.writes.at(-1)).toEqual({ name: "renamed-at-a-shell", title: "Deploy the thing" });
  });

  it("follows a rename the stack carried onto the entry", async () => {
    // A server that supplies no session id and no birth name, so the name is
    // the only handle the entry has. Clearing a title derives nothing, so this
    // entry's own write left the name alone, and then somebody renamed the
    // session at a shell. `carry` is what keeps the entry current
    // (store/lobby.ts carryRenamedRecords calls it for every rename a poll
    // reveals).
    const w = world([sess("work", { title: "Work stuff" })]);
    await retitle(w, "work", "");
    w.renameRow("work", "play");
    w.stack.carry("work", "play");

    await expectOk(w.stack.undo());
    expect(w.writes.at(-1)).toEqual({ name: "play", title: "Work stuff" });
  });

  it("refuses when nothing links the entry to a live session any more", async () => {
    // The same world with the carry left out, which is what makes the case
    // above a test of the carry rather than of the name lookup.
    const w = world([sess("work", { title: "Work stuff" })]);
    await retitle(w, "work", "");
    w.renameRow("work", "play");

    await expectRefusal(w.stack.undo(), /gone/);
    expect(w.writes).toHaveLength(1);
  });

  it("finds it by the birth name when the id cannot help", async () => {
    // A session created with a minted id and renamed the moment its first
    // title landed (ADR-0022). The server records the name it was born with,
    // which is the name this tab was holding.
    const w = world([sess("fix-the-deploy", { title: "Fix the deploy", bornAs: "k7m2q9x4tp0v" })]);
    w.stack.push({ kind: "title", session: "k7m2q9x4tp0v", before: "", after: "Fix the deploy" });

    await expectOk(w.stack.undo());
    expect(w.writes.at(-1)).toEqual({ name: "fix-the-deploy", title: "" });
  });

  it("refuses when the session is gone", async () => {
    const w = world([sess("deploy-the-thing", { id: "$1", title: "Deploy the thing" })]);
    await retitle(w, "deploy-the-thing", "Fix the deploy");
    w.vanish("fix-the-deploy");
    await expectRefusal(w.stack.undo(), /gone/);
  });

  it("leaves another user's session alone", async () => {
    // A foreign row's id comes from another user's tmux server, where the same
    // $1 names an unrelated session (store/lobby.ts renamesBetween). Retitling
    // one on their behalf is not something an undo press asked for.
    const w = world([sess("alpha", { id: "$1", title: "Theirs", owner: "bob" })]);
    w.stack.push({ kind: "title", session: "alpha", id: "$1", before: "Mine", after: "Theirs" });
    await expectRefusal(w.stack.undo(), /gone/);
    expect(w.writes).toHaveLength(0);
  });
});

describe("undoing a retitle — the precondition", () => {
  it("refuses when the title changed under it", async () => {
    const w = world([sess("deploy-the-thing", { id: "$1", title: "Deploy the thing" })]);
    await retitle(w, "deploy-the-thing", "Fix the deploy");
    w.meddle("fix-the-deploy", "Something else");

    await expectRefusal(w.stack.undo(), /retitled/);
    expect(w.byId("$1")?.title).toBe("Something else"); // a refusal writes nothing
    expect(w.writes).toHaveLength(1);
  });

  it("still undoes when an unrelated session was retitled since", async () => {
    const w = world([
      sess("deploy-the-thing", { id: "$1", title: "Deploy the thing" }),
      sess("read-the-docs", { id: "$2", title: "Read the docs" }),
    ]);
    await retitle(w, "deploy-the-thing", "Fix the deploy");
    w.meddle("read-the-docs", "Write the docs");

    await expectOk(w.stack.undo());
    expect(w.byId("$1")?.title).toBe("Deploy the thing");
    expect(w.byId("$2")?.title).toBe("Write the docs");
  });

  it("refuses when the write does not land", async () => {
    const w = world([sess("deploy-the-thing", { id: "$1", title: "Deploy the thing" })]);
    await retitle(w, "deploy-the-thing", "Fix the deploy");
    w.breakWrite();
    await expectRefusal(w.stack.undo(), /did not go through/);
    expect(w.byId("$1")?.title).toBe("Fix the deploy");
  });

  it("drops the entry it refused, so the next press reaches the one below", async () => {
    const w = world([
      sess("deploy-the-thing", { id: "$1", title: "Deploy the thing" }),
      sess("read-the-docs", { id: "$2", title: "Read the docs" }),
    ]);
    await retitle(w, "deploy-the-thing", "Fix the deploy");
    await retitle(w, "read-the-docs", "Write the docs");
    w.meddle("write-the-docs", "Somebody else");

    await expectRefusal(w.stack.undo(), /retitled/);
    await expectOk(w.stack.undo());
    expect(w.byId("$1")?.title).toBe("Deploy the thing");
  });
});

// ---- the store records them ------------------------------------------------
// The cases above drive the handler against fake ports. These run the REAL
// store actions against a fake api, because the entry has to describe what the
// action actually did: a `before` read after the write, or a push on a retitle
// the server refused, is a bug no handler test can see.

class FakeApi implements LobbyApi {
  whoamiVal: Whoami = { authentik: "wiz@x", osUser: "wizard" };
  sessionsVal: Session[] = [];
  layoutVal: Layout = emptyLayout();
  titles: Array<{ name: string; title: string }> = [];
  titleError = 0;

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
  async killSession(_name: string) {}
  /** Stamps the title and moves the name after it, as tmux-api does. */
  async setSessionTitle(name: string, title: string) {
    if (this.titleError) {
      const status = this.titleError;
      this.titleError = 0;
      throw new ApiError(status, "nope");
    }
    this.titles.push({ name, title });
    const next =
      title === ""
        ? null
        : derive(
            title,
            this.sessionsVal.map((s) => s.name),
            name,
          );
    this.sessionsVal = this.sessionsVal.map((s) =>
      s.name === name ? { ...s, title, ...(next ? { name: next } : null) } : s,
    );
  }
  async prewarm(_dir: string) {}
  async releasePrewarm(_dir: string) {}
  async restoreSessions(_sel?: { snapshot: string; sessions: string[] }) {}
  async listSnapshots() {
    return { snapshots: [] as Snapshot[], memAvailableMb: -1, perSessionMb: 550 };
  }
  async getSnapshot(_ts: string) {
    return [] as SnapshotRow[];
  }
}

interface Wired {
  store: LobbyStore;
  stack: UndoStore;
  api: FakeApi;
  /** Every rename the store carried onto the stack, oldest first. */
  carried: Array<[string, string]>;
}

/** The store as App wires it, with a stack behind it. */
async function wire(sessions: Session[]): Promise<Wired> {
  const api = new FakeApi();
  api.sessionsVal = sessions;
  const inner = createUndoStore({ storage: null });
  const carried: Array<[string, string]> = [];
  // Wrapped rather than spied so the real carry still runs: this is the seam
  // store/lobby.ts calls from carryRenamedRecords, and the assertion is that
  // it calls it at all.
  const stack: UndoStore = {
    ...inner,
    carry: (from, to) => {
      carried.push([from, to]);
      inner.carry(from, to);
    },
  };
  let store!: LobbyStore;
  const dispose = createRoot((d) => {
    const [order] = createSignal<"manual">("manual");
    store = createLobbyStore({
      api,
      autoStart: false,
      syncHash: false,
      sessionOrder: order,
      undo: stack,
    });
    return d;
  });
  onTestFinished(() => {
    store.dispose();
    dispose();
  });
  await store.refresh();
  return { store, stack, api, carried };
}

const titleOf = (api: FakeApi, name: string): string | undefined =>
  api.sessionsVal.find((s) => s.name === name)?.title;

describe("the store records what it did", () => {
  it("undoes a retitle it made", async () => {
    const w = await wire([sess("deploy-the-thing", { id: "$1", title: "Deploy the thing" })]);
    expect(await w.store.rename("deploy-the-thing", "Fix the deploy")).toBe(true);
    expect(titleOf(w.api, "fix-the-deploy")).toBe("Fix the deploy");

    await expectOk(w.stack.undo());
    expect(titleOf(w.api, "deploy-the-thing")).toBe("Deploy the thing");
    await expectOk(w.stack.redo());
    expect(titleOf(w.api, "fix-the-deploy")).toBe("Fix the deploy");
  });

  it("undoes a cleared title, which goes through the same entry", async () => {
    // Emptying the rename box routes through clearTitle rather than rename
    // (store/lobby.ts:958), so it needs its own push or the one action on this
    // screen that cannot be re-typed from memory is the one Cmd+Z misses.
    const w = await wire([sess("deploy-the-thing", { id: "$1", title: "Deploy the thing" })]);
    expect(await w.store.rename("deploy-the-thing", "  ")).toBe(true);
    expect(titleOf(w.api, "deploy-the-thing")).toBe("");

    await expectOk(w.stack.undo());
    expect(titleOf(w.api, "deploy-the-thing")).toBe("Deploy the thing");
  });

  it("records the title as the server cleaned it", async () => {
    // The store cleans what was typed before sending it (lib/title.ts
    // cleanTitle), so an entry that kept the raw text would redo a title the
    // server never stored and then refuse its own precondition.
    const w = await wire([sess("alpha", { id: "$1" })]);
    await w.store.rename("alpha", "  Fix\tthe   deploy  ");
    expect(w.api.titles).toEqual([{ name: "alpha", title: "Fix the deploy" }]);

    await expectOk(w.stack.undo());
    await expectOk(w.stack.redo());
    expect(titleOf(w.api, "fix-the-deploy")).toBe("Fix the deploy");
  });

  it("records nothing when the retitle did not land", async () => {
    const w = await wire([sess("alpha", { id: "$1" })]);
    w.api.titleError = 404;
    expect(await w.store.rename("alpha", "Fix the deploy")).toBe(false);
    expect(w.stack.canUndo()).toBe(false);
  });

  it("carries a rename onto the stack", async () => {
    // The entries hold session NAMES, so a rename landing while one waits has
    // to be rewritten under it (store/undo.ts UndoEntryBase). This is the same
    // seam watch mode, the view mode and the draft already use
    // (carryRenamedRecords), and the assertion is that the stack is on it.
    const w = await wire([sess("alpha", { id: "$1" })]);
    w.api.sessionsVal = [sess("beta", { id: "$1" })];
    await w.store.refresh();
    expect(w.carried).toEqual([["alpha", "beta"]]);
  });

  it("unwinds two retitles in reverse", async () => {
    const w = await wire([
      sess("one", { id: "$1", title: "One" }),
      sess("two", { id: "$2", title: "Two" }),
    ]);
    await w.store.rename("one", "One again");
    await w.store.rename("two", "Two again");

    await expectOk(w.stack.undo());
    await expectOk(w.stack.undo());
    expect(w.api.sessionsVal.map((s) => [s.name, s.title])).toEqual([
      ["one", "One"],
      ["two", "Two"],
    ]);
  });
});
