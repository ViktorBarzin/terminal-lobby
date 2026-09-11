import { describe, it, expect } from "vitest";
import { buildTerminalArgs, type TerminalUrlOpts } from "../src/lib/terminal-url";
import { projectDirFor } from "../src/components/App";
import { LAYOUT_VERSION, type Layout } from "../src/types/lobby";

describe("buildTerminalArgs — ttyd positional ?arg= contract", () => {
  it("own session, defaults: only arg1 (name)", () => {
    expect(buildTerminalArgs("foo")).toBe("arg=foo");
    // an explicit 'default' command adds no arg2 (matches the vanilla shape)
    expect(buildTerminalArgs("foo", { cmd: "default" })).toBe(
      "arg=foo",
    );
  });

  it("own session, non-default command: arg2", () => {
    expect(buildTerminalArgs("foo", { cmd: "claude" })).toBe(
      "arg=foo&arg=claude",
    );
    expect(buildTerminalArgs("foo", { cmd: "shell" })).toBe(
      "arg=foo&arg=shell",
    );
  });

  it("own session with dir: dir lands at arg3, command placeholder at arg2", () => {
    // no command → 'default' placeholder precedes the dir
    expect(buildTerminalArgs("foo", { dir: "/home/x" })).toBe(
      "arg=foo&arg=default&arg=%2Fhome%2Fx",
    );
    // explicit command kept at arg2
    expect(
      buildTerminalArgs("foo", { cmd: "claude", dir: "/srv/p" }),
    ).toBe("arg=foo&arg=claude&arg=%2Fsrv%2Fp");
  });

  it("foreign attach: owner MUST reach arg4, with command+dir placeholders ahead", () => {
    // owner, no dir → dir becomes the inert 'default' placeholder at arg3
    expect(
      buildTerminalArgs("foo", { cmd: "claude", owner: "bob" }),
    ).toBe("arg=foo&arg=claude&arg=default&arg=bob");
    // owner + dir → real dir at arg3
    expect(
      buildTerminalArgs("foo", {
        cmd: "claude",
        dir: "/w",
        owner: "bob",
      }),
    ).toBe("arg=foo&arg=claude&arg=%2Fw&arg=bob");
    // owner with default command → 'default' placeholder still emitted at arg2
    expect(buildTerminalArgs("foo", { owner: "bob" })).toBe(
      "arg=foo&arg=default&arg=default&arg=bob",
    );
  });

  it("owner branch wins over the dir-only branch", () => {
    // both dir and owner present → single owner branch (4 args), not the dir one
    const u = buildTerminalArgs("s", { dir: "/d", owner: "o" });
    expect(u).toBe("arg=s&arg=default&arg=%2Fd&arg=o");
    expect(u.match(/arg=/g)?.length).toBe(4);
  });

  it("encodeURIComponent is applied to every arg value", () => {
    expect(buildTerminalArgs("a b")).toBe("arg=a%20b");
    expect(
      buildTerminalArgs("n", { cmd: "c", dir: "/a b/c&d" }),
    ).toBe("arg=n&arg=c&arg=%2Fa%20b%2Fc%26d");
  });

  it("empty-string opts are treated as absent", () => {
    expect(
      buildTerminalArgs("foo", { cmd: "", dir: "", owner: "" }),
    ).toBe("arg=foo");
  });
});

/**
 * Watch mode rides arg5, the deepest slot in the positional contract — so every
 * earlier position has to be emitted ahead of it, including an owner slot that
 * is empty for your OWN session. Dropping one shifts "ro" into the owner slot,
 * where tmux-attach.sh would read it as an OS user named "ro": the attach falls
 * back to your own server read-WRITE, i.e. it silently does the opposite of
 * what was asked. This is the same trap arg4 hit before (memory #9926), one
 * position deeper, which is why it is pinned this thoroughly.
 */
