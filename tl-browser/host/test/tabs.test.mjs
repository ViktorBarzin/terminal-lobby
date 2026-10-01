import assert from "node:assert/strict";
import { test } from "node:test";
import { TabRegistry } from "../lib/tabs.mjs";

test("a new page gets an id and becomes the agent's tab", () => {
  const reg = new TabRegistry();
  const a = {};
  const id = reg.add(a);
  assert.equal(id, "t1");
  assert.equal(reg.agentTab, "t1");
  assert.equal(reg.pageOf("t1"), a);
  assert.equal(reg.idOf(a), "t1");
  assert.deepEqual(reg.snapshot(), [{ id: "t1", url: "", title: "" }]);
});

test("the page that last navigated is the agent's tab", () => {
  const reg = new TabRegistry();
  const a = {};
  const b = {};
  reg.add(a);
  reg.add(b);
  assert.equal(reg.agentTab, "t2");
  assert.equal(reg.navigated(a), true);
  assert.equal(reg.agentTab, "t1");
  assert.equal(reg.navigated(a), false, "already the agent's tab");
});

test("closing the agent's tab falls back to the newest remaining page", () => {
  const reg = new TabRegistry();
  const a = {};
  const b = {};
  const c = {};
  reg.add(a);
  reg.add(b);
  reg.add(c);
  reg.navigated(b);
  assert.equal(reg.remove(b), true);
  assert.equal(reg.agentTab, "t3");
  assert.equal(reg.remove(a), false, "not the agent's tab");
  assert.equal(reg.remove(c), true);
  assert.equal(reg.agentTab, null);
  assert.deepEqual(reg.snapshot(), []);
});

test("ids are never reused", () => {
  const reg = new TabRegistry();
  const a = {};
  reg.add(a);
  reg.remove(a);
  assert.equal(reg.add({}), "t2");
});

test("url and title changes are reported once", () => {
  const reg = new TabRegistry();
  const a = {};
  reg.add(a);
  assert.equal(reg.update(a, { url: "https://x/" }), true);
  assert.equal(reg.update(a, { url: "https://x/" }), false);
  assert.equal(reg.update(a, { title: "X" }), true);
  assert.deepEqual(reg.snapshot(), [{ id: "t1", url: "https://x/", title: "X" }]);
  assert.equal(reg.update({}, { title: "unknown page" }), false);
});

test("pages it does not know are ignored", () => {
  const reg = new TabRegistry();
  assert.equal(reg.navigated({}), false);
  assert.equal(reg.remove({}), false);
  assert.equal(reg.idOf({}), null);
  assert.equal(reg.pageOf("t9"), null);
});
