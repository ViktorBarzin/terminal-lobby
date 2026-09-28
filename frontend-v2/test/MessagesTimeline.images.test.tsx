import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import type { Event } from "../src/types/events";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import { closePicture, picture } from "../src/store/picture";

/**
 * Pictures in the Text view (Viktor, 2026-09-24: "in text mode i would want to
 * be able to view images natively. we can distinguish them by file name/path.
 * agent communicating back with images should also render the same way").
 *
 * Three surfaces, one rule each:
 *   - Claude's prose: an ABSOLUTE image path, plain, in backticks, as `![](…)`
 *     or as `[x](…)`, keeps its text and is drawn under the block holding it.
 *     Fenced code stays code, and a bare name draws nothing.
 *   - the user's bubble: a picture pasted into the terminal is drawn where its
 *     `[Image #N]` placeholder stood.
 *   - a tool call: a small thumbnail for a Read of an image and for a
 *     screenshot, under the work group holding the call (or the turn's fold
 *     while it hides that group), which opens full size.
 * Every picture that cannot be read falls back to text, never a broken icon.
 */

afterEach(() => {
  closePicture();
  cleanup();
});

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
});

const STORE = "/var/lib/clipboard-store/wizard/qa/pasted-20260817-150232-a1b2c3d4.png";
const RECORD = "1ecbc9e7-ef70-4213-bd81-82c2dfcb5169";

/** One settled turn, so the assistant text renders as a finished message. */
const renderTurn = (events: Event[], props: { me?: string; session?: string } = {}) =>
  render(() => (
    <MessagesTimeline
      events={[...events, ev({ id: 99, kind: "turn_end" })]}
      me={props.me ?? "wizard"}
      session={props.session ?? "s"}
    />
  ));

const prose = (body: string, props?: { me?: string; session?: string }) =>
  renderTurn([ev({ id: 1, kind: "user", body: "go" }), ev({ id: 2, kind: "text", body })], props);

const message = (c: HTMLElement): HTMLElement => c.querySelector(".tl-row-message")!;
const drawn = (c: HTMLElement): string[] =>
  [...message(c).querySelectorAll(".tl-md-pictures img")].map((n) => n.getAttribute("src") ?? "");

