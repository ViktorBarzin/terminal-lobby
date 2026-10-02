// One end-to-end run against real headless Chrome: MCP over stdio on one
// side, a viewer on the socket on the other. Needs Google Chrome installed
// (channel "chrome"); skipped when it is not.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REFUSAL_TEXT } from "../lib/gate.mjs";
import { LineSplitter } from "../lib/protocol.mjs";
import { treePids } from "../lib/proctree.mjs";

const host = fileURLToPath(new URL("../host.mjs", import.meta.url));
const haveChrome = existsSync("/opt/google/chrome/chrome") || existsSync("/usr/bin/google-chrome");

/** The first call starts Chrome, which takes over a minute on a loaded box. */
const CALL_TIMEOUT_MS = 180_000;
/** Room for one Chrome start and the calls after it. */
const TEST_TIMEOUT_MS = 300_000;

const PAGE = `data:text/html,${encodeURIComponent(
  "<title>Hello page</title>" +
    '<input id="q" style="position:absolute;left:0;top:0;width:300px;height:40px">' +
    '<h1 style="margin-top:60px">Hello</h1>',
)}`;

/**
 * @typedef {import("../lib/protocol.mjs").HostMessage} HostMessage
 * @typedef {import("../lib/gate.mjs").JsonRpcMessage} JsonRpcMessage
 */

/**
 * Reads newline-delimited JSON from a stream and lets a test wait for the
 * next message that matches.
 * @template {object} M
 */
class Lines {
  /** @type {M[]} */
  seen = [];
  /** @type {{ match: (m: M) => boolean, resolve: (m: M) => void }[]} */
  #waiters = [];

  /** @param {NodeJS.ReadableStream} stream */
  constructor(stream) {
    const split = new LineSplitter(64_000_000);
    stream.on("data", (chunk) => {
      for (const line of split.push(chunk)) {
        const msg = JSON.parse(line);
        const w = this.#waiters.findIndex((x) => x.match(msg));
        if (w >= 0) this.#waiters.splice(w, 1)[0].resolve(msg);
        else this.seen.push(msg);
      }
    });
  }

  /**
   * @param {(m: M) => boolean} match
   * @param {string} what
   * @param {number} [timeout]
   * @returns {Promise<M>}
   */
  next(match, what, timeout = 20_000) {
    const i = this.seen.findIndex(match);
    if (i >= 0) return Promise.resolve(this.seen.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeout);
      this.#waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }
}

/**
 * @param {number} pid
 * @returns {string} the process state letter from /proc, e.g. "S" or "T"
 */
function procState(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
}

/**
 * Starts a host the way the launcher does, with its own HOME and runtime dir,
 * and gets it through the MCP handshake.
 * @param {import("node:test").TestContext} t
 * @param {Record<string, string>} env
 */
async function startHost(t, env) {
  const tmp = mkdtempSync(path.join(tmpdir(), "tl-browser-it-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const child = spawn(process.execPath, [host], {
    env: {
      PATH: process.env.PATH,
      HOME: tmp,
      XDG_RUNTIME_DIR: tmp,
      TL_BROWSER_STORAGE_STATE: "",
      ...env,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => child.kill("SIGKILL"));
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  /** @type {Lines<JsonRpcMessage>} */
  const mcp = new Lines(child.stdout);
  let nextId = 1;
  /**
   * @param {string} method
   * @param {object} [params]
   */
  const request = async (method, params) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return mcp.next((m) => m.id === id, `${method} #${id}`, CALL_TIMEOUT_MS);
  };
  /**
   * @param {string} name
   * @param {object} [args]
   */
  const callTool = async (name, args = {}) =>
    (await request("tools/call", { name, arguments: args })).result;

  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "integration-test", version: "1" },
  });
  assert.match(init.result.instructions, /browser_close/);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const sockPath = path.join(tmp, "tl-browser", `pid-${child.pid}.sock`);
  return { child, exited, callTool, sockPath };
}

