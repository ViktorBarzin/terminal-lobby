/**
 * Queued prompts, drawn where they will land.
 *
 * They were chips in the composer ("queued" and one clipped line each) until
 * the Quiet line composer (2026-09-24). A queued prompt is the reader's own
 * message that has not left yet, so it now sits at the end of the conversation
 * as a dashed outline of the bubble it will become, three at most and then a
 * count. And the working row that used to close the timeline is gone from it:
 * the composer's thin line says what the turn is doing.
 */
import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import { TextView } from "../src/components/TextView";
import type { PendingPrompt } from "../src/logic/compose.logic";
import type { Event } from "../src/types/events";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

const RUNNING: Event[] = [
  ev({ id: 1, kind: "user", body: "fix the card" }),
  ev({ id: 2, kind: "tool_use", tool: "Edit", toolId: "e1", body: '{"file_path":"a.ts"}' }),
];

const ghosts = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>(".tl-row-ghost"));

describe("queued prompts in the timeline", () => {
  it("draws each as a ghost bubble after the last row", () => {
    const { container } = render(() => (
      <MessagesTimeline events={RUNNING} queued={["also check the phone"]} />
    ));
    const g = ghosts(container);
    expect(g).toHaveLength(1);
    expect(g[0]!.classList.contains("tl-row-user")).toBe(true);
    // The attribute the stylesheet draws the dashed outline from
    // (textview.conversation.css.test.ts).
    expect(g[0]!.hasAttribute("data-queued")).toBe(true);
    const bubble = g[0]!.querySelector(".tl-bubble-ghost")!;
    expect(bubble.querySelector(".tl-ghost-tag")?.textContent).toBe("Queued");
    expect(bubble.textContent).toBe("Queuedalso check the phone");
    // The T3 pass (2026-09-27) drops the second line, "Sends when Claude
    // finishes this turn", as the prototype's ghost does: the tag says it.
    expect(bubble.querySelector(".tl-ghost-when")).toBeNull();
    expect(bubble.getAttribute("title")).toBe("also check the phone");
    // After every row of the conversation, where the message will land.
    const timeline = container.querySelector(".tl-timeline")!;
    const rows = Array.from(timeline.querySelectorAll(".tl-row"));
    expect(rows[rows.length - 1]).toBe(g[0]);
  });

  it("shows three, then says how many more are waiting", () => {
    const { container } = render(() => (
      <MessagesTimeline events={RUNNING} queued={["one", "two", "three", "four", "five"]} />
    ));
    expect(ghosts(container).map((g) => g.textContent)).toEqual([
      expect.stringContaining("one"),
      expect.stringContaining("two"),
      expect.stringContaining("three"),
    ]);
    expect(container.querySelector(".tl-ghost-more")?.textContent).toBe("+2 more waiting");
  });

  it("draws nothing when nothing is queued", () => {
    const { container } = render(() => <MessagesTimeline events={RUNNING} queued={[]} />);
    expect(ghosts(container)).toHaveLength(0);
    expect(container.querySelector(".tl-ghost-more")).toBeNull();
  });

  it("keeps a reader who was at the bottom there when a ghost arrives", () => {
    const [queued, setQueued] = createSignal<string[]>([]);
    const { container } = render(() => <MessagesTimeline events={RUNNING} queued={queued()} />);
    const scroller = container.querySelector<HTMLElement>(".tl-timeline")!;
    Object.defineProperty(scroller, "scrollHeight", { value: 1400, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 300, configurable: true });
    scroller.scrollTop = 0;
    setQueued(["the next thing"]);
    expect(scroller.scrollTop).toBe(1100);
  });
});

describe("the working row", () => {
  // It moved onto the composer's thin line (StatusLine), which says the same
  // words in the same place every time instead of 16px above the composer
  // inside the scroll.
  it("is no longer drawn at the foot of the timeline", () => {
    const { container, queryByText } = render(() => <MessagesTimeline events={RUNNING} />);
    expect(container.querySelector(".tl-row-working")).toBeNull();
    expect(queryByText("Working…")).toBeNull();
  });
});

describe("one message, drawn once", () => {
  // Sent mid-turn, a prompt shows at once as a pending bubble and a moment
  // later the CLI records it as queued. The pending bubble steps aside for the
  // ghost (spec risk R6).
  it("leaves out the pending bubble for a prompt Claude has queued", () => {
    const events: Event[] = [
      ...RUNNING,
      ev({ id: 3, kind: "meta", meta: "queued", body: "also check the phone" }),
    ];
    const pending: PendingPrompt[] = [
      { id: -1, text: "also check the phone", at: 5, command: false, afterId: 2 },
    ];
    const { container } = render(() => (
      <TextView
        events={events}
        pending={[]}
        onSend={async () => true}
        onStop={() => {}}
        onResolve={() => {}}
        pendingPrompts={() => pending}
      />
    ));
    const bubbles = Array.from(container.querySelectorAll(".tl-row-user")).filter((r) =>
      (r.textContent ?? "").includes("also check the phone"),
    );
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.classList.contains("tl-row-ghost")).toBe(true);
  });
});
