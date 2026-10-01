// Finds processes through /proc. Playwright 1.61 no longer exposes the Chrome
// it launched, so the host finds it as the child process that appeared during
// launch, and freezing signals Chrome and every helper it started rather than
// trusting that they all stay in one process group.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * @param {string} procDir
 * @returns {Map<number, number[]>} parent pid to child pids, for every process
 */
function parents(procDir) {
  /** @type {Map<number, number[]>} */
  const children = new Map();
  for (const name of readdirSync(procDir)) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try {
      stat = readFileSync(path.join(procDir, name, "stat"), "utf8");
    } catch {
      continue;
    }
    // "pid (comm) state ppid ...": comm may hold spaces and parentheses, so
    // read the fields after the last ")".
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    const list = children.get(ppid);
    if (list) list.push(Number(name));
    else children.set(ppid, [Number(name)]);
  }
  return children;
}

/**
 * @param {number} pid
 * @param {string} [procDir]
 * @returns {number[]}
 */
export function childPids(pid, procDir = "/proc") {
  return parents(procDir).get(pid) ?? [];
}

/**
 * @param {number} root
 * @param {string} [procDir]
 * @returns {number[]} root first, then its descendants; empty when root is gone
 */
export function treePids(root, procDir = "/proc") {
  const children = parents(procDir);
  let alive = false;
  for (const list of children.values()) if (list.includes(root)) alive = true;
  if (!alive) return [];
  const out = [root];
  for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i]) ?? []));
  return out;
}
