import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiError, getWorkspaces, normalizeWorkspaces, putWorkspaces } from "../src/lib/lobby-api";
import { apiUrl } from "../src/lib/config";
import { MIN_WORKSPACE_MEMBERS, WORKSPACES_VERSION, type Workspaces } from "../src/types/lobby";

/**
 * The client half of GET/PUT /api/sessions/workspaces — which sessions belong on
 * screen together (tmux-api/workspaces.go).
 *
 * Only the SERVER half of a Workspace is on this wire: the id and the ordered
 * members. The tree of rows and columns never leaves the browser (ADR-0027), so
 * what these tests watch hardest is the normalizer dropping every field the
 * server does not declare. That is not tidiness. tmux-api unmarshals into a
 * struct, so a field it has never heard of is silently gone on the way in and
 * absent on the way out — which is how the Ctrl+J dock used to vanish four
 * seconds after it was opened, before DockState became a real field. A client
 * that kept such a field would show state that survives in this tab and nowhere
 * else, and the bug would read as "the other tab forgot my workspace".
 */

type FetchArgs = [string, RequestInit];

/** A fetch answering one canned JSON body, the way tmux-api's GET does. `body`
 *  omitted is a bodiless reply, which is what its PUT answers with (204). */
function answering(status: number, body?: unknown) {
  const init = { status, headers: { "Content-Type": "application/json" } };
  return vi.fn(() =>
    Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), init)),
  );
}

/** A fetch answering a body verbatim — the server's error paths go through
 *  `http.Error`, which writes text/plain, and an ingress in front of a dead
 *  backend writes HTML. Neither is JSON. */
function answeringRaw(status: number, body: string | null) {
  return vi.fn(() => Promise.resolve(new Response(body, { status })));
}

/**
 * A body as it actually arrives: `unknown`, however the declaration reads.
 *
 * `normalizeWorkspaces` takes `Partial<Workspaces>` for the same reason
 * `normalizeLayout` takes `Partial<Layout>` — it describes what the caller MEANT
 * to receive. The server is a separate program, so the cast is where that
 * optimism is admitted, and these tests feed it the shapes a real deployment can
 * produce: an older server, a newer one, a half-written document.
 */
function asWire(v: unknown): Partial<Workspaces> {
  return v as Partial<Workspaces>;
}

/** One workspace of two tiles, exactly as the document holds it. */
const twoTiles: Workspaces = {
  version: WORKSPACES_VERSION,
  workspaces: [{ id: "w1", members: [{ name: "auth" }, { name: "deploy" }] }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reading which sessions belong together", () => {
  it("reads the document the server holds, in the member order it holds it in", async () => {
    // Member order is load-bearing rather than decorative: a device that has
    // never seen this workspace has no geometry for it and auto-arranges evenly
    // in THIS order, so a fresh laptop and a fresh phone lay it out alike.
    const f = answering(200, twoTiles);
    vi.stubGlobal("fetch", f);

    expect(await getWorkspaces()).toEqual(twoTiles);

    const [url, init] = f.mock.calls[0] as unknown as FetchArgs;
    expect(url).toBe(apiUrl("/workspaces"));
    expect(init.credentials).toBe("same-origin");
    // The browser must not serve a cached membership after a drag changed it.
    expect(init.cache).toBe("no-store");
  });

  it("reads a user who has never split anything as no workspaces", async () => {
    vi.stubGlobal("fetch", answering(200, { version: 1, workspaces: [] }));
    expect(await getWorkspaces()).toEqual({ version: WORKSPACES_VERSION, workspaces: [] });
  });

  it("throws the status rather than reading a 500 as an empty membership", async () => {
    // An empty document and an unreachable server are different answers, and
    // only one of them should unmark every member in the sidebar. tmux-api
    // answers 500 for a document it could not parse, on purpose — better a 500
    // than silently wiping the grouping on the next whole-document PUT.
    vi.stubGlobal("fetch", answeringRaw(500, "workspaces load for wizard failed"));
    await expect(getWorkspaces()).rejects.toMatchObject({ name: "ApiError", status: 500 });
  });

  it("rejects a reply that is not JSON at all", async () => {
    // What an ingress in front of a restarting tmux-api serves. Reading it as
    // "you have no workspaces" would be a lie the caller cannot tell from the
    // truth; a rejection lets it keep what it already had on screen.
    vi.stubGlobal("fetch", answeringRaw(200, "<html>502 Bad Gateway</html>"));
    await expect(getWorkspaces()).rejects.toThrow();
  });
});

