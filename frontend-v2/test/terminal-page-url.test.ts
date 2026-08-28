/**
 * Where terminal iframes are pointed.
 *
 * `/term.html` is served `no-cache`, so an attach costs at least a conditional
 * round trip, and a whole ~474 KB after every deploy — measured on Viktor's own
 * device through term.ready: 17 of 25 attaches pulled the full body. The
 * immutable copy is the same bytes under a name that changes when the content
 * does (`/assets/term-<asset>.html`, answered `immutable`), so an attach costs
 * nothing at all.
 *
 * The fingerprint comes from this page's own <head>, stamped by the deploy that
 * shipped both files — no request to discover it, and no window where the two
 * disagree. Everything unexpected has to fall back to the path that has always
 * been served, because getting this wrong 404s every terminal in the app.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const load = async (): Promise<string> => {
  vi.resetModules();
  const mod = await import("../src/lib/config");
  return mod.TERMINAL_PAGE_URL;
};

const stamp = (content: string | null): void => {
  document.head.querySelectorAll('meta[name="tl-term-asset"]').forEach((m) => m.remove());
  if (content === null) return;
  const m = document.createElement("meta");
  m.setAttribute("name", "tl-term-asset");
  m.setAttribute("content", content);
  document.head.appendChild(m);
};

beforeEach(() => stamp(null));
afterEach(() => {
  stamp(null);
  vi.resetModules();
});

describe("the terminal page URL", () => {
  it("uses the immutable copy when the deploy stamped a fingerprint", async () => {
    stamp("b40edcd054b4");
    expect(await load()).toBe("/assets/term-b40edcd054b4.html");
  });

  it("falls back when there is no stamp at all", async () => {
    expect(await load()).toBe("/term.html");
  });

  it("falls back on an unsubstituted placeholder", async () => {
    // A mis-stamped deploy ships the literal placeholder; asking for
    // /assets/term-__TL_TERM_ASSET__.html would 404 every attach.
    stamp("__TL_TERM_ASSET__");
    expect(await load()).toBe("/term.html");
  });

  it.each(["", "  ", "nothex", "b40edcd054b", "b40edcd054b4a", "../../etc/passwd"])(
    "falls back on a fingerprint that is not one: %j",
    async (bad) => {
      stamp(bad);
      expect(await load()).toBe("/term.html");
    },
  );
});
