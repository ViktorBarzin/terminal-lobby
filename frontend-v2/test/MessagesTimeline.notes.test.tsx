/**
 * The conversation's small rows read as notes, the way the T3 pass draws them.
 *
 * docs/plans/2026-09-27-text-view-t3-pass.md, prototype
 * pages/wizard/composer/6-t3.html (`.m-note`): a centred muted line such as
 * "Allowed: Bash", with the thing it names in the text colour. They were a
 * centred rule with a word on it (meta rows) and a bordered card with a lock
 * (permission rows) until 2026-09-27.
 */
import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import type { Event } from "../src/types/events";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

// No turn_end, so the turn stays open and nothing folds away.
const OPEN: Event[] = [ev({ id: 1, kind: "user", body: "fix the card" })];

describe("a permission row", () => {
  const draw = (decision?: string) => {
    const events: Event[] = [
      ...OPEN,
      ev({ id: 2, kind: "permission_request", reqId: "r1", tool: "Bash", body: "{}" }),
    ];
    if (decision) {
      events.push(ev({ id: 3, kind: "permission_resolved", reqId: "r1", body: decision }));
    }
    const { container } = render(() => <MessagesTimeline events={events} />);
    return container.querySelector<HTMLElement>(".tl-row-permission")!;
  };

  it.each([
    ["allow", "Allowed: Bash"],
    ["deny", "Denied: Bash"],
  ])("reads %s as a note", (decision, text) => {
    const row = draw(decision);
    expect(row.textContent).toBe(text);
    expect(row.dataset.decision).toBe(decision);
    expect(row.querySelector("b")?.textContent).toBe("Bash");
  });

  it("says Claude asked while the answer is still to come", () => {
    const row = draw();
    expect(row.textContent).toBe("Asked: Bash");
    expect(row.dataset.decision).toBe("pending");
  });

  it("names the request when the tool is unknown", () => {
    const events: Event[] = [
      ...OPEN,
      ev({ id: 2, kind: "permission_resolved", reqId: "r2", body: "allow" }),
    ];
    const { container } = render(() => <MessagesTimeline events={events} />);
    expect(container.querySelector(".tl-row-permission")?.textContent).toBe("Allowed: permission");
  });

  it("draws no lock and no card", () => {
    const row = draw("allow");
    expect(row.textContent).not.toContain("🔐");
    expect(row.querySelector(".tl-perm-state")).toBeNull();
  });
});

describe("a meta row", () => {
  it("is one line, with no rules either side", () => {
    const events: Event[] = [
      ...OPEN,
      ev({ id: 2, kind: "meta", meta: "hook-error", body: "PreToolUse exited 2" }),
    ];
    const { container } = render(() => <MessagesTimeline events={events} />);
    const row = container.querySelector<HTMLElement>(".tl-row-meta")!;
    expect(row.querySelector(".tl-meta-rule")).toBeNull();
    expect(row.textContent).toBe("hook failed · PreToolUse exited 2");
    expect(row.querySelector(".tl-meta-value")?.textContent).toBe("PreToolUse exited 2");
  });
});
