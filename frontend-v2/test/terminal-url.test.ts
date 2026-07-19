import { describe, it, expect } from "vitest";
import { buildTerminalUrl, terminalUrl } from "../src/lib/terminal-url";

describe("buildTerminalUrl — ttyd positional ?arg= contract", () => {
  it("own session, defaults: only arg1 (name)", () => {
    expect(buildTerminalUrl("", "foo")).toBe("/?arg=foo");
    // an explicit 'default' command adds no arg2 (matches the vanilla shape)
    expect(buildTerminalUrl("", "foo", { cmd: "default" })).toBe("/?arg=foo");
  });

  it("own session, non-default command: arg2", () => {
    expect(buildTerminalUrl("", "foo", { cmd: "claude" })).toBe(
      "/?arg=foo&arg=claude",
    );
    expect(buildTerminalUrl("", "foo", { cmd: "shell" })).toBe(
      "/?arg=foo&arg=shell",
    );
  });

  it("own session with dir: dir lands at arg3, command placeholder at arg2", () => {
    // no command → 'default' placeholder precedes the dir
    expect(buildTerminalUrl("", "foo", { dir: "/home/x" })).toBe(
      "/?arg=foo&arg=default&arg=%2Fhome%2Fx",
    );
    // explicit command kept at arg2
    expect(buildTerminalUrl("", "foo", { cmd: "claude", dir: "/srv/p" })).toBe(
      "/?arg=foo&arg=claude&arg=%2Fsrv%2Fp",
    );
  });

  it("foreign attach: owner MUST reach arg4, with command+dir placeholders ahead", () => {
    // owner, no dir → dir becomes the inert 'default' placeholder at arg3
    expect(buildTerminalUrl("", "foo", { cmd: "claude", owner: "bob" })).toBe(
      "/?arg=foo&arg=claude&arg=default&arg=bob",
    );
    // owner + dir → real dir at arg3
    expect(
      buildTerminalUrl("", "foo", { cmd: "claude", dir: "/w", owner: "bob" }),
    ).toBe("/?arg=foo&arg=claude&arg=%2Fw&arg=bob");
    // owner with default command → 'default' placeholder still emitted at arg2
    expect(buildTerminalUrl("", "foo", { owner: "bob" })).toBe(
      "/?arg=foo&arg=default&arg=default&arg=bob",
    );
  });

  it("owner branch wins over the dir-only branch", () => {
    // both dir and owner present → single owner branch (4 args), not the dir one
    const u = buildTerminalUrl("", "s", { dir: "/d", owner: "o" });
    expect(u).toBe("/?arg=s&arg=default&arg=%2Fd&arg=o");
    expect(u.match(/arg=/g)?.length).toBe(4);
  });

  it("encodeURIComponent is applied to every arg value", () => {
    expect(buildTerminalUrl("", "a b")).toBe("/?arg=a%20b");
    expect(buildTerminalUrl("", "n", { cmd: "c", dir: "/a b/c&d" })).toBe(
      "/?arg=n&arg=c&arg=%2Fa%20b%2Fc%26d",
    );
  });

  it("base prefixes the URL (canary/cross-origin ttyd)", () => {
    expect(buildTerminalUrl("https://t.example", "foo")).toBe(
      "https://t.example/?arg=foo",
    );
  });

  it("empty-string opts are treated as absent", () => {
    expect(buildTerminalUrl("", "foo", { cmd: "", dir: "", owner: "" })).toBe(
      "/?arg=foo",
    );
  });
});

describe("terminalUrl — config-bound (same-origin base)", () => {
  it("builds a same-origin root URL by default", () => {
    expect(terminalUrl("foo")).toBe("/?arg=foo");
    expect(terminalUrl("foo", { cmd: "claude" })).toBe("/?arg=foo&arg=claude");
  });
});
