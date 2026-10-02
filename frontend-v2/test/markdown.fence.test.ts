/**
 * A reply streaming in can stop partway through a code fence. The renderer
 * closes it, so the half-written block reads as code from its first line.
 */
import { describe, it, expect } from "vitest";
import { closeOpenFence } from "../src/components/Markdown";

describe("closeOpenFence", () => {
  it("closes a fence the text leaves open, with the same marker", () => {
    expect(closeOpenFence("Run:\n\n```bash\nnpm test")).toBe("Run:\n\n```bash\nnpm test\n```");
    expect(closeOpenFence("~~~~\nx")).toBe("~~~~\nx\n~~~~");
  });

  it("leaves closed fences and plain prose alone", () => {
    const done = "```ts\nconst a = 1;\n```\nafter";
    expect(closeOpenFence(done)).toBe(done);
    expect(closeOpenFence("no code here")).toBe("no code here");
  });

  it("needs the closing fence to be at least as long as the opening one", () => {
    expect(closeOpenFence("````\n```\nstill code")).toBe("````\n```\nstill code\n````");
  });

  it("does not read inline code on its own line as a fence", () => {
    expect(closeOpenFence("``` a `b` ```")).toBe("``` a `b` ```");
  });
});
