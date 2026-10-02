import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ViewerServer } from "../lib/viewers.mjs";

/**
 * @typedef {import("../lib/viewers.mjs").Viewer} Viewer
 * @typedef {import("../lib/protocol.mjs").ViewerMessage} ViewerMessage
 */

/**
 * A viewer server on a private temporary socket, recording what it hears.
 * @param {import("node:test").TestContext} t
 * @param {Partial<ConstructorParameters<typeof ViewerServer>[0]>} [hooks]
 */
async function serve(t, hooks = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "tl-browser-viewers-"));
  /** @type {Viewer[]} */
  const hellos = [];
  /** @type {[Viewer, ViewerMessage][]} */
  const messages = [];
  /** @type {Viewer[]} */
  const gone = [];
  /** @type {string[]} */
  const released = [];
  const server = new ViewerServer({
    onHello: (v) => hellos.push(v),
    onMessage: (v, m) => messages.push([v, m]),
    onGone: (v) => gone.push(v),
    onRelease: (user) => {
      released.push(user);
      return { t: "control", holder: null, holderId: null, since: null, lapseAt: null };
    },
    ...hooks,
  });
  const file = await server.listen(path.join(dir, "sock"), "s1");
  t.after(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { server, file, hellos, messages, gone, released };
}

/**
 * @param {string} file
 * @returns {Promise<net.Socket>}
 */
async function connect(file) {
  const sock = net.connect(file);
  await new Promise((resolve, reject) => sock.once("connect", resolve).once("error", reject));
  return sock;
}

/**
 * @param {() => boolean} cond
 * @param {string} what
 */
async function until(cond, what) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("each connection gets an id of its own, even for the same person", async (t) => {
  const { hellos } = await serve(t).then(async (s) => {
    const a = await connect(s.file);
    const b = await connect(s.file);
    t.after(() => {
      a.destroy();
      b.destroy();
    });
    a.write('{"t":"hello","user":"viktor","canControl":true}\n');
    b.write('{"t":"hello","user":"viktor","canControl":true}\n');
    await until(() => s.hellos.length === 2, "two hellos");
    return s;
  });
  const [a, b] = hellos;
  assert.equal(a.user, "viktor");
  assert.equal(b.user, "viktor");
  assert.match(a.id, /^[0-9a-f]{16}$/);
  assert.match(b.id, /^[0-9a-f]{16}$/);
  assert.notEqual(a.id, b.id);
});

/**
 * Everything a socket receives until the host ends it.
 * @param {net.Socket} sock
 * @returns {Promise<string>}
 */
function readToEnd(sock) {
  return new Promise((resolve) => {
    let got = "";
    sock.on("data", (d) => {
      got += d;
    });
    sock.once("close", () => resolve(got));
  });
}

test("a release as a connection's first line frees that user's control, answers, and ends", async (t) => {
  const s = await serve(t);
  const sock = await connect(s.file);
  const reply = readToEnd(sock);
  sock.write('{"t":"release","user":"anca"}\n');
  assert.equal(
    await reply,
    '{"t":"control","holder":null,"holderId":null,"since":null,"lapseAt":null}\n',
  );
  assert.deepEqual(s.released, ["anca"]);
  assert.equal(s.hellos.length, 0, "a release connection is not a viewer");
  assert.equal(s.server.viewers.size, 0);
});

test("nothing after a release line is read, not even a hello", async (t) => {
  const s = await serve(t);
  const sock = await connect(s.file);
  sock.write('{"t":"release","user":"anca"}\n');
  // The hello goes in a write of its own, after the answer, so it reaches the
  // host as a later chunk on the half-closed connection.
  await new Promise((resolve) => sock.once("data", resolve));
  sock.write('{"t":"hello","user":"anca","canControl":true}\n');
  await new Promise((resolve) => sock.once("close", resolve));
  assert.deepEqual(s.released, ["anca"]);
  assert.equal(s.hellos.length, 0);
});

test("a release sent after the hello is viewer traffic, and is ignored", async (t) => {
  const s = await serve(t);
  const sock = await connect(s.file);
  t.after(() => sock.destroy());
  sock.write('{"t":"hello","user":"viktor","canControl":true}\n');
  sock.write('{"t":"release","user":"anca"}\n{"t":"takeControl"}\n');
  await until(() => s.messages.length === 1, "the message after it");
  assert.deepEqual(s.released, []);
  assert.deepEqual(
    s.messages.map(([, m]) => m),
    [{ t: "takeControl" }],
    "the release reached nothing, the next message still did",
  );
});

test("a first line that is neither a hello nor a release ends the connection", async (t) => {
  const s = await serve(t);
  const sock = await connect(s.file);
  const reply = readToEnd(sock);
  sock.write('{"t":"takeControl"}\n');
  assert.equal(await reply, "");
  assert.deepEqual(s.released, []);
  assert.equal(s.hellos.length, 0);
});

test("cursor messages of every kind are dropped for a viewer that has not caught up", () => {
  const server = new ViewerServer({
    onHello: () => {},
    onMessage: () => {},
    onGone: () => {},
    onRelease: () => ({ t: "control", holder: null, holderId: null, since: null, lapseAt: null }),
  });
  /** @type {string[]} */
  const written = [];
  const socket = { destroyed: false, writableLength: 0, write: (/** @type {string} */ s) => written.push(s) };
  const v = /** @type {Viewer} */ (/** @type {unknown} */ ({ socket }));
  for (const kind of /** @type {const} */ (["move", "down", "up", "click"])) {
    socket.writableLength = 0;
    server.sendCursor(v, { t: "cursor", tab: "1", x: 1, y: 1, kind });
    socket.writableLength = 5_000_000;
    server.sendCursor(v, { t: "cursor", tab: "1", x: 2, y: 2, kind });
  }
  assert.equal(written.length, 4, "one of each kind while caught up, none while behind");
});
