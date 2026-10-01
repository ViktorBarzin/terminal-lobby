import assert from "node:assert/strict";
import { test } from "node:test";
import { chromeLaunchOptions, sandboxed } from "../lib/browser.mjs";

test("Chrome launches with its sandbox on by default", () => {
  assert.equal(sandboxed({}), true);
  const opts = chromeLaunchOptions({ channel: "chrome", sandbox: sandboxed({}) });
  assert.equal(opts.chromiumSandbox, true);
  assert.equal(opts.channel, "chrome");
  assert.equal(opts.headless, true);
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
