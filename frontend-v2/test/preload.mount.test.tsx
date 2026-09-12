/**
 * SEAM TWO and THREE: which sessions the shell mounts, and what a click does to
 * the one the pointer preloaded.
 *
 * The whole feature is one invariant. A preload is a REAL tmux attach — 627 ms
 * of ttyd forking, tmux attaching and redrawing, measured (ADR-0026) — so
 * promoting it must not rebuild anything. `<For>` keys a row by the identity of
 * its item, and Solid disposes a row whose item is replaced, taking
 * TerminalNative, the xterm instance and the open socket with it. The preloaded
 * session arrives from `store/preload.ts` and the promoted one from
 * `store/keepalive.ts`, which are two different objects for the same session,
 * so the list the shell renders has to hand out ONE object per session and keep
 * it. That is `createMountList`, and this file is it.
 *
 * The rendering half is asserted against a real `<For>` rather than by reading
 * the array, because "the array looks right" and "the DOM node survived" are
 * different claims and only the second one is the feature.
 */
import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import { createMemo, createSignal, For } from "solid-js";
import { createMountList, slotClasses } from "../src/components/App";
import type { KeptSession } from "../src/store/keepalive";
import type { PreloadSlot } from "../src/store/preload";

const kept = (name: string, owner?: string): KeptSession => ({
  key: `${owner ?? ""}\0${name}`,
  name,
  owner,
});

const slotFor = (name: string, owner?: string): PreloadSlot => ({
  key: `${owner ?? ""}\0${name}`,
  name,
  owner,
  filledAt: 1_700_000_000_000,
});

describe("createMountList", () => {
  it("mounts the kept sessions, in the order keepalive holds them", () => {
    const list = createMountList();
    expect(list([kept("alpha"), kept("beta")], null).map((k) => k.name)).toEqual(["alpha", "beta"]);
  });

  it("adds the preloaded session at the end, where it cannot move a live row", () => {
    const list = createMountList();
    expect(list([kept("alpha")], slotFor("beta")).map((k) => k.name)).toEqual(["alpha", "beta"]);
  });

  it("mounts a session once when it is both kept and preloaded", () => {
    const list = createMountList();
    expect(list([kept("alpha")], slotFor("alpha")).map((k) => k.name)).toEqual(["alpha"]);
  });

  // THE INVARIANT. The preload store hands over one object and keepalive hands
  // over another; if the identity changed between them, the click that promoted
  // the preload would dispose the terminal it had just paid for.
  it("keeps one identity for a session across the promotion", () => {
    const list = createMountList();
    const before = list([kept("alpha")], slotFor("beta"));
    const after = list([kept("alpha"), kept("beta")], null);
    expect(after[1]).toBe(before[1]);
    expect(after[0]).toBe(before[0]);
  });

  it("tells two owners' sessions of the same name apart", () => {
    const list = createMountList();
    const out = list([kept("code")], slotFor("code", "bob"));
    expect(out).toHaveLength(2);
    expect(out.map((k) => k.owner)).toEqual([undefined, "bob"]);
  });

  it("forgets a session that leaves, so a later one is a fresh mount", () => {
    const list = createMountList();
    const first = list([], slotFor("beta"));
    list([], null); // the TTL dropped it unopened
    const second = list([], slotFor("beta"));
    expect(second[0]).not.toBe(first[0]);
  });
});

describe("the shell's session slots", () => {
  /** One row per mount, rendered the way App renders them. */
  function harness() {
    const [kept_, setKept] = createSignal<KeptSession[]>([]);
    const [slot, setSlot] = createSignal<PreloadSlot | null>(null);
    const [selected, setSelected] = createSignal<string | null>(null);
    const list = createMountList();
    /** Every mount this harness has ever performed, in order. */
    const mounts: string[] = [];
    const { container } = render(() => {
      const mounted = createMemo(() => list(kept_(), slot()));
      return (
        <For each={mounted()}>
          {(k) => {
            mounts.push(k.name);
            const shown = () => k.key === selected();
            return (
              <div
                class="tl-session-slot"
                classList={slotClasses(shown(), slot()?.key === k.key)}
                data-name={k.name}
                data-preload={slot()?.key === k.key ? "" : undefined}
              />
            );
          }}
        </For>
      );
    });
    const row = (name: string) => container.querySelector(`[data-name="${name}"]`);
    return { container, mounts, row, setKept, setSlot, setSelected };
  }

  it("renders a preloaded session offstage, and does not select it", () => {
    const h = harness();
    h.setKept([kept("alpha")]);
    h.setSelected(kept("alpha").key);
    h.setSlot(slotFor("beta"));

    const preloaded = h.row("beta")!;
    expect(preloaded).toBeTruthy();
    // Offstage, NOT `display: none`: a terminal built inside one cannot
    // measure its own font, and the click pays for that in a double-width
    // first frame. `slotClasses` carries the measurement.
    expect(preloaded.classList.contains("tl-offstage")).toBe(true);
    expect(preloaded.classList.contains("tl-hidden")).toBe(false);
    expect(preloaded.hasAttribute("data-preload")).toBe(true);
    // The session on screen is unchanged: a hover selects nothing.
    expect(h.row("alpha")!.classList.contains("tl-hidden")).toBe(false);
    expect(h.row("alpha")!.classList.contains("tl-offstage")).toBe(false);
  });

  it("reveals the preloaded terminal on a click instead of building one", () => {
    const h = harness();
    h.setSlot(slotFor("beta"));
    const node = h.row("beta");
    expect(h.mounts).toEqual(["beta"]);

    // The click: keepalive takes the session on and the slot empties, in that
    // order, inside one batch.
    h.setKept([kept("beta")]);
    h.setSlot(null);
    h.setSelected(kept("beta").key);

    expect(h.mounts).toEqual(["beta"]); // nothing was mounted a second time
    expect(h.row("beta")).toBe(node); // and it is the very same element
    expect(h.row("beta")!.classList.contains("tl-hidden")).toBe(false);
    expect(h.row("beta")!.classList.contains("tl-offstage")).toBe(false);
    expect(h.row("beta")!.hasAttribute("data-preload")).toBe(false);
  });

  it("leaves the preload alone while another session is opened", () => {
    const h = harness();
    h.setSlot(slotFor("beta"));
    const node = h.row("beta");

    h.setKept([kept("alpha")]);
    h.setSelected(kept("alpha").key);

    expect(h.row("beta")).toBe(node);
    // Still the pointer's, so still offstage rather than hidden.
    expect(h.row("beta")!.classList.contains("tl-offstage")).toBe(true);
    expect(h.mounts).toEqual(["beta", "alpha"]);
  });

  it("drops the mount when the slot is emptied unopened", () => {
    const h = harness();
    h.setSlot(slotFor("beta"));
    expect(h.row("beta")).toBeTruthy();

    h.setSlot(null); // 60 s TTL, a replacement, or a failed attach

    expect(h.row("beta")).toBeNull();
  });
});
