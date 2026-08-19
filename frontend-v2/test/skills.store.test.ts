import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSkillsStore } from "../src/store/skills";
import type { Inventory } from "../src/lib/skills-api";

/**
 * The store's failure reporting. One case is load-bearing enough to pin: a 404
 * on the INVENTORY cannot mean "that skill is gone", because the request names
 * no skill — it means nothing is serving GET /skills. Saying the wrong one of
 * those made a routing bug read as a data problem, so the two messages differ.
 */

const inventory: Inventory = { user: "wizard", skills: [], plugins: [], peers: [] };

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const spy = vi.fn((input: RequestInfo | URL) => Promise.resolve(handler(String(input))));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("the skills store's error reporting", () => {
  it("reads the inventory into place", async () => {
    stubFetch(() => json(inventory));
    const s = createSkillsStore();
    await s.load();
    expect(s.inventory()?.user).toBe("wizard");
    expect(s.error()).toBe("");
  });

  it("says nothing is answering /skills when the inventory 404s", async () => {
    // What a route that matches only /skills/* produces: the request falls
    // through to whatever serves everything else, and that answers 404.
    stubFetch(() => new Response("<html><h1>404</h1></html>", { status: 404 }));
    const s = createSkillsStore();
    await s.load();
    expect(s.inventory()).toBeNull();
    expect(s.error()).toContain("Nothing is answering /skills");
    expect(s.error()).not.toContain("no longer there");
  });

  it("still blames the skill when an ACTION 404s, where that is what it means", async () => {
    const s = createSkillsStore();
    stubFetch((url) => (url.includes("/skills/remove") ? new Response("no such skill", { status: 404 }) : json(inventory)));
    await s.load();
    await s.remove("gone-already");
    // The action's message goes to a toast rather than the group's error slot,
    // and the inventory reload leaves the panel usable.
    expect(s.error()).toBe("");
    expect(s.inventory()).not.toBeNull();
  });

  it("distinguishes an unreachable service from a refusal", async () => {
    stubFetch(() => {
      throw new Error("connection refused");
    });
    const s = createSkillsStore();
    await s.load();
    expect(s.error()).toContain("Could not reach");

    stubFetch(() => new Response("nope", { status: 403 }));
    await s.load();
    expect(s.error()).toContain("Not permitted");
  });
});
