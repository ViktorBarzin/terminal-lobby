import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOSE_NOTE, INSTRUCTIONS, McpGate, REFUSAL_TEXT } from "../lib/gate.mjs";

function setup({ holder = null, started = true } = {}) {
  const log = [];
  const state = { holder, started };
  const gate = new McpGate({
    toClient: (m) => log.push(["client", m]),
    toServer: (m) => log.push(["server", m]),
    controlHolder: () => state.holder,
    browserStarted: () => state.started,
    onCall: (name, args) => log.push(["call", name, args]),
    onClose: () => log.push(["close"]),
  });
  return { gate, log, state };
}

const call = (id, name, args = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

test("the initialize answer carries the server instructions", () => {
  const { gate, log } = setup();
  gate.fromClient({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  gate.fromServer({
    jsonrpc: "2.0",
    id: 0,
    result: { protocolVersion: "2025-06-18", serverInfo: { name: "x" } },
  });
  const [, reply] = log.at(-1);
  assert.equal(reply.result.instructions, INSTRUCTIONS);
  assert.match(INSTRUCTIONS, /browser_close/);
  assert.match(INSTRUCTIONS, /frees its memory/);
  assert.match(INSTRUCTIONS, /has control/);
  assert.match(INSTRUCTIONS, /live/);
});

test("instructions the server already gave are kept", () => {
  const { gate, log } = setup();
  gate.fromClient({ jsonrpc: "2.0", id: "tl-init-1", method: "initialize", params: {} });
  gate.fromServer({
    jsonrpc: "2.0",
    id: "tl-init-1",
    result: { instructions: "Upstream says hi." },
  });
  assert.equal(log.at(-1)[1].result.instructions, `Upstream says hi.\n\n${INSTRUCTIONS}`);
});

test("the tool list tells the agent that browser_close frees memory, and leaves the rest alone", () => {
  const { gate, log } = setup();
  gate.fromClient({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  gate.fromServer({
    jsonrpc: "2.0",
    id: 1,
    result: {
      tools: [
        { name: "browser_navigate", description: "Navigate to a URL" },
        { name: "browser_close", description: "Close the page" },
      ],
    },
  });
  const tools = log.at(-1)[1].result.tools;
  assert.equal(tools[0].description, "Navigate to a URL");
  assert.equal(tools[1].description, `Close the page. ${CLOSE_NOTE}`);
  assert.equal(
    CLOSE_NOTE,
    "Closes the browser and frees its memory. Call this when you are done browsing.",
  );
});

test("a tool call is forwarded and counted until it is answered", () => {
  const { gate, log } = setup();
  gate.fromClient(call(2, "browser_navigate", { url: "https://x/" }));
  assert.deepEqual(log[0], ["call", "browser_navigate", { url: "https://x/" }]);
  assert.equal(log[1][0], "server");
  assert.equal(gate.inFlight, 1);
  gate.fromServer({ jsonrpc: "2.0", id: 2, result: { content: [] } });
  assert.equal(gate.inFlight, 0);
  assert.deepEqual(log.at(-1), ["client", { jsonrpc: "2.0", id: 2, result: { content: [] } }]);
});

test("while a person holds control every tool call is refused by the host", () => {
  const { gate, log, state } = setup({ holder: "viktor" });
  gate.fromClient(call(3, "browser_snapshot"));
  gate.fromClient(call(4, "browser_close"));
  assert.equal(log.length, 2);
  for (const [dest, msg] of log) {
    assert.equal(dest, "client");
    assert.equal(msg.result.isError, true);
    assert.deepEqual(msg.result.content, [{ type: "text", text: REFUSAL_TEXT }]);
  }
  assert.deepEqual(
    log.map(([, m]) => m.id),
    [3, 4],
  );
  assert.equal(gate.inFlight, 0);
  state.holder = null;
  gate.fromClient(call(5, "browser_snapshot"));
  assert.equal(log.at(-1)[0], "server");
});

test("browser_close is answered first and then closes the host", () => {
  const { gate, log } = setup();
  gate.fromClient(call(6, "browser_close"));
  assert.equal(log.at(-1)[0], "server");
  gate.fromServer({
    jsonrpc: "2.0",
    id: 6,
    result: { content: [{ type: "text", text: "closed" }] },
  });
  assert.deepEqual(
    log.slice(-2).map((e) => e[0]),
    ["client", "close"],
  );
});

test("browser_close with no browser started answers without starting one", () => {
  const { gate, log } = setup({ started: false });
  gate.fromClient(call(7, "browser_close"));
  assert.deepEqual(
    log.map((e) => e[0]),
    ["client", "close"],
  );
  assert.equal(log[0][1].id, 7);
  assert.equal(log[0][1].result.isError, undefined);
});

test("everything else passes straight through", () => {
  const { gate, log } = setup();
  const notif = { jsonrpc: "2.0", method: "notifications/initialized" };
  const serverReq = { jsonrpc: "2.0", id: 0, method: "roots/list" };
  const clientReply = { jsonrpc: "2.0", id: 0, result: { roots: [] } };
  const stray = { jsonrpc: "2.0", id: 99, result: { x: 1 } };
  gate.fromClient(notif);
  gate.fromServer(serverReq);
  gate.fromClient(clientReply);
  gate.fromServer(stray);
  assert.deepEqual(log, [
    ["server", notif],
    ["client", serverReq],
    ["server", clientReply],
    ["client", stray],
  ]);
});

test("a call with a malformed params object is forwarded for the server to reject", () => {
  const { gate, log } = setup();
  gate.fromClient({ jsonrpc: "2.0", id: 8, method: "tools/call" });
  assert.deepEqual(log[0], ["call", "", {}]);
  assert.equal(log[1][0], "server");
});
