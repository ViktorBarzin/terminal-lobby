import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_LABEL,
  MAX_MESSAGE,
  MAX_OPTIONS,
  MAX_VALUE,
  PopupBoard,
  checkChoice,
  describeSelectInPage,
  dialogText,
  selectOpens,
} from "../lib/popups.mjs";

/** @param {string} tab */
const select = (tab) => ({
  kind: /** @type {const} */ ("select"),
  msg: { t: "popup", kind: "select", tab, options: [], multiple: false, rect: { x: 0, y: 0, w: 1, h: 1 } },
});
/** @param {string} tab */
const dialog = (tab) => ({
  kind: /** @type {const} */ ("dialog"),
  msg: { t: "popup", kind: "dialog", tab, type: "alert", message: "hi", defaultValue: "" },
});

test("a tab holds one popup, and a new one replaces it", () => {
  const b = new PopupBoard();
  const first = select("t1");
  assert.equal(b.set(first), null);
  const second = dialog("t1");
  assert.equal(b.set(second), first, "the replaced popup comes back so it can be let go");
  assert.equal(b.get("t1"), second);
  assert.deepEqual(b.all(), [second]);
});

test("an answer goes to the popup on the tab it names, or on the viewer's tab", () => {
  const b = new PopupBoard();
  const s1 = select("t1");
  const d2 = dialog("t2");
  b.set(s1);
  b.set(d2);
  assert.equal(b.find("select", "t1"), s1);
  assert.equal(b.find("dialog", "t2"), d2);
  assert.equal(b.find("dialog", "t1"), d2, "the only dialog, wherever it is");
  assert.equal(b.find("select", null), s1);
});

test("an answer that could mean two popups means none", () => {
  const b = new PopupBoard();
  b.set(dialog("t1"));
  b.set(dialog("t2"));
  assert.equal(b.find("dialog", "t3"), null);
  assert.equal(b.find("dialog", null), null);
  assert.equal(b.find("select", "t1"), null);
});

test("taking a popup removes it only when it is still the one there", () => {
  const b = new PopupBoard();
  const s = select("t1");
  b.set(s);
  assert.equal(b.take(dialog("t1")), false);
  assert.equal(b.take(s), true);
  assert.equal(b.get("t1"), null);
  assert.equal(b.take(s), false);
});

test("dropping a kind, and closed tabs, removes their popups", () => {
  const b = new PopupBoard();
  const s1 = select("t1");
  const d2 = dialog("t2");
  const s3 = select("t3");
  b.set(s1);
  b.set(d2);
  b.set(s3);
  assert.deepEqual(b.drop("select"), [s1, s3]);
  assert.deepEqual(b.all(), [d2]);
  b.set(s3);
  assert.deepEqual(b.prune(new Set(["t3"])), [d2]);
  assert.deepEqual(b.all(), [s3]);
});

const options = [
  { value: "a", label: "A", selected: true, disabled: false },
  { value: "b", label: "B", selected: false, disabled: false },
  { value: "c", label: "C", selected: false, disabled: true },
  { value: "", label: "None", selected: false, disabled: false },
];

test("a choice picks enabled options the list offers", () => {
  assert.deepEqual(checkChoice({ options, multiple: false }, { t: "choose", value: "b" }), ["b"]);
  assert.deepEqual(checkChoice({ options, multiple: false }, { t: "choose", value: "" }), [""]);
  assert.deepEqual(checkChoice({ options, multiple: true }, { t: "choose", values: ["a", "b"] }), [
    "a",
    "b",
  ]);
  assert.deepEqual(checkChoice({ options, multiple: true }, { t: "choose", values: [] }), []);
  assert.deepEqual(
    checkChoice({ options, multiple: true }, { t: "choose", value: "a" }),
    ["a"],
    "one value is a choice of one in a multiple list too",
  );
});

test("a choice outside the list, of a disabled option, or of several in a single list is refused", () => {
  assert.equal(checkChoice({ options, multiple: false }, { t: "choose", value: "z" }), null);
  assert.equal(checkChoice({ options, multiple: false }, { t: "choose", value: "c" }), null);
  assert.equal(checkChoice({ options, multiple: false }, { t: "choose", values: ["a", "b"] }), null);
  assert.equal(checkChoice({ options, multiple: false }, { t: "choose", values: [] }), null);
  assert.equal(checkChoice({ options, multiple: true }, { t: "choose", values: ["a", "c"] }), null);
});

