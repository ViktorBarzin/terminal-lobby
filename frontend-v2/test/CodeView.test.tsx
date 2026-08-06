import { describe, it, expect, vi, afterEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import hljs from "highlight.js/lib/core";
import { CodeView } from "../src/components/CodeView";

/**
 * highlight.js runs SYNCHRONOUSLY on the main thread, so its cost is a freeze of
 * the whole lobby — no scrolling, no clicks, no stream updates — for as long as
 * it runs. Measured on the deployed build (5df2fbd) through the preview overlay,
 * longest single main-thread block per file:
 *
 *     256 KiB .txt  2863 ms      1 MiB .txt   9869 ms      1 MiB .ts  3211 ms
 *       3 MiB .txt 34898 ms      9 MiB .txt 156458 ms      3 MiB .ts  8756 ms
 *
 * 9 MB is not an abuse case: file-api's maxFileSize is 10 MiB and the app's own
 * 413 copy advertises "max 10MB", so the app promises to preview it.
 *
 * These tests pin the guard by BEHAVIOUR rather than by importing a constant, so
 * they keep meaning if the numbers are retuned: they fix the sizes that must not
 * be highlighted (64 KiB with no grammar, 512 KiB with one) and the sizes that
 * still must be (64 KiB WITH a grammar — the auto path costs ~6x more per byte,
 * so it earns a lower ceiling than a known grammar, not the same one).
 *
 * The spies call through on purpose: nothing here stubs what highlight.js
 * returns, so the "still highlights" cases assert on real hljs markup.
 */

const LINE = 'const x = "abc"; // padding so this parses like real source\n';

function filler(chars: number): string {
  return LINE.repeat(Math.ceil(chars / LINE.length)).slice(0, chars);
}

const KIB = 1024;
/** Over any sane auto ceiling; a known grammar must still highlight at this size. */
const BIG = 64 * KIB;
/** Over any sane ceiling, grammar or not. */
const HUGE = 512 * KIB;
const SMALL = 2 * KIB;

// hljs is a singleton module object, and CodeView's lazy `import()` resolves to
// this very instance — so a spy here sees the component's own calls.
const spyAuto = () => vi.spyOn(hljs, "highlightAuto");
const spyKnown = () => vi.spyOn(hljs, "highlight");

afterEach(() => vi.restoreAllMocks());

const pre = (c: HTMLElement) => c.querySelector("pre.tl-codeview") as HTMLPreElement;
const codeEl = (c: HTMLElement) => c.querySelector("pre.tl-codeview code") as HTMLElement;

async function settled(container: HTMLElement): Promise<void> {
  // Either outcome is observable: highlighted markup, or the skipped marker.
  await waitFor(
    () => {
      const el = codeEl(container);
      expect(
        el.innerHTML.includes("hljs-") || pre(container).dataset.highlight === "skipped",
      ).toBe(true);
    },
    { timeout: 20_000 },
  );
}

describe("<CodeView> — large files are not highlighted (main-thread freeze)", () => {
  it("skips highlightAuto for a large file with no grammar, and renders it verbatim", async () => {
    const auto = spyAuto();
    const known = spyKnown();
    const code = filler(BIG);

    const { container } = render(() => <CodeView code={code} />);
    await settled(container);

    expect(auto).not.toHaveBeenCalled();
    expect(known).not.toHaveBeenCalled();
    expect(pre(container).dataset.highlight).toBe("skipped");
    // The text is all there — the guard drops the colours, never the content.
    expect(codeEl(container).textContent).toBe(code);
    expect(codeEl(container).querySelector("span")).toBeNull();
  }, 30_000);

  it("skips highlight() for a large file even when the grammar is known", async () => {
    const auto = spyAuto();
    const known = spyKnown();
    const code = filler(HUGE);

    const { container } = render(() => <CodeView code={code} language="typescript" />);
    await settled(container);

    expect(known).not.toHaveBeenCalled();
    expect(auto).not.toHaveBeenCalled();
    expect(pre(container).dataset.highlight).toBe("skipped");
    expect(codeEl(container).textContent).toBe(code);
  }, 30_000);

  it("tells the reader why the colours are missing", async () => {
    const { container } = render(() => <CodeView code={filler(BIG)} />);
    await settled(container);

    const note = container.querySelector(".tl-codeview-skipped");
    expect(note).toBeTruthy();
    expect(note!.textContent?.toLowerCase()).toContain("large");
  }, 30_000);
});

describe("<CodeView> — the guard does not cost normal files their highlighting", () => {
  it("still highlights a small file with a known grammar", async () => {
    const known = spyKnown();
    const { container } = render(() => (
      <CodeView code={filler(SMALL)} language="typescript" />
    ));
    await settled(container);

    expect(known).toHaveBeenCalledTimes(1);
    expect(codeEl(container).innerHTML).toContain("hljs-");
    expect(pre(container).dataset.highlight).toBeUndefined();
  }, 30_000);

  it("still auto-detects a small file with no grammar", async () => {
    const auto = spyAuto();
    const { container } = render(() => <CodeView code={filler(SMALL)} />);
    await settled(container);

    expect(auto).toHaveBeenCalledTimes(1);
    expect(codeEl(container).innerHTML).toContain("hljs-");
  }, 30_000);

  it("keeps highlighting a 64 KiB file that HAS a grammar — the auto ceiling is not the grammar ceiling", async () => {
    const known = spyKnown();
    const { container } = render(() => <CodeView code={filler(BIG)} language="typescript" />);
    await settled(container);

    expect(known).toHaveBeenCalledTimes(1);
    expect(codeEl(container).innerHTML).toContain("hljs-");
  }, 30_000);
});
