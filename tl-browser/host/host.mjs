#!/usr/bin/env node
// The session browser's host (ADR-0035). tl-browser starts it on a session's
// first browser tool call and talks MCP to it over stdio. It runs
// playwright-mcp through createConnection with a Chrome it launches itself,
// sits between Claude and playwright-mcp on the MCP stream (the gate), and
// serves the viewer socket the lobby watches and drives the browser through.
//
//   node host.mjs              serve MCP on stdio
//   node host.mjs --describe   print {"initialize":…,"tools":…} and exit,
//                              without launching Chrome; tl-browser caches it
//
// Environment, all optional:
//   TL_BROWSER_CHANNEL            Chrome channel (default "chrome")
//   TL_BROWSER_STORAGE_STATE      storage state to seed cookies from; empty
//                                 for none (default ~/.cache/playwright-shared-storage-state.json)
//   TL_BROWSER_NO_SANDBOX         "1" runs Chrome without its sandbox, for a
//                                 container without the setuid helper (default: sandboxed)
//   TL_BROWSER_IDLE_FREEZE_MS     idle time before Frozen (default 10 min)
//   TL_BROWSER_FROZEN_CLOSE_MS    frozen time before the host closes (default 2 h)
//   TL_BROWSER_CONTROL_LAPSE_MS   time without input before control lapses (default 10 min)

import os from "node:os";
import { createConnection } from "@playwright/mcp";
import { summarize } from "./lib/activity.mjs";
import { BrowserSession, sandboxed, storageStatePath, VIEWPORT } from "./lib/browser.mjs";
import { Control } from "./lib/control.mjs";
import { CursorBoard } from "./lib/cursor.mjs";
import { GateTransport, McpGate } from "./lib/gate.mjs";
import { IdleClock } from "./lib/idle.mjs";
import { checkChoice, dialogText, PopupBoard, selectOpens } from "./lib/popups.mjs";
import { LineSplitter, normalizeUrl, socketDir, socketName } from "./lib/protocol.mjs";
import { TmuxRegistration } from "./lib/tmux.mjs";
import { ViewerServer } from "./lib/viewers.mjs";

/**
 * @typedef {import("./lib/gate.mjs").JsonRpcMessage} JsonRpcMessage
 * @typedef {import("./lib/viewers.mjs").Viewer} Viewer
 * @typedef {import("./lib/protocol.mjs").ViewerMessage} ViewerMessage
 * @typedef {import("./lib/protocol.mjs").HostMessage} HostMessage
 * @typedef {import("./lib/protocol.mjs").PopupMessage} PopupMessage
 * @typedef {import("playwright-core").Page} Page
 * @typedef {import("playwright-core").Dialog} Dialog
 * @typedef {{ kind: "select", msg: PopupMessage & { kind: "select" }, handle: import("./lib/browser.mjs").SelectHandle }
 *   | { kind: "dialog", msg: PopupMessage & { kind: "dialog" }, page: Page, dialog: Dialog }} OpenPopup
 */

const env = process.env;

/**
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function ms(name, fallback) {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const FREEZE_MS = ms("TL_BROWSER_IDLE_FREEZE_MS", 10 * 60_000);
const CLOSE_MS = ms("TL_BROWSER_FROZEN_CLOSE_MS", 2 * 60 * 60_000);
const LAPSE_MS = ms("TL_BROWSER_CONTROL_LAPSE_MS", 10 * 60_000);
/** Often enough to hit the shortest timer closely, never busier than 20 ms. */
const TICK_MS = Math.min(
  5000,
  Math.max(20, Math.floor(Math.min(FREEZE_MS, CLOSE_MS, LAPSE_MS) / 10)),
);
/** A lapse moved by more than this since the last report is reported again. */
const LAPSE_REPORT_MS = 60_000;
/** Longest MCP message read from Claude. */
const MAX_MCP_LINE = 64_000_000;

const mcpConfig = {
  browser: {
    launchOptions: {
      channel: env.TL_BROWSER_CHANNEL || "chrome",
      headless: true,
      chromiumSandbox: sandboxed(env),
    },
    contextOptions: { viewport: VIEWPORT },
  },
};

/** @param {unknown} err */
function log(err) {
  process.stderr.write(`tl-browser-host: ${err instanceof Error ? err.message : String(err)}\n`);
}

