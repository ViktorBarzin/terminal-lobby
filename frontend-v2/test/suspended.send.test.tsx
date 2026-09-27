import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

/**
 * The terminal is scenery here and expensive scenery — xterm wants a
 * `matchMedia` jsdom does not ship, and the rejection fails the whole file.
 * What the real one does is TerminalNative.wiring.test.tsx.
 */
vi.mock("../src/components/TerminalNative", () => ({
  TerminalNative: () => <div class="tl-terminal-native" />,
}));

import { SessionView } from "../src/components/SessionView";

/**
 * A message typed at a suspended session.
 *
 * The pane's frozen scrollback looks live and the transcript is all there, so
 * the view the person last had open is the one they get. Their Send wakes the
 * session and the prompt goes in once Claude can take it (store/wake-send.ts).
 * Found in review on 2026-09-27: the text used to wait in module memory until
 * somebody clicked the sidebar row, a session opened by URL never woke, and a
 * reload lost the words.
 */

interface Post {
  url: string;
  body: string;
}

const posts: Post[] = [];

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push({ url, body: String(init.body ?? "") });
      return Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
}

const promptBodies = (): unknown[] =>
  posts.filter((p) => p.url.includes("/prompt")).map((p) => JSON.parse(p.body));

/** Show the view whose name matches, through the header's one view icon. The
 *  icon names the view it switches TO, so it is clicked only when it matches. */
const showView = (root: HTMLElement, name: RegExp): void => {
  const b = root.querySelector<HTMLButtonElement>(".tl-bar-group .tl-view-toggle");
  expect(b, "the header's view icon").toBeTruthy();
  if (name.test(b!.getAttribute("aria-label") ?? "")) fireEvent.click(b!);
};

const field = (root: HTMLElement) =>
  root.querySelector<HTMLTextAreaElement>(".tl-composer textarea");

/** Write a message and press Send. */
function type(root: HTMLElement, text: string): void {
  expect(field(root), "the composer's field").toBeTruthy();
  fireEvent.input(field(root)!, { target: { value: text } });
  fireEvent.click(root.querySelector<HTMLButtonElement>(".tl-composer .tl-send")!);
}

beforeEach(() => {
  posts.length = 0;
  localStorage.clear();
  stubFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("<SessionView> — sending at a suspended session", () => {
  it("wakes the session, then sends with the readiness wait", async () => {
    const [suspended] = createSignal(true);
    const resume = vi.fn(async () => true);
    const { container, unmount } = render(() => (
      <SessionView session="qa-suspend-a" suspended={suspended} resume={resume} />
    ));
    showView(container as HTMLElement, /Text/i);
    type(container as HTMLElement, "Reply with the word: kiwi");

    await waitFor(() =>
      expect(promptBodies()).toEqual([{ text: "Reply with the word: kiwi", awaitReady: true }]),
    );
    expect(resume).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("keeps the text in the field when the session would not wake", async () => {
    const [suspended] = createSignal(true);
    const resume = vi.fn(async () => false);
    const { container, unmount } = render(() => (
      <SessionView session="qa-suspend-b" suspended={suspended} resume={resume} />
    ));
    showView(container as HTMLElement, /Text/i);
    type(container as HTMLElement, "still here");

    await waitFor(() => expect(field(container as HTMLElement)?.value).toBe("still here"));
    expect(promptBodies()).toEqual([]);
    unmount();
  });

  it("posts straight away on a live session", async () => {
    const [suspended] = createSignal(false);
    const resume = vi.fn(async () => true);
    const { container, unmount } = render(() => (
      <SessionView session="qa-suspend-c" suspended={suspended} resume={resume} />
    ));
    showView(container as HTMLElement, /Text/i);
    type(container as HTMLElement, "right now");

    await waitFor(() => expect(promptBodies()).toEqual([{ text: "right now" }]));
    expect(resume).not.toHaveBeenCalled();
    unmount();
  });
});