describe("pictures in Claude's prose", () => {
  it("keeps a plain path's text and draws the picture under its paragraph", () => {
    const { container } = prose("I wrote the chart to /tmp/claude-1000/x/plot.png for you.");
    const p = message(container).querySelector("p")!;
    expect(p.textContent).toBe("I wrote the chart to /tmp/claude-1000/x/plot.png for you.");
    expect(p.nextElementSibling?.classList.contains("tl-md-pictures")).toBe(true);
    expect(drawn(container)).toEqual(["/files/image?path=%2Ftmp%2Fclaude-1000%2Fx%2Fplot.png"]);
  });

  it("draws a backticked path, the way Claude usually names one", () => {
    const { container } = prose("Saved `/home/wizard/code/out/shot.png`.");
    expect(drawn(container)).toEqual([
      "/files/image?path=%2Fhome%2Fwizard%2Fcode%2Fout%2Fshot.png",
    ]);
    expect(message(container).querySelector("code")?.textContent).toBe(
      "/home/wizard/code/out/shot.png",
    );
  });

  it("leaves a path in a fenced block as code", () => {
    const { container } = prose("```bash\nopen /tmp/a.png\n```");
    expect(message(container).querySelector("img")).toBeNull();
  });

  it("draws ![](/abs) in place through the picture route", () => {
    const { container } = prose("Here it is:\n\n![the chart](/tmp/chart.png)");
    const img = message(container).querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/files/image?path=%2Ftmp%2Fchart.png");
    expect(img.closest(".tl-md-pictures")).toBeNull();
    // Drawn once, not again under the paragraph.
    expect(message(container).querySelectorAll("img")).toHaveLength(1);
  });

  it("points [x](/abs) at the picture route and draws it under the paragraph", () => {
    const { container } = prose("See [the screenshot](/tmp/shot.png).");
    const a = message(container).querySelector("a")!;
    expect(a.getAttribute("href")).toBe("/files/image?path=%2Ftmp%2Fshot.png");
    expect(a.textContent).toBe("the screenshot");
    expect(drawn(container)).toEqual(["/files/image?path=%2Ftmp%2Fshot.png"]);
  });

  it("draws a path in a list item inside that item", () => {
    const { container } = prose("- first: /tmp/a.png\n- second: nothing");
    const li = message(container).querySelector("li")!;
    expect(li.querySelector(".tl-md-pictures img")?.getAttribute("src")).toBe(
      "/files/image?path=%2Ftmp%2Fa.png",
    );
    expect(li.lastElementChild?.classList.contains("tl-md-pictures")).toBe(true);
  });

  it("draws a path in a table cell after the table, not in the cell", () => {
    const { container } = prose("| shot | note |\n|---|---|\n| /tmp/a.png | top |");
    expect(message(container).querySelector("td img")).toBeNull();
    const pictures = message(container).querySelector(".tl-md-pictures")!;
    expect(pictures.previousElementSibling?.classList.contains("tl-table-scroll")).toBe(true);
    expect(drawn(container)).toEqual(["/files/image?path=%2Ftmp%2Fa.png"]);
  });

  it("draws a path in a heading under the heading", () => {
    const { container } = prose("## Result /tmp/a.png\n\nmore");
    const h = message(container).querySelector("h2")!;
    expect(h.nextElementSibling?.classList.contains("tl-md-pictures")).toBe(true);
  });

  it("draws the same picture once, under its first mention", () => {
    const { container } = prose("Look at /tmp/a.png.\n\nAgain, `/tmp/a.png` shows it.");
    expect(drawn(container)).toEqual(["/files/image?path=%2Ftmp%2Fa.png"]);
    const first = message(container).querySelector("p")!;
    expect(first.nextElementSibling?.classList.contains("tl-md-pictures")).toBe(true);
  });

  it("draws a markdown image once even when its path was mentioned first", () => {
    const { container } = prose("The file /tmp/a.png:\n\n![shot](/tmp/a.png)");
    expect(message(container).querySelectorAll("img")).toHaveLength(1);
  });

  it("draws nothing for a bare name, a relative path, a ~ path or a URL", () => {
    const { container } = prose(
      "Saved nova-tv.png, shots/a.png, ./b.png, ~/c.png and https://x.com/d.png.",
    );
    expect(message(container).querySelector("img")).toBeNull();
  });

  it("draws nothing for another user's store path", () => {
    const { container } = prose(
      "It is at /var/lib/clipboard-store/bob/qa/pasted-20260817-150232-a1b2c3d4.png.",
    );
    expect(message(container).querySelector("img")).toBeNull();
  });

  // TextView passes "" until whoami answers: a store path waits for it, and
  // every other picture can already draw.
  it("draws pictures outside the store before the effective user is known", () => {
    const { container } = prose(`Both ${STORE} and /tmp/a.png.`, { me: "" });
    expect(drawn(container)).toEqual(["/files/image?path=%2Ftmp%2Fa.png"]);
  });

  it("removes a picture that cannot be read and keeps the text", () => {
    const { container } = prose("A logo lives at /logos/x.png on the site.");
    fireEvent.error(message(container).querySelector("img")!);
    expect(message(container).querySelector("img")).toBeNull();
    expect(message(container).textContent).toContain("/logos/x.png");
  });

  it("turns a markdown image that cannot be read into its path", () => {
    const { container } = prose("![shot](/tmp/gone.png)");
    fireEvent.error(message(container).querySelector("img")!);
    expect(message(container).querySelector("img")).toBeNull();
    expect(message(container).querySelector(".tl-attach-path")?.textContent).toBe("/tmp/gone.png");
  });

  it("opens a picture in the lightbox", () => {
    const { container } = prose("Chart: /tmp/plot.png");
    fireEvent.click(message(container).querySelector(".tl-md-pictures button")!);
    expect(picture()?.src).toBe("/files/image?path=%2Ftmp%2Fplot.png");
  });

  it("keeps a document named in prose a link to its bytes", () => {
    const { container } = prose("The report is /home/wizard/report.pdf.");
    const a = message(container).querySelector("a");
    expect(a?.getAttribute("href")).toBe("/files/read?path=%2Fhome%2Fwizard%2Freport.pdf");
  });
});