test("a select opens a list for a click or a press, never for a move or a release", () => {
  assert.equal(selectOpens({ t: "mouse", type: "down", x: 1, y: 1, button: "left", clickCount: 1 }), true);
  assert.equal(selectOpens({ t: "mouse", type: "click", x: 1, y: 1, button: "left", clickCount: 1 }), true);
  assert.equal(selectOpens({ t: "mouse", type: "up", x: 1, y: 1, button: "left", clickCount: 1 }), false);
  assert.equal(selectOpens({ t: "mouse", type: "move", x: 1, y: 1, button: "left", clickCount: 0 }), false);
  assert.equal(selectOpens({ t: "mouse", type: "down", x: 1, y: 1, button: "right", clickCount: 1 }), false);
  assert.equal(selectOpens({ t: "insertText", text: "a" }), false);
});

test("a dialog's message and default value are cut to their caps", () => {
  assert.equal(MAX_MESSAGE, 4096);
  assert.equal(MAX_VALUE, 1024);
  assert.deepEqual(dialogText("Leave?", "Ada"), { message: "Leave?", defaultValue: "Ada" });
  const long = dialogText("m".repeat(10_000), "d".repeat(5000));
  assert.equal(long.message, "m".repeat(4096));
  assert.equal(long.defaultValue, "d".repeat(1024));
  const exact = dialogText("m".repeat(4096), "d".repeat(1024));
  assert.equal(exact.message.length, 4096);
  assert.equal(exact.defaultValue.length, 1024);
});

test("a cut never leaves half of a surrogate pair at the end", () => {
  const emoji = "\u{1F600}";
  const { message, defaultValue } = dialogText(`${"m".repeat(4095)}${emoji}`, `${"d".repeat(1023)}${emoji}`);
  assert.equal(message, "m".repeat(4095));
  assert.equal(defaultValue, "d".repeat(1023));
});

/**
 * A stand-in for a select element, enough for describeSelectInPage.
 * @param {{ value: string, label?: string, disabled?: boolean, selected?: boolean }[]} opts
 */
function fakeSelect(opts) {
  return /** @type {HTMLSelectElement} */ (
    /** @type {unknown} */ ({
      multiple: false,
      getBoundingClientRect: () => ({ x: 1, y: 2, width: 3, height: 4 }),
      options: opts.map((o) => ({
        value: o.value,
        label: o.label ?? o.value,
        text: o.label ?? o.value,
        selected: o.selected ?? false,
        disabled: o.disabled ?? false,
        parentElement: null,
      })),
    })
  );
}

test("an option value over the cap is cut and cannot be chosen", (t) => {
  // @ts-ignore a page global the function reads, absent in Node
  globalThis.HTMLOptGroupElement = class {};
  // @ts-ignore
  t.after(() => delete globalThis.HTMLOptGroupElement);
  const limits = { maxOptions: MAX_OPTIONS, maxLabel: MAX_LABEL, maxValue: MAX_VALUE };
  const desc = describeSelectInPage(
    fakeSelect([
      { value: "short", selected: true },
      { value: "v".repeat(1024), label: "exactly at the cap" },
      { value: "v".repeat(1025), label: "one over" },
    ]),
    limits,
  );
  assert.deepEqual(desc.options, [
    { value: "short", label: "short", selected: true, disabled: false },
    { value: "v".repeat(1024), label: "exactly at the cap", selected: false, disabled: false },
    { value: "v".repeat(1024), label: "one over", selected: false, disabled: true },
  ]);
  assert.deepEqual(
    checkChoice(desc, { t: "choose", value: "v".repeat(1024) }),
    ["v".repeat(1024)],
    "the value that fits picks its own option",
  );
  const cutOnly = describeSelectInPage(fakeSelect([{ value: "w".repeat(2000) }]), limits);
  assert.equal(
    checkChoice(cutOnly, { t: "choose", value: "w".repeat(1024) }),
    null,
    "a cut value never stands in for the real one",
  );
});
