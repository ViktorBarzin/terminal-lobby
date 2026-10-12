import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AssetCreateUrlResult,
  AuthSessionState,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpServer } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProxyAuthGate, type WhoamiFetch } from "../src/auth.ts";
import { environmentDescriptor, environmentIdFor } from "../src/descriptor.ts";
import { SequenceClock } from "../src/sequence.ts";
import { sidecarLayer } from "../src/server.ts";
import { placeholderShell } from "../src/shell.ts";

const ADMIN = { "x-authentik-username": "viktor", "x-tl-proxy-secret": "s3cret" };
const NOT_ADMIN = { "x-authentik-username": "anca", "x-tl-proxy-secret": "s3cret" };
const WRONG_SECRET = { "x-authentik-username": "viktor", "x-tl-proxy-secret": "guess" };

const whoami: WhoamiFetch = async (relay) => {
  if (relay.secret !== "s3cret") return { status: 401, body: undefined };
  if (relay.identity === "viktor") {
    return { status: 200, body: { authentik: "viktor", osUser: "wizard", admin: true } };
  }
  return { status: 200, body: { authentik: relay.identity, osUser: relay.identity, admin: false } };
};

let base = "";
let webDir = "";
let scope: Scope.Closeable | undefined;
const clock = new SequenceClock(1_791_800_000_000);

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "tl-t3-view-web-"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>T3</title>");
  mkdirSync(join(webDir, "assets"));
  writeFileSync(join(webDir, "assets", "index-AbCd1234.js"), "export {};");
  const startedAt = "2026-10-12T08:00:00.000Z";
  const descriptor = environmentDescriptor({
    environmentId: environmentIdFor("test"),
    label: "test",
  });
  const layer = sidecarLayer(
    {
      gate: new ProxyAuthGate({ authHeader: "X-Authentik-Username", whoami }),
      webDir,
      config: { descriptor, cwd: "/", startedAt },
      clock,
      shell: (identity) =>
        Effect.sync(() =>
          placeholderShell({
            osUser: identity.osUser,
            snapshotSequence: clock.current(),
            startedAt,
          }),
        ),
    },
    { host: "127.0.0.1", port: 0 },
  );
  const opened = Effect.runSync(Scope.make());
  scope = opened;
  const context = await Effect.runPromise(Layer.buildWithScope(layer, opened));
  base = HttpServer.formatAddress(Context.get(context, HttpServer.HttpServer).address);
});

afterAll(async () => {
  if (scope) await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(webDir, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers });

describe("auth gate on every route", () => {
  it.each([
    "/",
    "/assets/index-AbCd1234.js",
    "/.well-known/t3/environment",
    "/api/auth/session",
    "/api/orchestration/shell",
    "/ws?orchestrationProtocol=2",
    "/some/app/route",
    "/api/unknown",
  ])(
    "refuses %s without credentials (401), a wrong secret (401) and a non-admin (403)",
    async (path) => {
      expect((await get(path)).status).toBe(401);
      expect((await get(path, WRONG_SECRET)).status).toBe(401);
      expect((await get(path, NOT_ADMIN)).status).toBe(403);
    },
  );

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

    const route = await get("/env-1/thread-1", ADMIN);
    expect(await route.text()).toContain("<title>T3</title>");

    const asset = await get("/assets/index-AbCd1234.js", ADMIN);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");

    expect((await get("/assets/missing-AbCd1234.js", ADMIN)).status).toBe(404);
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
    expect(shell.snapshotSequence).toBe(clock.current());
    expect(shell.projects[0]?.workspaceRoot).toBe("/home/wizard");
  });

  it("404s unknown API paths instead of serving index.html", async () => {
    expect((await get("/api/orchestration/threads/x/bounded", ADMIN)).status).toBe(404);
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
    const response = await get("/ws?orchestrationProtocol=1", ADMIN);
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
async function openRpc(headers: Record<string, string>) {
  const url = `${base.replace("http", "ws")}/ws?orchestrationProtocol=2`;
  const socket = new WebSocket(url, { headers });
  const frames: Frame[] = [];
  const waiters: Array<() => void> = [];
  socket.addEventListener("message", (event) => {
    const parsed: unknown = JSON.parse(String(event.data));
    for (const frame of Array.isArray(parsed) ? parsed : [parsed]) frames.push(frame);
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
  return { socket, request, exitOf, chunkOf };
}

describe("RPC over /ws", () => {
  it("refuses the upgrade without credentials", async () => {
    await expect(openRpc({})).rejects.toThrow("websocket refused");
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
