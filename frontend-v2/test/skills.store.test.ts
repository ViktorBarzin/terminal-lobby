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

describe("the skills store's inline file", () => {
  const view = {
    owner: "wizard",
    name: "grilling",
    skillmd: "---\nname: grilling\n---\nbody\n",
    path: "/home/wizard/.claude/skills/grilling/SKILL.md",
  };

  it("reads the file when a row is expanded, and forgets it when it closes", async () => {
    stubFetch((url) => (url.includes("/view") ? json(view) : json(inventory)));
    const s = createSkillsStore();
    s.toggleExpanded("", "grilling");
    await vi.waitFor(() => expect(s.view()?.name).toBe("grilling"));
    expect(s.draft()).toBe(view.skillmd);
    expect(s.saved()).toBe(view.skillmd);

    s.toggleExpanded("", "grilling"); // same row again: closed
    expect(s.view()).toBeNull();
    expect(s.draft()).toBe("");
  });

  it("reports a file it could not read rather than showing an empty one", async () => {
    stubFetch((url) =>
      url.includes("/view") ? new Response("no such skill", { status: 404 }) : json(inventory),
    );
    const s = createSkillsStore();
    s.toggleExpanded("", "gone");
    await vi.waitFor(() => expect(s.viewError()).toContain("no longer there"));
    expect(s.view()).toBeNull();
  });

  it("saves the draft and moves only the mark for what is on disk", async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      if (url.includes("/view")) return json(view);
      if (url.includes("/edit")) return json({ name: "grilling", path: view.path, hash: "h2" });
      return json(inventory);
    });
    const s = createSkillsStore();
    s.toggleExpanded("", "grilling");
    await vi.waitFor(() => expect(s.view()).toBeTruthy());

    s.setDraft("sharper\n");
    await s.save("grilling");
    expect(seen.some((u) => u.includes("/skills/edit"))).toBe(true);
    expect(s.saved()).toBe("sharper\n");
    expect(s.draft()).toBe("sharper\n");
    // Not re-read: the same view object means the editor is left alone.
    expect(s.view()?.skillmd).toBe(view.skillmd);
    // The inventory is re-read, because the row's hash and size just moved.
    expect(seen.filter((u) => u.endsWith("/skills")).length).toBeGreaterThan(0);
  });

  it("throws an edit away by reading the file again", async () => {
    stubFetch((url) => (url.includes("/view") ? json(view) : json(inventory)));
    const s = createSkillsStore();
    s.toggleExpanded("", "grilling");
    await vi.waitFor(() => expect(s.view()).toBeTruthy());
    const first = s.view();
    s.setDraft("typed\n");

    await s.reread();
    expect(s.draft()).toBe(view.skillmd);
    // A different object, so the editor rebuilds around the file on disk.
    expect(s.view()).not.toBe(first);
  });

  it("has nothing to re-read when no row is open", async () => {
    const spy = stubFetch(() => json(inventory));
    const s = createSkillsStore();
    await s.reread();
    expect(spy).not.toHaveBeenCalled();
  });
});
