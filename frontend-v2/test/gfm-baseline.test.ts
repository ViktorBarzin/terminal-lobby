import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { remarkPluginsFor } from "../src/lib/markdown-plugins";

// remark-gfm's autolink-literal extension builds its email pattern with a
// LOOKBEHIND, and it does so inside a transform that runs on EVERY markdown
// render. Lookbehind arrived in Safari 16.4, so on the oldest engine we serve
// (iPadOS 15.8) that `new RegExp` throws and takes the whole render with it.
//
// This is the second half of the 2026-08-18 blank-iPad fix: setting vite's
// build.target to safari15 made esbuild rewrite the offending regex LITERAL
// into `new RegExp("…")`, which fixes parsing — the lobby now starts — but
// moves the failure to the moment the transform runs. Without this gate the
// iPad would trade a blank lobby for a text view that throws on the first
// message it draws.
describe("markdown plugins on the baseline engine", () => {
  it("uses remark-gfm where lookbehind is supported", () => {
    expect(remarkPluginsFor(true)).toHaveLength(1);
  });

  it("drops remark-gfm where it is not, so the render still completes", () => {
    expect(remarkPluginsFor(false)).toHaveLength(0);
  });

  it("hands back the same array identity for repeat renders", () => {
    expect(remarkPluginsFor(true)).toBe(remarkPluginsFor(true));
    expect(remarkPluginsFor(false)).toBe(remarkPluginsFor(false));
  });

  it("keeps GFM working wherever lookbehind exists", () => {
    const proc = unified().use(remarkParse).use(remarkPluginsFor(true) as never);
    const types: string[] = [];
    const walk = (n: { type?: string; children?: unknown[] }) => {
      if (n?.type) types.push(n.type);
      (n?.children ?? []).forEach((c) => walk(c as never));
    };
    walk(proc.runSync(proc.parse("| a | b |\n| - | - |\n| 1 | 2 |")) as never);
    expect(types).toContain("table");
  });

  // Deliberately NOT a test that the render throws without the gate. The throw
  // does not exist in SOURCE: there the pattern is a regex literal, which V8
  // reads happily, so patching the RegExp constructor here proves nothing. It
  // only becomes a `new RegExp("…")` call in the SHIPPED bundle, where esbuild
  // rewrote the literal it could not lower for safari15 — so the failure lives
  // in the build output and the engine, neither of which this suite runs.
  // What is testable is that the component asks for the gated list at all.
  it("is what the markdown component actually uses", () => {
    const src = readFileSync(resolve(process.cwd(), "src/components/Markdown.tsx"), "utf8");
    expect(src).toContain("remarkPlugins={remarkPlugins}");
    expect(src).not.toContain("remarkPlugins={[remarkGfm]}");
  });
});