describe("pictures in the user's bubble", () => {
  const PASTE = { n: 0, mediaType: "image/png", bytes: 73251, paste: 1 };

  it("draws a terminal paste where its placeholder stood", () => {
    const { container } = renderTurn([
      ev({
        id: 1,
        kind: "user",
        body: "[Image #1]\n\nwhat is wrong with this layout?",
        images: [PASTE],
        record: RECORD,
      }),
    ]);
    const bubble = container.querySelector(".tl-row-user")!;
    expect(bubble.querySelector("img")?.getAttribute("src")).toBe(
      `/result/s/user/${RECORD}/image/0`,
    );
    expect(bubble.textContent).not.toContain("[Image #1]");
    expect(bubble.textContent).toContain("what is wrong with this layout?");
  });

  it("keeps the placeholder when the timeline is not told its session", () => {
    const { container } = render(() => (
      <MessagesTimeline
        events={[
          ev({ id: 1, kind: "user", body: "[Image #1] hi", images: [PASTE], record: RECORD }),
        ]}
        me="wizard"
      />
    ));
    const bubble = container.querySelector(".tl-row-user")!;
    expect(bubble.querySelector("img")).toBeNull();
    expect(bubble.textContent).toContain("[Image #1] hi");
  });

  it("draws a picture outside the store through the picture route", () => {
    const { container } = renderTurn([ev({ id: 1, kind: "user", body: "why? /tmp/a.png" })]);
    expect(container.querySelector(".tl-row-user img")?.getAttribute("src")).toBe(
      "/files/image?path=%2Ftmp%2Fa.png",
    );
  });

  // The collapse used to slice the body at character 600, and a store path
  // across that boundary came out as a broken fragment of text.
  it("never cuts a path in half when it collapses a long message", () => {
    const body = "x".repeat(585) + " " + STORE + " " + "y".repeat(200);
    const { container } = renderTurn([ev({ id: 1, kind: "user", body })]);
    const bubble = container.querySelector(".tl-row-user")!;
    expect(bubble.querySelector("img")?.getAttribute("src")).toBe(
      "/clipboard/img/qa/pasted-20260817-150232-a1b2c3d4.png",
    );
    expect(bubble.textContent).not.toContain("y");
    expect(bubble.textContent).toContain("…");
    fireEvent.click(bubble.querySelector(".tl-linkbtn")!);
    expect(bubble.textContent).toContain("y".repeat(200));
  });
});

