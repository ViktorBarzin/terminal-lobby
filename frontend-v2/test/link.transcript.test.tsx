import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import Transcript from "../src/link/Transcript";

/**
 * An ended public link's conversation (ADR-0040). The first live check drew
 * a pasted picture's prompt with no picture: the timeline draws one only when
 * it has a session to name, and the link page passed none. This pins that the
 * page draws it, through the link's own route rather than the lobby's.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LINK = "0123456789abcdef";
const RECORD = "1ecbc9e7-ef70-4213-bd81-82c2dfcb5169";

describe("an ended link's transcript", () => {
  it("draws a pasted picture through the link's image route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          title: "Deploy",
          endedAt: 1,
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
      })),
    );
    const { container } = render(() => <Transcript link={LINK} onGone={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-row-message")).not.toBeNull());
    const srcs = [...container.querySelectorAll("img")].map((i) => i.getAttribute("src") ?? "");
    expect(srcs).toContain(`/s/api/link/image?l=${LINK}&record=${RECORD}&n=0`);
  });

  it("tells the page the link is gone on a 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => null })),
    );
    const onGone = vi.fn();
    render(() => <Transcript link={LINK} onGone={onGone} />);
    await waitFor(() => expect(onGone).toHaveBeenCalled());
  });
});
