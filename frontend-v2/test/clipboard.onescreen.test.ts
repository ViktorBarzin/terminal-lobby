/**
 * One paste, one upload — no matter how many sessions the tab is holding open.
 *
 * Reported 2026-08-29: "pasting. image sometimes pastes in multiple times."
 *
 * `installImageClipboard` registers a CAPTURE-phase paste listener on the
 * shared document, and it is installed per mounted SessionView. Since
 * 0e94a63 ("keep every session you open mounted") every session opened in a tab
 * stays mounted and is merely CSS-hidden — so a tab holding N sessions holds N
 * listeners, and one paste is handled N times. `e.stopPropagation()` does not
 * help: it stops other NODES, not sibling listeners on the same node in the
 * same phase.
 *
 * The evidence was on disk. One paste on 2026-08-29 left four byte-identical
 * PNGs (one md5, 859,263 bytes each) in four different session directories of
 * the real clipboard store inside 307ms. Every same-second multi-directory
 * cluster in that store post-dates 2026-08-19, which is when keepalive landed;
 * before it, every paste lands in exactly one directory.
 *
 * "Sometimes" was therefore "as many times as you have sessions open" — and
 * with one session open it is indistinguishable from correct.
 *
 * The gate is `active`, and it is checked FIRST, before preventDefault: a
 * hidden session's handler must not even swallow the event, or the visible
 * session's handler gets a gesture with its default already suppressed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { installImageClipboard } from "../src/clipboard/attach";

const png = () =>
  new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });

/** A paste event carrying one image, as a browser delivers it. */
function pasteEvent(file: File): Event {
  const e = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", {
    value: { items: [{ kind: "file", type: file.type, getAsFile: () => file }] },
  });
  return e;
}

/** One mounted session's clipboard install, with its uploads counted. */
function mount(opts: { session: string; active?: () => boolean }) {
  const uploads: string[] = [];
  const clip = installImageClipboard({
    session: () => opts.session,
    sendToPty: () => true,
    ...(opts.active ? { active: opts.active } : {}),
    upload: async (_blob: Blob, o: { session: string }) => {
      uploads.push(o.session);
      return { path: `/store/${o.session}/shot.png` };
    },
    toast: () => 1,
    dismiss: () => {},
  } as never);
  return { clip, uploads };
}

const mounted: { dispose: () => void }[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!.dispose();
  vi.restoreAllMocks();
});

describe("a paste is handled once, however many sessions are mounted", () => {
  it("uploads once when four sessions are open and one is on screen", async () => {
    // The measured case: four kept sessions, four listeners, four files.
    const names = ["alpha", "beta", "gamma", "delta"];
    const rigs = names.map((n) =>
      mount({ session: n, active: () => n === "alpha" }),
    );
    rigs.forEach((r) => mounted.push(r.clip));

    document.dispatchEvent(pasteEvent(png()));
    await new Promise((r) => setTimeout(r, 0));

    const all = rigs.flatMap((r) => r.uploads);
    expect(all, "one upload, into the session on screen").toEqual(["alpha"]);
  });

  it("still uploads exactly once when only one session is mounted", async () => {
    // The case that always looked fine, and must keep working.
    const rig = mount({ session: "solo", active: () => true });
    mounted.push(rig.clip);
    document.dispatchEvent(pasteEvent(png()));
    await new Promise((r) => setTimeout(r, 0));
    expect(rig.uploads).toEqual(["solo"]);
  });

  it("does not swallow the event on behalf of a session that is off screen", async () => {
    // preventDefault comes BEFORE the routing in this handler, so an off-screen
    // instance that bailed late would still have consumed the gesture — and the
    // on-screen one, or the composer, would get a dead event.
    const hidden = mount({ session: "hidden", active: () => false });
    mounted.push(hidden.clip);
    const e = pasteEvent(png());
    document.dispatchEvent(e);
    await new Promise((r) => setTimeout(r, 0));
    expect(hidden.uploads, "no upload").toEqual([]);
    expect(e.defaultPrevented, "the gesture is left alone").toBe(false);
  });

  it("routes to the composer only for the session on screen", async () => {
    const seen: string[] = [];
    const rigs = ["front", "back"].map((n) => {
      const clip = installImageClipboard({
        session: () => n,
        sendToPty: () => true,
        active: () => n === "front",
        composerOwns: () => true,
        onComposerFiles: async () => {
          seen.push(n);
        },
        toast: () => 1,
        dismiss: () => {},
      } as never);
      mounted.push(clip);
      return clip;
    });
    expect(rigs).toHaveLength(2);

    document.dispatchEvent(pasteEvent(png()));
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["front"]);
  });

  it("treats an absent `active` as on screen, so existing callers are unchanged", async () => {
    const rig = mount({ session: "legacy" });
    mounted.push(rig.clip);
    document.dispatchEvent(pasteEvent(png()));
    await new Promise((r) => setTimeout(r, 0));
    expect(rig.uploads).toEqual(["legacy"]);
  });
});