describe("buildTerminalArgs — arg5 (Watch mode)", () => {
  it("own session, watch: every earlier slot is emitted, owner blank at arg4", () => {
    const u = buildTerminalArgs("foo", { watch: true });
    expect(u).toBe("arg=foo&arg=default&arg=default&arg=&arg=ro");
    expect(u.match(/arg=/g)?.length).toBe(5);
  });

  it("own session, watch, with a command and dir: real values keep their slots", () => {
    expect(
      buildTerminalArgs("foo", {
        cmd: "claude",
        dir: "/srv/p",
        watch: true,
      }),
    ).toBe("arg=foo&arg=claude&arg=%2Fsrv%2Fp&arg=&arg=ro");
  });

  it("foreign session, watch: owner keeps arg4 and ro lands at arg5", () => {
    const u = buildTerminalArgs("foo", {
      owner: "bob",
      watch: true,
    });
    expect(u).toBe("arg=foo&arg=default&arg=default&arg=bob&arg=ro");
    // The owner must still be the FOURTH arg, not the fifth.
    expect(new URLSearchParams(u).getAll("arg")[3]).toBe("bob");
  });

  it("watch:false is identical to omitting it — no arg5, no shape change", () => {
    for (const opts of [
      {},
      { cmd: "claude" },
      { dir: "/d" },
      { owner: "bob" },
      { cmd: "claude", dir: "/d", owner: "bob" },
    ]) {
      expect(buildTerminalArgs("foo", { ...opts, watch: false })).toBe(
        buildTerminalArgs("foo", opts),
      );
    }
  });

  it("the mode value is the literal the attach script matches on", () => {
    // tmux-attach.sh validates arg5 against ^(ro|rw)$ and only acts on "ro";
    // anything else falls through to the server's ceiling.
    const args = new URLSearchParams(buildTerminalArgs("foo", { watch: true })).getAll(
      "arg",
    );
    expect(args[4]).toBe("ro");
  });
});

/**
 * The arg3 slot had a correct builder branch and NO caller: the one call site
 * passed only {cmd, owner}, so a session created inside a project with a `dir`
 * opened in $HOME even though /api/layout carried the directory and the attach
 * script honours it. This pins the lookup that feeds arg3.
 */
describe("projectDirFor — the layout directory a session should be born in", () => {
  const layout = (): Layout => ({
    version: LAYOUT_VERSION,
    projects: [
      { name: "qa-vdirp", sessions: ["qa-vdirs"], dir: "/tmp/qa-harness-scratch" },
      { name: "nodir", sessions: ["plain"] },
    ],
    ungrouped: ["loose"],
    ungroupedIndex: 0,
  });

  it("returns the owning project's dir", () => {
    expect(projectDirFor(layout(), "qa-vdirs")).toBe("/tmp/qa-harness-scratch");
  });

  it("returns undefined for a session in a project that has no dir", () => {
    expect(projectDirFor(layout(), "plain")).toBeUndefined();
  });

  it("returns undefined for an ungrouped session and for an unknown one", () => {
    expect(projectDirFor(layout(), "loose")).toBeUndefined();
    expect(projectDirFor(layout(), "never-heard-of-it")).toBeUndefined();
  });

  it("feeds buildTerminalArgs's arg3 branch", () => {
    expect(
      buildTerminalArgs("qa-vdirs", {
        dir: projectDirFor(layout(), "qa-vdirs"),
      }),
    ).toBe("arg=qa-vdirs&arg=default&arg=%2Ftmp%2Fqa-harness-scratch");
  });
});

/**
 * arg6/arg7 — the model and the effort a NEW session launches on.
 *
 * They are flags on the process rather than a `/model` typed into it once it is
 * up. Measured 2026-09-06 on this box: launching with them costs the same 2.4s
 * as launching without (2.40/2.54/2.84 bare against 2.49/2.42/4.49 flagged),
 * while driving the picker afterwards costs 3.83/4.20/3.99s on a browser-sized
 * pane. So the flags are free and the drive is not.
 *
 * They are the DEEPEST slots, which is the whole of what these tests pin:
 * everything before them has to be emitted or the value lands on the wrong $n.
 */