describe("what a normalized document keeps, and what it drops", () => {
  it("drops fields the server does not declare, at both levels", async () => {
    vi.stubGlobal(
      "fetch",
      answering(200, {
        version: 1,
        focused: "auth",
        workspaces: [
          {
            id: "w1",
            members: [{ name: "auth" }, { name: "deploy" }],
            name: "review",
            tree: { kind: "leaf", key: "wizard auth" },
          },
        ],
      }),
    );

    const got = await getWorkspaces();
    expect(got).toEqual(twoTiles);
    expect(Object.keys(got)).toEqual(["version", "workspaces"]);
    expect(got.workspaces.map((w) => Object.keys(w))).toEqual([["id", "members"]]);
  });

  it("cannot carry an unknown field back to the server on the next write", async () => {
    // The round trip is where the drop earns its keep. A client that kept
    // `tree` here would PUT geometry the server unmarshals away, and the next
    // device to read the document would see a workspace that had lost the
    // arrangement this one thinks it saved.
    vi.stubGlobal(
      "fetch",
      answering(200, {
        version: 1,
        workspaces: [
          { id: "w1", members: [{ name: "auth" }, { name: "deploy" }], tree: { kind: "split" } },
        ],
      }),
    );
    const got = await getWorkspaces();

    const put = answering(204);
    vi.stubGlobal("fetch", put);
    await putWorkspaces(got);

    const [url, init] = put.mock.calls[0] as unknown as FetchArgs;
    expect(url).toBe(apiUrl("/workspaces"));
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual(twoTiles);
  });

  it("answers in the version this client speaks, whatever the document claims", () => {
    const got = normalizeWorkspaces(
      asWire({
        version: 7,
        workspaces: [{ id: "w1", members: [{ name: "auth" }, { name: "deploy" }] }],
      }),
    );
    expect(got.version).toBe(WORKSPACES_VERSION);
  });

  it.each([
    ["nothing at all", null],
    ["a body that is not an object", "workspaces"],
    ["a document whose workspaces are not a list", { version: 1, workspaces: { w1: ["auth"] } }],
    ["a workspace that is not an object", { version: 1, workspaces: [null, 7] }],
    [
      "a workspace with no id",
      { version: 1, workspaces: [{ members: [{ name: "auth" }, { name: "deploy" }] }] },
    ],
    [
      "an id outside the session-name charset",
      {
        version: 1,
        workspaces: [{ id: "w 1/../etc", members: [{ name: "auth" }, { name: "deploy" }] }],
      },
    ],
  ])("reads %s as no workspaces", (_what, raw) => {
    expect(normalizeWorkspaces(asWire(raw))).toEqual({
      version: WORKSPACES_VERSION,
      workspaces: [],
    });
  });

  it("drops entries in the member list that are not members at all", () => {
    // A bare string is the shape from before a member carried an owner, and the
    // numbers and nulls are what a half-written document holds. None of them is
    // an object with a name, so none of them becomes a tile pointing at nothing.
    const got = normalizeWorkspaces(
      asWire({
        version: 1,
        workspaces: [
          { id: "w1", members: [{ name: "auth" }, 7, null, "docs", { name: "deploy" }] },
        ],
      }),
    );
    expect(got).toEqual(twoTiles);
  });

  it("gives a session claimed twice to the workspace that names it first", () => {
    // EXCLUSIVITY: a session belongs to at most one workspace, because two tiles
    // of one session would contend for its Grid continuously. The server refuses
    // such a document on write and repairs it first-mention-wins on read
    // (healWorkspaces); this mirrors the repair, so a client in front of a server
    // too old to have it shows the grouping that server will settle on anyway.
    const got = normalizeWorkspaces(
      asWire({
        version: 1,
        workspaces: [
          { id: "w1", members: [{ name: "auth" }, { name: "deploy" }] },
          { id: "w2", members: [{ name: "auth" }, { name: "docs" }, { name: "logs" }] },
        ],
      }),
    );
    expect(got.workspaces).toEqual([
      { id: "w1", members: [{ name: "auth" }, { name: "deploy" }] },
      { id: "w2", members: [{ name: "docs" }, { name: "logs" }] },
    ]);
  });

  it("drops a session named twice inside one workspace", () => {
    const got = normalizeWorkspaces(
      asWire({
        version: 1,
        workspaces: [
          { id: "w1", members: [{ name: "auth" }, { name: "auth" }, { name: "deploy" }] },
        ],
      }),
    );
    expect(got).toEqual(twoTiles);
  });

  it("drops a workspace left below the two tiles that make one", () => {
    // `docs` is all w2 has left once w1 has claimed `auth`, and one tile is not a
    // workspace: closing down to a single tile ends it and shows that session on
    // its own, so a one-member group describes a state the UI cannot be in.
    const orphan = { id: "w2", members: [{ name: "auth" }, { name: "docs" }] };
    expect(orphan.members.length - 1).toBeLessThan(MIN_WORKSPACE_MEMBERS);

    const got = normalizeWorkspaces(
      asWire({
        version: 1,
        workspaces: [{ id: "w1", members: [{ name: "auth" }, { name: "deploy" }] }, orphan],
      }),
    );
    expect(got).toEqual(twoTiles);
  });

  it("keeps the first of two workspaces sharing an id", () => {
    const got = normalizeWorkspaces(
      asWire({
        version: 1,
        workspaces: [
          { id: "w1", members: [{ name: "auth" }, { name: "deploy" }] },
          { id: "w1", members: [{ name: "docs" }, { name: "logs" }] },
        ],
      }),
    );
    expect(got).toEqual(twoTiles);
  });

  it("keeps a member whose session is dead, because a kill keeps membership", () => {
    // Only a deliberate close or drag-out removes a session from a workspace. A
    // killed member keeps its slot in the member order so a restore puts its tile
    // back where it was, which is what assignments/<user>.json already gives
    // project placement. Nothing here checks a name against the live session
    // list, and nothing should.
    const got = normalizeWorkspaces(
      asWire({
        version: 1,
        workspaces: [{ id: "w1", members: [{ name: "auth" }, { name: "deploy" }] }],
      }),
    );
    expect(got.workspaces.map((w) => w.members)).toEqual([[{ name: "auth" }, { name: "deploy" }]]);
  });
});

