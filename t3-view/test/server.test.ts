import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AssetCreateUrlResult,
  AuthAccessTokenResult,
  AuthSessionState,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadStreamItem,
  OrchestrationV2ThreadTranscript,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpServer } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BearerAuthGate,
  ProxyAuthGate,
  type RelayCredentials,
  type WhoamiFetch,
} from "../src/auth.ts";
import { Commands } from "../src/commands/dispatch.ts";
import { environmentDescriptor, environmentIdFor, serverVersionOf } from "../src/descriptor.ts";
import { Hub } from "../src/hub.ts";
import { LobbyApi } from "../src/lobby/api.ts";
import { SequenceClock } from "../src/sequence.ts";
import { sidecarLayer } from "../src/server.ts";
import type { ExchangeRequest } from "../src/pairing.ts";
import { AUTH_CLOSE_CODE, BearerWatch } from "../src/revocation.ts";
import { PendingDispatches } from "../src/threads/pending.ts";
import { WsTickets } from "../src/tickets.ts";
import { BORN_AS, type FakeLobby, SESSION_NAME, startFakeLobby } from "./helpers/fakeLobby.ts";

const ADMIN = { "x-authentik-username": "viktor", "x-tl-proxy-secret": "s3cret" };
const NOT_ADMIN = { "x-authentik-username": "anca", "x-tl-proxy-secret": "s3cret" };
const STRANGER = { "x-authentik-username": "stranger", "x-tl-proxy-secret": "s3cret" };
const WRONG_SECRET = { "x-authentik-username": "viktor", "x-tl-proxy-secret": "guess" };

/** Device tokens tmux-api and the lobby accept right now; a test revokes one by deleting it. */
const devices = new Set(["tld1_device", "tld1_other"]);
const DEVICE = { authorization: "Bearer tld1_device" };
const BAD_DEVICE = { authorization: "Bearer tld1_revoked" };
const whoamiCalls: RelayCredentials[] = [];

const whoami: WhoamiFetch = async (relay) => {
  whoamiCalls.push(relay);
  if (relay.bearer !== undefined) {
    return devices.has(relay.bearer)
      ? { status: 200, body: { authentik: "viktor", osUser: "wizard", admin: false } }
      : { status: 401, body: undefined };
  }
  if (relay.secret !== "s3cret") return { status: 401, body: undefined };
  if (relay.identity === "viktor") {
    return { status: 200, body: { authentik: "viktor", osUser: "wizard", admin: true } };
  }
  if (relay.identity === "stranger") return { status: 403, body: undefined };
  return { status: 200, body: { authentik: relay.identity, osUser: relay.identity, admin: false } };
};

const PAIRING_CODE = "ABCD-EFGH-JKLM";
const exchanges: ExchangeRequest[] = [];
const ticketClock = { now: Date.now() };

