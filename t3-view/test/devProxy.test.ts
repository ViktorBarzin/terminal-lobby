/**
 * scripts/dev-proxy.mjs stamps an admin identity and the real proxy secret on
 * what it forwards, and loopback is reachable by every OS user on the devvm.
 * It must serve only the browser that opened the token link it printed.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingHttpHeaders, type Server, createServer, request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = new URL("../scripts/dev-proxy.mjs", import.meta.url).pathname;

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** The first response line the proxy writes back to a raw WebSocket upgrade. */
function upgrade(port: number, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      const lines = [
        "GET /ws HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ];
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (data.includes("\r\n")) {
        socket.destroy();
        resolve(data.slice(0, data.indexOf("\r\n")));
      }
    });
    socket.on("close", () => resolve(data.split("\r\n")[0] ?? ""));
    socket.on("error", reject);
  });
}

describe("dev-proxy", () => {
  let dir: string;
  let target: Server;
  let proxy: ChildProcess;
  let port = 0;
  let link = "";
  const seen: IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dev-proxy-"));
    writeFileSync(join(dir, "secret"), "s3cret\n", { mode: 0o600 });
    target = createServer((req, res) => {
      seen.push(req.headers);
      res.end("upstream");
    });
    target.on("upgrade", (_req, socket) => {
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    const targetPort = typeof address === "object" && address !== null ? address.port : 0;
    proxy = spawn(
      process.execPath,
      [
        SCRIPT,
        "--listen",
        "127.0.0.1:0",
        "--target",
        `127.0.0.1:${targetPort}`,
        "--identity",
        "viktor",
        "--secret-file",
        join(dir, "secret"),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    link = await new Promise<string>((resolve, reject) => {
      let err = "";
      proxy.stderr?.setEncoding("utf8");
      proxy.stderr?.on("data", (chunk: string) => {
        err += chunk;
        const found = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(err);
        if (found !== null) resolve(found[0]);
      });
      proxy.on("exit", (code) => reject(new Error(`dev-proxy exited ${code}: ${err}`)));
    });
    port = Number(new URL(link).port);
  });

  afterAll(async () => {
    proxy.kill();
    await new Promise<void>((resolve) => target.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a request without the cookie, and forwards nothing", async () => {
    const reply = await get(port, "/");
    expect(reply.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("refuses a wrong token", async () => {
    const reply = await get(port, "/?token=guess");
    expect(reply.status).toBe(401);
    expect(reply.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a WebSocket upgrade without the cookie", async () => {
    expect(await upgrade(port)).toMatch(/^HTTP\/1\.1 401/);
  });

  it("trades the printed token for an HttpOnly cookie and drops the token from the URL", async () => {
    const reply = await get(port, new URL(link).pathname + new URL(link).search);
    expect(reply.status).toBe(302);
    expect(reply.headers.location).toBe("/");
    const cookie = reply.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it("forwards a request carrying the cookie with the identity and secret, minus the cookie", async () => {
    const minted = await get(port, new URL(link).pathname + new URL(link).search);
    const pair = (minted.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
    const reply = await get(port, "/x", {
      cookie: `other=1; ${pair}`,
      "x-authentik-username": "someone-else",
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe("upstream");
    const headers = seen.at(-1);
    expect(headers?.["x-authentik-username"]).toBe("viktor");
    expect(headers?.["x-tl-proxy-secret"]).toBe("s3cret");
    expect(headers?.cookie).toBe("other=1");
    expect(await upgrade(port, { Cookie: pair })).toMatch(/^HTTP\/1\.1 101/);
  });
});
