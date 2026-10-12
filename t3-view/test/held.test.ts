import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { HeldPrompts } from "../src/threads/held.ts";

const prompt = (id: string, text: string) => ({ messageId: MessageId.make(id), text });

function stateFile(): string {
  return join(mkdtempSync(join(tmpdir(), "tl-t3-held-")), "state", "held.json");
}

describe("HeldPrompts", () => {
  it("keeps a thread's held prompts across a restart, per OS user", () => {
    const file = stateFile();
    const first = new HeldPrompts(file);
    first.set("wizard", "t1", [prompt("m1", "later please"), prompt("m2", "and this")]);
    first.set("emo", "t1", [prompt("m3", "someone else's")]);

    const second = new HeldPrompts(file);
    expect(second.get("wizard", "t1")).toEqual([
      prompt("m1", "later please"),
      prompt("m2", "and this"),
    ]);
    expect(second.get("emo", "t1")).toEqual([prompt("m3", "someone else's")]);
    expect(second.get("wizard", "t2")).toEqual([]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("forgets a thread once nothing is held there", () => {
    const file = stateFile();
    const held = new HeldPrompts(file);
    held.set("wizard", "t1", [prompt("m1", "later please")]);
    held.set("wizard", "t1", []);
    expect(new HeldPrompts(file).get("wizard", "t1")).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  });

  it("works in memory without a file, and skips entries it cannot read", () => {
    const held = new HeldPrompts();
    held.set("wizard", "t1", [prompt("m1", "x")]);
    expect(held.get("wizard", "t1")).toEqual([prompt("m1", "x")]);
  });
});
