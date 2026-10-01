// The viewer socket: an owner-only unix socket session-events connects to on
// behalf of a person watching the lobby. Each connection starts with the
// viewer hello session-events writes; until then nothing else is read.

import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { encode, LineSplitter, parseViewerHello, parseViewerMessage } from "./protocol.mjs";

/**
 * @typedef {import("./protocol.mjs").ViewerMessage} ViewerMessage
 * @typedef {import("./protocol.mjs").HostMessage} HostMessage
 */

/**
 * @typedef {object} Viewer
 * @property {net.Socket} socket
 * @property {string} id this connection's own id, sent back in the host's
 *   hello as "you"; control is held by it, so two devices of one person are
 *   told apart
 * @property {string} user
 * @property {boolean} canControl
 * @property {boolean} subscribed
 * @property {string | null} tab the tab chosen to watch, or null to follow the agent's tab
 * @property {string | null} shown the tab whose frames this viewer is getting
 */

/** Longest line read from a viewer: a megabyte paste, JSON-escaped. */
const MAX_LINE = 8_000_000;
/** A viewer that has not drained this much is skipped for frames until it does. */
const FRAME_BACKLOG = 1_000_000;
const HELLO_TIMEOUT_MS = 10_000;

/**
 * Makes the socket directory, or checks an existing one is ours and private.
 * @param {string} dir
 */
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (st.uid !== process.getuid?.()) throw new Error(`${dir} belongs to uid ${st.uid}`);
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/**
 * @param {string} file
 * @returns {Promise<boolean>} whether something is listening there
 */
function listening(file) {
  return new Promise((resolve) => {
    const s = net.connect(file);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

export class ViewerServer {
  /** @type {Set<Viewer>} */
  viewers = new Set();
  /** @type {string | null} */
  path = null;
  /** @type {net.Server | null} */
  #server = null;
  #o;

  /**
   * @param {{
   *   onHello: (v: Viewer) => void,
   *   onMessage: (v: Viewer, msg: ViewerMessage) => void,
   *   onGone: (v: Viewer) => void,
   * }} opts
   */
  constructor(opts) {
    this.#o = opts;
  }

  /**
   * @param {string} dir
   * @param {string} name file name without ".sock"
   * @returns {Promise<string>} the socket path
   */
  async listen(dir, name) {
    ensurePrivateDir(dir);
    let file = path.join(dir, `${name}.sock`);
    if (await listening(file)) {
      // Another live host already serves this session (a second Claude in
      // the same tmux session). Take a name of our own rather than its socket.
      file = path.join(dir, `${name}-${process.pid}.sock`);
    }
    try {
      unlinkSync(file);
    } catch {
      // Nothing stale to remove.
    }
    const server = net.createServer((socket) => this.#accept(socket));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(file, () => resolve(undefined));
    });
    chmodSync(file, 0o600);
    this.#server = server;
    this.path = file;
    return file;
  }

  /**
   * @param {Viewer} v
   * @param {HostMessage} msg
   */
  send(v, msg) {
    if (!v.socket.destroyed) v.socket.write(encode(msg));
  }

  /**
   * A frame is dropped for a viewer that has not caught up, since the next
   * one supersedes it anyway.
   * @param {Viewer} v
   * @param {HostMessage & { t: "frame" }} msg
   */
  sendFrame(v, msg) {
    if (v.socket.writableLength > FRAME_BACKLOG) return;
    this.send(v, msg);
  }

  /** @param {HostMessage} msg */
  broadcast(msg) {
    for (const v of this.viewers) this.send(v, msg);
  }

  anySubscribed() {
    for (const v of this.viewers) if (v.subscribed) return true;
    return false;
  }

  /** Ends every connection and removes the socket. */
  async close() {
    const server = this.#server;
    this.#server = null;
    // Let the last messages (the "closed" state) reach each viewer, briefly.
    const ended = [...this.viewers].map(
      (v) =>
        new Promise((resolve) => {
          v.socket.once("close", resolve);
          v.socket.end();
          setTimeout(() => {
            v.socket.destroy();
            resolve(undefined);
          }, 1000).unref();
        }),
    );
    if (this.path) {
      try {
        unlinkSync(this.path);
      } catch {
        // Already gone.
      }
    }
    await Promise.all(ended);
    if (server) await new Promise((resolve) => server.close(() => resolve(undefined)));
  }

  /** @param {net.Socket} socket */
  #accept(socket) {
    const lines = new LineSplitter(MAX_LINE);
    /** @type {Viewer | null} */
    let viewer = null;
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    socket.on("data", (chunk) => {
      let got;
      try {
        got = lines.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const line of got) {
        if (!viewer) {
          const hello = parseViewerHello(line);
          if (!hello) {
            socket.destroy();
            return;
          }
          clearTimeout(helloTimer);
          viewer = {
            socket,
            id: randomBytes(8).toString("hex"),
            ...hello,
            subscribed: false,
            tab: null,
            shown: null,
          };
          this.viewers.add(viewer);
          this.#o.onHello(viewer);
          continue;
        }
        const msg = parseViewerMessage(line);
        if (msg) this.#o.onMessage(viewer, msg);
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (viewer && this.viewers.delete(viewer)) this.#o.onGone(viewer);
    });
  }
}
