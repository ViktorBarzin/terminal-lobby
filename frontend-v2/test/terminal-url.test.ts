import { describe, it, expect } from "vitest";
import { buildTerminalUrl, terminalUrl } from "../src/lib/terminal-url";
import { projectDirFor } from "../src/components/App";
import { LAYOUT_VERSION, type Layout } from "../src/types/lobby";

describe("buildTerminalUrl — ttyd positional ?arg= contract", () => {
  it("own session, defaults: only arg1 (name)", () => {
    expect(buildTerminalUrl("/term.html", "foo")).toBe("/term.html?arg=foo");
    // an explicit 'default' command adds no arg2 (matches the vanilla shape)
    expect(buildTerminalUrl("/term.html", "foo", { cmd: "default" })).toBe(
      "/term.html?arg=foo",
    );
  });

  it("own session, non-default command: arg2", () => {
    expect(buildTerminalUrl("/term.html", "foo", { cmd: "claude" })).toBe(
      "/term.html?arg=foo&arg=claude",
    );
    expect(buildTerminalUrl("/term.html", "foo", { cmd: "shell" })).toBe(
      "/term.html?arg=foo&arg=shell",
    );
  });

  it("own session with dir: dir lands at arg3, command placeholder at arg2", () => {
    // no command → 'default' placeholder precedes the dir
    expect(buildTerminalUrl("/term.html", "foo", { dir: "/home/x" })).toBe(
      "/term.html?arg=foo&arg=default&arg=%2Fhome%2Fx",
    );
    // explicit command kept at arg2
    expect(
      buildTerminalUrl("/term.html", "foo", { cmd: "claude", dir: "/srv/p" }),
    ).toBe("/term.html?arg=foo&arg=claude&arg=%2Fsrv%2Fp");
  });

  it("foreign attach: owner MUST reach arg4, with command+dir placeholders ahead", () => {
    // owner, no dir → dir becomes the inert 'default' placeholder at arg3
    expect(
      buildTerminalUrl("/term.html", "foo", { cmd: "claude", owner: "bob" }),
    ).toBe("/term.html?arg=foo&arg=claude&arg=default&arg=bob");
    // owner + dir → real dir at arg3
    expect(
      buildTerminalUrl("/term.html", "foo", {
        cmd: "claude",
        dir: "/w",
        owner: "bob",
      }),
    ).toBe("/term.html?arg=foo&arg=claude&arg=%2Fw&arg=bob");
    // owner with default command → 'default' placeholder still emitted at arg2
    expect(buildTerminalUrl("/term.html", "foo", { owner: "bob" })).toBe(
      "/term.html?arg=foo&arg=default&arg=default&arg=bob",
    );
  });

  it("owner branch wins over the dir-only branch", () => {
    // both dir and owner present → single owner branch (4 args), not the dir one
    const u = buildTerminalUrl("/term.html", "s", { dir: "/d", owner: "o" });
    expect(u).toBe("/term.html?arg=s&arg=default&arg=%2Fd&arg=o");
    expect(u.match(/arg=/g)?.length).toBe(4);
  });

  it("encodeURIComponent is applied to every arg value", () => {
    expect(buildTerminalUrl("/term.html", "a b")).toBe("/term.html?arg=a%20b");
    expect(
      buildTerminalUrl("/term.html", "n", { cmd: "c", dir: "/a b/c&d" }),
    ).toBe("/term.html?arg=n&arg=c&arg=%2Fa%20b%2Fc%26d");
  });

  it("base is prepended verbatim (canary / cross-origin term page)", () => {
    // A cross-origin canary passes the FULL page URL (origin + path) as base.
    expect(buildTerminalUrl("https://t.example/term.html", "foo")).toBe(
      "https://t.example/term.html?arg=foo",
    );
    // The base is prepended literally — no "/" is injected, so the query
    // appends directly onto whatever page path the base names.
    expect(buildTerminalUrl("/term2.html", "foo")).toBe("/term2.html?arg=foo");
  });

  it("empty-string opts are treated as absent", () => {
    expect(
      buildTerminalUrl("/term.html", "foo", { cmd: "", dir: "", owner: "" }),
    ).toBe("/term.html?arg=foo");
  });
});

describe("terminalUrl — config-bound (default /term.html base, avoids SPA recursion)", () => {
  it("builds a same-origin /term.html URL by default (NOT '/', which would reload the SPA)", () => {
    expect(terminalUrl("foo")).toBe("/term.html?arg=foo");
    expect(terminalUrl("foo", { cmd: "claude" })).toBe(
      "/term.html?arg=foo&arg=claude",
    );
  });
});

/**
 * The arg3 slot had a correct builder branch and NO caller: the one call site
 * (TerminalView) passed only {cmd, owner}, so a session created inside a project
 * with a `dir` opened in $HOME even though /api/layout carried the directory and
 * the attach script honours it. This pins the lookup that feeds arg3.
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

  it("feeds buildTerminalUrl's arg3 branch", () => {
    expect(
      buildTerminalUrl("/term.html", "qa-vdirs", {
        dir: projectDirFor(layout(), "qa-vdirs"),
      }),
    ).toBe("/term.html?arg=qa-vdirs&arg=default&arg=%2Ftmp%2Fqa-harness-scratch");
  });
});