/**
 * Connects to the viewer socket as session-events would for one person.
 * @param {string} sockPath
 * @param {string} user
 * @param {boolean} canControl
 */
async function connectViewer(sockPath, user, canControl) {
  const sock = net.connect(sockPath);
  await new Promise((resolve, reject) => sock.once("connect", resolve).once("error", reject));
  /** @type {Lines<HostMessage>} */
  const view = new Lines(sock);
  /** @param {object} msg */
  const send = (msg) => sock.write(`${JSON.stringify(msg)}\n`);
  send({ t: "hello", user, canControl });
  const hello = await view.next((m) => m.t === "hello", `${user}'s hello`);
  return { sock, view, send, hello };
}

test("a session browser end to end", {
  skip: !haveChrome && "Google Chrome is not installed",
  timeout: 90_000,
}, async (t) => {
  const { child, exited, callTool, sockPath } = await startHost(t, {
    TL_BROWSER_IDLE_FREEZE_MS: "1500",
  });

  const nav = await callTool("browser_navigate", { url: PAGE });
  assert.notEqual(nav.isError, true, JSON.stringify(nav));

  assert.ok(existsSync(sockPath), "the viewer socket exists once Chrome runs");
  assert.equal(statSync(sockPath).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(sockPath)).mode & 0o777, 0o700);

  const { view, send, hello } = await connectViewer(sockPath, "tester", true);
  assert.equal(hello.state, "live");
  assert.equal(hello.tabs.length, 1);
  assert.equal(hello.agentTab, hello.tabs[0].id);
  assert.equal(hello.tabs[0].title, "Hello page");
  assert.deepEqual(hello.control, { holder: null, holderId: null, since: null, lapseAt: null });
  assert.match(hello.you, /^[0-9a-f]{16}$/, "the host names this connection");
  assert.deepEqual(hello.viewport, { w: 1280, h: 800 });
  const replayed = await view.next((m) => m.t === "activity", "the latest activity");
  assert.equal(replayed.summary, "Loading a page");

  send({ t: "subscribe", tab: null });
  const frame = await view.next((m) => m.t === "frame", "a frame");
  assert.equal(frame.tab, hello.agentTab);
  assert.ok(
    Buffer.from(frame.jpeg, "base64")
      .subarray(0, 2)
      .equals(Buffer.from([0xff, 0xd8])),
    "a JPEG",
  );
  assert.deepEqual([frame.w, frame.h], [1280, 800]);

  // A watch-only viewer sees frames but cannot take control or type.
  const ro = await connectViewer(sockPath, "watcher", false);
  const roView = ro.view;
  ro.send({ t: "subscribe", tab: null });
  await roView.next((m) => m.t === "frame", "a frame for the watch-only viewer");
  ro.send({ t: "takeControl" });
  ro.send({ t: "insertText", text: "nope" });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    [...view.seen, ...roView.seen].some((m) => m.t === "control" || m.t === "error"),
    false,
    "a watch-only viewer changes nothing and is not answered",
  );
  ro.sock.destroy();

  // Input without control is refused.
  send({ t: "insertText", text: "nope" });
  await view.next((m) => m.t === "error", "a refusal of input without control");

  send({ t: "takeControl" });
  const taken = await view.next((m) => m.t === "control", "control taken");
  assert.equal(taken.holder, "tester");
  assert.equal(taken.holderId, hello.you);

  const refused = await callTool("browser_snapshot");
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0].text, REFUSAL_TEXT);

  // The same person on a second device takes control over from the first.
  const phone = await connectViewer(sockPath, "tester", true);
  assert.notEqual(phone.hello.you, hello.you, "each connection has its own id");
  assert.equal(phone.hello.control.holderId, hello.you);
  phone.send({ t: "takeControl" });
  const moved = await view.next(
    (m) => m.t === "control" && m.holderId === phone.hello.you,
    "control moved to the second device",
  );
  assert.equal(moved.holder, "tester");
  send({ t: "insertText", text: "from the laptop" });
  await view.next((m) => m.t === "error", "the first device's input refused once control moved");

  // The holding device goes away: control stays, so the agent is still held
  // off, and the person resumes it from the first device.
  phone.sock.destroy();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await callTool("browser_snapshot")).isError, true, "control outlives its connection");
  send({ t: "takeControl" });
  await view.next(
    (m) => m.t === "control" && m.holderId === hello.you,
    "control resumed on the first device",
  );

  // session-events frees a user's control with a release as the first line
  // of a connection of its own. Inside a viewer's stream it does nothing.
  send({ t: "release", user: "tester" });
  /** @param {string} user */
  const release = async (user) => {
    const sock = net.connect(sockPath);
    let got = "";
    sock.on("data", (d) => {
      got += d;
    });
    sock.write(`${JSON.stringify({ t: "release", user })}\n`);
    await new Promise((resolve) => sock.once("close", resolve));
    return JSON.parse(got);
  };
  const notTheirs = await release("someone-else");
  assert.equal(notTheirs.holderId, hello.you, "another user's release leaves control alone");
  assert.equal((await release("tester")).holder, null);
  await view.next((m) => m.t === "control" && m.holder === null, "control released");
  assert.notEqual((await callTool("browser_snapshot")).isError, true, "the agent drives again");
  send({ t: "takeControl" });
  await view.next((m) => m.t === "control" && m.holderId === hello.you, "control taken again");

  // Type into the page as the person in control, then copy it back out.
  send({ t: "mouse", type: "click", x: 100, y: 20, button: "left", clickCount: 1 });
  send({ t: "insertText", text: "typed by a person" });
  send({ t: "key", type: "press", key: "Control+a" });
  send({ t: "copy" });
  const copied = await view.next((m) => m.t === "copied", "copied text");
  assert.equal(copied.text, "typed by a person");

  send({ t: "handBack" });
  const back = await view.next(
    (m) => m.t === "control" && m.holder === null,
    "control handed back",
  );
  assert.equal(back.since, null);

  const snap = await callTool("browser_snapshot");
  assert.notEqual(snap.isError, true, JSON.stringify(snap));
  assert.match(
    JSON.stringify(snap.content),
    /typed by a person/,
    "the agent sees what the person typed",
  );
  const activity = await view.next(
    (m) => m.t === "activity" && m.tool === "browser_snapshot",
    "activity",
  );
  assert.equal(activity.summary, "Reading the page");

  // Nobody watching and nothing running: it freezes.
  send({ t: "unsubscribe" });
  await view.next((m) => m.t === "state" && m.state === "frozen", "frozen", 10_000);
  const chrome = treePids(child.pid).filter((pid) => pid !== child.pid);
  assert.ok(chrome.length > 0, "Chrome runs under the host");
  for (const pid of chrome) {
    try {
      assert.equal(procState(pid), "T", `process ${pid} is stopped`);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") throw err;
    }
  }

  // A tool call wakes it first.
  const woke = await callTool("browser_snapshot");
  assert.notEqual(woke.isError, true, JSON.stringify(woke));
  await view.next((m) => m.t === "state" && m.state === "live", "live again");

  // The agent opens a tab: it becomes the agent's tab, and a viewer that
  // follows the agent is moved onto it.
  send({ t: "subscribe", tab: null });
  await view.next(
    (m) => m.t === "frame" && m.tab === hello.agentTab,
    "a frame after resubscribing",
  );
  const opened = await callTool("browser_tabs", { action: "new" });
  assert.notEqual(opened.isError, true, JSON.stringify(opened));
  const tabs = await view.next((m) => m.t === "tabs" && m.tabs.length === 2, "two tabs");
  assert.notEqual(tabs.agentTab, hello.agentTab);
  await view.next((m) => m.t === "frame" && m.tab === tabs.agentTab, "a frame of the new tab");
  send({ t: "selectTab", tab: hello.agentTab });
  await view.next((m) => m.t === "frame" && m.tab === hello.agentTab, "a frame of the chosen tab");

  const closed = await callTool("browser_close");
  assert.notEqual(closed.isError, true, JSON.stringify(closed));
  assert.equal(await exited, 0);
  await view.next((m) => m.t === "state" && m.state === "closed", "closed");
  assert.equal(existsSync(sockPath), false, "the socket is removed");
  for (let i = 0; i < 20 && chrome.some((pid) => existsSync(`/proc/${pid}`)); i++)
    await new Promise((r) => setTimeout(r, 100));
  for (const pid of chrome)
    assert.equal(existsSync(`/proc/${pid}`), false, `Chrome process ${pid} is gone`);
});