/**
 * A member is `{name, owner?}`, and the owner is what makes a foreign session
 * tileable.
 *
 * Viktor's answer during the design (2026-09-12) was that ANY session you can
 * open belongs in a workspace, shared and foreign included — a session emo
 * shared with you, sitting beside two of your own. A bare name cannot say whose
 * session it is: tmux names are unique only inside one user's server, which is
 * why the global project store keys a session by `(owner, name)`
 * (tmux-api/projects.go `SessionRef`) and why keepalive mounts one live view per
 * owner AND name.
 *
 * An omitted owner means the caller. It is omitted rather than `""` because
 * both sides compare members for equality and absent is not the same value as
 * empty — and because a workspace of your own sessions is the common case by a
 * wide margin, which would otherwise carry your own name on every entry.
 */
describe("a workspace may hold somebody else's session", () => {
  /** The design's own wire example, the literal tmux-api's handler test PUTs
   *  and answers 204 to (tmux-api/workspaces_test.go
   *  `TestHandleWorkspacesForeignMemberKeepsItsOwner`). */
  const foreignWire = {
    version: 1,
    workspaces: [{ id: "w1", members: [{ name: "auth", owner: "emo" }, { name: "deploy" }] }],
  };

  it("carries a foreign member's owner through a read and back onto the wire", async () => {
    // The round trip is the whole test. An owner dropped on the way in would
    // come back naming a session of YOUR own called `auth` — a different
    // terminal where you have one, and nothing at all where you do not.
    vi.stubGlobal("fetch", answering(200, foreignWire));
    const got = await getWorkspaces();
    expect(got.workspaces[0]?.members).toEqual([
      { name: "auth", owner: "emo" },
      { name: "deploy" },
    ]);

    const put = answering(204);
    vi.stubGlobal("fetch", put);
    await putWorkspaces(got);
    const [, init] = put.mock.calls[0] as unknown as FetchArgs;
    expect(String(init.body)).toBe(
      '{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth","owner":"emo"},{"name":"deploy"}]}]}',
    );
  });

  it("leaves your own member ownerless rather than handing it an empty owner", () => {
    const got = normalizeWorkspaces(asWire(foreignWire));
    expect(Object.keys(got.workspaces[0]?.members[1] ?? {})).toEqual(["name"]);
  });

  it("reads an explicit empty owner as no owner, the way the server writes it", () => {
    // `omitempty` means the server answers `{"name":"deploy"}` to a member PUT
    // as `{"name":"deploy","owner":""}`, so a client that kept the empty string
    // would compare its own members unequal to the document it just saved and
    // rebuild every tree for nothing.
    const got = normalizeWorkspaces(
      asWire({
        version: 1,
        workspaces: [{ id: "w1", members: [{ name: "auth", owner: "" }, { name: "deploy" }] }],
      }),
    );
    expect(got.workspaces[0]?.members).toEqual([{ name: "auth" }, { name: "deploy" }]);
  });

  it("keeps one NAME under two different owners, because they are two terminals", () => {
    // Two people each having a session called `auth` is ordinary. Exclusivity is
    // about a session, and a session is the pair.
    const got = normalizeWorkspaces(
      asWire({
        version: 1,
        workspaces: [{ id: "w1", members: [{ name: "auth", owner: "emo" }, { name: "auth" }] }],
      }),
    );
    expect(got.workspaces[0]?.members).toEqual([{ name: "auth", owner: "emo" }, { name: "auth" }]);
  });

  it("gives a session claimed twice to the first workspace, by owner AND name", () => {
    const got = normalizeWorkspaces(
      asWire({
        version: 1,
        workspaces: [
          { id: "w1", members: [{ name: "auth", owner: "emo" }, { name: "deploy" }] },
          {
            id: "w2",
            members: [{ name: "auth", owner: "emo" }, { name: "docs" }, { name: "auth" }],
          },
        ],
      }),
    );
    expect(got.workspaces).toEqual([
      { id: "w1", members: [{ name: "auth", owner: "emo" }, { name: "deploy" }] },
      { id: "w2", members: [{ name: "docs" }, { name: "auth" }] },
    ]);
  });

  it("drops a member the server would not store, field by field", () => {
    // The layout.go trap one level deeper: tmux-api unmarshals a member into a
    // two-field struct, so a `title` tucked into one is gone on the way in and
    // absent on the way out. Keeping it here would show state that survives in
    // this tab and nowhere else.
    const got = normalizeWorkspaces(
      asWire({
        version: 1,
        workspaces: [
          {
            id: "w1",
            members: [
              "auth",
              7,
              null,
              { owner: "emo" },
              { name: "bad name" },
              { name: "docs", owner: "not an os user" },
              { name: "auth", owner: "emo", title: "shared with me" },
              { name: "deploy" },
            ],
          },
        ],
      }),
    );
    expect(got.workspaces[0]?.members).toEqual([
      { name: "auth", owner: "emo" },
      { name: "deploy" },
    ]);
  });
});

