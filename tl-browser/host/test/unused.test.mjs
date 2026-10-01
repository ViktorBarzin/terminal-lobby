// A host that never opens a browser must not outlive the freeze window: the
// launcher starts one per tool call, and an idle host holds ~140 MB on its own.
// No Chrome is needed, since none is launched.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const host = fileURLToPath(new URL("../host.mjs", import.meta.url));

test("a host that never launches a browser exits after the freeze window", {
  timeout: 30_000,
}, async (t) => {
  const tmp = mkdtempSync(path.join(tmpdir(), "tl-browser-unused-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const child = spawn(process.execPath, [host], {
    env: {
      PATH: process.env.PATH,
      HOME: tmp,
      XDG_RUNTIME_DIR: tmp,
      TL_BROWSER_STORAGE_STATE: "",
      TL_BROWSER_IDLE_FREEZE_MS: "500",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => child.kill("SIGKILL"));
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));

  // Initialized, stdin held open, and no tool called.
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "unused-test", version: "1" },
      },
    })}\n`,
  );
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const started = Date.now();
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const code = await Promise.race([
    exited,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve("still running"), 15_000);
    }),
  ]);
  clearTimeout(timer);
  assert.equal(code, 0);
  assert.ok(Date.now() - started >= 300, "it waited out the freeze window first");
});
