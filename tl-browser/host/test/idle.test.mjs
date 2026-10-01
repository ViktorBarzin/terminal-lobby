import assert from "node:assert/strict";
import { test } from "node:test";
import { IdleClock } from "../lib/idle.mjs";

function setup() {
  const c = { t: 0 };
  const idle = new IdleClock({ freezeMs: 100, closeMs: 1000, now: () => c.t });
  return { c, idle };
}

test("a fresh browser is live and nothing is due", () => {
  const { idle } = setup();
  assert.equal(idle.state, "live");
  assert.equal(idle.check(false), null);
});

test("idle for the freeze time freezes, exactly once", () => {
  const { c, idle } = setup();
  c.t = 99;
  assert.equal(idle.check(false), null);
  c.t = 100;
  assert.equal(idle.check(false), "freeze");
  assert.equal(idle.state, "frozen");
  c.t = 150;
  assert.equal(idle.check(false), null);
});

test("frozen for the close time closes", () => {
  const { c, idle } = setup();
  c.t = 100;
  idle.check(false);
  c.t = 1099;
  assert.equal(idle.check(false), null);
  c.t = 1100;
  assert.equal(idle.check(false), "close");
});

test("activity resets the idle time", () => {
  const { c, idle } = setup();
  c.t = 90;
  idle.touch();
  c.t = 150;
  assert.equal(idle.check(false), null);
  c.t = 190;
  assert.equal(idle.check(false), "freeze");
});

test("being busy counts as activity", () => {
  const { c, idle } = setup();
  c.t = 500;
  assert.equal(idle.check(true), null);
  c.t = 599;
  assert.equal(idle.check(false), null);
  c.t = 600;
  assert.equal(idle.check(false), "freeze");
});

test("thawing goes back to live and restarts the idle time", () => {
  const { c, idle } = setup();
  c.t = 100;
  idle.check(false);
  c.t = 700;
  assert.equal(idle.thaw(), true);
  assert.equal(idle.state, "live");
  assert.equal(idle.thaw(), false, "already live");
  c.t = 799;
  assert.equal(idle.check(false), null);
  c.t = 800;
  assert.equal(idle.check(false), "freeze");
});

test("a frozen browser someone is busy with is not closed", () => {
  const { c, idle } = setup();
  c.t = 100;
  idle.check(false);
  c.t = 1000;
  assert.equal(idle.check(true), null);
  c.t = 1100;
  assert.equal(idle.check(false), null, "the frozen time restarted when it was busy");
  c.t = 2000;
  assert.equal(idle.check(false), "close");
});
