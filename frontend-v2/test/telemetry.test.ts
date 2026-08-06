import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { createTracker, MAX_BUFFER } from "../src/telemetry/track";

describe("createTracker", () => {
  it("batches events and posts them on flush", async () => {
    const posts: unknown[] = [];
    const t = createTracker({ post: async (b) => void posts.push(b), autoFlush: false });

    t.track("session.selected", { "tl.session": "worktree" });
    t.track("palette.action", { "tl.key": "session.kill" });
    expect(posts).toHaveLength(0); // nothing leaves until a flush

    await t.flush();
    expect(posts).toHaveLength(1);
    const batch = posts[0] as { client: string; events: { name: string }[] };
    expect(batch.client).toBe("lobby-v2");
    expect(batch.events.map((e) => e.name)).toEqual(["session.selected", "palette.action"]);
    t.dispose();
  });

  it("does not post an empty batch", async () => {
    const post = vi.fn(async () => {});
    const t = createTracker({ post, autoFlush: false });
    await t.flush();
    expect(post).not.toHaveBeenCalled();
    t.dispose();
  });

  // Telemetry must never surface as a broken app: a failing intake is dropped
  // silently, and the buffer is cleared so a dead endpoint cannot grow it
  // without bound.
  it("swallows post failures and drops the batch", async () => {
    const t = createTracker({
      post: async () => {
        throw new Error("network down");
      },
      autoFlush: false,
    });
    t.track("app.error", { "tl.kind": "test" });
    await expect(t.flush()).resolves.toBeUndefined();

    const posts: unknown[] = [];
    const t2 = createTracker({ post: async (b) => void posts.push(b), autoFlush: false });
    t2.track("app.loaded", {});
    await t2.flush();
    await t2.flush(); // nothing left over from the first flush
    expect(posts).toHaveLength(1);
    t.dispose();
    t2.dispose();
  });

  it("caps the buffer, keeping the newest events", async () => {
    const posts: { events: { attrs: Record<string, unknown> }[] }[] = [];
    const t = createTracker({ post: async (b) => void posts.push(b as never), autoFlush: false });
    for (let i = 0; i < MAX_BUFFER + 10; i++) t.track("palette.action", { "tl.key": String(i) });
    await t.flush();
    const evs = posts[0]!.events;
    expect(evs).toHaveLength(MAX_BUFFER);
    expect(evs[evs.length - 1]!.attrs["tl.key"]).toBe(String(MAX_BUFFER + 9));
    t.dispose();
  });

  it("flushes on an interval once auto-flush is on", async () => {
    vi.useFakeTimers();
    const post = vi.fn(async () => {});
    const t = createTracker({ post, flushMs: 5000 });
    t.track("view.switched", { "tl.to": "terminal" });
    expect(post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(post).toHaveBeenCalledTimes(1);
    t.dispose();
    vi.useRealTimers();
  });

  // A tab being closed is exactly when the last events matter, and a normal
  // fetch is killed mid-flight — so the final flush goes out via sendBeacon.
  it("uses sendBeacon when the page is going away", () => {
    const beacon = vi.fn(() => true);
    const post = vi.fn(async () => {});
    const t = createTracker({ post, autoFlush: false, beacon });
    t.track("session.detached", { "tl.session": "x" });
    t.flushSync();
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
    const [, body] = beacon.mock.calls[0] as unknown as [string, string];
    expect(JSON.parse(body).events[0].name).toBe("session.detached");
    t.dispose();
  });

  it("is a no-op after dispose", async () => {
    const post = vi.fn(async () => {});
    const t = createTracker({ post, autoFlush: false });
    t.dispose();
    t.track("app.loaded", {});
    await t.flush();
    expect(post).not.toHaveBeenCalled();
  });
});

/**
 * prefs.changed is emitted by BOTH frontends against one catalog entry
 * (telemetry/events.go: "tl.key = the dotted path of the field that changed,
 * tl.to = its new scalar value"). The vanilla page has no build step and no
 * harness of its own, so its copy of the diff is sliced out of the shipped
 * source and run — the same idiom term-html.bridge.test.ts uses — rather than
 * left to drift back to the namespace/sub-key-name shape.
 */
const VANILLA = resolve(__dirname, "../..", "frontend/index.html");

type PathValue = [string, string];

function vanillaChangedPrefPaths(): (prev: unknown, next: unknown) => PathValue[] {
  const src = readFileSync(VANILLA, "utf8");
  const decl = "function changedPrefPaths(prev, next) {";
  const start = src.indexOf(decl);
  expect(start, "changedPrefPaths in frontend/index.html").toBeGreaterThan(-1);
  const end = src.indexOf("\n        }", start);
  expect(end, "its closing brace").toBeGreaterThan(start);
  return runInNewContext(
    `${src.slice(start, end + 10)}; changedPrefPaths`,
    {},
  ) as (prev: unknown, next: unknown) => PathValue[];
}

describe("prefs.changed — both frontends report path + value", () => {
  it("the vanilla page names the leaf and its new value", () => {
    const changed = vanillaChangedPrefPaths();
    expect(
      changed(
        { fontSize: 15, session: { newCommand: "codex" } },
        { fontSize: 15, session: { newCommand: "shell" } },
      ),
    ).toEqual([["session.newCommand", "shell"]]);
  });

  it("the vanilla page reports booleans, and stays silent on a no-op", () => {
    const changed = vanillaChangedPrefPaths();
    const doc = { fontSize: 15, notify: { onAwaiting: false, onDone: true } };
    expect(changed(doc, { ...doc, notify: { onAwaiting: true, onDone: true } })).toEqual([
      ["notify.onAwaiting", "true"],
    ]);
    expect(changed(doc, doc)).toEqual([]);
  });
});
