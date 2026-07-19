import { describe, it, expect, vi } from "vitest";
import { createEditorView } from "../src/components/codemirror-view";

/**
 * A real-CodeMirror smoke test (imports the actual @codemirror packages, unlike
 * the rest of the suite which stays on the pure logic). Proves the factory
 * mounts, seeds the doc, resolves a language, and fires onChange — i.e. the
 * integration is wired, not just the state machine.
 */
function mount(): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

describe("codemirror-view factory — real CodeMirror in jsdom", () => {
  it("mounts an EditorView, seeds the doc, and renders CodeMirror DOM", () => {
    const host = mount();
    const view = createEditorView({
      parent: host,
      doc: "const a = 1;\n",
      language: "typescript",
      onChange: () => {},
    });
    expect(view.state.doc.toString()).toBe("const a = 1;\n");
    expect(host.querySelector(".cm-editor")).toBeTruthy();
    expect(host.querySelector(".cm-content")).toBeTruthy();
    view.destroy();
    host.remove();
  });

  it("fires onChange with the full current text on a document change", () => {
    const host = mount();
    const onChange = vi.fn();
    const view = createEditorView({ parent: host, doc: "a", onChange });
    view.dispatch({ changes: { from: 1, insert: "b" } });
    expect(onChange).toHaveBeenCalledWith("ab");
    view.destroy();
    host.remove();
  });

  it("mounts each supported language grammar without throwing", () => {
    const langs = [
      "javascript",
      "jsx",
      "typescript",
      "tsx",
      "json",
      "markdown",
      "html",
      "css",
      "python",
      "go",
      "yaml",
      "shell",
      undefined, // plain text
    ] as const;
    for (const language of langs) {
      const host = mount();
      const view = createEditorView({ parent: host, doc: "x", language, onChange: () => {} });
      expect(host.querySelector(".cm-editor")).toBeTruthy();
      view.destroy();
      host.remove();
    }
  });
});