if (process.argv.includes("--describe")) await describe();
else await serve();

/**
 * Drives playwright-mcp's server through the same gate as a real session,
 * so the cached answers carry the instructions and the browser_close note.
 */
async function describe() {
  /** @type {Map<string | number, (msg: JsonRpcMessage) => void>} */
  const waiting = new Map();
  const server = await createConnection(mcpConfig, async () => {
    throw new Error("describe mode does not start a browser");
  });
  const transport = new GateTransport((msg) => gate.fromServer(msg));
  const gate = new McpGate({
    toClient: (msg) => {
      if (msg.id !== undefined) waiting.get(msg.id)?.(msg);
    },
    toServer: (msg) => transport.deliver(msg),
    controlHolder: () => null,
    browserStarted: () => false,
    onCall: () => {},
    onClose: () => {},
  });
  await server.connect(transport);
  /**
   * @param {number} id
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<Record<string, unknown>>}
   */
  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      waiting.set(id, (msg) =>
        msg.result ? resolve(msg.result) : reject(new Error(JSON.stringify(msg.error))),
      );
      gate.fromClient({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });
  const initialize = await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "tl-browser", version: "describe" },
  });
  gate.fromClient({ jsonrpc: "2.0", method: "notifications/initialized" });
  const tools = await request(2, "tools/list");
  process.stdout.write(`${JSON.stringify({ initialize, tools })}\n`);
  process.exit(0);
}

