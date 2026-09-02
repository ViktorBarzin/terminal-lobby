import { describe, it, expect } from "vitest";
// Vite inlines the page at transform time, so this needs no node:fs and runs
// in the suite's default jsdom environment like every other test here.
import termHtml from "../../frontend/term.html?raw";

/**
 * frontend/term.html — temporal-dead-zone guard for the coarse-pointer block.
 *
 * term.html has no build step, so nothing type-checks it and no bundler warns
 * about declaration order. Its whole body is ONE `(async function () { … })()`,
 * and inside it sits `if (isCoarsePointer) { … }` — the block that builds the
 * phone's compose bar. A `let` at the IIFE's own statement level is hoisted but
 * NOT initialised, so assigning to it from inside that block, above the `let`,
 * throws `ReferenceError: Cannot access 'X' before initialization`.
 *
 * That is not a lint nit here, it is a total outage on one class of device.
 * The throw rejects the async IIFE, so every line after it is abandoned —
 * including the `/token` fetch and `new WebSocket(...)` that attach the
 * terminal. A fine pointer skips the block and never trips, so the page keeps
 * working on a desktop while every phone silently fails to connect. That is
 * exactly what shipped in 6297e67 (offline held keys): `heldComposeOwns` and
 * `heldComposePaint` were assigned ~730 lines above their `let`, and terminal
 * mode stopped connecting on iOS for three days while text mode masked it.
 *
 * The check is deliberately narrow — assignments at the block's OWN statement
 * level, which run synchronously while the IIFE is still executing. Assignments
 * nested deeper (inside handlers and helper bodies) run later, by which time
 * every `let` is initialised, and are legitimate.
 */

/** Line numbers are 1-based, matching an editor and the stack traces we get. */
const lines = (): string[] => termHtml.split("\n");

/**
 * The `if (isCoarsePointer) {` block's [open, close] line numbers, found by
 * brace matching so the test survives every edit above and inside it.
 */
function coarseBlock(src: string[]): { start: number; end: number } {
  const start = src.findIndex((l) => /^\s*if \(isCoarsePointer\) \{/.test(l));
  expect(start, "if (isCoarsePointer) { block").toBeGreaterThan(-1);
  const indent = /^(\s*)/.exec(src[start] ?? "")?.[1] ?? "";
  const end = src.findIndex(
    (l, i) => i > start && l === indent + "}",
  );
  expect(end, "closing brace of the coarse-pointer block").toBeGreaterThan(start);
  return { start: start + 1, end: end + 1 };
}

/** `let`/`const` declared at the async IIFE's own statement level (8 spaces). */
function iifeDeclarations(src: string[]): Map<string, number> {
  const decls = new Map<string, number>();
  src.forEach((line, i) => {
    const name = line.match(/^ {8}(?:let|const)\s+([A-Za-z_$][\w$]*)/)?.[1];
    if (name && !decls.has(name)) decls.set(name, i + 1);
  });
  return decls;
}

/**
 * Bare assignments (`name = …`, not a declaration, not a comparison) at the
 * coarse block's own statement level — one indent step inside it.
 */
function statementLevelAssignments(
  src: string[],
  block: { start: number; end: number },
): Map<string, number> {
  const found = new Map<string, number>();
  for (let n = block.start + 1; n < block.end; n++) {
    const line = src[n - 1];
    if (line === undefined) continue;
    if (/^ {12}(?:let|const|var|return|if|for|while)\b/.test(line)) continue;
    const name = line.match(/^ {12}([A-Za-z_$][\w$]*)\s*=(?!=)/)?.[1];
    if (name && !found.has(name)) found.set(name, n);
  }
  return found;
}

describe("term.html — coarse-pointer block declaration order", () => {
  it("assigns no IIFE-scoped let/const above its own declaration", () => {
    const src = lines();
    const block = coarseBlock(src);
    const decls = iifeDeclarations(src);
    const assigns = statementLevelAssignments(src, block);

    const violations = [...assigns]
      .filter(([name, at]) => {
        const declaredAt = decls.get(name);
        return declaredAt !== undefined && declaredAt > at;
      })
      .map(
        ([name, at]) =>
          `${name}: assigned at line ${at}, declared at line ${decls.get(name)} ` +
          `— move the declaration above line ${block.start}`,
      );

    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("keeps the held-input hooks the mobile compose bar overrides in scope early", () => {
    // The two the outage was made of. Named explicitly so a future edit that
    // reintroduces the pattern fails on the specific pair, not just the sweep.
    const src = lines();
    const block = coarseBlock(src);
    const decls = iifeDeclarations(src);
    for (const name of ["heldComposeOwns", "heldComposePaint"]) {
      const declaredAt = decls.get(name);
      expect(declaredAt, `${name} declared at the IIFE statement level`).toBeDefined();
      expect(
        declaredAt!,
        `${name} must be declared before the coarse-pointer block that assigns it`,
      ).toBeLessThan(block.start);
    }
  });
});
