// The gate between Claude and playwright-mcp on the MCP stream. Every message
// in both directions passes through it, which is where the host enforces the
// control lock, times activity, adds its instructions, and learns that
// browser_close has been answered and the host may exit.

/**
 * @typedef {string | number} JsonRpcId
 * @typedef {{ jsonrpc: "2.0", id?: JsonRpcId, method?: string, params?: Record<string, unknown>,
 *   result?: Record<string, unknown>, error?: unknown }} JsonRpcMessage
 */

export const INSTRUCTIONS = [
  "This browser belongs to this session, and the user can watch it live in the lobby while you use it.",
  "When a browsing task is done, call browser_close: it shuts the browser and frees its memory. The next browser tool call opens a fresh one.",
  "If a browser tool says the user has control of the browser, stop: do not retry, end your turn and wait for the user to tell you they are done.",
].join(" ");

export const CLOSE_NOTE =
  "Closes the browser and frees its memory. Call this when you are done browsing.";

export const REFUSAL_TEXT =
  "The user has taken control of the browser. Don't retry; end your turn and wait for them to tell you they are done.";

/**
 * @param {JsonRpcId} id
 * @param {Record<string, unknown>} result
 * @returns {JsonRpcMessage}
 */
function reply(id, result) {
  return { jsonrpc: "2.0", id, result };
}

/**
 * @param {unknown} msg
 * @returns {msg is JsonRpcMessage & { id: JsonRpcId }}
 */
function isResponse(msg) {
  const m = /** @type {JsonRpcMessage} */ (msg);
  return m.method === undefined && m.id !== undefined && ("result" in m || "error" in m);
}

export class McpGate {
  /** @type {Set<JsonRpcId>} */
  #initIds = new Set();
  /** @type {Set<JsonRpcId>} */
  #listIds = new Set();
  /** @type {Set<JsonRpcId>} */
  #closeIds = new Set();
  /** @type {Set<JsonRpcId>} */
  #calls = new Set();
  #o;

  /**
   * @param {{
   *   toClient: (msg: JsonRpcMessage) => void,
   *   toServer: (msg: JsonRpcMessage) => void,
   *   controlHolder: () => string | null,
   *   browserStarted: () => boolean,
   *   onCall: (name: string, args: Record<string, unknown>) => void,
   *   onClose: () => void,
   * }} opts
   */
  constructor(opts) {
    this.#o = opts;
  }

  /** Tool calls forwarded and not yet answered. */
  get inFlight() {
    return this.#calls.size;
  }

  /** @param {JsonRpcMessage} msg */
  fromClient(msg) {
    const id = msg.id;
    if (id !== undefined && msg.method === "initialize") this.#initIds.add(id);
    if (id !== undefined && msg.method === "tools/list") this.#listIds.add(id);
    if (id !== undefined && msg.method === "tools/call") {
      const params = msg.params ?? {};
      const name = typeof params.name === "string" ? params.name : "";
      const rawArgs = params.arguments;
      /** @type {Record<string, unknown>} */
      const args =
        rawArgs !== null && typeof rawArgs === "object"
          ? /** @type {Record<string, unknown>} */ (rawArgs)
          : {};
      if (this.#o.controlHolder() !== null) {
        this.#o.toClient(
          reply(id, { content: [{ type: "text", text: REFUSAL_TEXT }], isError: true }),
        );
        return;
      }
      if (name === "browser_close" && !this.#o.browserStarted()) {
        this.#o.toClient(
          reply(id, { content: [{ type: "text", text: "The browser is closed." }] }),
        );
        this.#o.onClose();
        return;
      }
      if (name === "browser_close") this.#closeIds.add(id);
      this.#calls.add(id);
      this.#o.onCall(name, args);
    }
    this.#o.toServer(msg);
  }

  /** @param {JsonRpcMessage} msg */
  fromServer(msg) {
    if (!isResponse(msg)) {
      this.#o.toClient(msg);
      return;
    }
    const id = msg.id;
    if (this.#initIds.delete(id) && msg.result) {
      const prior = typeof msg.result.instructions === "string" ? msg.result.instructions : "";
      msg.result.instructions = prior ? `${prior}\n\n${INSTRUCTIONS}` : INSTRUCTIONS;
    }
    if (this.#listIds.delete(id) && Array.isArray(msg.result?.tools)) {
      for (const tool of msg.result.tools) {
        if (tool?.name === "browser_close") {
          const base = String(tool.description ?? "").replace(/\.?\s*$/, "");
          tool.description = base ? `${base}. ${CLOSE_NOTE}` : CLOSE_NOTE;
        }
      }
    }
    this.#calls.delete(id);
    this.#o.toClient(msg);
    if (this.#closeIds.delete(id)) this.#o.onClose();
  }
}

/**
 * The MCP SDK's Transport, as playwright-mcp's Server sees it. Messages the
 * gate forwards go in through deliver(); everything the Server sends comes
 * out through onSend. Nothing here touches stdio, so --describe can drive the
 * same Server without one.
 */
export class GateTransport {
  /** @type {((msg: JsonRpcMessage) => void) | undefined} */
  onmessage;
  /** @type {(() => void) | undefined} */
  onclose;
  /** @type {((err: Error) => void) | undefined} */
  onerror;
  #onSend;

  /** @param {(msg: JsonRpcMessage) => void} onSend */
  constructor(onSend) {
    this.#onSend = onSend;
  }

  async start() {}

  /** @param {JsonRpcMessage} msg */
  async send(msg) {
    this.#onSend(msg);
  }

  async close() {
    this.onclose?.();
  }

  /** @param {JsonRpcMessage} msg */
  deliver(msg) {
    this.onmessage?.(msg);
  }
}
