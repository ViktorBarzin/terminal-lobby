/**
 * The format ratchet has to be honest about who runs it.
 *
 * `npm run format:changed` compares against a base ref. When CI only ever
 * builds pushes to master, that base resolves to the commit being built, so
 * the check has nothing to compare and passes on everything. A CI step in that
 * position enforces nothing while looking like a gate, which is worse than no
 * step at all: the comment next to it tells the next reader that formatting
 * drift is caught, and it is not.
 *
 * So: a workflow may run the ratchet only when it can hand it a base that is
 * not HEAD. Either the workflow runs on branches or pull requests, or it sets
 * `TL_FORMAT_SINCE` explicitly. And when nothing in CI runs it, CONTRIBUTING
 * has to say so, because a contributor who believes CI checks their formatting
 * will not run it themselves.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = (p: string): string => resolve(__dirname, "../..", p);

const WORKFLOW_DIR = REPO(".github/workflows");
const workflows = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .map((f) => ({ name: f, text: readFileSync(resolve(WORKFLOW_DIR, f), "utf8") }));

/** Strip full-line `#` comments so prose about a trigger is not read as one. */
function code(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** Runs on something other than a master push, so a base ref exists. */
function runsOnBranches(text: string): boolean {
  const body = code(text);
  if (/^\s*pull_request:/m.test(body)) return true;
  const branches = body.match(/^\s*branches:\s*\[(.*)\]/m);
  if (!branches?.[1]) return false;
  return branches[1]
    .split(",")
    .map((b) => b.trim().replace(/['"]/g, ""))
    .some((b) => b !== "master" && b !== "main");
}

describe("format ratchet", () => {
  it("is only wired into CI where CI can give it a real base", () => {
    const dishonest = workflows
      .filter((w) => code(w.text).includes("format:changed"))
      .filter((w) => !runsOnBranches(w.text) && !code(w.text).includes("TL_FORMAT_SINCE"))
      .map((w) => w.name);
    expect(dishonest).toEqual([]);
  });

  it("is described as local-only while no workflow runs it", () => {
    const inCI = workflows.some((w) => code(w.text).includes("format:changed"));
    if (inCI) return;
    const contributing = readFileSync(REPO("CONTRIBUTING.md"), "utf8");
    expect(contributing).toMatch(/CI does not run it/i);
  });

  it("lets the base ref be overridden", () => {
    const script = readFileSync(REPO("frontend-v2/scripts/format-changed.sh"), "utf8");
    expect(script).toMatch(/TL_FORMAT_SINCE:-origin\/master/);
  });
});
