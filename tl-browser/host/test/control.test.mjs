import assert from "node:assert/strict";
import { test } from "node:test";
import { Control } from "../lib/control.mjs";

function clock(start = 1000) {
  const c = { t: start, now: () => c.t };
  return c;
}

const NOBODY = { holder: null, holderId: null, since: null, lapseAt: null };

test("nobody holds control at first", () => {
  const c = clock();
  const ctl = new Control({ lapseMs: 600, now: c.now });
  assert.equal(ctl.holder, null);
  assert.equal(ctl.holderId, null);
  assert.deepEqual(ctl.snapshot(), NOBODY);
});

test("taking control records which connection, whose name, since when and when it lapses", () => {
  const c = clock();
  const ctl = new Control({ lapseMs: 600, now: c.now });
  ctl.take("c1", "viktor");
  assert.deepEqual(ctl.snapshot(), { holder: "viktor", holderId: "c1", since: 1000, lapseAt: 1600 });
});

test("another person can take over, and the clock restarts for them", () => {
  const c = clock();
  const ctl = new Control({ lapseMs: 600, now: c.now });
  ctl.take("c1", "viktor");
  c.t = 1200;
  ctl.take("c2", "anca");
  assert.deepEqual(ctl.snapshot(), { holder: "anca", holderId: "c2", since: 1200, lapseAt: 1800 });
});

test("the same person's other device takes control over from the first", () => {
  const c = clock();
  const ctl = new Control({ lapseMs: 600, now: c.now });
  ctl.take("laptop", "viktor");
  c.t = 1200;
  ctl.take("phone", "viktor");
  assert.deepEqual(
    ctl.snapshot(),
    { holder: "viktor", holderId: "phone", since: 1000, lapseAt: 1800 },
    "the same person keeps since; the connection moves",
  );
  assert.equal(ctl.input("laptop"), false, "the first device no longer drives");
  assert.equal(ctl.input("phone"), true);
  assert.equal(ctl.handBack("laptop"), false, "nor can it hand back");
  assert.equal(ctl.holderId, "phone");
});

test("taking it again on the holding connection keeps since and pushes the lapse out", () => {
  const c = clock();
  const ctl = new Control({ lapseMs: 600, now: c.now });
  ctl.take("c1", "viktor");
  c.t = 1300;
  ctl.take("c1", "viktor");
  assert.deepEqual(ctl.snapshot(), { holder: "viktor", holderId: "c1", since: 1000, lapseAt: 1900 });
});

test("only the holding connection's input is allowed, and it pushes the lapse out", () => {
  const c = clock();
  const ctl = new Control({ lapseMs: 600, now: c.now });
  assert.equal(ctl.input("c1"), false, "nobody holds it yet");
  ctl.take("c1", "viktor");
  c.t = 1500;
  assert.equal(ctl.input("c2"), false);
  assert.equal(ctl.snapshot().lapseAt, 1600, "another connection's input moves nothing");
  assert.equal(ctl.input("c1"), true);
  assert.equal(ctl.snapshot().lapseAt, 2100);
});

test("only the holding connection can hand back", () => {
  const c = clock();
  const ctl = new Control({ lapseMs: 600, now: c.now });
  ctl.take("c1", "viktor");
  assert.equal(ctl.handBack("c2"), false);
  assert.equal(ctl.holder, "viktor");
  assert.equal(ctl.handBack("c1"), true);
  assert.equal(ctl.holder, null);
  assert.equal(ctl.handBack("c1"), false, "handing back twice changes nothing");
});

test("control lapses once the lapse time passes with no input", () => {
  const c = clock();
  const ctl = new Control({ lapseMs: 600, now: c.now });
  ctl.take("c1", "viktor");
  c.t = 1599;
  assert.equal(ctl.lapse(), false);
  assert.equal(ctl.holder, "viktor");
  c.t = 1600;
  assert.equal(ctl.lapse(), true);
  assert.deepEqual(ctl.snapshot(), NOBODY);
  assert.equal(ctl.lapse(), false, "nothing left to lapse");
});

test("the lapse follows the connection that holds control", () => {
  const c = clock();
  const ctl = new Control({ lapseMs: 600, now: c.now });
  ctl.take("laptop", "viktor");
  c.t = 1500;
  ctl.take("phone", "viktor");
  c.t = 2000;
  assert.equal(ctl.input("laptop"), false, "the old device's input does not keep it alive");
  c.t = 2100;
  assert.equal(ctl.lapse(), true);
});

test("releasing a user's control frees it whichever connection holds it", () => {
  const c = clock();
  const ctl = new Control({ lapseMs: 600, now: c.now });
  ctl.take("c1", "anca");
  assert.equal(ctl.release("viktor"), false, "someone else's release changes nothing");
  assert.equal(ctl.holderId, "c1");
  assert.equal(ctl.release("anca"), true);
  assert.deepEqual(ctl.snapshot(), NOBODY);
  assert.equal(ctl.release("anca"), false, "nothing left to release");
});
