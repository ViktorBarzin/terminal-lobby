import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { tmuxApiWhoami } from "../src/whoami.ts";

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function serve(
  handler: (headers: IncomingHttpHeaders, path: string | undefined) => [number, string],
): Promise<string> {
  server = createServer((req, res) => {
    const [status, body] = handler(req.headers, req.url);
    res.writeHead(status, { "content-type": "application/json" }).end(body);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("tmuxApiWhoami", () => {
  it("relays the identity header and the secret to GET /whoami", async () => {
    let seen: { headers: IncomingHttpHeaders; path: string | undefined } | undefined;
    const base = await serve((headers, path) => {
      seen = { headers, path };
      return [200, JSON.stringify({ authentik: "viktor", osUser: "wizard", admin: true })];
    });
    const result = await tmuxApiWhoami(base)({
      header: "X-Authentik-Username",
      identity: "viktor",
      secret: "s3cret",
    });
    expect(result).toEqual({
      status: 200,
      body: { authentik: "viktor", osUser: "wizard", admin: true },
    });
    expect(seen?.path).toBe("/whoami");
    expect(seen?.headers["x-authentik-username"]).toBe("viktor");
    expect(seen?.headers["x-tl-proxy-secret"]).toBe("s3cret");
  });

  it("returns the status and no body for a refusal", async () => {
    const base = await serve(() => [401, "missing or incorrect proxy secret"]);
    const result = await tmuxApiWhoami(base)({ header: "X-A", identity: "v", secret: "x" });
    expect(result).toEqual({ status: 401, body: undefined });
  });

  it("treats an unparseable 200 body as no body", async () => {
    const base = await serve(() => [200, "not json"]);
    const result = await tmuxApiWhoami(base)({ header: "X-A", identity: "v", secret: "x" });
    expect(result).toEqual({ status: 200, body: undefined });
  });
});
