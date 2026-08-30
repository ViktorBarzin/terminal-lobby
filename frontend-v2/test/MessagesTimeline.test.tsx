import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { Event } from "../src/types/events";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import { deriveRows } from "../src/components/timeline.logic";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
});

describe("<MessagesTimeline> (smoke)", () => {
  it("renders a settled turn: user bubble, folded work, and the final markdown answer", () => {
    const events: Event[] = [
      ev({ id: 1, kind: "user", body: "please list files" }),
      ev({ id: 2, kind: "text", body: "let me check" }),
      ev({ id: 3, kind: "tool_use", tool: "Bash", toolId: "t1", body: '{"command":"ls"}' }),
      ev({ id: 4, kind: "tool_result", toolId: "t1", body: "README.md" }),
      ev({ id: 5, kind: "text", body: "All **done** now." }),
      ev({ id: 6, kind: "turn_end" }),
    ];

    const { container, getByText, queryByText, getByRole } = render(() => (
      <MessagesTimeline events={events} />
    ));

    // user prompt is shown
    expect(getByText("please list files")).toBeInTheDocument();
    // final assistant message rendered through markdown (bold -> <strong>)
    const strong = container.querySelector("strong");
    expect(strong?.textContent).toBe("done");
    expect(container.textContent).toContain("All");
    // the fold summary is present, and folded work (the command) is hidden
    expect(getByText(/Worked/)).toBeInTheDocument();
    expect(getByText(/2 steps/)).toBeInTheDocument();
    expect(queryByText("ls")).toBeNull();

    // Expanding the fold reveals the hidden tool row. Since 2026-08-16 that row
    // is labelled with what the call is DOING — the command, not "Bash" — so
    // the reader can tell two Bash calls apart without opening either.
    fireEvent.click(getByRole("button", { name: /Worked/ }));
    expect(getByText("ls")).toBeInTheDocument();
    expect(getByText("Command")).toBeInTheDocument();
  });

  it("shows a working indicator while the last turn is still running", () => {
    const events: Event[] = [
      ev({ id: 1, kind: "user", body: "start" }),
      ev({ id: 2, kind: "text", body: "on it" }),
    ];
    const { getByText } = render(() => <MessagesTimeline events={events} />);
    expect(getByText("Working…")).toBeInTheDocument();
    expect(getByText("on it")).toBeInTheDocument();
  });

  it("renders an empty state with no events", () => {
    const { getByText } = render(() => <MessagesTimeline events={[]} />);
    expect(getByText(/No messages yet/)).toBeInTheDocument();
  });
});

/**
 * Row identity across a stream append.
 *
 * `<For>` reconciles by object REFERENCE and deriveRows allocates fresh rows on
 * every call, so a single SSE event tore down and rebuilt the whole timeline:
 * measured in a browser, an expanded tool row snapped shut mid-turn and every
 * mermaid diagram re-mounted (its generated svg id walked tl-mmd-5 → 6 → 8 in
 * one turn). Node identity is the testable core of that: a diagram can only
 * re-render if the subtree holding it was re-created.
 */
describe("<MessagesTimeline> row identity", () => {
  /** A running turn — rows render unfolded, so the tool row is reachable. */
  const LIVE: Event[] = [
    ev({ id: 1, kind: "user", body: "read the notes" }),
    ev({ id: 2, kind: "text", body: "on it" }),
    ev({
      id: 3,
      kind: "tool_use",
      tool: "Read",
      toolId: "t1",
      body: '{"file_path":"notes.txt"}',
    }),
  ];

  it("keeps every existing row's DOM node when an event arrives", () => {
    const [events, setEvents] = createSignal<Event[]>(LIVE);
    const { container } = render(() => <MessagesTimeline events={events()} />);

    const before = [...container.querySelectorAll(".tl-row")];
    expect(before.length).toBeGreaterThan(2);

    setEvents([...LIVE, ev({ id: 4, kind: "text", body: "here it is" })]);

    const after = [...container.querySelectorAll(".tl-row")];
    expect(after).toHaveLength(before.length + 1);
    for (const node of before) {
      expect(
        after.includes(node),
        `${node.className} was re-created instead of updated in place`,
      ).toBe(true);
    }
  });

  it("leaves an expanded tool row expanded when its own result lands", () => {
    const [events, setEvents] = createSignal<Event[]>(LIVE);
    const { container } = render(() => <MessagesTimeline events={events()} />);

    const tool = container.querySelector(".tl-row-tool")!;
    const toggle = tool.querySelector(".tl-tool-toggle")!;
    fireEvent.click(toggle);
    expect(tool.querySelector(".tl-code")).not.toBeNull();
    expect(tool.getAttribute("data-status")).toBe("running");

    setEvents([
      ...LIVE,
      ev({ id: 4, kind: "tool_result", toolId: "t1", body: "line one" }),
    ]);

    expect(container.querySelector(".tl-row-tool")).toBe(tool);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // …and the row updated in place rather than being replaced.
    expect(tool.getAttribute("data-status")).toBe("ok");
    expect(tool.textContent).toContain("line one");
  });
});

