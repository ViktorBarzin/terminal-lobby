/**
 * The Text view while Claude writes (ADR-0036): the reply streams in at the
 * end of the open turn, rendered as markdown, with no generic "Working…" row
 * under it; the stored reply takes its place without a duplicate. And the
 * notice for a session that started before the mod could stream it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { TextView } from "../src/components/TextView";
import { NO_STREAM, applyDelta, type StreamState } from "../src/store/stream";
import type { Event, StreamDelta } from "../src/types/events";

const g = globalThis as unknown as { EventSource: unknown };
const realES = g.EventSource;

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "demo", ...e });
const delta = (body: string, over: Partial<StreamDelta> = {}): StreamDelta => ({
  kind: "delta",
  session: "demo",
  turnId: "t1",
  stream: "text",
  block: 0,
  body,
  ...over,
});

const PROMPT = ev({ id: 1, kind: "user", body: "Explain the plan", at: Date.now() });

function mount(over: {
  events?: () => Event[];
  stream?: () => StreamState;
  noMod?: () => boolean;
  onOpenTerminal?: () => void;
}) {
  g.EventSource = class {
    close(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  };
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return render(() => (
    <TextView
      session="demo"
      events={over.events?.() ?? [PROMPT]}
      pending={[]}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
      stream={over.stream}
      noMod={over.noMod?.()}
      onOpenTerminal={over.onOpenTerminal}
    />
  ));
}

afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
  localStorage.clear();
});

const streamingRow = (c: HTMLElement) =>
  c.querySelector<HTMLElement>(".tl-timeline .tl-row-message[data-streaming]");

describe("<TextView> while a reply streams", () => {
  it("draws the words so far as markdown, and follows them as they grow", () => {
    const [stream, setStream] = createSignal(applyDelta(NO_STREAM, delta("It has **two")));
    const { container } = mount({ stream });
    // Half an emphasis is still its asterisks, as markdown has it.
    expect(streamingRow(container)?.textContent).toContain("It has **two");
    setStream((s) => applyDelta(s, delta(" parts**.")));
    expect(streamingRow(container)?.querySelector("strong")?.textContent).toBe("two parts");
  });

  it("draws no generic Working row under the streaming reply", () => {
    const { container } = mount({ stream: () => applyDelta(NO_STREAM, delta("It has")) });
    expect(container.querySelector(".tl-timeline .tl-row-live")).toBeNull();
  });

  it("still draws the Working row before anything streams", () => {
    const { container } = mount({ stream: () => NO_STREAM });
    expect(container.querySelector(".tl-timeline .tl-row-live")?.textContent).toContain("Working");
  });

  it("reads an unclosed fence as code while it streams", () => {
    const s = applyDelta(NO_STREAM, delta("Run this:\n\n```bash\nnpm test\n"));
    const { container } = mount({ stream: () => s });
    const block = streamingRow(container)?.querySelector(".tl-code-block");
    expect(block?.getAttribute("data-lang")).toBe("bash");
    expect(block?.textContent).toContain("npm test");
  });

  it("keeps a mermaid fence as its source until the reply is stored", () => {
    const s = applyDelta(NO_STREAM, delta("```mermaid\ngraph TD\n  A-->"));
    const { container } = mount({ stream: () => s });
    const row = streamingRow(container)!;
    expect(row.querySelector(".tl-mermaid")).toBeNull();
    expect(row.querySelector(".tl-code-block")?.textContent).toContain("A-->");
  });

  it("shows the reply once when the stored text replaces the stream", () => {
    const [events, setEvents] = createSignal<Event[]>([PROMPT]);
    const [stream, setStream] = createSignal(applyDelta(NO_STREAM, delta("The answer is 4")));
    const { container } = mount({ events, stream });
    setEvents([PROMPT, ev({ id: 2, kind: "text", body: "The answer is 4.", at: Date.now() })]);
    setStream(NO_STREAM);
    const messages = container.querySelectorAll(".tl-timeline .tl-row-message");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.hasAttribute("data-streaming")).toBe(false);
    expect(messages[0]!.textContent).toContain("The answer is 4.");
  });

  it("shows thinking as it streams, in the folded thinking row", () => {
    const s = applyDelta(NO_STREAM, delta("Reading the plan first", { stream: "thinking" }));
    const { container } = mount({ stream: () => s });
    const row = container.querySelector(".tl-timeline .tl-row-thinking[data-streaming]");
    expect(row?.querySelector(".tl-thinking-label")?.textContent).toBe("Thinking…");
    expect(row?.querySelector(".tl-thinking-preview")?.textContent).toBe("Reading the plan first");
    expect(container.querySelector(".tl-timeline .tl-row-live")).toBeNull();
  });
});

describe("<TextView> for a session that started before the mod", () => {
  it("says so in place of the empty timeline, with the way to the Terminal", () => {
    const open = vi.fn();
    const { container } = mount({ events: () => [], noMod: () => true, onOpenTerminal: open });
    const note = container.querySelector(".tl-nomod-note")!;
    expect(note.textContent).toContain(
      "This session started before the lobby could stream it. It restarts on its own when it's idle; the terminal works meanwhile.",
    );
    expect(container.textContent).not.toContain("No messages yet.");
    expect(container.textContent).not.toContain("Loading the conversation");
    fireEvent.click(note.querySelector("button")!);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("says nothing once the mod connects", () => {
    const [noMod, setNoMod] = createSignal(true);
    const { container } = mount({ events: () => [], noMod });
    expect(container.querySelector(".tl-nomod-note")).not.toBeNull();
    setNoMod(false);
    expect(container.querySelector(".tl-nomod-note")).toBeNull();
  });
});