const POPUP_PAGE = `data:text/html,${encodeURIComponent(
  "<title>Popups</title>" +
    '<select id="s" style="position:absolute;left:10px;top:10px;width:200px;height:30px">' +
    '<option value="a">Apple</option><option value="b">Banana</option>' +
    '<option value="c" disabled>Cherry</option></select>' +
    '<button id="al" style="position:absolute;left:10px;top:100px;width:100px;height:30px"' +
    " onclick=\"alert('Saved');log.push('alert')\">alert</button>" +
    '<button id="pr" style="position:absolute;left:10px;top:150px;width:100px;height:30px"' +
    " onclick=\"log.push('prompt:'+prompt('Your name?','Ada'))\">prompt</button>" +
    '<input id="f" type="file" style="position:absolute;left:10px;top:200px;width:200px;height:30px">' +
    "<script>window.log=[];s.addEventListener('input',()=>log.push('input:'+s.value));" +
    "s.addEventListener('change',()=>log.push('change:'+s.value))</script>",
)}`;

/**
 * @param {(msg: object) => void} send
 * @param {number} x
 * @param {number} y
 */
function press(send, x, y) {
  send({ t: "mouse", type: "down", x, y, button: "left", clickCount: 1 });
  send({ t: "mouse", type: "up", x, y, button: "left", clickCount: 1 });
}

