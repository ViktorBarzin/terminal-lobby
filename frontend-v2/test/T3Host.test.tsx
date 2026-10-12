import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSignal } from "solid-js";
import { render, fireEvent } from "@solidjs/testing-library";
import { T3Host } from "../src/components/T3Host";
import { createFrameClaims } from "../src/t3/frame-claim";
import { loadEnvironmentId, saveEnvironmentId, type FrameChord } from "../src/t3/embed.logic";

const ORIGIN = "http://127.0.0.1:17691";
const CHORDS: FrameChord[] = [
  { ctrl: false, shift: false, alt: true, meta: false, key: "1", code: "Digit1" },
];

const frames = (): HTMLIFrameElement[] => [
  ...document.querySelectorAll<HTMLIFrameElement>("iframe"),
];

function fromFrame(frame: HTMLIFrameElement | null, data: unknown, origin = ORIGIN): void {
  window.dispatchEvent(
    new MessageEvent("message", { data, origin, source: frame?.contentWindow ?? null }),
  );
}

const altOne = {
  type: "tl-key",
  v: 1,
  key: "1",
  code: "Digit1",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: true,
  repeat: false,
};

describe("<T3Host> — at most one T3 frame", () => {
  beforeEach(() => localStorage.clear());

  it("two sessions that both want the frame draw one, in the one that asked last", () => {
    const claims = createFrameClaims();
    const host = (key: string) => (
      <T3Host
        claimKey={key}
        want={() => true}
        prefer={() => false}
        threadId={() => key}
        origin={ORIGIN}
        chords={() => CHORDS}
        claims={claims}
      />
    );
    const { container } = render(() => (
      <div>
        <div class="a">{host("a")}</div>
        <div class="b">{host("b")}</div>
      </div>
    ));
    expect(frames()).toHaveLength(1);
    expect(container.querySelector(".b iframe")).toBeTruthy();
    // The other one says where the frame is and offers to bring it here.
    const here = container.querySelector<HTMLButtonElement>(".a .tl-t3-elsewhere button");
    expect(here).toBeTruthy();
    fireEvent.click(here!);
    expect(frames()).toHaveLength(1);
    expect(container.querySelector(".a iframe")).toBeTruthy();
  });

  it("a kept session going off screen unmounts its frame rather than keeping it", () => {
    const claims = createFrameClaims();
    const [onScreen, setOnScreen] = createSignal(true);
    render(() => (
      <T3Host
        claimKey="a"
        want={onScreen}
        prefer={() => false}
        threadId={() => "a"}
        origin={ORIGIN}
        chords={() => CHORDS}
        claims={claims}
      />
    ));
    expect(frames()).toHaveLength(1);
    setOnScreen(false);
    expect(frames()).toHaveLength(0);
    expect(claims.owner()).toBeNull();
  });

  it("the focused tile takes the frame when it gains focus", () => {
    const claims = createFrameClaims();
    const [focusA, setFocusA] = createSignal(false);
    const { container } = render(() => (
      <div>
        <div class="a">
          <T3Host
            claimKey="a"
            want={() => true}
            prefer={focusA}
            threadId={() => "a"}
            origin={ORIGIN}
            chords={() => CHORDS}
            claims={claims}
          />
        </div>
        <div class="b">
          <T3Host
            claimKey="b"
            want={() => true}
            prefer={() => !focusA()}
            threadId={() => "b"}
            origin={ORIGIN}
            chords={() => CHORDS}
            claims={claims}
          />
        </div>
      </div>
    ));
    expect(container.querySelector(".b iframe")).toBeTruthy();
    setFocusA(true);
    expect(frames()).toHaveLength(1);
    expect(container.querySelector(".a iframe")).toBeTruthy();
  });

  it("the module-wide claims are shared by every host that does not bring its own", () => {
    render(() => (
      <div>
        <T3Host
          claimKey="x"
          want={() => true}
          prefer={() => false}
          threadId={() => "x"}
          origin={ORIGIN}
          chords={() => CHORDS}
        />
        <T3Host
          claimKey="y"
          want={() => true}
          prefer={() => false}
          threadId={() => "y"}
          origin={ORIGIN}
          chords={() => CHORDS}
        />
      </div>
    ));
    expect(frames()).toHaveLength(1);
  });

  it("frames the thread URL when the environment id is known", () => {
    saveEnvironmentId(ORIGIN, "env-1");
    render(() => (
      <T3Host
        claimKey="a"
        want={() => true}
        prefer={() => true}
        threadId={() => "824smya2cmz5"}
        origin={ORIGIN}
        chords={() => CHORDS}
        claims={createFrameClaims()}
      />
    ));
    expect(frames()[0]!.getAttribute("src")).toBe(`${ORIGIN}/env-1/824smya2cmz5?embed`);
  });

  it("says so instead of framing anything when the session has no thread", () => {
    const { container } = render(() => (
      <T3Host
        claimKey="a"
        want={() => true}
        prefer={() => true}
        threadId={() => null}
        origin={ORIGIN}
        chords={() => CHORDS}
        claims={createFrameClaims()}
      />
    ));
    expect(frames()).toHaveLength(0);
    expect(container.textContent).toContain("own Claude sessions");
  });
});

