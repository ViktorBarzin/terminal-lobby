import { describe, it, expect } from "vitest";
import { steerAgent } from "../src/lib/steer-api";

const answer = (status: number, body = "") =>
  (async () => new Response(status === 204 ? null : body, { status })) as never;

describe("steerAgent", () => {
  it("posts the text to the agent's message route", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const r = await steerAgent("demo", "a#1", "stop now", (async (u: string, i?: RequestInit) => {
      url = u;
      init = i;
      return new Response(null, { status: 204 });
    }) as never);
    expect(r).toEqual({ kind: "sent" });
    expect(url).toContain("/events/demo/agents/a%231/message");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ text: "stop now" });
  });
  it("keeps the words out of the field when delivery is unconfirmed", async () => {
    expect(await steerAgent("s", "a", "x", answer(504))).toEqual({ kind: "unconfirmed" });
  });
  it("treats the agent's own state as final and anything else as retryable", async () => {
    expect(await steerAgent("s", "a", "x", answer(409, "this agent has finished\n"))).toEqual({
      kind: "refused",
      message: "this agent has finished",
      final: true,
    });
    expect(await steerAgent("s", "a", "x", answer(502, "refused"))).toMatchObject({ final: false });
    expect(await steerAgent("s", "a", "x", answer(501, "restart it"))).toMatchObject({
      final: true,
    });
  });
});
