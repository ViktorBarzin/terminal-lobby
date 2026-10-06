/**
 * The public-links client (lib/links-api.ts): the routes it calls under the
 * tmux-api prefix, the body a create sends, and the server's own words
 * surviving into the error a person sees.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLink, listLinks, revokeLink, revokeSessionLinks } from "../src/lib/links-api";

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

describe("links-api", () => {
  it("lists from GET /api/sessions/links", async () => {
    const calls = stubFetch(200, "[]");
    expect(await listLinks()).toEqual([]);
    expect(calls[0]?.url).toBe("/api/sessions/links");
    expect(calls[0]?.init?.method).toBeUndefined();
  });

  it("creates with name, mode and ttl, and hands back the token", async () => {
    const calls = stubFetch(
      201,
      JSON.stringify({ link: { id: "L1", session: "s", mode: "ro" }, token: "tok" }),
    );
    const got = await createLink({ name: "s", mode: "ro", ttl: "7d", note: "for Ana" });
    expect(got.token).toBe("tok");
    expect(calls[0]?.url).toBe("/api/sessions/links");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "s",
      mode: "ro",
      ttl: "7d",
      note: "for Ana",
    });
  });

  it("carries the server's refusal text into the error", async () => {
    stubFetch(400, "invalid lifetime: 1h, 24h, 7d or never; a read-write link lasts at most 24h\n");
    await expect(createLink({ name: "s", mode: "rw", ttl: "never" })).rejects.toThrow(
      /a read-write link lasts at most 24h/,
    );
  });

  it("revokes one link by id, and a link already gone is not an error", async () => {
    const calls = stubFetch(204, "");
    await revokeLink("a/b");
    expect(calls[0]?.url).toBe("/api/sessions/links/a%2Fb");
    expect(calls[0]?.init?.method).toBe("DELETE");
    stubFetch(404, "no such link");
    await expect(revokeLink("gone")).resolves.toBeUndefined();
  });

  it("stops every link on a session by name, and says how many", async () => {
    const calls = stubFetch(200, JSON.stringify({ revoked: 2 }));
    expect(await revokeSessionLinks("my session")).toBe(2);
    expect(calls[0]?.url).toBe("/api/sessions/links?session=my%20session");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });
});
