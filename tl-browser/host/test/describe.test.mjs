import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const host = fileURLToPath(new URL("../host.mjs", import.meta.url));

test("--describe prints the handshake and tool list on one line and exits", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [host, "--describe"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    timeout: 30_000,
  });
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const { initialize, tools } = JSON.parse(lines[0]);
  assert.equal(typeof initialize.protocolVersion, "string");
  assert.ok(initialize.capabilities.tools);
  assert.match(initialize.instructions, /browser_close/);
  const names = tools.tools.map((t) => t.name);
  assert.ok(names.includes("browser_navigate"));
  const close = tools.tools.find((t) => t.name === "browser_close");
  assert.match(close.description, /frees its memory/);
});
