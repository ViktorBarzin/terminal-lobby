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
  const server = new ViewerServer({
    onHello: (v) => hellos.push(v),
    onMessage: (v, m) => messages.push([v, m]),
    onGone: (v) => gone.push(v),
    ...hooks,
  });
  const file = await server.listen(path.join(dir, "sock"), "s1");
  t.after(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { server, file, hellos, messages, gone };
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
