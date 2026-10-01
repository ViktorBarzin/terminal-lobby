import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { childPids, treePids } from "../lib/proctree.mjs";

const proc = mkdtempSync(path.join(tmpdir(), "tl-proc-"));
after(() => rmSync(proc, { recursive: true, force: true }));

/**
 * @param {number} pid
 * @param {number} ppid
 * @param {string} comm
 */
function fake(pid, ppid, comm) {
  mkdirSync(path.join(proc, String(pid)));
  writeFileSync(
    path.join(proc, String(pid), "stat"),
    `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1\n`,
  );
}

fake(1, 0, "init");
fake(100, 1, "chrome");
fake(101, 100, "chrome (zygote)");
fake(102, 101, "chrome) S 1 x");
fake(103, 100, "chrome");
fake(200, 1, "unrelated");
fake(201, 200, "child of unrelated");
mkdirSync(path.join(proc, "self"));

test("a process and all its descendants are found, and nothing else", () => {
  assert.deepEqual(
    treePids(100, proc).sort((a, b) => a - b),
    [100, 101, 102, 103],
  );
});

test("a process with no children is just itself", () => {
  assert.deepEqual(treePids(103, proc), [103]);
});

test("a process that is gone yields nothing", () => {
  assert.deepEqual(treePids(999, proc), []);
});

test("the direct children of a process are listed", () => {
  assert.deepEqual(
    childPids(100, proc).sort((a, b) => a - b),
    [101, 103],
  );
  assert.deepEqual(childPids(999, proc), []);
});
