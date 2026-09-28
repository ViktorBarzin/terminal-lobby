/**
 * Prose in a code block is not coloured as code.
 *
 * Found in the T3 pass's live check on 2026-09-28: a story Claude wrote in an
 * untagged fence came out highlighted, keywords and "strings" picked out in
 * colour, because an untagged block ran highlight.js's auto-detection. An
 * untagged fence, or one tagged text, is shown as it was written. A tagged
 * language is still highlighted.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import hljs from "highlight.js/lib/core";
import { Markdown } from "../src/components/Markdown";

afterEach(() => vi.restoreAllMocks());

const STORY =
  "THE LAST WATCH\n\nThe letter came on the supply boat, and if it rained we would wait.";

describe("<Markdown>: a code block of prose", () => {
  it.each([
    ["an untagged fence", "```\n" + STORY + "\n```"],
    ["a text fence", "```text\n" + STORY + "\n```"],
    ["a txt fence", "```txt\n" + STORY + "\n```"],
  ])("leaves %s uncoloured", (_name, md) => {
    const auto = vi.spyOn(hljs, "highlightAuto");
    const { container } = render(() => <Markdown text={md} />);
    const pre = container.querySelector<HTMLElement>("pre.tl-codeview")!;
    expect(pre.dataset.highlight).toBe("off");
    expect(pre.textContent).toContain("The letter came on the supply boat");
    expect(auto).not.toHaveBeenCalled();
  });

  it("still colours a block tagged with a language", async () => {
    const { container } = render(() => <Markdown text={"```ts\nconst x = 1;\n```"} />);
    await waitFor(
      () => expect(container.querySelector("pre.tl-codeview code")!.innerHTML).toContain("hljs-"),
      { timeout: 20_000 },
    );
  });
});