describe("buildTerminalArgs — the model and effort a new session starts on", () => {
  it("puts the model at arg6, filling every slot before it", () => {
    const u = buildTerminalArgs("foo", { cmd: "claude", dir: "/srv/p", model: "claude-opus-5" });
    expect(u).toBe("arg=foo&arg=claude&arg=%2Fsrv%2Fp&arg=&arg=&arg=claude-opus-5");
    expect(u.match(/arg=/g)?.length).toBe(6);
  });

  it("puts the effort at arg7, with an empty model slot when only it is set", () => {
    const u = buildTerminalArgs("foo", { cmd: "claude", effort: "max" });
    expect(u).toBe("arg=foo&arg=claude&arg=default&arg=&arg=&arg=&arg=max");
    expect(u.match(/arg=/g)?.length).toBe(7);
  });

  it("carries both, and the watch request still lands on arg5", () => {
    const u = buildTerminalArgs("foo", {
      cmd: "codex",
      dir: "/srv/p",
      watch: true,
      model: "gpt-5.6-terra",
      effort: "high",
    });
    expect(u).toBe(
      "arg=foo&arg=codex&arg=%2Fsrv%2Fp&arg=&arg=ro&arg=gpt-5.6-terra&arg=high",
    );
  });

  // The one model name that is not plain alphanumerics. It has to reach the
  // attach percent-encoded, or the bracket ends the query value.
  it("percent-encodes the context-window suffix", () => {
    const u = buildTerminalArgs("foo", { cmd: "claude", model: "claude-opus-5[1m]" });
    expect(u).toBe("arg=foo&arg=claude&arg=default&arg=&arg=&arg=claude-opus-5%5B1m%5D");
  });

  it("keeps a foreign attach's owner on arg4", () => {
    const u = buildTerminalArgs("foo", { cmd: "claude", owner: "bob", model: "claude-sonnet-5" });
    expect(u).toBe("arg=foo&arg=claude&arg=default&arg=bob&arg=&arg=claude-sonnet-5");
  });

  // The default IS the absence of a choice, and the shallow shapes above have
  // to stay byte-identical: every existing attach in the app builds one.
  it("emits nothing extra when neither is chosen", () => {
    expect(buildTerminalArgs("foo", { cmd: "claude", model: "", effort: "" })).toBe(
      "arg=foo&arg=claude",
    );
    expect(buildTerminalArgs("foo", { cmd: "claude", dir: "/srv/p" })).toBe(
      "arg=foo&arg=claude&arg=%2Fsrv%2Fp",
    );
  });
});

/**
 * arg5 — the ATTACH MODE, now a three-valued slot.
 *
 * Position 5 carries what the client is asking the attach to be: absent for a
 * drive, "ro" for a watch, "pre" for a preload (ADR-0026). The three are one
 * question with three answers, so they share one slot rather than getting a
 * position each — which is also why a caller that asks for two of them at once
 * is a programming error rather than a precedence puzzle.
 *
 * These are table-driven on purpose: the failure this pins is POSITIONAL, so
 * the assertion has to be the whole `arg` list for each mode side by side, not
 * a spot check on the value that moved.
 */