/**
 * Turn folds toggle both ways. Expanding used to remove the fold row from the
 * DOM, so nothing could put the turn back short of a reload — while the tool
 * rows right next to it toggled correctly in the same component.
 */
describe("<MessagesTimeline> turn fold", () => {
  const SETTLED: Event[] = [
    ev({ id: 1, kind: "user", body: "do it" }),
    ev({ id: 2, kind: "text", body: "thinking" }),
    ev({ id: 3, kind: "tool_use", tool: "Bash", toolId: "t1", body: "ls" }),
    ev({ id: 4, kind: "text", body: "all done" }),
    ev({ id: 5, kind: "turn_end" }),
  ];

  it("expands and re-folds, with the caret and aria-expanded following state", () => {
    const { container } = render(() => <MessagesTimeline events={SETTLED} />);
    const fold = container.querySelector(".tl-fold-btn")!;
    const caret = () => container.querySelector(".tl-fold-caret")!.textContent;

    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(caret()).toBe("▸");
    expect(container.querySelector(".tl-row-tool")).toBeNull();

    fireEvent.click(fold);
    expect(container.querySelector(".tl-row-tool")).not.toBeNull();
    expect(container.querySelector(".tl-fold-btn")).toBe(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(caret()).toBe("▾");

    fireEvent.click(fold);
    expect(container.querySelector(".tl-row-tool")).toBeNull();
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(caret()).toBe("▸");
  });
});

/**
 * Fenced blocks are wrapped exactly once.
 *
 * solid-markdown renders every fence as its own default `pre` and puts the
 * `code` component inside it. Our `code` override returns BLOCK elements — a
 * <pre class="tl-code"> for a normal fence, a <div class="tl-mermaid"> for a
 * mermaid one — so each fence came out as <pre><pre class="tl-code">…</pre>
 * </pre> and each diagram as <pre><div class="tl-mermaid">. <pre>'s content
 * model is phrasing content, so a <pre>, <div> or <svg> inside one is invalid.
 *
 * It is inert today only because `.tl-markdown pre` sets nothing but a margin,
 * which collapses with the child's. The day anyone gives `.tl-code` a
 * background, padding or border on its natural selector, every code block
 * doubles it and every diagram gets boxed in a code-block surface.
 */
describe("<MessagesTimeline> fenced blocks", () => {
  const said = (body: string): Event[] => [
    ev({ id: 1, kind: "user", body: "show me" }),
    ev({ id: 2, kind: "text", body }),
    ev({ id: 3, kind: "turn_end" }),
  ];

  // Since 2026-08-17 a fence goes through CodeView, which highlights it lazily
  // (highlight.js) — so the <pre> carries its classes as well. What has to stay
  // true is the shape: ONE <pre> per fence, carrying the language and the code.
  it("renders a code fence as exactly one <pre>", () => {
    const { container } = render(() => (
      <MessagesTimeline events={said("```bash\nls -la\n```")} />
    ));
    const md = container.querySelector(".tl-markdown")!;
    const pres = [...md.querySelectorAll("pre")];
    expect(pres).toHaveLength(1);
    expect(pres[0]!.classList.contains("tl-code")).toBe(true);
    expect(pres[0]!.getAttribute("data-lang")).toBe("bash");
    expect(pres[0]!.textContent).toBe("ls -la");
    // …and nothing wraps it in a second <pre>.
    expect(pres[0]!.parentElement!.closest("pre")).toBeNull();
  });

  it("renders a mermaid fence with no <pre> ancestor", () => {
    const { container } = render(() => (
      <MessagesTimeline events={said("```mermaid\ngraph TD;\nA-->B;\n```")} />
    ));
    const md = container.querySelector(".tl-markdown")!;
    const diagram = md.querySelector(".tl-mermaid")!;
    expect(diagram).not.toBeNull();
    expect(diagram.closest("pre")).toBeNull();
    expect(md.querySelectorAll("pre")).toHaveLength(0);
  });

  it("keeps prose and inline code out of it", () => {
    const { container } = render(() => (
      <MessagesTimeline events={said("run `ls` first\n\n```\nplain\n```")} />
    ));
    const md = container.querySelector(".tl-markdown")!;
    expect(md.querySelector(".tl-inline-code")!.textContent).toBe("ls");
    expect(md.querySelector(".tl-inline-code")!.closest("pre")).toBeNull();
    const pres = [...md.querySelectorAll("pre")];
    expect(pres).toHaveLength(1);
    expect(pres[0]!.classList.contains("tl-code")).toBe(true);
    expect(pres[0]!.getAttribute("data-lang")).toBeNull();
  });
});

/**
 * A collapsed fold that hides a FAILED step used to read exactly
 * "▸ Worked for 5s · 1 step" — count and duration, nothing else. The failure
 * was still narrated by the visible assistant message and still visible on
 * expansion (the ✗, the "output (error)" label, the red output), so nothing
 * malfunctioned; the fold row alone gave the eye no reason to open it.
 */
describe("<MessagesTimeline> collapsed failure signal", () => {
  const FAILED: Event[] = [
    ev({ id: 1, kind: "user", body: "read the missing file" }),
    ev({ id: 2, kind: "text", body: "reading it" }),
    ev({
      id: 3,
      kind: "tool_use",
      tool: "Read",
      toolId: "t1",
      body: '{"file_path":"/nope.txt"}',
    }),
    ev({
      id: 4,
      kind: "tool_result",
      toolId: "t1",
      body: "ENOENT: no such file",
      isError: true,
    }),
    ev({ id: 5, kind: "text", body: "the read failed: no such file" }),
    ev({ id: 6, kind: "turn_end" }),
  ];

  const HEALTHY: Event[] = [
    ev({ id: 1, kind: "user", body: "read the notes" }),
    ev({ id: 2, kind: "text", body: "reading it" }),
    ev({ id: 3, kind: "tool_use", tool: "Read", toolId: "t1", body: "{}" }),
    ev({ id: 4, kind: "tool_result", toolId: "t1", body: "hello", isError: false }),
    ev({ id: 5, kind: "text", body: "here it is" }),
    ev({ id: 6, kind: "turn_end" }),
  ];

  it("marks the collapsed fold row when it hides a failure", () => {
    const { container } = render(() => <MessagesTimeline events={FAILED} />);
    const btn = container.querySelector(".tl-fold-btn")!;
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("data-has-error")).toBe("true");
    const signal = container.querySelector(".tl-fold-error");
    expect(signal).not.toBeNull();
    expect(signal!.textContent).toContain("✗");
    // …and the label says so in words, not by colour alone.
    expect(btn.textContent).toContain("failed");
  });

  it("renders no failure signal on a healthy turn", () => {
    const { container } = render(() => <MessagesTimeline events={HEALTHY} />);
    const btn = container.querySelector(".tl-fold-btn")!;
    expect(btn.getAttribute("data-has-error")).toBeNull();
    expect(container.querySelector(".tl-fold-error")).toBeNull();
    expect(btn.textContent).not.toContain("failed");
  });

  it("still shows the ✗, the output (error) label and the red output when expanded", () => {
    const { container } = render(() => <MessagesTimeline events={FAILED} />);
    fireEvent.click(container.querySelector(".tl-fold-btn")!);
    const tool = container.querySelector(".tl-row-tool")!;
    expect(tool.getAttribute("data-status")).toBe("error");
    expect(tool.querySelector(".tl-tool-tick")!.textContent).toBe("✗");

    fireEvent.click(tool.querySelector(".tl-tool-toggle")!);
    const labels = [...tool.querySelectorAll(".tl-tool-section-label")].map(
      (n) => n.textContent,
    );
    expect(labels).toContain("output (error)");
    expect(tool.querySelector(".tl-code-error")!.textContent).toContain("ENOENT");
  });
});

