/**
 * What the text view's markdown actually supports.
 *
 * This exists because "does it do tables / mermaid / images" is a question with
 * a real answer, and the answer should be checked rather than remembered.
 */
import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import { Markdown } from "../src/components/Markdown";

const md = (text: string) => {
  const { container } = render(() => <Markdown text={text} />);
  return container.querySelector(".tl-markdown")!;
};

describe("CommonMark", () => {
  it("renders headings, emphasis, lists, links and blockquotes", () => {
    const el = md(
      [
        "# Title",
        "",
        "Some **bold** and _italic_ and `inline`.",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "",
        "> quoted",
        "",
        "[a link](https://example.com)",
      ].join("\n"),
    );
    expect(el.querySelector("h1")!.textContent).toBe("Title");
    expect(el.querySelector("strong")!.textContent).toBe("bold");
    expect(el.querySelector("em")!.textContent).toBe("italic");
    expect(el.querySelector(".tl-inline-code")!.textContent).toBe("inline");
    expect(el.querySelectorAll("ul li")).toHaveLength(2);
    expect(el.querySelector("ol li")!.textContent).toBe("first");
    expect(el.querySelector("blockquote")!.textContent).toContain("quoted");
    const a = el.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.com");
    // A link out of a transcript opens away from the lobby, safely.
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
  });
});

describe("GitHub-flavoured markdown", () => {
  it("renders tables", () => {
    const el = md(["| a | b |", "|---|---|", "| 1 | 2 |"].join("\n"));
    expect(el.querySelectorAll("table th")).toHaveLength(2);
    expect(el.querySelectorAll("table td")).toHaveLength(2);
  });

  it("renders task lists and strikethrough", () => {
    const el = md("- [x] done\n- [ ] todo\n\n~~gone~~");
    expect(el.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(el.querySelector("del")!.textContent).toBe("gone");
  });

  it("autolinks a bare URL", () => {
    const el = md("see https://example.com/x for more");
    expect(el.querySelector("a")!.getAttribute("href")).toBe("https://example.com/x");
  });
});

describe("beyond markdown", () => {
  it("hands a mermaid fence to the diagram renderer, not to a <pre>", () => {
    const el = md("```mermaid\ngraph TD;\nA-->B;\n```");
    expect(el.querySelector(".tl-mermaid, .tl-mermaid-fallback")).not.toBeNull();
  });

  it("renders an inline image, lazily", () => {
    const el = md("![a picture](https://example.com/p.png)");
    const img = el.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://example.com/p.png");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("alt")).toBe("a picture");
  });

  // A transcript can carry anything a model wrote, including markup aimed at
  // the page it lands on.
  it("sanitizes HTML rather than executing it", () => {
    const el = md('<img src=x onerror="alert(1)"><script>alert(2)</script>\n\nafter');
    expect(el.querySelector("script")).toBeNull();
    expect(el.innerHTML).not.toContain("onerror");
    expect(el.textContent).toContain("after");
  });
});
