import assert from "node:assert/strict";
import { test } from "node:test";
import { Control } from "../lib/control.mjs";

function clock(start = 1000) {
  const c = { t: start, now: () => c.t };
  return c;
}

test("nobody holds control at first", () => {
  const c = clock();
  const ctl = new Control({ lapseMs: 600, now: c.now });
  assert.equal(ctl.holder, null);
  assert.deepEqual(ctl.snapshot(), { holder: null, since: null, lapseAt: null });
});

test("taking control records who, since when and when it lapses", () => {
  const c = clock();
  const ctl = new Control({ lapseMs: 600, now: c.now });
  ctl.take("viktor");
  assert.deepEqual(ctl.snapshot(), { holder: "viktor", since: 1000, lapseAt: 1600 });
});

test("another person can take over, and the clock restarts for them", () => {
  const c = clock();
  const ctl = new Control({ lapseMs: 600, now: c.now });
  ctl.take("viktor");
  c.t = 1200;
  ctl.take("anca");
  assert.deepEqual(ctl.snapshot(), { holder: "anca", since: 1200, lapseAt: 1800 });
});

test("taking it again as the holder keeps since and pushes the lapse out", () => {
  const c = clock();
  const ctl = new Control({ lapseMs: 600, now: c.now });
  ctl.take("viktor");
  c.t = 1300;
  ctl.take("viktor");
  assert.deepEqual(ctl.snapshot(), { holder: "viktor", since: 1000, lapseAt: 1900 });
});

test("only the holder's input is allowed, and it pushes the lapse out", () => {
  const c = clock();
  const ctl = new Control({ lapseMs: 600, now: c.now });
  assert.equal(ctl.input("viktor"), false, "nobody holds it yet");
  ctl.take("viktor");
  c.t = 1500;
  assert.equal(ctl.input("anca"), false);
  assert.equal(ctl.snapshot().lapseAt, 1600, "someone else's input moves nothing");
  assert.equal(ctl.input("viktor"), true);
  assert.equal(ctl.snapshot().lapseAt, 2100);
});

test("only the holder can hand back", () => {
  const c = clock();
  const ctl = new Control({ lapseMs: 600, now: c.now });
  ctl.take("viktor");
  assert.equal(ctl.handBack("anca"), false);
  assert.equal(ctl.holder, "viktor");
  assert.equal(ctl.handBack("viktor"), true);
  assert.equal(ctl.holder, null);
  assert.equal(ctl.handBack("viktor"), false, "handing back twice changes nothing");
});

test("control lapses once the lapse time passes with no input", () => {
  const c = clock();
  const ctl = new Control({ lapseMs: 600, now: c.now });
  ctl.take("viktor");
  c.t = 1599;
  assert.equal(ctl.lapse(), false);
  assert.equal(ctl.holder, "viktor");
  c.t = 1600;
  assert.equal(ctl.lapse(), true);
  assert.deepEqual(ctl.snapshot(), { holder: null, since: null, lapseAt: null });
  assert.equal(ctl.lapse(), false, "nothing left to lapse");
});
