import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import { ToolIcon } from "../src/components/ToolIcon";

describe("<ToolIcon>", () => {
  it("draws a distinct mark per tool", () => {
    for (const tool of ["claude", "codex", "shell"] as const) {
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
