import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LineSplitter,
  normalizeUrl,
  parseViewerHello,
  parseViewerMessage,
  socketDir,
  socketName,
} from "../lib/protocol.mjs";

test("the viewer hello carries the user and whether they may control", () => {
  assert.deepEqual(parseViewerHello('{"t":"hello","user":"viktor","canControl":true}'), {
    user: "viktor",
    canControl: true,
  });
  assert.deepEqual(parseViewerHello('{"t":"hello","user":"anca","canControl":false}'), {
    user: "anca",
    canControl: false,
  });
});

test("a hello missing or mistyping a field is refused", () => {
  for (const line of [
    "",
    "nope",
    "[]",
    '{"t":"subscribe","tab":null}',
    '{"t":"hello","canControl":true}',
    '{"t":"hello","user":"","canControl":true}',
    '{"t":"hello","user":"viktor"}',
    '{"t":"hello","user":"viktor","canControl":"yes"}',
    '{"t":"hello","user":7,"canControl":true}',
  ]) {
    assert.equal(parseViewerHello(line), null, line);
  }
});

const valid = [
  { t: "subscribe", tab: null },
  { t: "subscribe", tab: "t2" },
  { t: "unsubscribe" },
  { t: "selectTab", tab: "t1" },
  { t: "mouse", type: "move", x: 10, y: 20, button: "left", clickCount: 0 },
  { t: "mouse", type: "click", x: 10.5, y: 20, button: "right", clickCount: 2 },
  { t: "mouse", type: "down", x: 0, y: 0, button: "middle", clickCount: 1 },
  { t: "wheel", x: 1, y: 2, dx: 0, dy: -120 },
  { t: "key", type: "press", key: "Enter" },
  { t: "key", type: "down", key: "a" },
  { t: "insertText", text: "hello" },
  { t: "navigate", url: "https://example.com" },
  { t: "back" },
  { t: "forward" },
  { t: "reload" },
  { t: "copy" },
  { t: "takeControl" },
  { t: "handBack" },
  { t: "choose", value: "b" },
  { t: "choose", value: "" },
  { t: "choose", value: "b", tab: "t2" },
  { t: "choose", values: ["a", "c"] },
  { t: "choose", values: [] },
  { t: "dialog", accept: true },
  { t: "dialog", accept: false },
  { t: "dialog", accept: true, text: "an answer" },
  { t: "dialog", accept: true, text: "" },
  { t: "dialog", accept: false, tab: "t1" },
];

for (const msg of valid) {
  test(`${JSON.stringify(msg)} is accepted as sent`, () => {
    assert.deepEqual(parseViewerMessage(JSON.stringify(msg)), msg);
  });
}

test("a mouse message without button or clickCount gets the defaults", () => {
  assert.deepEqual(parseViewerMessage('{"t":"mouse","type":"click","x":1,"y":2}'), {
    t: "mouse",
    type: "click",
    x: 1,
    y: 2,
    button: "left",
    clickCount: 1,
  });
});

test("unknown fields are dropped rather than passed on", () => {
  assert.deepEqual(parseViewerMessage('{"t":"back","evil":1}'), { t: "back" });
});

const invalid = [
  "",
  "not json",
  "null",
  "42",
  '{"t":"nope"}',
  '{"tab":"t1"}',
  '{"t":"hello","user":"x","canControl":true}',
  '{"t":"subscribe","tab":5}',
  '{"t":"selectTab"}',
  '{"t":"selectTab","tab":null}',
  '{"t":"mouse","type":"wiggle","x":1,"y":1}',
  '{"t":"mouse","type":"click","x":"1","y":1}',
  '{"t":"mouse","type":"click","x":1}',
  '{"t":"mouse","type":"click","x":1,"y":1,"button":"thumb"}',
  '{"t":"mouse","type":"click","x":1,"y":1,"clickCount":-1}',
  '{"t":"mouse","type":"click","x":1,"y":1,"clickCount":1.5}',
  '{"t":"mouse","type":"click","x":1e400,"y":1}',
  '{"t":"wheel","x":1,"y":1,"dx":1}',
  '{"t":"key","type":"press"}',
  '{"t":"key","type":"tap","key":"a"}',
  '{"t":"key","type":"press","key":""}',
  `{"t":"key","type":"press","key":"${"a".repeat(65)}"}`,
  '{"t":"insertText"}',
  '{"t":"insertText","text":5}',
  '{"t":"navigate"}',
  '{"t":"navigate","url":""}',
  '{"t":"choose"}',
  '{"t":"choose","value":5}',
  '{"t":"choose","value":null}',
  '{"t":"choose","value":"a","values":["a"]}',
  '{"t":"choose","values":"a"}',
  '{"t":"choose","values":["a",1]}',
  '{"t":"choose","value":"a","tab":""}',
  '{"t":"choose","value":"a","tab":7}',
  '{"t":"dialog"}',
  '{"t":"dialog","accept":"yes"}',
  '{"t":"dialog","accept":true,"text":5}',
  '{"t":"dialog","accept":true,"tab":null}',
];