let base = "";
let webDir = "";
let scope: Scope.Closeable | undefined;
let lobby: FakeLobby | undefined;
let hub: Hub | undefined;
const clock = new SequenceClock(1_791_800_000_000);

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "tl-t3-view-web-"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>T3</title>");
  mkdirSync(join(webDir, "assets"));
  writeFileSync(join(webDir, "assets", "index-AbCd1234.js"), "export {};");
  const startedAt = "2026-10-12T08:00:00.000Z";
  lobby = await startFakeLobby({
    identity: "viktor",
    secret: "s3cret",
    fixture: "01-open-first-turn.sse",
    bearers: devices,
  });
  const bearer = new BearerAuthGate({ whoami });
  const watch = new BearerWatch({
    gate: bearer,
    onRevoked: (key) => hub?.revoke(key),
    intervalMs: 100,
  });
  const api = new LobbyApi({
    tmuxApiUrl: lobby.url,
    sessionEventsUrl: lobby.url,
    onUnauthorized: (relay) => {
      if (relay.bearer !== undefined) void watch.suspect(relay.bearer);
    },
  });
  const pending = new PendingDispatches();
  const liveHub = new Hub({ api, clock, pending, startedAt });
  hub = liveHub;
  const descriptor = environmentDescriptor({
    environmentId: environmentIdFor("test"),
    label: "test",
  });
  const layer = sidecarLayer(
    {
      gate: new ProxyAuthGate({ authHeader: "X-Authentik-Username", whoami }),
      bearer,
      tickets: new WsTickets({ now: () => ticketClock.now }),
      watch,
      exchange: async (request) => {
        exchanges.push(request);
        if (request.code !== PAIRING_CODE) {
          return { ok: false, status: 401, reason: "bad code" };
        }
        devices.add("tld1_paired");
        return { ok: true, token: "tld1_paired" };
      },
      webDir,
      config: { descriptor, cwd: "/", startedAt },
      clock,
      hub: liveHub,
      commands: new Commands({
        api,
        pending,
        now: Date.now,
        thread: async (identity, threadId) => {
          const user = liveHub.user(identity);
          const live = await user.thread(threadId, identity.relay);
          const entry = user.entry(threadId);
          return live === undefined || entry === undefined ? undefined : { entry, live };
        },
        project: async (identity, projectId) => liveHub.user(identity).directory.project(projectId),
        alias: () => {},
      }),
    },
    { host: "127.0.0.1", port: 0 },
  );
  const opened = Effect.runSync(Scope.make());
  scope = opened;
  const context = await Effect.runPromise(Layer.buildWithScope(layer, opened));
  base = HttpServer.formatAddress(Context.get(context, HttpServer.HttpServer).address);
});

