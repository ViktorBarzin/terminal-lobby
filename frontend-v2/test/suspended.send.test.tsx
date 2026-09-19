import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
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
import { heldFor, resetHeld } from "../src/store/suspend-queue";

/**
 * A message typed at a session that is still waking up.
 *
 * The composer does not know the session is suspended and should not have to:
 * the pane's frozen scrollback looks live, the transcript is all there, and
 * the view the person last had open is the one they get. What changes is where
 * the text GOES. session-events would inject a prompt into a pane holding a
 * dead shell, report 200, and lose it — so it waits here until the poll says
 * the session is back.
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

const prompts = (): string[] =>
  posts.filter((p) => p.url.includes("/prompt")).map((p) => String(JSON.parse(p.body).text));

const segment = (root: HTMLElement, title: RegExp): HTMLButtonElement => {
  const b = Array.from(root.querySelectorAll<HTMLButtonElement>(".tl-viewswitch .tl-seg")).find(
    (el) => title.test(el.getAttribute("title") ?? ""),
  );
  expect(b, `the ${title} segment`).toBeTruthy();
  return b!;
};

/** Write a message and press Send. */
function type(root: HTMLElement, text: string): void {
  const field = root.querySelector<HTMLTextAreaElement>(".tl-composer textarea");
  expect(field, "the composer's field").toBeTruthy();
  fireEvent.input(field!, { target: { value: text } });
  fireEvent.click(root.querySelector<HTMLButtonElement>(".tl-composer .tl-send")!);
}

beforeEach(() => {
  posts.length = 0;
  resetHeld();
  localStorage.clear();
  stubFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetHeld();
  localStorage.clear();
});

describe("<SessionView> — sending at a suspended session", () => {
  it("holds the message instead of posting it into a dead pane", async () => {
    const [suspended] = createSignal(true);
    const { container, unmount } = render(() => (
      <SessionView session="qa-suspend-a" suspended={suspended} />
    ));
    fireEvent.click(segment(container as HTMLElement, /Text/i));
    type(container as HTMLElement, "the next thing");
    await Promise.resolve();

    expect(prompts(), "nothing may reach a dead pane").toEqual([]);
    expect(heldFor("qa-suspend-a")).toEqual(["the next thing"]);
    unmount();
  });

  it("sends it as soon as the session is back", async () => {
    const [suspended, setSuspended] = createSignal(true);
    const { container, unmount } = render(() => (
      <SessionView session="qa-suspend-b" suspended={suspended} />
    ));
    fireEvent.click(segment(container as HTMLElement, /Text/i));
    type(container as HTMLElement, "carried over");
    expect(prompts()).toEqual([]);

    setSuspended(false);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(prompts()).toEqual(["carried over"]);
    expect(heldFor("qa-suspend-b")).toEqual([]);
    unmount();
  });

  it("posts straight away on a live session", async () => {
    const [suspended] = createSignal(false);
    const { container, unmount } = render(() => (
      <SessionView session="qa-suspend-c" suspended={suspended} />
    ));
    fireEvent.click(segment(container as HTMLElement, /Text/i));
    type(container as HTMLElement, "right now");
    await Promise.resolve();

    expect(prompts()).toEqual(["right now"]);
    expect(heldFor("qa-suspend-c")).toEqual([]);
    unmount();
  });

  it("clears the field, because the message was accepted", async () => {
    // Resolving false is the composer's signal to put the text BACK, which
    // would leave a person looking at a message they thought they had sent.
    const [suspended] = createSignal(true);
    const { container, unmount } = render(() => (
      <SessionView session="qa-suspend-d" suspended={suspended} />
    ));
    fireEvent.click(segment(container as HTMLElement, /Text/i));
    type(container as HTMLElement, "accepted");
    await Promise.resolve();
    await Promise.resolve();

    const field = (container as HTMLElement).querySelector<HTMLTextAreaElement>(
      ".tl-composer textarea",
    );
    expect(field?.value).toBe("");
    unmount();
  });
});