describe("buildTerminalArgs — arg5 is drive | watch | preload", () => {
  const withCmdAndDir: ReadonlyArray<{
    label: string;
    opts: TerminalUrlOpts;
    args: string[];
  }> = [
    {
      label: "drive: no mode arg at all, so the list stops at arg3",
      opts: { cmd: "claude", dir: "/srv/p" },
      args: ["foo", "claude", "/srv/p"],
    },
    {
      label: "watch: ro at arg5, owner blank at arg4",
      opts: { cmd: "claude", dir: "/srv/p", watch: true },
      args: ["foo", "claude", "/srv/p", "", "ro"],
    },
    {
      label: "preload: pre at arg5, owner blank at arg4",
      opts: { cmd: "claude", dir: "/srv/p", preload: true },
      args: ["foo", "claude", "/srv/p", "", "pre"],
    },
  ];

  it.each(withCmdAndDir)("$label", ({ opts, args }) => {
    expect(new URLSearchParams(buildTerminalArgs("foo", opts)).getAll("arg")).toEqual(args);
  });

  // The same three with NOTHING else chosen, which is what a sidebar hover
  // actually sends. Every earlier slot has to be filled with its placeholder or
  // "pre" lands in the owner slot, where tmux-attach.sh reads it as an OS user
  // named "pre" and the attach silently becomes an ordinary read-write drive —
  // the exact thing ignore-size exists to prevent.
  const bare: ReadonlyArray<{ label: string; opts: TerminalUrlOpts; args: string[] }> = [
    { label: "drive", opts: {}, args: ["foo"] },
    { label: "watch", opts: { watch: true }, args: ["foo", "default", "default", "", "ro"] },
    { label: "preload", opts: { preload: true }, args: ["foo", "default", "default", "", "pre"] },
  ];

  it.each(bare)("bare $label: placeholders ahead of the mode", ({ opts, args }) => {
    const u = buildTerminalArgs("foo", opts);
    expect(new URLSearchParams(u).getAll("arg")).toEqual(args);
    expect(u.match(/arg=/g)?.length).toBe(args.length);
  });

  it("the preload literal is the one MODE_RE matches", () => {
    // devvm/tmux-attach.sh validates arg5 against ^(ro|rw|pre)$ and maps "pre"
    // to `attach-session -f ignore-size`. Anything else is no request at all.
    const args = new URLSearchParams(buildTerminalArgs("foo", { preload: true })).getAll("arg");
    expect(args[4]).toBe("pre");
    expect(args).toHaveLength(5);
  });

  it("preload:false is identical to omitting it — no arg5, no shape change", () => {
    for (const opts of [
      {},
      { cmd: "claude" },
      { dir: "/d" },
      { owner: "bob" },
      { cmd: "claude", dir: "/d", owner: "bob" },
      { cmd: "claude", model: "claude-opus-5", effort: "max" },
    ]) {
      expect(buildTerminalArgs("foo", { ...opts, preload: false })).toBe(
        buildTerminalArgs("foo", opts),
      );
    }
  });

  it("a launch model cannot push the preload request off arg5", () => {
    // The deep branch builds arg5 separately from the mid one, so it gets its
    // own assertion — an off-by-one here is how arg4 died once already.
    const u = buildTerminalArgs("foo", {
      cmd: "codex",
      dir: "/srv/p",
      preload: true,
      model: "gpt-5.6-terra",
      effort: "high",
    });
    expect(new URLSearchParams(u).getAll("arg")).toEqual([
      "foo",
      "codex",
      "/srv/p",
      "",
      "pre",
      "gpt-5.6-terra",
      "high",
    ]);
  });

  it("keeps an owner on arg4 and the preload request on arg5", () => {
    // The builder is positional and nothing more: a preload is own-sessions-
    // only, and that refusal lives in tmux-attach.sh, which denies a "pre"
    // naming another owner. What is pinned here is only that the shape does
    // not corrupt if such a request is ever built.
    const u = buildTerminalArgs("foo", { owner: "bob", preload: true });
    expect(new URLSearchParams(u).getAll("arg")).toEqual([
      "foo",
      "default",
      "default",
      "bob",
      "pre",
    ]);
  });

  // Watch and preload are the same slot answering the same question, so asking
  // for both is a bug in the caller. It throws rather than picking a winner:
  // silently demoting a preload to a watch would attach read-only, which calls
  // PinGrid, and grid.go never reverts a pin — so every card the pointer
  // crossed would keep a grid pin for life (ADR-0026). A loud error on the
  // first hover is cheaper than that, and it cannot be mistaken for working.
  it.each([
    { label: "on its own", opts: { watch: true, preload: true } },
    { label: "down the model/effort branch", opts: { watch: true, preload: true, model: "claude-opus-5" } },
    { label: "with an owner", opts: { watch: true, preload: true, owner: "bob" } },
  ])("throws when a caller asks for a watch and a preload at once ($label)", ({ opts }) => {
    expect(() => buildTerminalArgs("foo", opts)).toThrow(/mutually exclusive/i);
  });
});
