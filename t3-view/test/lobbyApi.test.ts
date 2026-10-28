import { describe, expect, it } from "vitest";

import { LobbyApi, LobbyError } from "../src/lobby/api.ts";

const relay = { header: "X-Authentik-Username", identity: "viktor", secret: "s" };

function capture(status: number, body = "") {
  const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
    });
    return new Response(body === "" ? null : body, { status });
  }) as typeof globalThis.fetch;
  const api = new LobbyApi({
    tmuxApiUrl: "http://tmux-api",
    sessionEventsUrl: "http://session-events",
    fetch,
  });
  return { api, seen };
}

describe("LobbyApi.kill", () => {
  it("deletes the session by name in tmux-api, as the user", async () => {
    const { api, seen } = capture(204);
    await api.kill(relay, "brisk-otter", undefined);
    expect(seen).toEqual([
      {
        url: "http://tmux-api/sessions/brisk-otter",
        method: "DELETE",
        headers: expect.objectContaining({ "X-Authentik-Username": "viktor" }),
      },
    ]);
  });

  it("names the owner of a session shared with the user", async () => {
    const { api, seen } = capture(204);
    await api.kill(relay, "brisk-otter", "emo");
    expect(seen[0]?.url).toBe("http://tmux-api/sessions/brisk-otter?owner=emo");
  });

  it("throws the lobby's refusal", async () => {
    const { api } = capture(404, "session not found\n");
    await expect(api.kill(relay, "brisk-otter", undefined)).rejects.toEqual(
      new LobbyError(404, "session not found\n"),
    );
  });
});