describe("pictures on tool rows", () => {
  const READ = { n: 0, mediaType: "image/jpeg", bytes: 139874 };
  const TOOL = "toolu_01EaDF17CdmXP8Wc3ctiXaL2";

  const readTurn = (session?: string) =>
    renderTurn(
      [
        ev({ id: 1, kind: "user", body: "look at it" }),
        ev({ id: 11, kind: "text", body: "reading it" }),
        ev({
          id: 2,
          kind: "tool_use",
          tool: "Read",
          toolId: TOOL,
          body: '{"file_path":"/tmp/claude-1000/x/scratchpad/shot.png"}',
        }),
        ev({ id: 3, kind: "tool_result", toolId: TOOL, images: [READ] }),
        ev({ id: 4, kind: "text", body: "the header overlaps" }),
      ],
      session === undefined ? {} : { session },
    );

  /** The fold hides settled work; open it to reach the work group. */
  const unfold = (c: HTMLElement): void => {
    fireEvent.click(c.querySelector(".tl-fold-btn")!);
  };
  /** Open the work group, then its first call. */
  const openCall = (c: HTMLElement): HTMLElement => {
    fireEvent.click(c.querySelector(".tl-row-group .tl-group-head")!);
    const call = c.querySelector<HTMLElement>(".tl-group-call")!;
    fireEvent.click(call.querySelector(".tl-group-call-head")!);
    return call;
  };

  // Since the T3 pass (2026-09-27) a tool's pictures are drawn under the work
  // group that holds the call, folded or open, and under the turn's fold while
  // the fold hides that group.
  it("shows a Read of an image as a thumbnail of the transcript's own copy, under the fold", () => {
    const { container } = readTurn();
    const img = container.querySelector(".tl-row-fold .tl-group-pics .tl-tool-thumb img");
    expect(img?.getAttribute("src")).toBe(`/result/s/${TOOL}/image/0`);
    expect(img?.getAttribute("alt")).toBe("shot.png");
  });

  it("moves the thumbnail under its work group once the turn is unfolded", () => {
    const { container } = readTurn();
    unfold(container);
    expect(container.querySelector(".tl-row-fold .tl-tool-thumb")).toBeNull();
    const img = container.querySelector(".tl-row-group .tl-group-pics .tl-tool-thumb img");
    expect(img?.getAttribute("src")).toBe(`/result/s/${TOOL}/image/0`);
  });

  it("shows no empty output when the picture-only call is opened", () => {
    const { container } = readTurn();
    unfold(container);
    const call = openCall(container);
    expect(call.querySelector(".tl-tool-raw")).not.toBeNull();
    expect(call.querySelector(".tl-tool-raw pre.tl-code:not(details pre)")).toBeNull();
    expect(call.textContent).not.toContain("Show full output");
  });

  it("opens the thumbnail full size", () => {
    const { container } = readTurn();
    fireEvent.click(container.querySelector(".tl-tool-thumb")!);
    expect(picture()?.src).toBe(`/result/s/${TOOL}/image/0`);
  });

  it("removes a thumbnail that cannot be read, and keeps the group and its call", () => {
    const { container } = readTurn();
    unfold(container);
    const group = container.querySelector(".tl-row-group")!;
    fireEvent.error(group.querySelector(".tl-tool-thumb img")!);
    expect(group.querySelector("img")).toBeNull();
    fireEvent.click(group.querySelector(".tl-group-head")!);
    expect(group.querySelector(".tl-group-call-label")?.textContent).toContain("shot.png");
  });

  it("shows a screenshot's file through the picture route", () => {
    const { container } = renderTurn([
      ev({ id: 1, kind: "user", body: "shoot it" }),
      ev({ id: 11, kind: "text", body: "taking it" }),
      ev({
        id: 2,
        kind: "tool_use",
        tool: "mcp__playwright__browser_take_screenshot",
        toolId: "toolu_01Kxabcdefgh",
        body: '{"filename":"page-top.png"}',
      }),
      ev({
        id: 3,
        kind: "tool_result",
        toolId: "toolu_01Kxabcdefgh",
        body: "### Result\n- [Screenshot of viewport](./page-top.png)",
        files: ["/home/wizard/page-top.png"],
      }),
      ev({ id: 4, kind: "text", body: "done" }),
    ]);
    unfold(container);
    const img = container.querySelector(".tl-row-group .tl-tool-thumb img");
    expect(img?.getAttribute("src")).toBe("/files/image?path=%2Fhome%2Fwizard%2Fpage-top.png");
    expect(img?.getAttribute("alt")).toBe("page-top.png");
  });

  it("draws no block picture without a session to read it from", () => {
    const { container } = render(() => (
      <MessagesTimeline
        events={[
          ev({ id: 1, kind: "user", body: "look" }),
          ev({
            id: 2,
            kind: "tool_use",
            tool: "Read",
            toolId: TOOL,
            body: '{"file_path":"/tmp/a.png"}',
          }),
          ev({ id: 3, kind: "tool_result", toolId: TOOL, images: [READ] }),
        ]}
        me="wizard"
      />
    ));
    expect(container.querySelector(".tl-row-group img")).toBeNull();
  });
});
