import { describe, it, expect, afterEach, vi } from "vitest";
import { appendActAs, readActAsFrom } from "../src/lib/config";
import { actAsUrl, lensTarget } from "../src/lib/act-as";

describe("actAsUrl — switching is a navigation", () => {
  it("adds the target", () => {
    expect(actAsUrl("http://x/", "emo")).toBe("/?as=emo");
  });

  it("replaces an existing target", () => {
    expect(actAsUrl("http://x/?as=emo", "ancamilea")).toBe("/?as=ancamilea");
  });

  it("removes it to return to yourself", () => {
    expect(actAsUrl("http://x/?as=emo", "")).toBe("/");
  });

  it("keeps the other knobs so a canary or remote devvm stays pointed there", () => {
    expect(actAsUrl("http://x/?api=https%3A%2F%2Fd&terminal=%2Ft2.html", "emo")).toBe(
      "/?api=https%3A%2F%2Fd&terminal=%2Ft2.html&as=emo",
    );
    expect(actAsUrl("http://x/?api=https%3A%2F%2Fd&as=emo", "")).toBe(
      "/?api=https%3A%2F%2Fd",
    );
  });

  // The hash names the selected session in the identity you are LEAVING.
  it("drops the selected-session hash", () => {
    expect(actAsUrl("http://x/#my-session", "emo")).toBe("/?as=emo");
    expect(actAsUrl("http://x/?as=emo#their-session", "")).toBe("/");
  });

  // ?session= names a session the same way the hash does, and readInitialSelection
  // reads it as a fallback — so leaving it on carried a name from the identity
  // being left into the one being entered. On 2026-08-17 that put wizard's
  // `Council-tax` into emo's account: the switched page attached the remembered
  // name one second after the switch, with the owner defaulted to emo.
  it("drops the selected-session query parameter too", () => {
    expect(actAsUrl("http://x/?session=Council-tax", "emo")).toBe("/?as=emo");
    expect(actAsUrl("http://x/?as=emo&session=their-work", "")).toBe("/");
    expect(actAsUrl("http://x/?api=https%3A%2F%2Fd&session=mine", "emo")).toBe(
      "/?api=https%3A%2F%2Fd&as=emo",
    );
  });
});

/**
 * The act-as switch travels as ?as=<user> on the lobby URL, threaded into every
 * backend call. It is a query parameter rather than a header because two of the
 * surfaces it must reach are not fetch() calls at all — file previews and
 * gallery thumbnails are <img src> — and a parameter is the only form all of
 * them can carry.
 */

describe("lensTarget — whose account this tab is looking at", () => {
  const me = { authentik: "vbarzin", osUser: "wizard" };
  const switched = { authentik: "vbarzin", osUser: "emo", realUser: "wizard" };

  it("is empty for an ordinary tab", () => {
    expect(lensTarget(me, "")).toBe("");
    expect(lensTarget(null, "")).toBe("");
  });

  it("names the target the server confirms the tab switched to", () => {
    expect(lensTarget(switched, "emo")).toBe("emo");
  });

  // Acting as yourself is not a switch: it is your own account, so its sessions
  // resolve and are remembered as your own.
  it("is empty for a tab acting as its own user", () => {
    expect(lensTarget({ authentik: "emil.barzin", osUser: "emo" }, "emo")).toBe("");
  });

  // Assume the switch took until the server says otherwise. The first attach
  // happens early and a lens defaults to watching, so guessing wrong here costs
  // a click; guessing the other way types into someone else's session.
  it("assumes the switch took while ?as= is set and whoami has not landed", () => {
    expect(lensTarget(null, "emo")).toBe("emo");
    expect(lensTarget(undefined, "emo")).toBe("emo");
  });
});

describe("appendActAs — the pure half", () => {
  it("is inert without a target (the state every request has ever been in)", () => {
    expect(appendActAs("/api/sessions/whoami", "")).toBe("/api/sessions/whoami");
    expect(appendActAs("/files/read?path=%2Fx", "")).toBe("/files/read?path=%2Fx");
  });

  it("starts a query when the URL has none", () => {
    expect(appendActAs("/api/sessions/sessions", "emo")).toBe(
      "/api/sessions/sessions?as=emo",
    );
  });

  it("extends a query the URL already has", () => {
    expect(appendActAs("/files/list?dir=%2Fhome%2Femo&all=1", "emo")).toBe(
      "/files/list?dir=%2Fhome%2Femo&all=1&as=emo",
    );
  });

  it("encodes the target", () => {
    expect(appendActAs("/x", "a b&c")).toBe("/x?as=a%20b%26c");
  });
});

