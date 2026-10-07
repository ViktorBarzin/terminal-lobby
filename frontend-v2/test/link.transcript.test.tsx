import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import Transcript from "../src/link/Transcript";

/**
 * A shared session's conversation on the public-link page (ADR-0040,
 * ADR-0041). It draws pasted pictures through the link's own route, follows a
 * live conversation by asking only for what is new, and stops once the
 * session has ended.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const LINK = "0123456789abcdef";
const RECORD = "1ecbc9e7-ef70-4213-bd81-82c2dfcb5169";
const noop = () => {};

const answer = (body: object) => ({ ok: true, status: 200, json: async () => body });

describe("a shared conversation", () => {
  it("draws a pasted picture through the link's image route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        answer({
          title: "Deploy",
          live: false,
          last: 3,
          events: [
            {
              id: 1,
              kind: "user",
              session: LINK,
              turnId: "c1-t1",
              body: "[Image #1] what is this?",
              record: RECORD,
              images: [{ n: 0, mediaType: "image/png", bytes: 97, paste: 1 }],
            },
            { id: 2, kind: "text", session: LINK, turnId: "c1-t1", body: "A blue square." },
            { id: 3, kind: "turn_end", session: LINK, turnId: "c1-t1" },
          ],
        }),
      ),
    );
    const { container } = render(() => (
      <Transcript link={LINK} onGone={noop} onLive={noop} onTitle={noop} />
    ));
    await waitFor(() => expect(container.querySelector(".tl-row-message")).not.toBeNull());
    const srcs = [...container.querySelectorAll("img")].map((i) => i.getAttribute("src") ?? "");
    expect(srcs).toContain(`/s/api/link/image?l=${LINK}&record=${RECORD}&n=0`);
  });

  it("follows a live conversation, asking only for what came after", async () => {
    const urls: string[] = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        call++;
        if (call === 1) {
          return answer({
            title: "Deploy",
            live: true,
            last: 1,
            events: [{ id: 1, kind: "user", session: LINK, turnId: "c1-t1", body: "go" }],
          });
        }
        return answer({
          title: "Deploy",
          live: false,
          last: 2,
          events: [{ id: 2, kind: "text", session: LINK, turnId: "c1-t1", body: "Done now." }],
        });
      }),
    );
    const onLive = vi.fn();
    const { container } = render(() => (
      <Transcript link={LINK} onGone={noop} onLive={onLive} onTitle={noop} />
    ));
    await waitFor(() => expect(container.textContent).toContain("Done now."), { timeout: 6000 });
    expect(urls[0]).toBe(`/s/api/link/transcript?l=${LINK}`);
    expect(urls[1]).toBe(`/s/api/link/transcript?l=${LINK}&after=1`);
    expect(onLive).toHaveBeenLastCalledWith(false);
    // Ended: it stops asking.
    await new Promise((r) => setTimeout(r, 3500));
    expect(urls).toHaveLength(2);
  }, 12000);

  it("tells the page the link is gone on a 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => null })),
    );
    const onGone = vi.fn();
    render(() => <Transcript link={LINK} onGone={onGone} onLive={noop} onTitle={noop} />);
    await waitFor(() => expect(onGone).toHaveBeenCalled());
  });
});