afterAll(async () => {
  hub?.dispose();
  await lobby?.close();
  if (scope) await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(webDir, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers });

describe("auth gate on every route", () => {
  it.each([
    "/",
    "/assets/index-AbCd1234.js",
    "/api/orchestration/shell",
    "/ws?orchestrationProtocol=2",
    "/some/app/route",
    "/api/unknown",
    "/.well-known/t3/thread/x",
  ])(
    "refuses %s without credentials (401), a wrong secret (401) and an unmapped user (403)",
    async (path) => {
      expect((await get(path)).status).toBe(401);
      expect((await get(path, WRONG_SECRET)).status).toBe(401);
      expect((await get(path, STRANGER)).status).toBe(403);
    },
  );

  it("admits a lobby user who is not an admin", async () => {
    const index = await get("/", NOT_ADMIN);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("<title>T3</title>");
  });

  it("refuses the trace upload without credentials", async () => {
    const response = await fetch(`${base}/api/observability/v1/traces`, { method: "POST" });
    expect(response.status).toBe(401);
  });
});

describe("HTTP routes for an admin", () => {
  it("serves the web build at / and app routes, and assets as immutable", async () => {
    const index = await get("/", ADMIN);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("<title>T3</title>");
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expect(index.headers.get("content-security-policy")).toBe(
      "frame-ancestors http://localhost:* http://127.0.0.1:*",
    );

    const route = await get("/env-1/thread-1", ADMIN);
    expect(await route.text()).toContain("<title>T3</title>");

    const asset = await get("/assets/index-AbCd1234.js", ADMIN);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");

    expect((await get("/assets/missing-AbCd1234.js", ADMIN)).status).toBe(404);
  });

  it("names the user's thread for the key the lobby frames a session by", async () => {
    const byName = await get(`/.well-known/t3/thread/${SESSION_NAME}`, ADMIN);
    expect(byName.status).toBe(200);
    expect(byName.headers.get("cache-control")).toBe("no-store");
    expect(await byName.json()).toEqual({ threadId: BORN_AS });
    expect(await (await get(`/.well-known/t3/thread/${BORN_AS}`, ADMIN)).json()).toEqual({
      threadId: BORN_AS,
    });
    expect((await get("/.well-known/t3/thread/nope", ADMIN)).status).toBe(404);
    expect((await get(`/.well-known/t3/thread/${SESSION_NAME}`)).status).toBe(401);
  });

  it("names the lobby key and session for one of the user's threads, for the frame's route reports", async () => {
    const found = await get(`/.well-known/t3/session/${BORN_AS}`, ADMIN);
    expect(found.status).toBe(200);
    expect(found.headers.get("cache-control")).toBe("no-store");
    expect(await found.json()).toEqual({ key: BORN_AS, name: SESSION_NAME });
    expect((await get("/.well-known/t3/session/nope", ADMIN)).status).toBe(404);
    expect((await get(`/.well-known/t3/session/${BORN_AS}`)).status).toBe(401);
  });

  it("redirects a thread route framed by another key of the same session to its thread id", async () => {
    const env = environmentIdFor("test");
    const moved = await fetch(`${base}/${env}/${SESSION_NAME}?embed`, {
      headers: ADMIN,
      redirect: "manual",
    });
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe(`/${env}/${BORN_AS}?embed`);
    const direct = await get(`/${env}/${BORN_AS}?embed`, ADMIN);
    expect(direct.status).toBe(200);
    expect(await direct.text()).toContain("<title>T3</title>");
    const unknown = await fetch(`${base}/${env}/nope?embed`, {
      headers: ADMIN,
      redirect: "manual",
    });
    expect(unknown.status).toBe(200);
  });

  it("does not serve files outside the web build", async () => {
    const response = await get("/..%2f..%2fetc%2fpasswd", ADMIN);
    expect([400, 404]).toContain(response.status);
    expect(await response.text()).not.toContain("root:");
  });

  it("answers the environment descriptor with protocol 2", async () => {
    const body = await (await get("/.well-known/t3/environment", ADMIN)).json();
    expect(body).toMatchObject({ label: "test", orchestrationProtocolVersion: 2 });
  });

  it("answers an authenticated session without terminal scopes", async () => {
    const body = Schema.decodeUnknownSync(Schema.toCodecJson(AuthSessionState))(
      await (await get("/api/auth/session", ADMIN)).json(),
    );
    expect(body.authenticated).toBe(true);
    expect(body.permissions).not.toContain("terminal:operate");
  });

  it("needs x-t3-orchestration-protocol: 2 on the shell route", async () => {
    expect((await get("/api/orchestration/shell", ADMIN)).status).toBe(400);
    const response = await get("/api/orchestration/shell", {
      ...ADMIN,
      "x-t3-orchestration-protocol": "2",
    });
    expect(response.status).toBe(200);
    const shell = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ShellSnapshot))(
      await response.json(),
    );
    expect(shell.projects.map((p) => [p.title, p.workspaceRoot])).toEqual([
      ["lobby", "/home/wizard/code/lobby"],
      ["Ungrouped", "/home/wizard"],
    ]);
    expect(shell.threads.map((t) => [t.id, t.title, t.projectId])).toEqual([
      [BORN_AS, "Running echo hi with Bash tool", "project:lobby"],
    ]);
  });

  it("404s unknown API paths instead of serving index.html", async () => {
    expect((await get("/api/orchestration/unknown", ADMIN)).status).toBe(404);
  });

  it("serves a thread's bounded snapshot from its lobby stream, and 404 for a thread the lobby does not list", async () => {
    const protocol = { ...ADMIN, "x-t3-orchestration-protocol": "2" };
    const response = await get(
      `/api/orchestration/threads/${BORN_AS}/bounded?compactTurnItems=1`,
      protocol,
    );
    expect(response.status).toBe(200);
    const bounded = Schema.decodeUnknownSync(
      Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot),
    )(await response.json());
    expect(bounded.hasMoreHistory).toBe(false);
    expect(bounded.projection.thread.id).toBe(BORN_AS);
    expect(bounded.projection.visibleTurnItems.map((r) => r.item.type)).toEqual([
      "user_message",
      "command_execution",
      "assistant_message",
    ]);
    expect((await get("/api/orchestration/threads/nope/bounded", protocol)).status).toBe(404);
    const history = await get(`/api/orchestration/threads/${BORN_AS}/history?cursor=x`, protocol);
    expect(await history.json()).toMatchObject({
      items: [],
      hasMoreHistory: false,
      nextCursor: null,
    });
  });

  it("refuses a write a browser marks as sent from another origin", async () => {
    const response = await fetch(`${base}/api/observability/v1/traces`, {
      method: "POST",
      headers: { ...ADMIN, "sec-fetch-site": "same-site" },
      body: "{}",
    });
    expect(response.status).toBe(403);
  });

  it("accepts the client's trace upload with 204", async () => {
    const response = await fetch(`${base}/api/observability/v1/traces`, {
      method: "POST",
      headers: ADMIN,
      body: "{}",
    });
    expect(response.status).toBe(204);
  });

  it("answers 426 on /ws with another protocol version", async () => {
    const response = await get("/ws?orchestrationProtocol=1", { ...ADMIN, origin: base });
    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({ orchestrationProtocolVersion: 2 });
  });
});

