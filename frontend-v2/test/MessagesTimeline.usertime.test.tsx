import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import type { Event } from "../src/types/events";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import { messageTime, messageTimeFull } from "../src/components/message-time.logic";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

describe("when a user message was sent", () => {
  it("is shown under the bubble, with the whole moment on hover", () => {
    const sent = Date.now() - 60_000;
    const { container } = render(() => (
      <MessagesTimeline events={[ev({ id: 1, kind: "user", body: "hello", at: sent })]} />
    ));
    const time = container.querySelector(".tl-row-user time.tl-user-time");
    expect(time?.textContent).toBe(messageTime(sent, Date.now()));
    expect(time?.getAttribute("datetime")).toBe(new Date(sent).toISOString());
    expect(time?.getAttribute("title")).toBe(messageTimeFull(sent));
    // After the bubble, so it reads below it.
    expect(time?.previousElementSibling?.classList.contains("tl-bubble-user")).toBe(true);
  });

  it("waits until the session has taken the message", () => {
    const { container } = render(() => (
      <MessagesTimeline
        events={[ev({ id: 1, kind: "user", body: "hello", at: Date.now(), sending: true })]}
      />
    ));
    expect(container.querySelector(".tl-row-user[data-sending]")).not.toBeNull();
    expect(container.querySelector(".tl-user-time")).toBeNull();
  });

  it("is left out when the record carries no time", () => {
    const { container } = render(() => (
      <MessagesTimeline events={[ev({ id: 1, kind: "user", body: "hello" })]} />
    ));
    expect(container.querySelector(".tl-row-user")).not.toBeNull();
    expect(container.querySelector(".tl-user-time")).toBeNull();
  });
});