describe("readActAsFrom — what the URL is allowed to say", () => {
  it("reads a plain username", () => {
    expect(readActAsFrom("?as=emo")).toBe("emo");
    expect(readActAsFrom("?session=foo&as=ancamilea")).toBe("ancamilea");
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
      "?as=emo%20emo",
      "?as=emo;id",
      "?as=-emo",
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
describe("config wiring under ?as=emo", () => {
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
    const c = await load("?as=emo");
    expect(c.ACT_AS).toBe("emo");
    expect(c.apiUrl("/sessions")).toBe("/api/sessions/sessions?as=emo");
    expect(c.apiUrl("/layout")).toBe("/api/sessions/layout?as=emo");
    expect(c.fileListUrl("/home/emo")).toBe(
      "/files/list?dir=%2Fhome%2Femo&as=emo",
    );
    expect(c.fileReadUrl("/home/emo/f")).toBe(
      "/files/read?path=%2Fhome%2Femo%2Ff&as=emo",
    );
    expect(c.fileWriteUrl()).toBe("/files/write?as=emo");
    expect(c.clipboardListUrl("main")).toBe(
      "/clipboard/list?session=main&as=emo",
    );
    expect(c.clipboardImgUrl("main", "a.png")).toBe(
      "/clipboard/img/main/a.png?as=emo",
    );
    // session-events refuses ?as= with a 501 rather than serving the caller's
    // own transcripts — but it must still be ASKED, so the refusal is what the
    // Text view surfaces instead of silently wrong data.
    expect(c.eventsUrl("main", 0)).toBe("/events/main?rev=1&as=emo");
    expect(c.eventsUrl("main", 7)).toBe("/events/main?lastEventId=7&rev=1&as=emo");
    expect(c.promptUrl("main")).toBe("/prompt/main?as=emo");
    expect(c.cancelUrl("main")).toBe("/cancel/main?as=emo");
  });

  it("leaves every builder untouched with no ?as=", async () => {
    const c = await load("");
    expect(c.ACT_AS).toBe("");
    expect(c.apiUrl("/sessions")).toBe("/api/sessions/sessions");
    expect(c.fileReadUrl("/home/x/f")).toBe("/files/read?path=%2Fhome%2Fx%2Ff");
    expect(c.eventsUrl("main", 0)).toBe("/events/main?rev=1");
    expect(c.clipboardListUrl("main")).toBe("/clipboard/list?session=main");
  });

  it("keeps push off the switch", async () => {
    // Push subscriptions must never follow: the SPA refreshes its registration
    // on boot, so an as-emo tab would otherwise enrol this browser as one of
    // emo's devices and keep delivering their notifications here long after the
    // tab closed. These are verbatim constants, which is what keeps them out.
    await load("?as=emo");
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
describe("terminal URL under ?as=emo", () => {
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
    // and in an as-emo tab emo's sessions ARE 'own'. Without this default the
    // iframe would attach WIZARD's session of the same name, because ttyd never
    // sees ?as=.
    const { terminalUrl } = await load("?as=emo");
    expect(terminalUrl("main")).toBe(
      "/term.html?arg=main&arg=default&arg=default&arg=emo",
    );
  });

  it("does not override a genuinely foreign owner", async () => {
    // While acting as emo you can still see sessions shared WITH emo by a third
    // party. Forcing the owner to emo would attach the wrong account's session.
    const { terminalUrl } = await load("?as=emo");
    expect(terminalUrl("main", { owner: "ancamilea" })).toBe(
      "/term.html?arg=main&arg=default&arg=default&arg=ancamilea",
    );
  });

  it("still reaches arg5 when watching", async () => {
    const { terminalUrl } = await load("?as=emo");
    expect(terminalUrl("main", { watch: true })).toBe(
      "/term.html?arg=main&arg=default&arg=default&arg=emo&arg=ro",
    );
  });

  it("changes nothing without ?as=", async () => {
    const { terminalUrl } = await load("");
    expect(terminalUrl("main")).toBe("/term.html?arg=main");
    expect(terminalUrl("main", { owner: "emo" })).toBe(
      "/term.html?arg=main&arg=default&arg=default&arg=emo",
    );
  });
});
