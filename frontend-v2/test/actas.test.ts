import { describe, it, expect, afterEach, vi } from "vitest";
import { appendActAs, readActAsFrom } from "../src/lib/config";
import { actAsUrl } from "../src/lib/act-as";

describe("actAsUrl — switching is a navigation", () => {
  it("adds the target", () => {
    expect(actAsUrl("http://x/", "bob")).toBe("/?as=bob");
  });

  it("replaces an existing target", () => {
    expect(actAsUrl("http://x/?as=bob", "carol")).toBe("/?as=carol");
  });

  it("removes it to return to yourself", () => {
    expect(actAsUrl("http://x/?as=bob", "")).toBe("/");
  });

  it("keeps the other knobs so a canary or remote devvm stays pointed there", () => {
    expect(actAsUrl("http://x/?api=https%3A%2F%2Fd&terminal=%2Ft2.html", "bob")).toBe(
      "/?api=https%3A%2F%2Fd&terminal=%2Ft2.html&as=bob",
    );
    expect(actAsUrl("http://x/?api=https%3A%2F%2Fd&as=bob", "")).toBe(
      "/?api=https%3A%2F%2Fd",
    );
  });

  // The hash names the selected session in the identity you are LEAVING.
  it("drops the selected-session hash", () => {
    expect(actAsUrl("http://x/#my-session", "bob")).toBe("/?as=bob");
    expect(actAsUrl("http://x/?as=bob#their-session", "")).toBe("/");
  });
});

/**
 * The act-as switch travels as ?as=<user> on the lobby URL, threaded into every
 * backend call. It is a query parameter rather than a header because two of the
 * surfaces it must reach are not fetch() calls at all — file previews and
 * gallery thumbnails are <img src> — and a parameter is the only form all of
 * them can carry.
 */

describe("appendActAs — the pure half", () => {
  it("is inert without a target (the state every request has ever been in)", () => {
    expect(appendActAs("/api/sessions/whoami", "")).toBe("/api/sessions/whoami");
    expect(appendActAs("/files/read?path=%2Fx", "")).toBe("/files/read?path=%2Fx");
  });

  it("starts a query when the URL has none", () => {
    expect(appendActAs("/api/sessions/sessions", "bob")).toBe(
      "/api/sessions/sessions?as=bob",
    );
  });

  it("extends a query the URL already has", () => {
    expect(appendActAs("/files/list?dir=%2Fhome%2Fbob&all=1", "bob")).toBe(
      "/files/list?dir=%2Fhome%2Fbob&all=1&as=bob",
    );
  });

  it("encodes the target", () => {
    expect(appendActAs("/x", "a b&c")).toBe("/x?as=a%20b%26c");
  });
});

describe("readActAsFrom — what the URL is allowed to say", () => {
  it("reads a plain username", () => {
    expect(readActAsFrom("?as=bob")).toBe("bob");
    expect(readActAsFrom("?session=foo&as=carol")).toBe("carol");
  });

  it("is empty when absent", () => {
    expect(readActAsFrom("")).toBe("");
    expect(readActAsFrom("?api=https://x")).toBe("");
  });

  // The server refuses a malformed target regardless — this is about not
  // sending one, and not letting a hand-edited URL put junk in every request.
  it("drops anything that could not be a username", () => {
    for (const q of [
      "?as=../wizard",
      "?as=bob%20bob",
      "?as=bob;id",
      "?as=-bob",
      "?as=" + "a".repeat(33),
      "?as=",
    ]) {
      expect(readActAsFrom(q)).toBe("");
    }
  });
});

/**
 * The wiring: with ?as= in the address bar, every backend builder carries it
 * and the push endpoints do not. Module-level constants read the URL once at
 * import, so these reload the module against a stubbed location.
 */
