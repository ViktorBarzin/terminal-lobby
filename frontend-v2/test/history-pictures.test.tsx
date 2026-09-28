/**
 * ↑ brings a message with a picture back WITH the picture.
 *
 * Deployed review round 3 (2026-09-28): a message sent with a picture chip
 * came back from ↑ as `[Image #1]What is in this picture, in five words?`,
 * plain text with no picture, and Enter on it sent Claude a placeholder with
 * nothing behind it. History is read from the transcript, where the CLI has
 * swapped the path for its placeholder. A file chip came back as its raw store
 * path, which still worked but was no longer the chip that was typed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { Composer } from "../src/components/Composer";
import { tokenizeStorePaths, withSentPictures } from "../src/lib/attachments";
import { rememberSent, sentPictures, SENT_PICTURES_KEY } from "../src/store/sentPictures";

const PIC = "/var/lib/clipboard-store/wizard/qa/pasted-20260928-162426-bffcb7c8.png";
const DOC = "/var/lib/clipboard-store/wizard/qa/file-20260928-101010-0123abcd-report.pdf";

describe("a store path in a recalled message", () => {
  it("becomes the chip it was sent from", () => {
    const got = tokenizeStorePaths(`What is in this picture? ${PIC} and ${DOC} too`);
    expect(got.items.map((a) => a.path)).toEqual([PIC, DOC]);
    expect(got.items.map((a) => a.kind)).toEqual(["image", "doc"]);
    expect(got.text).toBe(`What is in this picture? ${got.items[0]!.token} and ${got.items[1]!.token} too`);
    expect(got.text).not.toContain("/var/lib");
  });

  it("leaves a path outside the store as text", () => {
    const text = "Look at /home/wizard/shot.png please";
    expect(tokenizeStorePaths(text)).toEqual({ text, items: [] });
  });
});

describe("a history entry the CLI rewrote with [Image #N]", () => {
  const sent = [`What is in this picture, in five words? ${PIC}`];

  it("comes back as the message this device sent", () => {
    expect(withSentPictures(["[Image #1]What is in this picture, in five words?"], sent)).toEqual(sent);
  });

  it("stays as it was when nothing sent from here matches", () => {
    const history = ["[Image #1]Something else entirely"];
    expect(withSentPictures(history, sent)).toEqual(history);
  });

  it("leaves an entry with no placeholder alone", () => {
    const history = ["What is in this picture, in five words?"];
    expect(withSentPictures(history, sent)).toEqual(history);
  });
});

describe("the messages with pictures this device sent", () => {
  beforeEach(() => localStorage.removeItem(SENT_PICTURES_KEY));

  it("keeps only messages that carry a store picture, newest last, per session", () => {
    rememberSent("s1", "plain words");
    rememberSent("s1", `first ${PIC}`);
    rememberSent("s2", `other ${PIC}`);
    rememberSent("s1", `second ${PIC}`);
    expect(sentPictures("s1")).toEqual([`first ${PIC}`, `second ${PIC}`]);
    expect(sentPictures("s2")).toEqual([`other ${PIC}`]);
  });

  it("holds a bounded number per session", () => {
    for (let i = 0; i < 40; i++) rememberSent("s1", `n${i} ${PIC}`);
    const kept = sentPictures("s1");
    expect(kept.length).toBeLessThanOrEqual(20);
    expect(kept.at(-1)).toBe(`n39 ${PIC}`);
  });

  it("reads corrupt storage as nothing", () => {
    localStorage.setItem(SENT_PICTURES_KEY, "{not json");
    expect(sentPictures("s1")).toEqual([]);
  });
});

describe("↑ in the composer", () => {
  it("recalls a picture message as a chip, and Enter sends the picture again", async () => {
    const onSend = vi.fn(async (_text: string) => true);
    const { container } = render(() => (
      <Composer
        pending={[]}
        history={[`What is in this picture, in five words? ${PIC}`]}
        onSend={onSend}
        onStop={() => {}}
        onResolve={() => {}}
      />
    ));
    const ta = container.querySelector<HTMLTextAreaElement>(".tl-composer-input")!;
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(ta.value).toMatch(/^What is in this picture, in five words\? \[img[^\]]*\]$/);
    expect(ta.value).not.toContain("/var/lib");
    expect(container.querySelector(".tl-inline-thumb")).not.toBeNull();
    fireEvent.keyDown(ta, { key: "Enter" });
    await Promise.resolve();
    expect(onSend).toHaveBeenCalled();
    expect(onSend.mock.calls[0]![0]).toBe(`What is in this picture, in five words? ${PIC}`);
  });

  it("walking back down past the newest entry leaves no chip behind", () => {
    const { container } = render(() => (
      <Composer
        pending={[]}
        history={[`look ${PIC}`]}
        onSend={async () => true}
        onStop={() => {}}
        onResolve={() => {}}
      />
    ));
    const ta = container.querySelector<HTMLTextAreaElement>(".tl-composer-input")!;
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    expect(ta.value).toBe("");
    expect(container.querySelector(".tl-inline-thumb")).toBeNull();
  });
});
