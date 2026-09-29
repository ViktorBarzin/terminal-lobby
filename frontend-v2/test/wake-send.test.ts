/**
 * A message sent at a suspended session wakes it and goes in once Claude can
 * take it.
 *
 * Found in review on 2026-09-27 against 0.78.0. Before this, Send at a
 * suspended session cleared the field and held the text in module memory
 * until somebody clicked the sidebar row: nothing started a resume, and a
 * reload lost the text. When the row was clicked, the held text was posted
 * about 1.6 s into `claude --resume`, landed in Claude's input box unsent, and
 * the view sat on "Working" until a reload.
 */
import { describe, it, expect, vi } from "vitest";
import { sendWaking } from "../src/store/wake-send";

function setup(suspended: boolean, resumed = true) {
  const order: string[] = [];
  const resume = vi.fn(async () => {
    order.push("resume");
    return resumed;
  });
  const send = vi.fn(async (text: string, o?: { awaitReady?: boolean }) => {
    order.push(o?.awaitReady ? `send-ready:${text}` : `send:${text}`);
    return true;
  });
  const notify = vi.fn();
  const go = sendWaking({ suspended: () => suspended, resume, send, notify });
  return { go, resume, send, notify, order };
}

describe("sendWaking", () => {
  it("sends straight away to a live session", async () => {
    const s = setup(false);
    expect(await s.go("hello")).toBe(true);
    expect(s.order).toEqual(["send:hello"]);
    expect(s.resume).not.toHaveBeenCalled();
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("wakes a suspended session, then sends with the server's readiness wait", async () => {
    const s = setup(true);
    expect(await s.go("Reply with the word: kiwi")).toBe(true);
    expect(s.order).toEqual(["resume", "send-ready:Reply with the word: kiwi"]);
    expect(s.notify).toHaveBeenCalledWith(expect.stringMatching(/waking/i), "info");
  });

  it("keeps the text when the session would not wake", async () => {
    const s = setup(true, false);
    expect(await s.go("hello")).toBe(false);
    expect(s.send).not.toHaveBeenCalled();
  });
});

/**
 * Deployed review round 5 (2026-09-29): for about 2 s after Send the field was
 * empty, no bubble showed, and only a toast said the message existed. It shows
 * as sent from the moment the wake starts, and goes if the wake fails (the
 * field gets it back).
 */
describe("sendWaking: the message while the session wakes", () => {
  it("shows the message from the moment the wake starts until the send has it", async () => {
    const order: string[] = [];
    let wake!: (ok: boolean) => void;
    const go = sendWaking({
      suspended: () => true,
      resume: () => new Promise<boolean>((r) => (wake = r)),
      send: async (t) => {
        order.push(`send:${t}`);
        return true;
      },
      hold: (t) => {
        order.push(`hold:${t}`);
        return () => order.push("release");
      },
    });
    const sending = go("Reply AWAKE");
    expect(order).toEqual(["hold:Reply AWAKE"]);
    wake(true);
    expect(await sending).toBe(true);
    expect(order).toEqual(["hold:Reply AWAKE", "send:Reply AWAKE", "release"]);
  });

  it("takes the message back down when the session would not wake", async () => {
    const release = vi.fn();
    const go = sendWaking({
      suspended: () => true,
      resume: async () => false,
      send: async () => true,
      hold: () => release,
    });
    expect(await go("hello")).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