/** @param {{ content?: { text?: string }[] }} result */
const resultText = (result) => (result.content ?? []).map((c) => c.text ?? "").join("\n");

test("a person in control answers the popups a frame does not show", {
  skip: !haveChrome && "Google Chrome is not installed",
  timeout: 90_000,
}, async (t) => {
  const { callTool, sockPath } = await startHost(t, {});
  const nav = await callTool("browser_navigate", { url: POPUP_PAGE });
  assert.notEqual(nav.isError, true, JSON.stringify(nav));

  const { view, send, hello } = await connectViewer(sockPath, "tester", true);
  const tab = hello.agentTab;
  const ro = await connectViewer(sockPath, "watcher", false);

  // With the agent in control, a dialog is playwright-mcp's, as it always was.
  const raised = await callTool("browser_evaluate", {
    function: "() => { setTimeout(() => alert('from the agent'), 0); return 1; }",
  });
  assert.notEqual(raised.isError, true, JSON.stringify(raised));
  let handled;
  for (let i = 0; i < 30; i++) {
    handled = await callTool("browser_handle_dialog", { accept: true });
    if (handled.isError !== true) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.notEqual(handled?.isError, true, JSON.stringify(handled));

  // A dialog left open for the agent goes to the person who takes control.
  await callTool("browser_evaluate", {
    function: "() => { setTimeout(() => log.push('confirm:' + confirm('Leave?')), 0); return 1; }",
  });
  for (let i = 0; i < 30; i++) {
    const r = await callTool("browser_snapshot");
    if (r.isError === true && /modal state/.test(resultText(r))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  send({ t: "takeControl" });
  await view.next((m) => m.t === "control" && m.holder === "tester", "control taken");
  const confirmed = await view.next((m) => m.t === "popup", "the pending confirm");
  assert.deepEqual(confirmed, {
    t: "popup",
    kind: "dialog",
    tab,
    type: "confirm",
    message: "Leave?",
    defaultValue: "",
  });

  // The same person's second device takes control: the dialog moves to it,
  // and the first device is told it is gone. Taking it back moves it again.
  const phone = await connectViewer(sockPath, "tester", true);
  assert.equal(phone.view.seen.some((m) => m.t === "popup"), false, "not yet in control");
  phone.send({ t: "takeControl" });
  assert.deepEqual(await view.next((m) => m.t === "popup", "the confirm leaving the laptop"), {
    t: "popup",
    kind: "none",
    tab,
  });
  assert.deepEqual(await phone.view.next((m) => m.t === "popup", "the confirm on the phone"), confirmed);
  send({ t: "takeControl" });
  assert.deepEqual(await view.next((m) => m.t === "popup", "the confirm back on the laptop"), confirmed);
  assert.equal((await phone.view.next((m) => m.t === "popup", "the confirm leaving the phone")).kind, "none");
  phone.sock.destroy();

  send({ t: "dialog", accept: false });
  assert.deepEqual(await view.next((m) => m.t === "popup", "the confirm gone"), {
    t: "popup",
    kind: "none",
    tab,
  });

  // Pressing the select gets its list; choosing sets it in the page.
  press(send, 50, 25);
  const list = await view.next((m) => m.t === "popup", "the select's list");
  assert.deepEqual(list, {
    t: "popup",
    kind: "select",
    tab,
    multiple: false,
    rect: { x: 10, y: 10, w: 200, h: 30 },
    options: [
      { value: "a", label: "Apple", selected: true, disabled: false },
      { value: "b", label: "Banana", selected: false, disabled: false },
      { value: "c", label: "Cherry", selected: false, disabled: true },
    ],
  });
  send({ t: "choose", value: "c" });
  await view.next((m) => m.t === "error", "a disabled option refused");
  send({ t: "choose", value: "b" });
  assert.equal((await view.next((m) => m.t === "popup", "the list gone")).kind, "none");

  // A press anywhere else closes a list left open, as it does in Chrome.
  press(send, 50, 25);
  const again = await view.next((m) => m.t === "popup", "the list again");
  assert.equal(again.kind, "select");
  assert.equal(again.options[1].selected, true, "the list shows the choice made");
  press(send, 600, 600);
  assert.equal((await view.next((m) => m.t === "popup", "the list closed")).kind, "none");

  // An alert raised by a person's click comes to the panel, and OK closes it.
  press(send, 50, 115);
  const alerted = await view.next((m) => m.t === "popup", "the alert");
  assert.equal(alerted.kind, "dialog");
  assert.equal(alerted.type, "alert");
  assert.equal(alerted.message, "Saved");
  send({ t: "dialog", accept: true });
  assert.equal((await view.next((m) => m.t === "popup", "the alert gone")).kind, "none");

  // A prompt takes the person's text.
  press(send, 50, 165);
  const prompted = await view.next((m) => m.t === "popup", "the prompt");
  assert.equal(prompted.type, "prompt");
  assert.equal(prompted.defaultValue, "Ada");
  send({ t: "dialog", accept: true, text: "Grace" });
  assert.equal((await view.next((m) => m.t === "popup", "the prompt gone")).kind, "none");

  // A file chooser is not supported: the panel is told, and it is cancelled.
  press(send, 50, 215);
  assert.deepEqual(await view.next((m) => m.t === "popup", "the file chooser"), {
    t: "popup",
    kind: "filechooser",
    tab,
  });

  assert.equal(
    ro.view.seen.some((m) => m.t === "popup"),
    false,
    "only the person in control is shown popups",
  );

  send({ t: "handBack" });
  await view.next((m) => m.t === "control" && m.holder === null, "control handed back");

  // Nothing the person answered is left blocking the agent.
  const state = await callTool("browser_evaluate", {
    function: "() => ({ value: document.querySelector('#s').value, log })",
  });
  assert.notEqual(state.isError, true, JSON.stringify(state));
  const text = resultText(state);
  assert.match(text, /"value": "b"/);
  for (const entry of ["confirm:false", "input:b", "change:b", "alert", "prompt:Grace"])
    assert.ok(text.includes(`"${entry}"`), `the page logged ${entry}: ${text}`);
  assert.equal(
    view.seen.some((m) => m.t === "popup"),
    false,
    "no popup came for the agent's own dialog",
  );
});

test("the agent's first calls share one tab, with no empty tab beside it", {
  skip: !haveChrome && "Google Chrome is not installed",
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const { callTool, sockPath } = await startHost(t, {});
  // Two calls in flight before the browser has a page: playwright-mcp opens a
  // page for each one that finds none, so the second used to leave an empty
  // about:blank tab beside the agent's page and make it the current one.
  const [nav, snap] = await Promise.all([
    callTool("browser_navigate", { url: PAGE }),
    callTool("browser_snapshot"),
  ]);
  assert.notEqual(nav.isError, true, JSON.stringify(nav));
  assert.notEqual(snap.isError, true, JSON.stringify(snap));
  const listed = resultText(await callTool("browser_tabs", { action: "list" }));
  assert.doesNotMatch(listed, /about:blank/, listed);

  const { hello } = await connectViewer(sockPath, "tester", true);
  assert.deepEqual(
    hello.tabs.map((tab) => tab.title),
    ["Hello page"],
    "the viewer's tab list shows only the agent's page",
  );
});

test("a person in control keeps it across a reconnect", {
  skip: !haveChrome && "Google Chrome is not installed",
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const { callTool, sockPath } = await startHost(t, {});
  const nav = await callTool("browser_navigate", { url: PAGE });
  assert.notEqual(nav.isError, true, JSON.stringify(nav));

  const first = await connectViewer(sockPath, "tester", true);
  first.send({ t: "takeControl" });
  const taken = await first.view.next(
    (m) => m.t === "control" && m.holderId === first.hello.you,
    "control taken",
  );

  // While the first connection is open, a resume naming it is a second
  // device's, and changes nothing: that takes control explicitly.
  const phone = await connectViewer(sockPath, "tester", true);
  phone.send({ t: "resume", prev: first.hello.you });

  // The connection drops. Another user, and a watch-only viewer, cannot
  // claim it by naming the closed connection.
  first.sock.destroy();
  const other = await connectViewer(sockPath, "someone-else", true);
  other.send({ t: "resume", prev: first.hello.you });
  const watcher = await connectViewer(sockPath, "tester", false);
  watcher.send({ t: "resume", prev: first.hello.you });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    [...phone.view.seen, ...other.view.seen, ...watcher.view.seen].some((m) => m.t === "control"),
    false,
    "control stays with the closed connection",
  );

  // The same person's tab reconnects and names its previous connection.
  const back = await connectViewer(sockPath, "tester", true);
  assert.equal(back.hello.control.holderId, first.hello.you);
  back.send({ t: "resume", prev: first.hello.you });
  const resumed = await back.view.next(
    (m) => m.t === "control" && m.holderId === back.hello.you,
    "control resumed on the new connection",
  );
  assert.equal(resumed.holder, "tester");
  assert.equal(resumed.since, taken.since, "the same person's control, not a new takeover");
  await phone.view.next((m) => m.t === "control" && m.holderId === back.hello.you, "others told");

  const refused = await callTool("browser_snapshot");
  assert.equal(refused.content[0].text, REFUSAL_TEXT, "the agent is still held off");
  back.send({ t: "insertText", text: "still mine" });
  back.send({ t: "copy" });
  await back.view.next((m) => m.t === "copied", "input accepted on the new connection");
  assert.equal(back.view.seen.some((m) => m.t === "error"), false, JSON.stringify(back.view.seen));
});

const CURSOR_PAGE = `data:text/html,${encodeURIComponent(
  "<title>Cursor</title><body style=margin:0>" +
    '<button id="go" style="position:absolute;left:100px;top:200px;width:120px;height:40px"' +
    " onclick=\"this.textContent='clicked'\">Go</button>" +
    '<iframe srcdoc="<body style=margin:0><button>In frame</button></body>"' +
    ' style="position:absolute;left:400px;top:300px;width:300px;height:150px;border:5px solid"></iframe>',
)}`;

test("the agent's clicks and a person's land on one cursor the viewers see", {
  skip: !haveChrome && "Google Chrome is not installed",
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const { callTool, sockPath } = await startHost(t, {});
  const nav = await callTool("browser_navigate", { url: CURSOR_PAGE });
  assert.notEqual(nav.isError, true, JSON.stringify(nav));

  const { view, send, hello } = await connectViewer(sockPath, "tester", true);
  const tab = hello.agentTab;
  send({ t: "subscribe", tab: null });
  await view.next((m) => m.t === "frame", "a frame");

  /**
   * Waits for the cursor's click and returns it with the cursor messages
   * that came before it.
   * @param {string} what
   */
  const untilClick = async (what) => {
    const click = await view.next((m) => m.t === "cursor" && m.kind === "click", what);
    const before = view.seen.filter((m) => m.t === "cursor");
    view.seen = view.seen.filter((m) => m.t !== "cursor");
    return { click, before };
  };

  // The agent clicks the button: the cursor moves to its centre and clicks.
  const clicked = await callTool("browser_click", { element: "Go button", target: "#go" });
  assert.notEqual(clicked.isError, true, JSON.stringify(clicked));
  const agent = await untilClick("the agent's click on the cursor");
  assert.deepEqual(agent.click, { t: "cursor", tab, x: 160, y: 220, kind: "click" });
  const moves = agent.before.filter((m) => m.kind === "move");
  assert.ok(moves.length > 0, "the cursor moved to the button first");
  assert.deepEqual([moves.at(-1)?.x, moves.at(-1)?.y], [160, 220], "the last move ends at its centre");
  assert.deepEqual(
    agent.before.filter((m) => m.kind !== "move").map((m) => m.kind),
    ["down", "up"],
  );

  // A viewer that starts watching is shown where the cursor is.
  const late = await connectViewer(sockPath, "watcher", false);
  late.send({ t: "subscribe", tab: null });
  assert.deepEqual(await late.view.next((m) => m.t === "cursor", "the last cursor on joining"), {
    t: "cursor",
    tab,
    x: 160,
    y: 220,
    kind: "move",
  });

  // A person in control clicks: the same cursor, the same messages.
  send({ t: "takeControl" });
  await view.next((m) => m.t === "control" && m.holderId === hello.you, "control taken");
  send({ t: "mouse", type: "click", x: 300, y: 100, button: "left", clickCount: 1 });
  const person = await untilClick("the person's click on the cursor");
  assert.deepEqual(person.click, { t: "cursor", tab, x: 300, y: 100, kind: "click" });
  assert.deepEqual(
    person.before.map((m) => [m.kind, m.x, m.y]),
    [
      ["move", 300, 100],
      ["down", 300, 100],
      ["up", 300, 100],
    ],
  );
  await late.view.next((m) => m.t === "cursor" && m.kind === "click" && m.x === 300, "the watcher sees it too");

  // Inside a same-origin iframe the position is still in the page's pixels.
  send({ t: "mouse", type: "click", x: 420, y: 320, button: "left", clickCount: 1 });
  const inFrame = await untilClick("a click inside the iframe");
  assert.deepEqual(inFrame.click, { t: "cursor", tab, x: 420, y: 320, kind: "click" });
});
