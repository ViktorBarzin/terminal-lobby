/**
 * The paired-devices client (lib/devices-api.ts): the tmux-api routes it calls
 * under the lobby's prefix, and the server's own words surviving into the
 * error a person sees.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { listDevices, pairDevice, revokeDevice } from "../src/lib/devices-api";

interface Call {
  url: string;
  init?: RequestInit;
}

function stubFetch(status: number, body: string): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(status === 204 ? null : body, { status });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("devices-api", () => {
  it("pairs with POST /devices/pair and hands back the code and its expiry", async () => {
    const calls = stubFetch(200, JSON.stringify({ code: "ABCDEFGHJKLM", expiresAt: 1800000300 }));
    expect(await pairDevice()).toEqual({ code: "ABCDEFGHJKLM", expiresAt: 1800000300 });
    expect(calls[0]?.url).toBe("/api/sessions/devices/pair");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("refuses an answer that is not a code", async () => {
    stubFetch(200, JSON.stringify({ code: 7 }));
    await expect(pairDevice()).rejects.toThrow();
  });

  it("carries the server's reason for a 429", async () => {
    stubFetch(
      429,
      JSON.stringify({ error: "too many pairing codes outstanding; wait for one to expire" }),
    );
    await expect(pairDevice()).rejects.toThrow(
      "too many pairing codes outstanding; wait for one to expire",
    );
  });

  it("falls back to the status when the body says nothing", async () => {
    stubFetch(502, "");
    await expect(pairDevice()).rejects.toThrow("pair HTTP 502");
  });

  it("lists from GET /devices", async () => {
    const device = {
      id: "a1b2c3d4e5f60718",
      label: "Pixel",
      deviceType: "mobile",
      os: "android",
      created: 1800000000,
      lastSeen: 0,
    };
    const calls = stubFetch(200, JSON.stringify([device]));
    expect(await listDevices()).toEqual([device]);
    expect(calls[0]?.url).toBe("/api/sessions/devices");
    expect(calls[0]?.init?.method).toBeUndefined();
  });

  it("reads a non-array list as empty", async () => {
    stubFetch(200, "null");
    expect(await listDevices()).toEqual([]);
  });

  it("revokes with DELETE /devices/{id}, a device already gone included", async () => {
    const calls = stubFetch(204, "");
    await revokeDevice("a1b2c3d4e5f60718");
    expect(calls[0]?.url).toBe("/api/sessions/devices/a1b2c3d4e5f60718");
    expect(calls[0]?.init?.method).toBe("DELETE");
    stubFetch(404, JSON.stringify({ error: "no such device" }));
    await expect(revokeDevice("a1b2c3d4e5f60718")).resolves.toBeUndefined();
  });

  it("says why a revoke was refused", async () => {
    stubFetch(
      403,
      JSON.stringify({ error: "devices are paired and revoked from a signed-in browser" }),
    );
    await expect(revokeDevice("a1b2c3d4e5f60718")).rejects.toThrow(
      "devices are paired and revoked from a signed-in browser",
    );
  });
});