interface Frame {
  readonly _tag: string;
  readonly requestId?: string;
  readonly values?: ReadonlyArray<unknown>;
  readonly exit?: { readonly _tag: string; readonly value?: unknown; readonly cause?: unknown };
}

/** A raw Effect RPC client over the JSON protocol, as the browser speaks it. */
async function openRpc(headers: Record<string, string>, origin: string | null = base, query = "") {
  const url = `${base.replace("http", "ws")}/ws?orchestrationProtocol=2${query}`;
  const socket = new WebSocket(url, {
    headers: origin === null ? headers : { ...headers, origin },
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }));
  });
  const frames: Frame[] = [];
  const waiters: Array<() => void> = [];
  socket.addEventListener("message", (event) => {
    const parsed: unknown = JSON.parse(String(event.data));
    for (const frame of Array.isArray(parsed) ? parsed : [parsed]) {
      frames.push(frame);
      // As the browser does: the server sends a stream's next chunk only
      // after the last one is acknowledged.
      if (frame._tag === "Chunk")
        socket.send(JSON.stringify({ _tag: "Ack", requestId: frame.requestId }));
    }
    for (const wake of waiters.splice(0)) wake();
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket refused")));
  });
  let nextId = 1;
  const request = (tag: string, payload: unknown) => {
    const id = nextId++;
    socket.send(JSON.stringify({ _tag: "Request", id: String(id), tag, payload, headers: [] }));
    return String(id);
  };
  const until = async (predicate: (frames: ReadonlyArray<Frame>) => Frame | undefined) => {
    for (;;) {
      const found = predicate(frames);
      if (found) return found;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  const exitOf = (id: string) =>
    until((all) => all.find((f) => f._tag === "Exit" && f.requestId === id));
  const chunkOf = (id: string) =>
    until((all) => all.find((f) => f._tag === "Chunk" && f.requestId === id));
  return { socket, request, exitOf, chunkOf, until, closed };
}

describe("RPC over /ws", () => {
  it("refuses the upgrade without credentials", async () => {
    await expect(openRpc({})).rejects.toThrow("websocket refused");
  });

  it("refuses an admin's upgrade opened by a page on another origin, or with no Origin", async () => {
    await expect(openRpc(ADMIN, "https://pages.viktorbarzin.me")).rejects.toThrow(
      "websocket refused",
    );
    await expect(openRpc(ADMIN, null)).rejects.toThrow("websocket refused");
    const foreign = await get("/ws?orchestrationProtocol=2", {
      ...ADMIN,
      origin: "https://pages.viktorbarzin.me",
    });
    expect(foreign.status).toBe(403);
  });

  it("answers server.getConfig and server.probe", async () => {
    const rpc = await openRpc(ADMIN);
    const config = await rpc.exitOf(rpc.request("server.getConfig", {}));
    expect(config.exit?._tag).toBe("Success");
    expect(config.exit?.value).toMatchObject({ providers: [{ instanceId: "claudeAgent" }] });
    const probe = await rpc.exitOf(rpc.request("server.probe", {}));
    expect(probe.exit).toEqual({ _tag: "Success", value: {} });
    rpc.socket.close();
  });

  it("answers vcs.refreshStatus as a directory with no repository, as the VCS stream does", async () => {
    const rpc = await openRpc(ADMIN);
    const status = await rpc.exitOf(rpc.request("vcs.refreshStatus", { cwd: "/home/wizard" }));
    expect(status.exit?._tag).toBe("Success");
    expect(status.exit?.value).toMatchObject({ isRepo: false, hasUpstream: false, pr: null });
    rpc.socket.close();
  });

  it("streams the shell snapshot then the completion marker", async () => {
    const rpc = await openRpc(ADMIN);
    const id = rpc.request("orchestration.subscribeShell", {
      afterSequence: 0,
      requestCompletionMarker: true,
    });
    const chunk = await rpc.chunkOf(id);
    const decode = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ShellStreamItem));
    const kinds = (chunk.values ?? []).map((v) => decode(v).kind);
    expect(kinds).toEqual(["snapshot", "synchronized"]);
    rpc.socket.close();
  });

  it("streams a thread as a snapshot then the completion marker, then live events", async () => {
    const rpc = await openRpc(ADMIN);
    const id = rpc.request("orchestration.subscribeThread", {
      threadId: BORN_AS,
      requestCompletionMarker: true,
    });
    const chunk = await rpc.chunkOf(id);
    const decode = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));
    const items = (chunk.values ?? []).map((v) => decode(v));
    expect(items.map((i) => i.kind)).toEqual(["snapshot", "synchronized"]);
    const snapshot = items[0];
    expect(snapshot?.kind === "snapshot" && snapshot.projection.runs.length).toBe(1);
    lobby?.push(
      `id: 18\ndata: ${JSON.stringify({ id: 18, kind: "user", session: SESSION_NAME, turnId: "t2", body: "next", at: 1 })}\n\n`,
    );
    const live = await rpc.until((all) =>
      all.find(
        (f) =>
          f._tag === "Chunk" &&
          f.requestId === id &&
          JSON.stringify(f.values).includes('"text":"next"'),
      ),
    );
    expect(JSON.stringify(live.values)).toContain('"text":"next"');
    rpc.socket.close();
  });

  it("offers the model a live session is on as a provider row when the catalogue lacks it", async () => {
    // The fixture session answers on claude-haiku-5-5, which the catalogue
    // does not list: the composer would otherwise show its default.
    const rpc = await openRpc(ADMIN);
    const config = rpc.request("subscribeServerConfig", {});
    await rpc.chunkOf(config);
    rpc.request("orchestration.subscribeThread", { threadId: BORN_AS });
    const offered = await rpc.until((all) =>
      all.find(
        (f) =>
          f._tag === "Chunk" &&
          f.requestId === config &&
          JSON.stringify(f.values).includes('"slug":"claude-haiku-5-5"'),
      ),
    );
    expect(JSON.stringify(offered.values)).toContain('"name":"claude-haiku-5-5"');
    const got = await rpc.exitOf(rpc.request("server.getConfig", {}));
    expect(JSON.stringify(got.exit?.value)).toContain('"slug":"claude-haiku-5-5"');
    rpc.socket.close();
  });

  it("sends a message to the session as the user, with the command id as the prompt id", async () => {
    const rpc = await openRpc(ADMIN);
    const exit = await rpc.exitOf(
      rpc.request("orchestration.dispatchCommand", {
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: "cmd-1",
        threadId: BORN_AS,
        messageId: "client-m1",
        text: "hello from T3",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      }),
    );
    expect(exit.exit?._tag).toBe("Success");
    expect(lobby?.posts.at(-1)).toEqual({
      path: `/prompt/${SESSION_NAME}`,
      body: { text: "hello from T3", id: "cmd-1" },
    });
    rpc.socket.close();
  });

  it("points project favicons at a URL that answers 404, as T3 does for a project without one", async () => {
    const rpc = await openRpc(ADMIN);
    const exit = await rpc.exitOf(
      rpc.request("assets.createUrl", {
        resource: { _tag: "project-favicon", cwd: "/home/wizard" },
      }),
    );
    expect(exit.exit?._tag).toBe("Success");
    const { relativeUrl } = Schema.decodeUnknownSync(Schema.toCodecJson(AssetCreateUrlResult))(
      exit.exit?.value,
    );
    expect((await get(relativeUrl, ADMIN)).status).toBe(404);
    rpc.socket.close();
  });

  it("refuses terminal RPCs by scope before any handler runs", async () => {
    const rpc = await openRpc(ADMIN);
    const exit = await rpc.exitOf(
      rpc.request("terminal.open", { threadId: "t", terminalId: "x", cwd: "/" }),
    );
    expect(exit.exit?._tag).toBe("Failure");
    expect(JSON.stringify(exit.exit?.cause)).toContain("EnvironmentAuthorizationError");
    rpc.socket.close();
  });

  it("dies on a unary RPC it does not serve, like T3's unknown tag", async () => {
    const rpc = await openRpc(ADMIN);
    const exit = await rpc.exitOf(rpc.request("server.getSettings", {}));
    expect(exit.exit?._tag).toBe("Failure");
    expect(JSON.stringify(exit.exit?.cause)).toContain(
      "tl-t3-view does not serve server.getSettings",
    );
    rpc.socket.close();
  });
});

