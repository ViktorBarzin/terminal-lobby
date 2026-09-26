import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import { ToolIcon } from "../src/components/ToolIcon";

describe("<ToolIcon>", () => {
  it("draws a distinct mark per tool", () => {
    for (const tool of ["claude", "codex", "pi", "shell"] as const) {
      const { container, unmount } = render(() => <ToolIcon tool={tool} />);
      const mark = container.querySelector(".tl-tool");
      expect(mark, tool).not.toBeNull();
      expect(mark!.classList.contains("tl-tool-" + tool), tool).toBe(true);
      expect(container.querySelector("svg"), tool).not.toBeNull();
      unmount();
    }
  });

  it("names the tool for hover and for assistive tech", () => {
    const { container } = render(() => <ToolIcon tool="codex" />);
    const mark = container.querySelector(".tl-tool")!;
    expect(mark.getAttribute("title")).toMatch(/codex/i);
    // the drawing itself is decoration — the label lives on the wrapper
    expect(container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });

  // Pi's mark is a plain π in the row's own text colour, the way the codex
  // blossom inherits it: one filled path and no frame, so it reads as an
  // agent's mark beside the others and not as the framed shell prompt.
  it("draws pi as a single filled glyph named pi", () => {
    const { container } = render(() => <ToolIcon tool="pi" />);
    const mark = container.querySelector(".tl-tool-pi")!;
    expect(mark.getAttribute("title")).toBe("Running pi");
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.querySelectorAll("path").length).toBe(1);
    expect(svg.querySelector("rect")).toBeNull();
  });

  it("gives pi a mark of its own, not a copy of another tool's", () => {
    const d = (tool: string) => {
      const { container, unmount } = render(() => <ToolIcon tool={tool} />);
      const path = container.querySelector("path")!.getAttribute("d");
      unmount();
      return path;
    };
    const pi = d("pi");
    expect(pi).toBeTruthy();
    for (const other of ["claude", "codex", "shell"]) expect(pi, other).not.toBe(d(other));
  });

  it("renders nothing when the server sent no tool", () => {
    // An older tmux-api, or a failed /proc scan: no mark beats a wrong mark.
    const { container } = render(() => <ToolIcon />);
    expect(container.querySelector(".tl-tool")).toBeNull();
  });

  it("renders nothing for a tool it does not know", () => {
    const { container } = render(() => <ToolIcon tool={"gemini" as never} />);
    expect(container.querySelector(".tl-tool")).toBeNull();
  });

  it("scales to the requested size", () => {
    const { container } = render(() => <ToolIcon tool="claude" size={20} />);
    expect(container.querySelector("svg")!.getAttribute("width")).toBe("20");
  });
});
