import { describe, it, expect } from "vitest";
import { messageTime, msUntilMidnight } from "../src/components/message-time.logic";

// Local-time constructors, so the cases hold in whatever zone the suite runs.
const at = (y: number, mo: number, d: number, h = 14, mi = 5) =>
  new Date(y, mo - 1, d, h, mi).getTime();
const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const NOW = at(2026, 11, 3, 16, 30); // a Tuesday

describe("messageTime", () => {
  it("shows only the time for a message sent today", () => {
    const sent = at(2026, 11, 3, 9, 41);
    expect(messageTime(sent, NOW)).toBe(hhmm(sent));
  });

  it("counts a message from just before midnight as yesterday", () => {
    const sent = at(2026, 11, 2, 23, 59);
    expect(messageTime(sent, at(2026, 11, 3, 0, 1))).toBe(`Yesterday ${hhmm(sent)}`);
  });

  it.each([2, 6])("names the weekday for a message %i days old", (back) => {
    const sent = at(2026, 11, 3 - back);
    const day = new Date(sent).toLocaleDateString([], { weekday: "short" });
    expect(messageTime(sent, NOW)).toBe(`${day} ${hhmm(sent)}`);
  });

  it("gives the date for a message a week or more old", () => {
    const sent = at(2026, 10, 27);
    const date = new Date(sent).toLocaleDateString([], { day: "numeric", month: "short" });
    expect(messageTime(sent, NOW)).toBe(`${date} ${hhmm(sent)}`);
  });

  it("adds the year when the message is from another year", () => {
    const sent = at(2025, 12, 20);
    const date = new Date(sent).toLocaleDateString([], {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    expect(messageTime(sent, at(2026, 1, 9))).toBe(`${date} ${hhmm(sent)}`);
  });

  it("gives a date, not a weekday, for a stamp ahead of the clock by a day", () => {
    const sent = at(2026, 11, 4);
    const date = new Date(sent).toLocaleDateString([], { day: "numeric", month: "short" });
    expect(messageTime(sent, NOW)).toBe(`${date} ${hhmm(sent)}`);
  });
});

describe("msUntilMidnight", () => {
  it("is the time left until the next local midnight", () => {
    expect(msUntilMidnight(at(2026, 11, 3, 23, 30))).toBe(30 * 60_000);
  });

  it("is a full day at midnight itself", () => {
    const midnight = at(2026, 11, 3, 0, 0);
    expect(msUntilMidnight(midnight)).toBe(at(2026, 11, 4, 0, 0) - midnight);
  });
});
