/**
 * A dropped file lands in the tile it was dropped ON, not the tile that happens
 * to hold focus.
 *
 * `installImageClipboard` puts its drop listener on the WINDOW and every
 * mounted `SessionView` installs one, so a four-tile workspace delivers one
 * drop to four listeners. Until 2026-09-12 they all gated on the same flag the
 * paste path uses — `active`, which is the focused tile — so exactly one
 * instance took the drop and it was the focused one wherever the pointer had
 * been. Dragging a screenshot from the desktop onto tile B while tile A held
 * focus uploaded into A's session directory and typed A's path at A's pty.
 *
 * Nothing a person could do would have prevented it. Focus moves on
 * `pointerdown` (App.tsx's capture-phase press on the slot) and a file drag
 * from the desktop sends no `pointerdown` at all — the browser's drag sequence
 * is dragenter / dragover / drop — so the tile under the pointer never became
 * the focused one on the way in.
 *
 * The gate is right for a PASTE, which arrives with a clipboard and no
 * coordinates: its only sane destination is the pty the keystrokes are already
 * going to. A DROP arrives with a point. So the drop is routed by hit-testing
 * that point against the visible tile boxes, and focus moves to the winner as
 * part of the drop — both halves matter, because the path is typed through
 * `window.__tlSendToTerminal`, a handle `lib/ownwhile.ts` gives to the focused
 * tile alone. Routing the upload without moving focus would put the image in
 * B's gallery and B's path on A's input line.
 *
 * The single-session lobby is the other half of the contract and is asserted
 * here too: with nothing reporting a tile box the election declines and the
 * `active` gate is the whole rule, unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installImageClipboard, type TileBox } from "../src/clipboard/attach";
import type { UploadOptions } from "../src/clipboard/upload";

vi.mock("../src/telemetry/track", () => ({ track: () => {} }));

const STORE = "/var/lib/clipboard-store/wizard";

const png = (name: string): File =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });

/**
 * A drop with real coordinates. `MouseEvent` rather than a bare `Event` because
 * `clientX`/`clientY` are the whole subject here and jsdom only gives them to
 * an event constructed as one; `dataTransfer` is defined on top, which is what
 * every other test in this subsystem does.
 */
function dropAt(x: number, y: number, files: File[]): MouseEvent {
  const e = new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(e, "dataTransfer", { value: { files } });
  return e;
}

/** What one mounted tile did with the gesture, in the order it did it. */
interface Tile {
  session: string;
  /** session names, one per file that uploaded through this install. */
  uploads: string[];
  /** the bytes this install typed at its pty. */
  sent: string[];
  dispose: () => void;
}

interface TileSpec {
  session: string;
  /** viewport box, or null for "not a tile" — off screen, or no workspace. */
  box: TileBox | null;
  focused?: boolean;
  watching?: boolean;
}

/** Every event in the order it happened, across all tiles, so the ORDER of a
 *  focus move against the upload that follows it is assertable and not assumed. */
let log: string[] = [];
let focus = "";
const live: Tile[] = [];

function mount(spec: TileSpec): Tile {
  const tile: Tile = { session: spec.session, uploads: [], sent: [], dispose: () => {} };
  const clip = installImageClipboard({
    session: () => spec.session,
    // The real wiring resolves `window.__tlSendToTerminal`, which belongs to
    // whichever tile is focused — so the stub reads the same shared variable
    // rather than closing over its own name. A fix that routed the upload
    // without moving focus would show up here as the path arriving at the
    // wrong session, and nowhere else.
    sendToPty: (t: string) => {
      log.push(`send:${focus}`);
      const target = live.find((x) => x.session === focus);
      target?.sent.push(t);
      return target !== undefined;
    },
    ...(spec.watching ? { enabled: () => false } : {}),
    active: () => focus === spec.session,
    tileBox: () => spec.box,
    focusTile: () => {
      log.push(`focus:${spec.session}`);
      focus = spec.session;
    },
    upload: async (_blob: Blob, o: UploadOptions) => {
      log.push(`upload:${o.session}`);
      tile.uploads.push(o.session);
      return { path: `${STORE}/${o.session}/${o.filename ?? "pasted.png"}`, stored: true };
    },
    toast: () => 0,
    dismiss: () => {},
  });
  tile.dispose = clip.dispose;
  live.push(tile);
  return tile;
}

