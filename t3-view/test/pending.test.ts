import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessageId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { PendingDispatches } from "../src/threads/pending.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("PendingDispatches", () => {
  it("hands back the oldest message id sent with a text, once", () => {
    const p = new PendingDispatches({ now: () => 1000 });
    p.add("k", { messageId: MessageId.make("m1"), text: "hello", at: 900 });
    p.add("k", { messageId: MessageId.make("m2"), text: "hello", at: 950 });
    expect(p.take("k", "hello  ")).toBe("m1");
    expect(p.take("k", "hello")).toBe("m2");
    expect(p.take("k", "hello")).toBeUndefined();
  });

  it("keeps threads apart", () => {
    const p = new PendingDispatches({ now: () => 1000 });
    p.add("a", { messageId: MessageId.make("m1"), text: "x", at: 900 });
    expect(p.take("b", "x")).toBeUndefined();
  });

  it("matches a long prompt whose row came back capped", () => {
    const p = new PendingDispatches({ now: () => 1000 });
    const long = "a".repeat(200);
    p.add("k", { messageId: MessageId.make("m1"), text: long, at: 900 });
    expect(p.take("k", long.slice(0, 120))).toBe("m1");
  });

  it("forgets an entry after its TTL", () => {
    let now = 1000;
    const p = new PendingDispatches({ ttlMs: 100, now: () => now });
    p.add("k", { messageId: MessageId.make("m1"), text: "x", at: 1000 });
    now = 1200;
    expect(p.take("k", "x")).toBeUndefined();
  });

  it("survives a restart through its file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-t3-pending-"));
    dirs.push(dir);
    const file = join(dir, "pending.json");
    const first = new PendingDispatches({ file, now: () => 1000 });
    first.add("k", { messageId: MessageId.make("m1"), text: "x", at: 900 });
    const second = new PendingDispatches({ file, now: () => 1000 });
    expect(second.take("k", "x")).toBe("m1");
  });
});
