import { describe, it, expect } from "vitest";
import termHtml from "../../frontend/term.html?raw";

/**
 * frontend/term.html — /token and /ws must resolve at the ORIGIN ROOT, whatever
 * path the page itself is served from.
 *
 * The page derives them from its own location, and that held while it was only
 * ever served at `/` (the vanilla page) or `/term.html` (the v2 iframe): both
 * strip to "". Then 486b11a started serving an immutable copy from
 * `/assets/term-<asset>.html` so an attach costs no round trip, and the SAME
 * derivation began producing `/assets/token` and `/assets/ws`.
 *
 * Those do not exist. `/assets/` routes to clipboard-upload (infra e0a41df5),
 * which serves static files — measured on the box: `/assets/token?arg=x` → 404
 * while `/token?arg=x` → 200 on ttyd. So the terminal fetched a 404, failed to
 * parse it as JSON, and never opened its socket: "Token fetch failed" on repeat,
 * and no terminal at all on the view that is the default for every session.
 *
 * The rule is in the page's own comment — /token and /ws live at the origin root
 * — so this pins it against the three paths the page is actually served from.
 */
describe("term.html token/ws origin", () => {
  /** The page's own derivation, lifted out and evaluated. */
  const baseFor = (pathname: string): string => {
    const m = termHtml.match(/const base = ([^;]+);/);
    if (!m) throw new Error("term.html no longer derives a base — update this test");
    return new Function("location", `return ${m[1]!}`)({ pathname });
  };

  it("resolves to the origin root from every path the page is served at", () => {
    // The vanilla page, the v2 iframe, and the immutable hashed copy.
    expect(baseFor("/")).toBe("");
    expect(baseFor("/term.html")).toBe("");
    expect(baseFor("/assets/term-b40edcd054b4.html")).toBe("");
  });

  it("still honours a genuine sub-path deployment", () => {
    // Not how anything is served today, but the derivation exists for it and
    // dropping it would be a silent change rather than a fix.
    expect(baseFor("/lobby/term.html")).toBe("/lobby");
  });
});