describe("config wiring under ?as=bob", () => {
  const load = async (search: string) => {
    vi.resetModules();
    vi.stubGlobal("window", {
      ...globalThis.window,
      location: { ...globalThis.window.location, search },
    });
    return await import("../src/lib/config");
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("carries the target on every backend surface", async () => {
    const c = await load("?as=bob");
    expect(c.ACT_AS).toBe("bob");
    expect(c.apiUrl("/sessions")).toBe("/api/sessions/sessions?as=bob");
    expect(c.apiUrl("/layout")).toBe("/api/sessions/layout?as=bob");
    expect(c.fileListUrl("/home/bob")).toBe(
      "/files/list?dir=%2Fhome%2Fbob&as=bob",
    );
    expect(c.fileReadUrl("/home/bob/f")).toBe(
      "/files/read?path=%2Fhome%2Fbob%2Ff&as=bob",
    );
    expect(c.fileWriteUrl()).toBe("/files/write?as=bob");
    expect(c.clipboardListUrl("main")).toBe(
      "/clipboard/list?session=main&as=bob",
    );
    expect(c.clipboardImgUrl("main", "a.png")).toBe(
      "/clipboard/img/main/a.png?as=bob",
    );
    // session-events refuses ?as= with a 501 rather than serving the caller's
    // own transcripts — but it must still be ASKED, so the refusal is what the
    // Text view surfaces instead of silently wrong data.
    expect(c.eventsUrl("main", 0)).toBe("/events/main?as=bob");
    expect(c.eventsUrl("main", 7)).toBe("/events/main?lastEventId=7&as=bob");
    expect(c.promptUrl("main")).toBe("/prompt/main?as=bob");
    expect(c.cancelUrl("main")).toBe("/cancel/main?as=bob");
  });

  it("leaves every builder untouched with no ?as=", async () => {
    const c = await load("");
    expect(c.ACT_AS).toBe("");
    expect(c.apiUrl("/sessions")).toBe("/api/sessions/sessions");
    expect(c.fileReadUrl("/home/x/f")).toBe("/files/read?path=%2Fhome%2Fx%2Ff");
    expect(c.eventsUrl("main", 0)).toBe("/events/main");
    expect(c.clipboardListUrl("main")).toBe("/clipboard/list?session=main");
  });

  it("keeps push off the switch", async () => {
    // Push subscriptions must never follow: the SPA refreshes its registration
    // on boot, so an as-bob tab would otherwise enrol this browser as one of
    // bob's devices and keep delivering their notifications here long after the
    // tab closed. These are verbatim constants, which is what keeps them out.
    await load("?as=bob");
    const p = await import("../src/pwa/push");
    for (const u of [p.PUSH_SUBS_API, p.VAPID_PUBLIC_API, p.PUSH_TEST_API]) {
      expect(u).not.toContain("as=");
    }
  });
});

/**
 * The terminal is the one surface that cannot carry ?as=: ttyd resolves the
 * guest from the Authentik header itself and takes positional ?arg= values, so
 * the switch rides the EXISTING arg4 owner slot instead.
 */
describe("terminal URL under ?as=bob", () => {
  const load = async (search: string) => {
    vi.resetModules();
    vi.stubGlobal("window", {
      ...globalThis.window,
      location: { ...globalThis.window.location, search },
    });
    return await import("../src/lib/terminal-url");
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("defaults the owner to the act-as target", async () => {
    // The sidebar passes no owner for a session it considers the caller's own,
    // and in an as-bob tab bob's sessions ARE 'own'. Without this default the
    // iframe would attach WIZARD's session of the same name, because ttyd never
    // sees ?as=.
    const { terminalUrl } = await load("?as=bob");
    expect(terminalUrl("main")).toBe(
      "/term.html?arg=main&arg=default&arg=default&arg=bob",
    );
  });

  it("does not override a genuinely foreign owner", async () => {
    // While acting as bob you can still see sessions shared WITH bob by a third
    // party. Forcing the owner to bob would attach the wrong account's session.
    const { terminalUrl } = await load("?as=bob");
    expect(terminalUrl("main", { owner: "carol" })).toBe(
      "/term.html?arg=main&arg=default&arg=default&arg=carol",
    );
  });

  it("still reaches arg5 when watching", async () => {
    const { terminalUrl } = await load("?as=bob");
    expect(terminalUrl("main", { watch: true })).toBe(
      "/term.html?arg=main&arg=default&arg=default&arg=bob&arg=ro",
    );
  });

  it("changes nothing without ?as=", async () => {
    const { terminalUrl } = await load("");
    expect(terminalUrl("main")).toBe("/term.html?arg=main");
    expect(terminalUrl("main", { owner: "bob" })).toBe(
      "/term.html?arg=main&arg=default&arg=default&arg=bob",
    );
  });
});