/**
 * A 2x2 workspace on a 1200x800 viewport, in the shape `toRects` produces:
 * the tiles tile the area exactly and adjacent ones share a boundary.
 *
 *     alpha  (0,0)-(600,400)     beta  (600,0)-(1200,400)
 *     gamma  (0,400)-(600,800)   delta (600,400)-(1200,800)
 */
const QUAD: Record<string, TileBox> = {
  alpha: { left: 0, top: 0, right: 600, bottom: 400 },
  beta: { left: 600, top: 0, right: 1200, bottom: 400 },
  gamma: { left: 0, top: 400, right: 600, bottom: 800 },
  delta: { left: 600, top: 400, right: 1200, bottom: 800 },
};

function workspace(focused: string, watching: string[] = []): Tile[] {
  focus = focused;
  return Object.entries(QUAD).map(([session, box]) =>
    mount({ session, box, watching: watching.includes(session) }),
  );
}

/** Every upload that happened anywhere, so "exactly one tile took it" is one
 *  assertion rather than four. */
const allUploads = (): string[] => live.flatMap((t) => t.uploads);

beforeEach(() => {
  log = [];
  focus = "";
  live.length = 0;
});

afterEach(() => {
  while (live.length) live.pop()?.dispose();
});

describe("a drop belongs to the tile under the pointer", () => {
  it("uploads into the UNFOCUSED tile the file was dropped on", async () => {
    // The reported case: focus on alpha (top-left), the file dropped on delta
    // (bottom-right). Before the fix every one of these four listeners gated on
    // `active`, so alpha's took it and delta never heard about the drop.
    const tiles = workspace("alpha");
    window.dispatchEvent(dropAt(900, 600, [png("shot.png")]));
    await vi.waitFor(() => expect(allUploads()).toHaveLength(1));

    expect(allUploads(), "delta's bucket, not alpha's").toEqual(["delta"]);
    const delta = tiles.find((t) => t.session === "delta");
    expect(delta?.sent, "and delta's own path").toEqual([`${STORE}/delta/shot.png `]);
  });

  it("moves focus to that tile BEFORE the path is typed", async () => {
    // Both halves of the fix in one assertion. `sendToPty` resolves a window
    // handle the focused tile owns, so an upload routed to delta while alpha
    // still held focus would put delta's path on alpha's input line.
    workspace("alpha");
    window.dispatchEvent(dropAt(900, 600, [png("shot.png")]));
    await vi.waitFor(() => expect(log).toContain("send:delta"));

    expect(log).toEqual(["focus:delta", "upload:delta", "send:delta"]);
    expect(focus, "and it stays there for whatever is typed next").toBe("delta");
  });

  it("leaves a drop on the focused tile exactly where it was", async () => {
    const tiles = workspace("alpha");
    window.dispatchEvent(dropAt(300, 200, [png("shot.png")]));
    await vi.waitFor(() => expect(allUploads()).toHaveLength(1));

    expect(allUploads()).toEqual(["alpha"]);
    // No focus move: alpha already had it, and a redundant `store.select` is a
    // write on every drop into the tile you are already typing into.
    expect(log).toEqual(["upload:alpha", "send:alpha"]);
    expect(tiles[0]?.sent).toEqual([`${STORE}/alpha/shot.png `]);
  });

  it("takes the drop exactly once, whichever tile wins", async () => {
    // Four window listeners, one gesture. The 2026-08-29 report was this count
    // going wrong in the other direction — four byte-identical PNGs in four
    // session directories inside 307ms — so the election has to elect ONE, not
    // merely elect correctly.
    workspace("alpha");
    window.dispatchEvent(dropAt(700, 100, [png("a.png"), png("b.png")]));
    await vi.waitFor(() => expect(allUploads()).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 0));

    expect(allUploads(), "two files, one tile").toEqual(["beta", "beta"]);
    expect(
      log.filter((e) => e.startsWith("send:")),
      "one line of paths",
    ).toHaveLength(1);
  });

  it("gives a drop that misses every tile to the focused one", async () => {
    // The gap beside a divider, or the sidebar. Losing the file because the
    // pointer was three pixels off a boundary would be worse than the bug this
    // routing fixes, so the old destination is the fallback.
    workspace("gamma");
    window.dispatchEvent(dropAt(1400, 900, [png("shot.png")]));
    await vi.waitFor(() => expect(allUploads()).toHaveLength(1));

    expect(allUploads()).toEqual(["gamma"]);
    expect(log, "already focused, so nothing moves").toEqual(["upload:gamma", "send:gamma"]);
  });

  it("lands on exactly one tile when the pointer is on the seam between two", async () => {
    // `toRects` tiles the area exactly, so x=600 is inside both alpha and beta
    // under the closed-bounds test `dnd/tiles.ts` uses for the same question.
    // Which one wins matters less than that only one does.
    workspace("delta");
    window.dispatchEvent(dropAt(600, 200, [png("shot.png")]));
    await vi.waitFor(() => expect(allUploads()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));

    expect(allUploads()).toHaveLength(1);
    expect(["alpha", "beta"]).toContain(allUploads()[0]);
  });

  it("refuses on behalf of a WATCHING tile instead of handing the drop to the focused one", async () => {
    // A read-only tile cannot be typed into, and the upload is the half that
    // must not happen anyway — it files the image in that session's gallery
    // before the path is refused. Routing the drop to a tile that then declines
    // is the honest outcome; quietly uploading into the focused session instead
    // would put the file somewhere nobody aimed at.
    workspace("alpha", ["beta"]);
    window.dispatchEvent(dropAt(900, 200, [png("shot.png")]));
    await new Promise((r) => setTimeout(r, 0));

    expect(allUploads(), "nothing uploaded anywhere").toEqual([]);
    expect(log.filter((e) => e.startsWith("send:"))).toEqual([]);
    // Focus still moves, and that is deliberate: clicking a watching tile
    // focuses it too (App.tsx's slot press does not check the watch), so the
    // drop leaves the same tile selected a click would have, and the refusal
    // toast is what says why nothing was typed.
    expect(focus).toBe("beta");
  });
});

