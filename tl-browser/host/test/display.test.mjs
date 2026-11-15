import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { headlessForced, startDisplay, xvfbArgs } from "../lib/display.mjs";

test("TL_BROWSER_HEADLESS=1 is the only way to ask for headless", () => {
  assert.equal(headlessForced({}), false);
  assert.equal(headlessForced({ TL_BROWSER_HEADLESS: "1" }), true);
  for (const v of ["", "0", "true", "yes"]) {
    assert.equal(headlessForced({ TL_BROWSER_HEADLESS: v }), false, `TL_BROWSER_HEADLESS=${v}`);
  }
});

test("Xvfb picks its own display, listens on no TCP port and exits with its last client", () => {
  const args = xvfbArgs({ width: 1920, height: 1080 });
  assert.deepEqual(args.slice(0, 2), ["-displayfd", "3"]);
  assert.ok(args.includes("1920x1080x24"));
  assert.deepEqual(args.slice(args.indexOf("-nolisten"), args.indexOf("-nolisten") + 2), [
    "-nolisten",
    "tcp",
  ]);
  assert.ok(args.includes("-terminate"));
});

/**
 * A fake Xvfb: `display` is what it writes on fd 3, `fail` an error it emits.
 * @param {{ display?: string, fail?: Error }} o
 */
function fakeSpawn(o) {
  /** @type {{ killed: string[], args: string[] }} */
  const seen = { killed: [], args: [] };
  /** @type {(cmd: string, args: string[]) => any} */
  const spawn = (cmd, args) => {
    assert.equal(cmd, "Xvfb");
    seen.args = args;
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null,
      stdio: [null, null, new PassThrough(), new PassThrough()],
      /** @param {string} sig */
      kill: (sig) => {
        seen.killed.push(sig ?? "SIGTERM");
        return true;
      },
    });
    setImmediate(() => {
      if (o.fail) child.emit("error", o.fail);
      else if (o.display !== undefined) child.stdio[3].write(o.display);
    });
    return child;
  };
  return { spawn, seen };
}

test("reads the display number Xvfb reports and stops it on request", async () => {
  const f = fakeSpawn({ display: "17\n" });
  const d = await startDisplay({ width: 1920, height: 1080 }, { spawn: f.spawn, timeoutMs: 1000 });
  assert.ok(d);
  assert.equal(d.display, ":17");
  assert.equal(d.pid, 4242, "the session freezes Xvfb with Chrome, so it needs the pid");
  d.stop();
  assert.deepEqual(f.seen.killed, ["SIGTERM"]);
});

test("no Xvfb on the box means no display, not a crash", async () => {
  const err = Object.assign(new Error("spawn Xvfb ENOENT"), { code: "ENOENT" });
  const f = fakeSpawn({ fail: err });
  const d = await startDisplay({ width: 1920, height: 1080 }, { spawn: f.spawn, timeoutMs: 1000 });
  assert.equal(d, null);
});

test("an Xvfb that never reports a display is killed and gives none", async () => {
  const f = fakeSpawn({});
  const d = await startDisplay({ width: 1920, height: 1080 }, { spawn: f.spawn, timeoutMs: 20 });
  assert.equal(d, null);
  assert.deepEqual(f.seen.killed, ["SIGKILL"]);
});

let haveXvfb = true;
try {
  execFileSync("which", ["Xvfb"], { stdio: "ignore" });
} catch {
  haveXvfb = false;
}

test("starts a real Xvfb", { skip: !haveXvfb && "Xvfb not installed" }, async () => {
  const d = await startDisplay({ width: 640, height: 480 });
  assert.ok(d, "no display");
  assert.match(d.display, /^:\d+$/);
  d.stop();
});
