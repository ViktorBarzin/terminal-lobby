import assert from "node:assert/strict";
import { test } from "node:test";
import { chromeLaunchOptions, sandboxed } from "../lib/browser.mjs";

test("Chrome launches with its sandbox on by default", () => {
  assert.equal(sandboxed({}), true);
  const opts = chromeLaunchOptions({ channel: "chrome", sandbox: sandboxed({}) });
  assert.equal(opts.chromiumSandbox, true);
  assert.equal(opts.channel, "chrome");
});

test("with a display Chrome runs headed on it; without one it runs headless", () => {
  const headed = chromeLaunchOptions({ channel: "chrome", sandbox: true, display: ":17" });
  assert.equal(headed.headless, false);
  assert.equal(headed.env?.DISPLAY, ":17");
  const headless = chromeLaunchOptions({ channel: "chrome", sandbox: true });
  assert.equal(headless.headless, true);
  assert.equal(headless.env, undefined);
});

// Turnstile fails with navigator.webdriver = true, which --enable-automation
// sets (measured 2026-11-15: 0 of 2 with it, 2 of 2 without).
test("Chrome does not announce itself as automated", () => {
  for (const display of [":17", undefined]) {
    const opts = chromeLaunchOptions({ channel: "chrome", sandbox: true, display });
    assert.deepEqual(opts.ignoreDefaultArgs, ["--enable-automation"]);
    assert.ok(opts.args?.includes("--disable-blink-features=AutomationControlled"));
  }
});

test("TL_BROWSER_NO_SANDBOX=1 is the only way to turn the sandbox off", () => {
  assert.equal(sandboxed({ TL_BROWSER_NO_SANDBOX: "1" }), false);
  for (const v of ["", "0", "true", "yes"]) {
    assert.equal(sandboxed({ TL_BROWSER_NO_SANDBOX: v }), true, `TL_BROWSER_NO_SANDBOX=${v}`);
  }
  assert.equal(chromeLaunchOptions({ channel: "chrome", sandbox: false }).chromiumSandbox, false);
});

test("the host keeps Chrome's signals to itself", () => {
  const opts = chromeLaunchOptions({ channel: "chrome", sandbox: true });
  assert.equal(opts.handleSIGINT, false);
  assert.equal(opts.handleSIGTERM, false);
  assert.equal(opts.handleSIGHUP, false);
});