for (const line of invalid) {
  test(`${line.slice(0, 60) || "(empty)"} is refused`, () => {
    assert.equal(parseViewerMessage(line), null);
  });
}

test("a pasted text over the limit is refused", () => {
  const big = JSON.stringify({ t: "insertText", text: "x".repeat(1_000_001) });
  assert.equal(parseViewerMessage(big), null);
});

test("a choice over the limits is refused", () => {
  const longValue = JSON.stringify({ t: "choose", value: "x".repeat(1_000_001) });
  assert.equal(parseViewerMessage(longValue), null);
  const many = JSON.stringify({ t: "choose", values: Array.from({ length: 10_001 }, (_, i) => `${i}`) });
  assert.equal(parseViewerMessage(many), null);
  const longText = JSON.stringify({ t: "dialog", accept: true, text: "x".repeat(1_000_001) });
  assert.equal(parseViewerMessage(longText), null);
});

test("the URL bar accepts a bare host and refuses schemes that reach outside the web", () => {
  assert.equal(normalizeUrl("https://example.com/a?b=c"), "https://example.com/a?b=c");
  assert.equal(normalizeUrl("http://localhost:8080/"), "http://localhost:8080/");
  assert.equal(normalizeUrl("example.com"), "https://example.com/");
  assert.equal(normalizeUrl("  example.com/path  "), "https://example.com/path");
  assert.equal(normalizeUrl("about:blank"), "about:blank");
  assert.equal(normalizeUrl("file:///etc/passwd"), null);
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("chrome://settings"), null);
  assert.equal(normalizeUrl("data:text/html,hi"), null);
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl("   "), null);
});

test("the socket is named after the tmux session id, or the pid outside tmux", () => {
  assert.equal(socketName("$12", 99), "s12");
  assert.equal(socketName("$0", 99), "s0");
  assert.equal(socketName(null, 99), "pid-99");
  assert.equal(socketName("", 99), "pid-99");
  assert.equal(socketName("$../x", 99), "pid-99", "anything but a plain id falls back to the pid");
});

test("the socket lives in the runtime dir, or a per-uid dir under /tmp", () => {
  assert.equal(socketDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, 1000), "/run/user/1000/tl-browser");
  assert.equal(socketDir({}, 1000), "/tmp/tl-browser-1000");
  assert.equal(socketDir({ XDG_RUNTIME_DIR: "" }, 1001), "/tmp/tl-browser-1001");
});

test("lines are split across chunks and the trailing part waits for its newline", () => {
  const s = new LineSplitter(100);
  assert.deepEqual(s.push('{"a":1}\n{"b"'), ['{"a":1}']);
  assert.deepEqual(s.push(":2}\n\n"), ['{"b":2}']);
  assert.deepEqual(s.push(Buffer.from("x\r\ny\n")), ["x", "y"]);
});

test("a line longer than the limit throws", () => {
  const s = new LineSplitter(10);
  assert.throws(() => s.push("0123456789abc"), /too long/);
});

test("a multi-byte character split across chunks survives", () => {
  const s = new LineSplitter(100);
  const bytes = Buffer.from("é\n");
  assert.deepEqual(s.push(bytes.subarray(0, 1)), []);
  assert.deepEqual(s.push(bytes.subarray(1)), ["é"]);
});