describe("<T3Host> — the message contract", () => {
  beforeEach(() => localStorage.clear());

  function mount() {
    const r = render(() => (
      <T3Host
        claimKey="a"
        want={() => true}
        prefer={() => true}
        threadId={() => "auth"}
        origin={ORIGIN}
        chords={() => CHORDS}
        claims={createFrameClaims()}
      />
    ));
    const frame = frames()[0]!;
    const post = vi.fn();
    Object.defineProperty(frame.contentWindow!, "postMessage", { value: post, configurable: true });
    const keys: KeyboardEvent[] = [];
    const onKey = (e: KeyboardEvent): void => void keys.push(e);
    window.addEventListener("keydown", onKey, true);
    return { r, frame, post, keys, done: () => window.removeEventListener("keydown", onKey, true) };
  }

  it("replays a key from the frame into this document, where the lobby's listeners are", () => {
    const m = mount();
    fromFrame(m.frame, altOne);
    expect(m.keys).toHaveLength(1);
    expect(m.keys[0]).toMatchObject({ key: "1", code: "Digit1", altKey: true, ctrlKey: false });
    expect(m.keys[0]!.target).toBe(m.frame);
    m.done();
  });

  it("drops a key that matches no chord the lobby sent the frame", () => {
    const m = mount();
    fromFrame(m.frame, { ...altOne, key: "W", code: "KeyW", shiftKey: true });
    fromFrame(m.frame, { ...altOne, key: "Backspace", code: "Backspace", shiftKey: true });
    expect(m.keys).toHaveLength(0);
    m.done();
  });

  it("delegates no clipboard access to a frame on a dev origin", () => {
    const m = mount();
    expect(m.frame.hasAttribute("allow")).toBe(false);
    m.done();
  });

  it("ignores a key from any other origin", () => {
    const m = mount();
    fromFrame(m.frame, altOne, "https://evil.example");
    expect(m.keys).toHaveLength(0);
    m.done();
  });

  it("ignores a key from the right origin but another window", () => {
    const m = mount();
    window.dispatchEvent(
      new MessageEvent("message", { data: altOne, origin: ORIGIN, source: window }),
    );
    expect(m.keys).toHaveLength(0);
    m.done();
  });

  it("ignores a malformed message", () => {
    const m = mount();
    fromFrame(m.frame, { ...altOne, type: "tl-run" });
    expect(m.keys).toHaveLength(0);
    m.done();
  });

  it("answers tl-ready with the chords, opens the thread, and remembers the environment", () => {
    const m = mount();
    fromFrame(m.frame, { type: "tl-ready", v: 1, environmentId: "env-9", threadId: null });
    expect(loadEnvironmentId(ORIGIN)).toBe("env-9");
    expect(m.post).toHaveBeenCalledWith({ type: "tl-bindings", v: 1, chords: CHORDS }, ORIGIN);
    expect(m.post).toHaveBeenCalledWith({ type: "tl-open", v: 1, threadId: "auth" }, ORIGIN);
    m.done();
  });

  it("does not re-open a thread the frame already shows", () => {
    const m = mount();
    fromFrame(m.frame, { type: "tl-ready", v: 1, environmentId: "env-9", threadId: "auth" });
    expect(m.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "tl-open" }), ORIGIN);
    m.done();
  });

  it("never posts before the frame says it is ready, and never to '*'", () => {
    const m = mount();
    expect(m.post).not.toHaveBeenCalled();
    fromFrame(m.frame, { type: "tl-ready", v: 1, environmentId: "env-9", threadId: "auth" });
    for (const call of m.post.mock.calls) expect(call[1]).toBe(ORIGIN);
    m.done();
  });
});

describe("<T3Host> — a frame in a tile that is not focused", () => {
  beforeEach(() => localStorage.clear());

  /** Tile A holds the frame while tile B is the focused one. */
  function mountUnfocused() {
    const [focusedA, setFocusedA] = createSignal(false);
    const onFocus = vi.fn(() => setFocusedA(true));
    render(() => (
      <T3Host
        claimKey="a"
        want={() => true}
        prefer={focusedA}
        onFocus={onFocus}
        threadId={() => "a"}
        origin={ORIGIN}
        chords={() => CHORDS}
        claims={createFrameClaims()}
      />
    ));
    const frame = frames()[0]!;
    const keys: { key: string; focusedA: boolean }[] = [];
    const onKey = (e: KeyboardEvent): void => void keys.push({ key: e.key, focusedA: focusedA() });
    window.addEventListener("keydown", onKey, true);
    return {
      frame,
      onFocus,
      keys,
      focusedA,
      done: () => window.removeEventListener("keydown", onKey, true),
    };
  }

  it("focuses its own tile before replaying a chord, so the chord acts on this session", () => {
    const m = mountUnfocused();
    fromFrame(m.frame, altOne);
    expect(m.onFocus).toHaveBeenCalledTimes(1);
    expect(m.keys).toEqual([{ key: "1", focusedA: true }]);
    m.done();
  });

  it("drops the chord when its tile could not take focus", () => {
    const onFocus = vi.fn();
    render(() => (
      <T3Host
        claimKey="a"
        want={() => true}
        prefer={() => false}
        onFocus={onFocus}
        threadId={() => "a"}
        origin={ORIGIN}
        chords={() => CHORDS}
        claims={createFrameClaims()}
      />
    ));
    const keys: KeyboardEvent[] = [];
    const onKey = (e: KeyboardEvent): void => void keys.push(e);
    window.addEventListener("keydown", onKey, true);
    fromFrame(frames()[0]!, altOne);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(keys).toHaveLength(0);
    window.removeEventListener("keydown", onKey, true);
  });

  it("focuses its tile when a click moves keyboard focus into the frame", () => {
    const m = mountUnfocused();
    m.frame.focus();
    window.dispatchEvent(new Event("blur"));
    expect(m.onFocus).toHaveBeenCalledTimes(1);
    expect(m.focusedA()).toBe(true);
    m.done();
  });

  it("does not take focus when the window loses it to something other than the frame", () => {
    const m = mountUnfocused();
    window.dispatchEvent(new Event("blur"));
    expect(m.onFocus).not.toHaveBeenCalled();
    m.done();
  });
});