const post = (path: string, headers: Record<string, string>, body?: string) =>
  fetch(`${base}${path}`, { method: "POST", headers, ...(body === undefined ? {} : { body }) });

async function ticketFor(headers: Record<string, string>): Promise<string> {
  const response = await post("/api/auth/websocket-ticket", headers);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ticket: string; expiresAt: string };
  return body.ticket;
}

const tokenForm = (code: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: code,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    ...extra,
  }).toString();

const FORM = { "content-type": "application/x-www-form-urlencoded" };

// Read here rather than written out, so moving the pin (t3-stable.yml) does not
// fail this test.
const PINNED_TAG = /^tag=(.+)$/m.exec(readFileSync(new URL("../T3_PIN", import.meta.url), "utf8"))![1]!;

describe("paired apps: credential-less routes", () => {
  it("answers the environment descriptor without credentials, readable cross-origin", async () => {
    const response = await get("/.well-known/t3/environment", { origin: "t3code://app" });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(await response.json()).toMatchObject({
      environmentId: environmentIdFor("test"),
      orchestrationProtocolVersion: 2,
      serverVersion: serverVersionOf(PINNED_TAG),
    });
  });

  it("answers a CORS preflight on any route with T3's methods and headers", async () => {
    for (const path of ["/api/auth/websocket-ticket", "/oauth/token", "/api/orchestration/shell"]) {
      const response = await fetch(`${base}${path}`, {
        method: "OPTIONS",
        headers: {
          origin: "t3code://app",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization",
        },
      });
      expect(response.status, path).toBe(204);
      expect(Object.fromEntries(response.headers)).toMatchObject({
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers":
          "authorization,b3,traceparent,content-type,dpop,x-t3-orchestration-protocol",
        "access-control-max-age": "600",
      });
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });

  it("tells a caller with no credential that it is not signed in", async () => {
    const response = await get("/api/auth/session");
    expect(response.status).toBe(200);
    const body = Schema.decodeUnknownSync(Schema.toCodecJson(AuthSessionState))(
      await response.json(),
    );
    expect(body.authenticated).toBe(false);
    expect(body.auth.bootstrapMethods).toContain("one-time-token");
  });

  it("exchanges a pairing code for a device token, passing the app's details on", async () => {
    const response = await post(
      "/oauth/token",
      { ...FORM, origin: "t3code://app", "sec-fetch-site": "cross-site" },
      tokenForm(PAIRING_CODE, {
        client_label: "Pixel 9",
        client_device_type: "mobile",
        client_os: "Android",
        scope: "orchestration:read",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = Schema.decodeUnknownSync(Schema.toCodecJson(AuthAccessTokenResult))(
      await response.json(),
    );
    expect(body).toMatchObject({
      access_token: "tld1_paired",
      token_type: "Bearer",
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "orchestration:read orchestration:operate filesystem:read",
    });
    expect(body.expires_in).toBeGreaterThan(365 * 24 * 60 * 60);
    expect(exchanges.at(-1)).toEqual({
      code: PAIRING_CODE,
      label: "Pixel 9",
      deviceType: "mobile",
      os: "Android",
    });
    // The new token works at once.
    const session = await get("/api/auth/session", { authorization: "Bearer tld1_paired" });
    expect(await session.json()).toMatchObject({
      authenticated: true,
      sessionMethod: "bearer-access-token",
    });
  });

  it("refuses a bad pairing code with T3's JSON 401, and a malformed exchange with 400", async () => {
    const bad = await post("/oauth/token", FORM, tokenForm("WRONG-CODE"));
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({
      _tag: "EnvironmentAuthInvalidError",
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: expect.any(String),
    });
    const malformed = await post("/oauth/token", FORM, "grant_type=password&subject_token=x");
    expect(malformed.status).toBe(400);
    const badScope = await post("/oauth/token", FORM, tokenForm(PAIRING_CODE, { scope: "a  b" }));
    expect(badScope.status).toBe(400);
    expect(await badScope.json()).toMatchObject({
      _tag: "EnvironmentRequestInvalidError",
      reason: "invalid_scope",
    });
  });
});

describe("paired apps: the bearer path", () => {
  it("answers the session for a bearer, and tells a refused bearer it is not signed in", async () => {
    const good = await get("/api/auth/session", DEVICE);
    expect(good.headers.get("access-control-allow-origin")).toBe("*");
    expect(await good.json()).toMatchObject({
      authenticated: true,
      sessionMethod: "bearer-access-token",
      permissions: ["orchestration:read", "orchestration:operate", "filesystem:read"],
    });
    const bad = await get("/api/auth/session", BAD_DEVICE);
    expect(bad.status).toBe(200);
    expect(await bad.json()).toMatchObject({ authenticated: false });
  });

  it("serves the shell to a bearer, relaying the bearer to the lobby", async () => {
    const response = await get("/api/orchestration/shell", {
      ...DEVICE,
      "x-t3-orchestration-protocol": "2",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const shell = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ShellSnapshot))(
      await response.json(),
    );
    expect(shell.threads.map((t) => t.id)).toEqual([BORN_AS]);
  });

  it("refuses a bad bearer with T3's JSON 401 and CORS, on every guarded route", async () => {
    for (const path of ["/api/orchestration/shell", "/", "/.well-known/t3/thread/x"]) {
      const response = await get(path, BAD_DEVICE);
      expect(response.status, path).toBe(401);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.json()).toMatchObject({
        _tag: "EnvironmentAuthInvalidError",
        code: "auth_invalid",
        reason: "invalid_credential",
      });
    }
    const empty = await get("/api/orchestration/shell", { authorization: "Bearer " });
    expect(await empty.json()).toMatchObject({ reason: "missing_credential" });
  });

  it("never consults the header gate for a bearer request, even beside a valid identity", async () => {
    whoamiCalls.length = 0;
    const response = await get("/api/orchestration/shell", {
      ...ADMIN,
      ...BAD_DEVICE,
      "x-t3-orchestration-protocol": "2",
    });
    expect(response.status).toBe(401);
    expect(whoamiCalls).toEqual([{ bearer: "tld1_revoked" }]);
  });

  it("exempts a bearer write from the cross-site check, and still applies it to a browser", async () => {
    const headers = { "sec-fetch-site": "cross-site", origin: "t3code://app" };
    expect((await post("/api/observability/v1/traces", { ...DEVICE, ...headers }, "{}")).status).toBe(
      204,
    );
    expect((await post("/api/observability/v1/traces", { ...ADMIN, ...headers }, "{}")).status).toBe(
      403,
    );
  });

  it("answers a browser opening /pair with a harmless success", async () => {
    const response = await post(
      "/api/auth/browser-session",
      { ...ADMIN, "content-type": "application/json" },
      JSON.stringify({ credential: PAIRING_CODE }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      authenticated: true,
      sessionMethod: "browser-session-cookie",
    });
  });

  it("serves a thread's transcript from its live projection", async () => {
    const response = await get(`/api/orchestration/threads/${BORN_AS}/transcript`, {
      ...DEVICE,
      "x-t3-orchestration-protocol": "2",
    });
    expect(response.status).toBe(200);
    const transcript = Schema.decodeUnknownSync(
      Schema.toCodecJson(OrchestrationV2ThreadTranscript),
    )(await response.json());
    expect(transcript.threadId).toBe(BORN_AS);
    // The fixture's first turn, then whatever earlier tests sent on this thread.
    expect(transcript.items.slice(0, 3).map((r) => r.item.type)).toEqual([
      "user_message",
      "command_execution",
      "assistant_message",
    ]);
    const missing = await get("/api/orchestration/threads/nope/transcript", {
      ...DEVICE,
      "x-t3-orchestration-protocol": "2",
    });
    expect(missing.status).toBe(404);
  });
});

describe("paired apps: WebSocket tickets", () => {
  it("issues a ticket to a bearer only", async () => {
    const response = await post("/api/auth/websocket-ticket", DEVICE);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await response.json()) as { ticket: string; expiresAt: string };
    expect(body.ticket.length).toBeGreaterThan(20);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    const browser = await post("/api/auth/websocket-ticket", ADMIN);
    expect(browser.status).toBe(401);
    expect(await browser.json()).toMatchObject({ reason: "missing_credential" });
    expect((await post("/api/auth/websocket-ticket", BAD_DEVICE)).status).toBe(401);
  });

  it("upgrades with a ticket from another origin, once", async () => {
    const ticket = await ticketFor(DEVICE);
    const query = `&wsTicket=${encodeURIComponent(ticket)}`;
    const rpc = await openRpc({}, "t3code://app", query);
    const probe = await rpc.exitOf(rpc.request("server.probe", {}));
    expect(probe.exit).toEqual({ _tag: "Success", value: {} });
    rpc.socket.close();
    await expect(openRpc({}, "t3code://app", query)).rejects.toThrow("websocket refused");
    const reused = await get(`/ws?orchestrationProtocol=2${query}`, { origin: "t3code://app" });
    expect(reused.status).toBe(401);
    expect(await reused.json()).toMatchObject({ _tag: "EnvironmentAuthInvalidError" });
  });

  it("refuses an expired ticket", async () => {
    const ticket = await ticketFor(DEVICE);
    ticketClock.now += 60_001;
    try {
      await expect(
        openRpc({}, "t3code://app", `&wsTicket=${encodeURIComponent(ticket)}`),
      ).rejects.toThrow("websocket refused");
    } finally {
      ticketClock.now -= 60_001;
    }
  });

  it("never falls back to the identity header when a ticket is refused", async () => {
    await expect(openRpc(ADMIN, base, "&wsTicket=made-up")).rejects.toThrow("websocket refused");
  });
});

describe("paired apps: revocation", () => {
  it("closes a revoked device's socket within one re-check and moves the stream it shared", async () => {
    const thread = { threadId: BORN_AS, requestCompletionMarker: true };
    // The device subscribes first, with no other socket open, so the shared
    // upstream stream moves to the device's credential.
    const device = await openRpc(
      {},
      "t3code://app",
      `&wsTicket=${encodeURIComponent(await ticketFor({ authorization: "Bearer tld1_other" }))}`,
    );
    await device.chunkOf(device.request("orchestration.subscribeThread", thread));
    const streamsBefore = lobby?.streams.length ?? 0;
    await waitFor(() => lobby?.streams.at(-1)?.auth === "bearer:tld1_other");

    const browser = await openRpc(ADMIN);
    const watched = browser.request("orchestration.subscribeThread", thread);
    await browser.chunkOf(watched);

    devices.delete("tld1_other");
    const closed = await device.closed;
    expect(closed.code).toBe(AUTH_CLOSE_CODE);

    // The stream reopens under the browser's credential, resuming.
    await waitFor(() => lobby?.streams.at(-1)?.auth === "proxy:viktor");
    expect(lobby?.streams.length).toBeGreaterThan(streamsBefore);
    expect(lobby?.streams.at(-1)?.path).toContain("lastEventId=");

    lobby?.push(
      `id: 30\ndata: ${JSON.stringify({ id: 30, kind: "user", session: SESSION_NAME, turnId: "t9", body: "after revoke", at: 2 })}\n\n`,
    );
    const live = await browser.until((all) =>
      all.find(
        (f) =>
          f._tag === "Chunk" &&
          f.requestId === watched &&
          JSON.stringify(f.values).includes("after revoke"),
      ),
    );
    expect(live).toBeDefined();
    browser.socket.close();
    // A revoked device's ticket request is refused from now on.
    expect((await post("/api/auth/websocket-ticket", { authorization: "Bearer tld1_other" })).status).toBe(401);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
