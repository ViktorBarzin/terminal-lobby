import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { SessionView } from "../src/components/SessionView";
import { resetPiModels } from "../src/lib/pi-models";

/**
 * A pi session's model button, wired end to end through the session view: the
 * reading comes from what the session list carries for it, the rows from
 * GET /pi-models and the session's stamped levels, and a pick goes out as
 * POST /model/{session} naming pi.
 */

/** The terminal, stubbed: a real one boots xterm, which jsdom cannot host. */
vi.mock("../src/components/TerminalNative", () => ({
  TerminalNative: () => <div class="tl-terminal-native" />,
}));

const OPUS = "anthropic/claude-opus-5";
const MINI = "openai/gpt-5.4-mini";
const row = (ref: string) => {
  const [provider, id] = ref.split("/");
  return { ref, provider, id, thinking: true };
};

const g = globalThis as unknown as { EventSource?: unknown };

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** Answer the two calls this is about; everything else is a 404. */
function serve(): Call[] {
  const calls: Call[] = [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith("/pi-models")) {
        return json({ signedIn: true, models: [row(OPUS), row(MINI)] });
      }
      if (url.includes("/model/")) return json({ model: MINI, effort: "high" });
      return new Response("", { status: 404 });
    }),
  );
  return calls;
}

const dial = (c: HTMLElement) => c.querySelector<HTMLButtonElement>(".tl-model-btn");
/** The exact model and level, which the model button's title carries. */
const shown = (c: HTMLElement) => dial(c)?.getAttribute("title");
/** The popover is drawn in the document's body (ModelSheet.tsx), so its rows
 *  are found there rather than under the view. */
const modelRows = (_c: HTMLElement) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".tl-ms-model"));
const labels = (c: HTMLElement) => [
  ...modelRows(c).map((b) => b.querySelector(".tl-ms-name")?.textContent ?? ""),
  ...Array.from(document.querySelectorAll<HTMLButtonElement>(".tl-ms-seg button")).map(
    (b) => b.textContent ?? "",
  ),
];

describe("<SessionView> — a pi session's model button", () => {
  let origES: unknown;
  beforeEach(() => {
    resetPiModels();
    origES = g.EventSource;
    g.EventSource = class {
      onopen: ((ev: unknown) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      addEventListener(type: string, fn: (ev: { data: string }) => void): void {
        if (type === "ready") fn({ data: "0" });
      }
      close(): void {}
    };
    localStorage.clear();
  });
  afterEach(() => {
    g.EventSource = origES;
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("reads the session's stamp, offers pi's rows, and switches model as pi", async () => {
    const calls = serve();
    const { container } = render(() => (
      <SessionView
        session="qa-pi"
        tool={() => "pi"}
        piStamp={() => ({ piModel: OPUS, piThinking: "high", piLevels: "off,low,medium,high" })}
      />
    ));
    await waitFor(() => expect(shown(container)).toBe(`Model and thinking: ${OPUS} · high`));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/pi-models"))).toBe(true));

    fireEvent.click(dial(container)!);
    // The open list follows the list, so rows arrive when the read lands.
    await waitFor(() =>
      expect(labels(container)).toEqual([OPUS, MINI, "off", "low", "medium", "high"]),
    );

    const mini = modelRows(container).find((b) => b.textContent?.includes(MINI))!;
    fireEvent.click(mini);
    await waitFor(() => expect(calls.some((c) => c.url.includes("/model/qa-pi"))).toBe(true));
    const post = calls.find((c) => c.url.includes("/model/qa-pi"))!;
    expect(post.method).toBe("POST");
    expect(post.body).toEqual({ tool: "pi", model: MINI, effort: "", awaitReady: false });
    await waitFor(() => expect(shown(container)).toBe(`Model and thinking: ${MINI} · high`));
  });

  // Each read of the list costs the server a login shell running pi.
  it("asks nothing about pi's models for a session that is not pi", async () => {
    const calls = serve();
    const { container } = render(() => <SessionView session="qa-claude" tool={() => "claude"} />);
    await waitFor(() => expect(dial(container)).not.toBeNull());
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.some((c) => c.url.endsWith("/pi-models"))).toBe(false);
  });
});