async function serve() {
  const tmux = new TmuxRegistration(env.TMUX_PANE);
  const control = new Control({ lapseMs: LAPSE_MS });
  const idle = new IdleClock({ freezeMs: FREEZE_MS, closeMs: CLOSE_MS });
  /** @type {BrowserSession | null} */
  let session = null;
  /** @type {Promise<import("playwright-core").BrowserContext> | null} */
  let launching = null;
  let closing = false;
  let reportedLapseAt = 0;
  /** @type {HostMessage | null} the latest activity, replayed to a viewer that joins */
  let lastActivity = null;
  /** @type {PopupBoard<OpenPopup>} the popups open now, one per tab */
  const popups = new PopupBoard();
  /** each tab's last cursor position, replayed to a viewer that starts watching it */
  const cursors = new CursorBoard();

  const viewers = new ViewerServer({
    onHello: (v) => {
      viewers.send(v, {
        t: "hello",
        you: v.id,
        state: idle.state,
        tabs: session?.tabs.snapshot() ?? [],
        agentTab: session?.tabs.agentTab ?? null,
        control: control.snapshot(),
        viewport: { w: VIEWPORT.width, h: VIEWPORT.height },
      });
      if (lastActivity) viewers.send(v, lastActivity);
      if (isController(v)) for (const p of pendingPopups()) viewers.send(v, p.msg);
    },
    onMessage: (v, msg) => onViewer(v, msg),
    onGone: () => reconcile(),
    onRelease: (user) => {
      if (!closing && control.release(user)) {
        broadcastControl();
        controlChanged();
      }
      return { t: "control", ...control.snapshot() };
    },
  });

  const transport = new GateTransport((msg) => gate.fromServer(msg));
  const gate = new McpGate({
    toClient: (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`),
    toServer: (msg) => transport.deliver(msg),
    controlHolder: () => control.holder,
    browserStarted: () => launching !== null,
    onCall: (name, args) => {
      wake();
      lastActivity = { t: "activity", tool: name, summary: summarize(name, args) };
      viewers.broadcast(lastActivity);
    },
    onClose: () => void shutdown(0),
  });

  const server = await createConnection(mcpConfig, () => {
    launching ??= launch().catch((err) => {
      launching = null;
      throw err;
    });
    return launching;
  });
  await server.connect(transport);

  const stdin = new LineSplitter(MAX_MCP_LINE);
  process.stdin.on("data", (chunk) => {
    let lines;
    try {
      lines = stdin.push(chunk);
    } catch (err) {
      log(err);
      void shutdown(1);
      return;
    }
    for (const line of lines) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log("dropped a line that is not JSON");
        continue;
      }
      if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
        log("dropped a line that is not a JSON-RPC message");
        continue;
      }
      gate.fromClient(msg);
    }
  });
  // Claude, or the launcher, went away: nobody is left to drive the browser.
  process.stdin.on("end", () => void shutdown(0));
  for (const sig of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"]))
    process.on(sig, () => void shutdown(0));
  process.on("uncaughtException", (err) => {
    log(err);
    void shutdown(1);
  });

  setInterval(tick, TICK_MS).unref();

  /** @returns {Promise<import("playwright-core").BrowserContext>} */
  async function launch() {
    const s = await BrowserSession.launch(
      {
        channel: mcpConfig.browser.launchOptions.channel,
        sandbox: sandboxed(env),
        storageState: storageStatePath(env, os.homedir()),
      },
      {
        onTabs: () => {
          if (!session) return;
          const tabs = session.tabs.snapshot();
          viewers.broadcast({ t: "tabs", tabs, agentTab: session.tabs.agentTab });
          const open = new Set(tabs.map((tab) => tab.id));
          for (const p of popups.prune(open)) letGo(p);
          cursors.prune(open);
          reconcile();
        },
        onDialog: (tab, page, dialog) => {
          const type = dialog.type();
          /** @type {OpenPopup} */
          const p = {
            kind: "dialog",
            msg: {
              t: "popup",
              kind: "dialog",
              tab,
              type:
                type === "confirm" || type === "prompt" || type === "beforeunload" ? type : "alert",
              ...dialogText(dialog.message(), dialog.defaultValue()),
            },
            page,
            dialog,
          };
          // Kept with the agent in control too: if a person takes control
          // before the agent answers it, it is theirs to answer.
          openPopup(p, control.holder !== null);
        },
        onFileChooser: (tab, page, chooser) => {
          // With the agent in control, playwright-mcp's browser_file_upload
          // answers it, as before.
          if (control.holder === null || !session) return;
          session.cancelFileChooser(page, chooser);
          toController({ t: "popup", kind: "filechooser", tab });
        },
        onCursor: (tab, report) => {
          const msg = cursors.report(tab, report);
          if (!msg) return;
          for (const v of viewers.viewers) {
            if (!v.subscribed || v.shown !== tab) continue;
            // A move the next one replaces may be dropped; a click never is.
            if (msg.kind === "move") viewers.sendLatest(v, msg);
            else viewers.send(v, msg);
          }
        },
        onFrame: (tab, frame) => {
          for (const v of viewers.viewers)
            if (v.subscribed && v.shown === tab)
              viewers.sendFrame(v, { t: "frame", tab, ...frame });
        },
        onDisconnected: () => {
          log("Chrome went away");
          void closeWhenSettled();
        },
      },
    );
    session = s;
    idle.thaw();
    try {
      const name = socketName(await tmux.sessionId(), process.pid);
      const sock = await viewers.listen(socketDir(env, process.getuid?.() ?? 0), name);
      await tmux.register(sock);
    } catch (err) {
      // The browser still works for the agent; only the lobby cannot see it.
      log(`viewer socket: ${err instanceof Error ? err.message : String(err)}`);
    }
    return s.context;
  }

  /** Wakes a frozen browser. Safe to call when it is live. */
  function wake() {
    if (!idle.thaw() || !session) return;
    session.thaw();
    void tmux.setState("live");
    viewers.broadcast({ t: "state", state: "live" });
  }

  function tick() {
    if (closing) return;
    if (control.lapse()) {
      broadcastControl();
      controlChanged();
    }
    if (!session) {
      // The launcher starts a host for a tool call, so one that has opened no
      // browser for a whole freeze window (a launch that failed, say) has
      // nothing left to do and should not keep its memory.
      if (idle.check(gate.inFlight > 0 || launching !== null) === "freeze") {
        log("no browser was opened, exiting");
        void shutdown(0);
      }
      return;
    }
    const busy = gate.inFlight > 0 || control.holder !== null || viewers.anySubscribed();
    const due = idle.check(busy);
    if (due === "freeze") {
      session.freeze();
      void tmux.setState("frozen");
      viewers.broadcast({ t: "state", state: "frozen" });
    } else if (due === "close") {
      log("closing a browser left frozen");
      void shutdown(0);
    }
  }

  /**
   * @param {Viewer} v
   * @returns {boolean} whether this connection is the person in control's
   */
  function isController(v) {
    return v.canControl && control.holderId !== null && v.id === control.holderId;
  }

  /** @param {PopupMessage} msg */
  function toController(msg) {
    for (const v of viewers.viewers) if (isController(v)) viewers.send(v, msg);
  }

  /**
   * Shows a popup to the person in control, replacing any other on its tab.
   * @param {OpenPopup} p
   * @param {boolean} show
   */
  function openPopup(p, show) {
    const prev = popups.set(p);
    if (prev) letGo(prev);
    if (show) toController(p.msg);
  }

  /**
   * Takes a popup off the board and tells the person in control it is gone.
   * @param {OpenPopup} p
   * @returns {boolean} whether it was still open
   */
  function closePopup(p) {
    if (!popups.take(p)) return false;
    letGo(p);
    toController({ t: "popup", kind: "none", tab: p.msg.tab });
    return true;
  }

  /** @param {OpenPopup} p */
  function letGo(p) {
    if (p.kind === "select") p.handle.dispose().catch(() => {});
  }

  /**
   * The popups still open, after forgetting dialogs the agent has answered.
   * @returns {OpenPopup[]}
   */
  function pendingPopups() {
    for (const p of popups.all())
      if (p.kind === "dialog" && !session?.dialogPending(p.page, p.dialog)) popups.take(p);
    return popups.all();
  }

  /**
   * Control changed hands. A select's list belonged to the person who opened
   * it. Dialogs wait for whoever drives next: a new holder is shown them, and
   * the agent answers them through playwright-mcp.
   */
  function controlChanged() {
    for (const p of popups.drop("select")) letGo(p);
    if (control.holder !== null) for (const p of pendingPopups()) toController(p.msg);
  }

  /**
   * After a person's press: show the list of a select it focused, or close
   * the list of one it moved away from.
   * @param {string} tab
   */
  async function lookForSelect(tab) {
    if (!session) return;
    const holder = control.holderId;
    const found = await session.focusedSelect(tab);
    const open = popups.get(tab);
    if (!found) {
      if (open?.kind === "select") closePopup(open);
      return;
    }
    if (control.holderId === null || control.holderId !== holder) {
      found.handle.dispose().catch(() => {});
      return;
    }
    const { handle, options, multiple, rect } = found;
    openPopup(
      { kind: "select", msg: { t: "popup", kind: "select", tab, options, multiple, rect }, handle },
      true,
    );
  }

  /**
   * A person's answer to a popup.
   * @param {Viewer} v
   * @param {ViewerMessage & { t: "choose" | "dialog" }} msg
   */
  function answerPopup(v, msg) {
    if (!session) return;
    const s = session;
    /** @param {string} message */
    const complain = (message) => viewers.send(v, { t: "error", message });
    const where = msg.tab ?? watchedTab(v);
    if (msg.t === "choose") {
      const p = popups.find("select", where);
      if (p?.kind !== "select") return complain("That list is no longer open.");
      const values = checkChoice(p.msg, msg);
      if (!values) return complain("That option cannot be chosen.");
      popups.take(p);
      s.choose(p.handle, values)
        .catch(() => complain("The list changed before the choice could be made."))
        .finally(() => {
          letGo(p);
          toController({ t: "popup", kind: "none", tab: p.msg.tab });
        });
      return;
    }
    const p = popups.find("dialog", where);
    if (p?.kind !== "dialog") return complain("That dialog is no longer open.");
    closePopup(p);
    s.answerDialog(p.page, p.dialog, msg.accept, msg.text).catch((err) => {
      // Answered already (the page closed it, or it went away): nothing to do.
      if (!/already handled|closed/i.test(String(err))) complain(String(err));
    });
  }

  function broadcastControl() {
    const snap = control.snapshot();
    reportedLapseAt = snap.lapseAt ?? 0;
    viewers.broadcast({ t: "control", ...snap });
  }

  /**
   * @param {Viewer} v
   * @returns {string | null}
   */
  function watchedTab(v) {
    return v.tab ?? session?.tabs.agentTab ?? null;
  }

  /**
   * Points every subscribed viewer at its tab, sends a fresh picture to any
   * whose tab just changed, and screencasts exactly the tabs being watched.
   */
  function reconcile() {
    if (!session) return;
    const s = session;
    /** @type {Set<string>} */
    const wanted = new Set();
    for (const v of viewers.viewers) {
      if (v.tab !== null && s.tabs.pageOf(v.tab) === null) v.tab = null;
      const tab = v.subscribed ? watchedTab(v) : null;
      if (tab === null) {
        v.shown = null;
        continue;
      }
      wanted.add(tab);
      if (v.shown === tab) continue;
      v.shown = tab;
      const cursor = cursors.last(tab);
      if (cursor) viewers.send(v, cursor);
      void s.snapshot(tab).then((frame) => {
        if (frame && v.shown === tab) viewers.sendFrame(v, { t: "frame", tab, ...frame });
      });
    }
    s.setWatched(wanted);
  }

  /**
   * @param {Viewer} v
   * @param {ViewerMessage} msg
   */
  function onViewer(v, msg) {
    if (closing) return;
    switch (msg.t) {
      case "subscribe":
        v.subscribed = true;
        v.tab = msg.tab;
        wake();
        reconcile();
        return;
      case "unsubscribe":
        v.subscribed = false;
        reconcile();
        return;
      case "selectTab":
        if (session?.tabs.pageOf(msg.tab)) {
          v.tab = msg.tab;
          reconcile();
        }
        return;
      case "takeControl": {
        if (!v.canControl) return;
        const before = control.holderId;
        control.take(v.id, v.user);
        // Control left another connection, perhaps the same person's other
        // device: the popups it was drawing are not its to answer any more.
        if (before !== null && before !== v.id) {
          for (const other of viewers.viewers)
            if (other.id === before)
              for (const p of popups.all())
                viewers.send(other, { t: "popup", kind: "none", tab: p.msg.tab });
        }
        wake();
        broadcastControl();
        controlChanged();
        return;
      }
      case "resume": {
        // Only from the holder's own closed connection, for the same user:
        // an open one is a second device, which takes control explicitly.
        if (!v.canControl || [...viewers.viewers].some((other) => other.id === msg.prev)) return;
        if (!control.resume(msg.prev, v.id, v.user)) return;
        broadcastControl();
        controlChanged();
        return;
      }
      case "handBack":
        if (v.canControl && control.handBack(v.id)) {
          broadcastControl();
          controlChanged();
        }
        return;
    }
    // Everything else drives the page, so it needs control.
    if (!v.canControl || !session) return;
    if (!control.input(v.id)) {
      viewers.send(v, { t: "error", message: "Take control of the browser first." });
      return;
    }
    wake();
    if ((control.snapshot().lapseAt ?? 0) - reportedLapseAt > LAPSE_REPORT_MS) broadcastControl();
    if (msg.t === "choose" || msg.t === "dialog") {
      answerPopup(v, msg);
      return;
    }
    const tab = watchedTab(v);
    if (tab === null) return;
    /** @type {ViewerMessage} */
    let action = msg;
    if (msg.t === "navigate") {
      const url = normalizeUrl(msg.url);
      if (!url) {
        viewers.send(v, { t: "error", message: "Only http and https addresses can be opened." });
        return;
      }
      action = { t: "navigate", url };
    }
    if (msg.t === "key" && msg.type !== "up" && (msg.key === "Escape" || msg.key === "Tab")) {
      // Either key closes an open select's list in the page too.
      const open = popups.get(tab);
      if (open?.kind === "select") closePopup(open);
    }
    session.act(tab, action).then(
      (text) => {
        if (msg.t === "copy") viewers.send(v, { t: "copied", text: text ?? "" });
        if (selectOpens(msg)) void lookForSelect(tab);
      },
      (err) =>
        viewers.send(v, { t: "error", message: err instanceof Error ? err.message : String(err) }),
    );
  }

  /** Chrome died under us: answer what is in flight, then go. */
  async function closeWhenSettled() {
    for (let i = 0; i < 100 && gate.inFlight > 0; i++) await new Promise((r) => setTimeout(r, 100));
    await shutdown(0);
  }

  /**
   * Clears the tmux options and the socket before Chrome goes, so nothing
   * points at a browser that is closing.
   * @param {number} code
   */
  async function shutdown(code) {
    if (closing) return;
    closing = true;
    viewers.broadcast({ t: "state", state: "closed" });
    tmux.clearSync();
    await viewers.close();
    if (session) await session.close();
    process.exit(code);
  }
}
