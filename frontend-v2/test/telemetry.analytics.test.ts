import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  PRODUCTION_HOSTS,
  SCRIPT_SRC,
  VISITOR_STORAGE_KEY,
  identifyPerson,
  loadAnalytics,
  resetAnalytics,
  visitorId,
  withVisitor,
  type AnalyticsWindow,
} from "../src/telemetry/analytics";

/**
 * Pageviews and replay through Rybbit, served same-origin from the Ingest path
 * (docs/adr/0048-usage-events-reach-the-event-pipeline.md). The package is
 * open source, so a lobby anywhere but the production host loads nothing.
 */

beforeEach(() => {
  resetAnalytics();
  document.head.querySelectorAll("script[data-site-id]").forEach((el) => el.remove());
});

function rybbit(): { identify: ReturnType<typeof vi.fn>; clearUserId: ReturnType<typeof vi.fn> } {
  return { identify: vi.fn(), clearUserId: vi.fn() };
}

describe("loadAnalytics", () => {
  it("adds the Rybbit script with the standard's attributes on the production host", () => {
    expect(loadAnalytics(document, PRODUCTION_HOSTS[0]!, window)).toBe(true);
    const s = document.head.querySelector<HTMLScriptElement>("script[data-site-id]");
    expect(s).not.toBeNull();
    expect(s!.getAttribute("src")).toBe(SCRIPT_SRC);
    expect(SCRIPT_SRC).toBe("/_t/r/script.js");
    expect(s!.defer).toBe(true);
    expect(s!.getAttribute("data-site-id")).toBe("1");
    expect(s!.getAttribute("data-replay-mask-all-inputs")).toBe("false");
    expect(s!.getAttribute("data-replay-mask-input-options")).toBe('{"password":true}');
  });

  it.each(["localhost", "127.0.0.1", "terminal-dev.viktorbarzin.me", "lobby.example.com"])(
    "loads nothing on %s",
    (host) => {
      expect(loadAnalytics(document, host, window)).toBe(false);
      expect(document.head.querySelector("script[data-site-id]")).toBeNull();
    },
  );

  it("adds the script once however often it is called", () => {
    loadAnalytics(document, PRODUCTION_HOSTS[0]!, window);
    expect(loadAnalytics(document, PRODUCTION_HOSTS[0]!, window)).toBe(false);
    expect(document.head.querySelectorAll("script[data-site-id]")).toHaveLength(1);
  });
});

describe("identifyPerson", () => {
  it("names the Person to a loaded script, once per id", () => {
    const r = rybbit();
    const win: AnalyticsWindow = { rybbit: r };
    identifyPerson("uid-1", win);
    identifyPerson("uid-1", win);
    expect(r.identify).toHaveBeenCalledTimes(1);
    expect(r.identify).toHaveBeenCalledWith("uid-1");
  });

  it("waits for the script when whoami answers first", () => {
    const win: AnalyticsWindow = {};
    loadAnalytics(document, PRODUCTION_HOSTS[0]!, win);
    identifyPerson("uid-2", win);
    const r = rybbit();
    win.rybbit = r;
    document.head.querySelector("script[data-site-id]")!.dispatchEvent(new Event("load"));
    expect(r.identify).toHaveBeenCalledWith("uid-2");
  });

  it("ignores a missing id, which a box without Authentik sends", () => {
    const r = rybbit();
    identifyPerson(undefined, { rybbit: r });
    identifyPerson("", { rybbit: r });
    expect(r.identify).not.toHaveBeenCalled();
  });

  it("clears the previous Person before naming a different one", () => {
    const r = rybbit();
    const win: AnalyticsWindow = { rybbit: r };
    identifyPerson("uid-1", win);
    identifyPerson("uid-3", win);
    expect(r.clearUserId).toHaveBeenCalledTimes(1);
    expect(r.identify).toHaveBeenLastCalledWith("uid-3");
  });
});

/**
 * The page's Rybbit visitor id rides on same-origin API calls as X-Visitor-Id,
 * so the services' Product events join the same Rybbit user as the visits
 * (the telemetry library's RequestMiddleware reads it).
 */
describe("the visitor id", () => {
  afterEach(() => {
    localStorage.removeItem(VISITOR_STORAGE_KEY);
    vi.restoreAllMocks();
  });

  it("is what the Rybbit script keeps in localStorage", () => {
    expect(VISITOR_STORAGE_KEY).toBe("rybbit-visitor-id");
    expect(visitorId()).toBeUndefined();
    localStorage.setItem(VISITOR_STORAGE_KEY, "rv-1");
    expect(visitorId()).toBe("rv-1");
  });

  // The script writes the id after the page has started, so it is read at
  // each call rather than once.
  it("is read at the call, not when the module loaded", () => {
    const before = withVisitor("/api/sessions/telemetry", { method: "POST" });
    localStorage.setItem(VISITOR_STORAGE_KEY, "rv-late");
    const after = withVisitor("/api/sessions/telemetry", { method: "POST" });
    expect(new Headers(before?.headers).has("X-Visitor-Id")).toBe(false);
    expect(new Headers(after?.headers).get("X-Visitor-Id")).toBe("rv-late");
  });

  it("joins the caller's headers without replacing them", () => {
    localStorage.setItem(VISITOR_STORAGE_KEY, "rv-1");
    const init = withVisitor("/api/sessions/layout", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
    });
    const h = new Headers(init?.headers);
    expect(h.get("Content-Type")).toBe("application/json");
    expect(h.get("X-Visitor-Id")).toBe("rv-1");
    expect(init?.method).toBe("PUT");
  });

  it("leaves the request untouched when there is none", () => {
    const init = { method: "POST", headers: { "Content-Type": "application/json" } };
    expect(withVisitor("/api/sessions/telemetry", init)).toBe(init);
    expect(withVisitor("/api/sessions/telemetry")).toBeUndefined();
  });

  it("goes to this origin only", () => {
    localStorage.setItem(VISITOR_STORAGE_KEY, "rv-1");
    const init = { method: "GET" };
    expect(withVisitor("https://devvm.example.com/api/sessions/whoami", init)).toBe(init);
  });

  it("costs the header, never the request, when storage refuses", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(visitorId()).toBeUndefined();
    const init = { method: "POST" };
    expect(withVisitor("/api/sessions/telemetry", init)).toBe(init);
  });
});