describe("one session on screen behaves exactly as it did before tiles", () => {
  it("takes a drop anywhere on the page when nothing reports a tile box", async () => {
    // The ordinary lobby, and every existing caller: `NewSessionComposer` and
    // every test written before this election existed pass no `tileBox`, so it
    // declines and `active` is the whole rule.
    focus = "solo";
    const solo = mount({ session: "solo", box: null });
    window.dispatchEvent(dropAt(17, 23, [png("shot.png")]));
    await vi.waitFor(() => expect(solo.uploads).toHaveLength(1));

    expect(solo.uploads).toEqual(["solo"]);
    expect(solo.sent).toEqual([`${STORE}/solo/shot.png `]);
    expect(log, "no election, so no focus move").toEqual(["upload:solo", "send:solo"]);
  });

  it("still keeps a kept-but-hidden session from taking the drop", async () => {
    // The 2026-08-29 duplication guard, untouched: three sessions mounted, one
    // on screen, no boxes anywhere.
    focus = "front";
    const front = mount({ session: "front", box: null });
    const back = mount({ session: "back", box: null });
    const older = mount({ session: "older", box: null });
    window.dispatchEvent(dropAt(400, 300, [png("shot.png")]));
    await vi.waitFor(() => expect(front.uploads).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));

    expect(front.uploads).toEqual(["front"]);
    expect(back.uploads).toEqual([]);
    expect(older.uploads).toEqual([]);
  });

  it("takes every drop in the view when the lone session DOES report a box", async () => {
    // A lobby showing one session is a workspace of one — "splits are the view
    // rather than a mode" — so its box covers the view and every drop in the
    // view is inside it.
    focus = "solo";
    const solo = mount({ session: "solo", box: { left: 0, top: 0, right: 1200, bottom: 800 } });
    window.dispatchEvent(dropAt(5, 795, [png("shot.png")]));
    await vi.waitFor(() => expect(solo.uploads).toHaveLength(1));

    expect(solo.uploads).toEqual(["solo"]);
    expect(log, "it already has focus").toEqual(["upload:solo", "send:solo"]);
  });

  it("does not let an off-screen preload claim the corner it is laid out in", async () => {
    // `.tl-offstage` is `visibility: hidden` and FULL SIZE, so a preload that
    // reported its real box would cover every tile and take every drop. It
    // reports null instead, and a `display: none` kept session measures 0x0 —
    // which is why a zero-area box is not a tile either.
    focus = "alpha";
    const tiles = workspace("alpha");
    const preload = mount({ session: "preload", box: null });
    const hidden = mount({ session: "hidden", box: { left: 0, top: 0, right: 0, bottom: 0 } });

    window.dispatchEvent(dropAt(0, 0, [png("shot.png")]));
    await vi.waitFor(() => expect(allUploads()).toHaveLength(1));

    expect(preload.uploads).toEqual([]);
    expect(hidden.uploads).toEqual([]);
    expect(tiles[0]?.uploads, "the tile that actually occupies (0,0)").toEqual(["alpha"]);
  });
});
