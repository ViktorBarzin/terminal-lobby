/**
 * The three things Mermaid.tsx configures that are NOT mermaid's defaults, each
 * of which is a defect this repo has already met on the pages site.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@solidjs/testing-library";
import { setTheme } from "../src/theme/theme";

const initialize = vi.fn();
const renderFn = vi.fn(async (id: string, code: string) => ({
  svg: `<svg data-id="${id}" data-code="${code}"></svg>`,
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: (...args: unknown[]) => initialize(...args),
    render: (id: string, code: string) => renderFn(id, code),
  },
}));

// Imported after the mock so the component picks it up.
const { Mermaid } = await import("../src/components/Mermaid");

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("<Mermaid>", () => {
  beforeEach(() => {
    initialize.mockClear();
    renderFn.mockClear();
  });

  it("suppresses mermaid's own error rendering", async () => {
    render(() => <Mermaid code="graph TD; A-->B;" />);
    await flush();
    // Without this a fence that fails to parse strands mermaid's temp container
    // in <body> — the "Syntax error in text" bomb — because render() throws
    // before reaching its own cleanup, and in an SPA the orphans accumulate.
    expect(initialize.mock.calls[0]![0]).toMatchObject({
      suppressErrorRendering: true,
    });
  });

  it("turns off useMaxWidth for every diagram type", async () => {
    render(() => <Mermaid code="graph TD; A-->B;" />);
    await flush();
    const cfg = initialize.mock.calls[0]![0] as Record<string, { useMaxWidth?: boolean }>;
    // Per-type, because mermaid has no global knob. The default shrinks a
    // diagram to its container: a six-node flowchart measured 355x27px on a
    // 390px phone.
    for (const type of ["flowchart", "sequence", "gantt", "state", "er", "class", "pie"]) {
      expect(cfg[type], type).toMatchObject({ useMaxWidth: false });
    }
  });

  it("re-renders when the theme changes, because the palette is baked in", async () => {
    render(() => <Mermaid code="graph TD; A-->B;" />);
    await flush();
    expect(renderFn).toHaveBeenCalledTimes(1);

    setTheme("ink");
    await flush();
    // A diagram drawn once on mount keeps the old theme's colours after a
    // switch — #333 on #0d1117 is 1.5:1, which is invisible.
    expect(renderFn.mock.calls.length).toBeGreaterThan(1);
    expect(initialize.mock.calls.at(-1)![0]).toMatchObject({ theme: "default" });

    setTheme("slate");
    await flush();
    expect(initialize.mock.calls.at(-1)![0]).toMatchObject({ theme: "dark" });
  });

  it("falls back to the source rather than blanking the message", async () => {
    renderFn.mockRejectedValueOnce(new Error("bad diagram"));
    const { container } = render(() => <Mermaid code="graph TD; ???" />);
    await flush();
    const fallback = container.querySelector(".tl-mermaid-fallback");
    expect(fallback?.textContent).toBe("graph TD; ???");
  });
});