describe("<MessagesTimeline> — image srcs are never rewritten", () => {
  it("passes an assistant message's image srcs through verbatim", () => {
    // Markdown is shared with the file preview, which now resolves RELATIVE
    // image srcs against the previewed file's directory. The transcript passes
    // no base, and its srcs are already addressed — so nothing here may change.
    const body = [
      "![shot](https://example.com/a.png)",
      "",
      "![served](/clipboard/img/abc.png)",
      "",
      "![bare](pic.png)",
    ].join("\n");
    const events: Event[] = [
      ev({ id: 1, kind: "user", body: "show me" }),
      ev({ id: 2, kind: "text", body }),
      ev({ id: 3, kind: "turn_end" }),
    ];

    const { container } = render(() => <MessagesTimeline events={events} />);
    expect(
      [...container.querySelectorAll("img")].map((n) => n.getAttribute("src")),
    ).toEqual([
      "https://example.com/a.png",
      "/clipboard/img/abc.png",
      "pic.png",
    ]);
  });
});

// --- attachments in the timeline (design 2026-08-17, decisions 2 and 8) -----
describe("attachments render in place", () => {
  const IMG = "/var/lib/clipboard-store/wizard/qa/pasted-20260817-150232-a1.png";

  /** One settled turn, so the assistant text renders as a finished message. */
  const renderTimeline = (events: Event[]) =>
    render(() => (
      <MessagesTimeline events={[...events, ev({ id: 99, kind: "turn_end" })]} me="wizard" />
    ));

  it("draws an image where the user's message named it", () => {
    const { container } = renderTimeline([
      ev({ id: 1, kind: "user", body: `what's wrong here? ${IMG}` }),
    ]);
    const img = container.querySelector(".tl-row-user img");
    expect(img?.getAttribute("src")).toBe("/clipboard/img/qa/pasted-20260817-150232-a1.png");
    expect(container.querySelector(".tl-row-user")?.textContent).not.toContain(IMG);
  });

  it("draws an image Claude named in its own prose", () => {
    const { container } = renderTimeline([
      ev({ id: 1, kind: "text", body: `the new chart is at ${IMG}` }),
    ]);
    expect(container.querySelector(".tl-row-message img")).not.toBeNull();
  });

  // The one regression this change is most likely to cause: a path inside a
  // fence is sample text, not an attachment.
  it("leaves a path inside a code fence as code", () => {
    const { container } = renderTimeline([
      ev({ id: 1, kind: "text", body: "```bash\ncp " + IMG + " .\n```" }),
    ]);
    expect(container.querySelector(".tl-row-message img")).toBeNull();
    expect(container.querySelector(".tl-row-message")?.textContent).toContain(IMG);
  });

  it("leaves a path in inline code alone", () => {
    const { container } = renderTimeline([
      ev({ id: 1, kind: "text", body: "run `cat " + IMG + "` first" }),
    ]);
    expect(container.querySelector(".tl-row-message img")).toBeNull();
    expect(container.querySelector(".tl-row-message")?.textContent).toContain(IMG);
  });

  it("still renders a markdown image reference the way it always did", () => {
    const { container } = renderTimeline([
      ev({ id: 1, kind: "text", body: "![shot](/files/read?path=%2Ftmp%2Fa.png)" }),
    ]);
    expect(container.querySelector(".tl-row-message img")).not.toBeNull();
  });
});

describe("<MessagesTimeline> — rows handed down by the owner", () => {
  const TURN: Event[] = [
    ev({ id: 1, kind: "user", body: "derive me" }),
    ev({ id: 2, kind: "text", body: "done" }),
    ev({ id: 3, kind: "turn_end" }),
  ];

  it("renders the rows it is given rather than folding the events again", () => {
    const rows = deriveRows(TURN);
    const { container } = render(() => (
      <MessagesTimeline events={[]} rows={rows} />
    ));
    expect(container.textContent).toContain("derive me");
  });

  it("falls back to deriving from events when no rows are passed", () => {
    const { container } = render(() => <MessagesTimeline events={TURN} />);
    expect(container.textContent).toContain("derive me");
  });

  it("follows the rows when they change", () => {
    const [rows, setRows] = createSignal(deriveRows(TURN));
    const { container } = render(() => (
      <MessagesTimeline events={[]} rows={rows()} />
    ));
    expect(container.textContent).not.toContain("second prompt");
    setRows(deriveRows([...TURN, ev({ id: 4, kind: "user", body: "second prompt" })]));
    expect(container.textContent).toContain("second prompt");
  });
});
