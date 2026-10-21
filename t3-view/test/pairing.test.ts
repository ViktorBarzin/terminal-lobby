import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { tmuxApiExchange } from "../src/pairing.ts";

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function serve(
  handler: (seen: { headers: IncomingHttpHeaders; path?: string; body: string }) => [number, string],
): Promise<string> {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8");
    });
    req.on("end", () => {
      const [status, out] = handler({
        headers: req.headers,
        body,
        ...(req.url === undefined ? {} : { path: req.url }),
      });
      res.writeHead(status, { "content-type": "application/json" }).end(out);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("tmuxApiExchange", () => {
  it("posts the code and the app's details, with no forwarding headers, and returns the token", async () => {
    let seen: { headers: IncomingHttpHeaders; path?: string; body: string } | undefined;
    const base = await serve((s) => {
      seen = s;
      return [200, JSON.stringify({ token: "tld1_new", id: "ab", user: "wizard", expiresIn: 0 })];
    });
    const result = await tmuxApiExchange(base)({
      code: "ABCD-EFGH-JKLM",
      label: "Pixel",
      deviceType: "mobile",
      os: "Android",
    });
    expect(result).toEqual({ ok: true, token: "tld1_new" });
    expect(seen?.path).toBe("/devices/exchange");
    expect(JSON.parse(seen?.body ?? "")).toEqual({
      code: "ABCD-EFGH-JKLM",
      label: "Pixel",
      deviceType: "mobile",
      os: "Android",
    });
    for (const h of ["x-real-ip", "x-forwarded-for", "forwarded", "authorization"]) {
      expect(seen?.headers[h], h).toBeUndefined();
    }
  });

  it("passes tmux-api's 401 for a bad code through", async () => {
    const base = await serve(() => [401, JSON.stringify({ error: "invalid or expired pairing code" })]);
    expect(await tmuxApiExchange(base)({ code: "nope" })).toMatchObject({ ok: false, status: 401 });
  });

  it("answers 502 for anything else", async () => {
    const base = await serve(() => [403, JSON.stringify({ error: "forbidden" })]);
    expect(await tmuxApiExchange(base)({ code: "x" })).toMatchObject({ ok: false, status: 502 });
    expect(await tmuxApiExchange("http://127.0.0.1:1")({ code: "x" })).toMatchObject({
      ok: false,
      status: 502,
    });
  });
});
