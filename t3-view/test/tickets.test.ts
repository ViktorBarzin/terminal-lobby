import { describe, expect, it } from "vitest";

import { WsTickets } from "../src/tickets.ts";

describe("WsTickets", () => {
  it("hands back the bearer a ticket was issued for, once", () => {
    const tickets = new WsTickets({ now: () => 1_000 });
    const { ticket, expiresAt } = tickets.issue("tld1_a");
    expect(expiresAt).toBe(61_000);
    expect(ticket).not.toContain("tld1_a");
    expect(tickets.consume(ticket)).toBe("tld1_a");
    expect(tickets.consume(ticket)).toBeUndefined();
  });

  it("refuses a ticket after its expiry, and one it never issued", () => {
    const clock = { now: 1_000 };
    const tickets = new WsTickets({ now: () => clock.now, ttlMs: 60_000 });
    const { ticket } = tickets.issue("tld1_a");
    clock.now += 60_000;
    expect(tickets.consume(ticket)).toBeUndefined();
    expect(tickets.consume("made-up")).toBeUndefined();
  });

  it("issues a different ticket every time", () => {
    const tickets = new WsTickets();
    const seen = new Set(Array.from({ length: 50 }, () => tickets.issue("tld1_a").ticket));
    expect(seen.size).toBe(50);
  });

  it("holds at most `max` tickets, dropping the oldest", () => {
    const tickets = new WsTickets({ max: 3 });
    const first = tickets.issue("tld1_1").ticket;
    for (let i = 2; i <= 4; i++) tickets.issue(`tld1_${i}`);
    expect(tickets.size).toBe(3);
    expect(tickets.consume(first)).toBeUndefined();
  });
});