describe("writing the document back", () => {
  it("PUTs the whole document as JSON and resolves on the server's 204", async () => {
    const f = answering(204);
    vi.stubGlobal("fetch", f);

    await expect(putWorkspaces(twoTiles)).resolves.toBeUndefined();

    const [url, init] = f.mock.calls[0] as unknown as FetchArgs;
    expect(url).toBe(apiUrl("/workspaces"));
    expect(init.method).toBe("PUT");
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    // Byte for byte the body tmux-api's own handler test PUTs and answers 204
    // to (tmux-api/workspaces_test.go). Pinned as a string rather than parsed so
    // a renamed key on this side fails here, where the message says which key,
    // instead of arriving at the server as a silently dropped field.
    expect(String(init.body)).toBe(
      '{"version":1,"workspaces":[{"id":"w1","members":[{"name":"auth"},{"name":"deploy"}]}]}',
    );
  });

  it("throws the server's refusal instead of reporting a save that did not happen", async () => {
    // validateWorkspaces refuses a document the heal would otherwise have to
    // repair on every later read, and the caller has an optimistic arrangement on
    // screen to roll back on the strength of this throw.
    vi.stubGlobal(
      "fetch",
      answeringRaw(
        400,
        "session wizard/auth listed more than once: a session belongs to at most one workspace",
      ),
    );

    const err = await putWorkspaces(twoTiles).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
  });
});
