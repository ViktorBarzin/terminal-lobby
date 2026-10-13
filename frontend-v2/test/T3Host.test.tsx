import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSignal, Show } from "solid-js";
import { render, fireEvent } from "@solidjs/testing-library";
import { T3Host, T3Park } from "../src/components/T3Host";
import { createFrameClaims } from "../src/t3/frame-claim";
import { createFrameKeeper, type FrameMove } from "../src/t3/frame-keeper";
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

describe("<T3Host> — the frame moving to another thread", () => {
  beforeEach(() => localStorage.clear());

  function mount(follow: (s: { key: string; name: string }) => boolean) {
    const onFollow = vi.fn(follow);
    render(() => (
      <T3Host
        claimKey="a"
        want={() => true}
        prefer={() => true}
        onFollow={onFollow}
        threadId={() => "auth"}
        origin={ORIGIN}
        chords={() => CHORDS}
        claims={createFrameClaims()}
      />
    ));
    const frame = frames()[0]!;
    const post = vi.fn();
    Object.defineProperty(frame.contentWindow!, "postMessage", { value: post, configurable: true });
    fromFrame(frame, { type: "tl-ready", v: 1, environmentId: "env-9", threadId: "auth" });
    post.mockClear();
    return { frame, post, onFollow };
  }

  const route = (threadId: string | null, session: { key: string; name: string } | null) => ({
    type: "tl-route",
    v: 1,
    threadId,
    session,
  });

  it("moves the lobby to the session the frame went to", () => {
    const m = mount(() => true);
    fromFrame(m.frame, route("5992c13c", { key: "bw8k5gt9v314", name: "say-hi" }));
    expect(m.onFollow).toHaveBeenCalledWith({ key: "bw8k5gt9v314", name: "say-hi" });
    expect(m.post).not.toHaveBeenCalled();
  });

  it("does nothing when the frame is on this session's own thread", () => {
    const m = mount(() => true);
    fromFrame(m.frame, route("auth", { key: "auth", name: "auth" }));
    expect(m.onFollow).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
  });

  it("sends the frame back to this session's thread when the lobby cannot follow", () => {
    const m = mount(() => false);
    fromFrame(m.frame, route("5992c13c", { key: "bw8k5gt9v314", name: "say-hi" }));
    expect(m.post).toHaveBeenCalledWith({ type: "tl-open", v: 1, threadId: "auth" }, ORIGIN);
  });

  it("sends the frame back from a thread that is no session of the caller's", () => {
    const m = mount(() => true);
    fromFrame(m.frame, route("emo~k9x", null));
    expect(m.onFollow).not.toHaveBeenCalled();
    expect(m.post).toHaveBeenCalledWith({ type: "tl-open", v: 1, threadId: "auth" }, ORIGIN);
  });

  it("leaves the frame on a route that is no thread, such as a new thread's draft", () => {
    const m = mount(() => true);
    fromFrame(m.frame, route(null, null));
    expect(m.onFollow).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
  });

  it("ignores a route report from any other origin", () => {
    const m = mount(() => true);
    fromFrame(
      m.frame,
      route("5992c13c", { key: "bw8k5gt9v314", name: "say-hi" }),
      "https://evil.example",
    );
    expect(m.onFollow).not.toHaveBeenCalled();
  });
});

describe("<T3Park> — the frame booted early and kept between uses", () => {
  beforeEach(() => localStorage.clear());

  /** What the frame was sent. jsdom gives a moved frame a fresh window, so
   *  the stub goes on again after every move. */
  const post = vi.fn();
  function stubPost(frame: HTMLIFrameElement) {
    Object.defineProperty(frame.contentWindow!, "postMessage", { value: post, configurable: true });
    return post;
  }
  /** moveBefore as jsdom lacks it: the same element, moved. */
  const move: FrameMove = (parent, node) => {
    parent.insertBefore(node, null);
    stubPost(node);
    return true;
  };
  const now = (start: () => void) => {
    start();
    return () => {};
  };

  function mount(opts: { move?: FrameMove; defer?: (s: () => void) => () => void } = {}) {
    post.mockClear();
    const keeper = createFrameKeeper(opts.move ?? move);
    const claims = createFrameClaims();
    const [want, setWant] = createSignal(false);
    const [park, setPark] = createSignal(true);
    const onFollow = vi.fn(() => true);
    const r = render(() => (
      <div>
        <Show when={park()}>
          <T3Park origin={ORIGIN} chords={() => CHORDS} keeper={keeper} defer={opts.defer ?? now} />
        </Show>
        <div class="pane">
          <T3Host
            claimKey="a"
            want={want}
            prefer={() => true}
            onFollow={onFollow}
            threadId={() => "auth"}
            origin={ORIGIN}
            chords={() => CHORDS}
            claims={claims}
            keeper={keeper}
          />
        </div>
      </div>
    ));
    return { r, keeper, setWant, setPark, onFollow };
  }

  it("boots one frame in the park, on T3's root, before anyone asks", () => {
    saveEnvironmentId(ORIGIN, "env-1");
    const { r } = mount();
    expect(frames()).toHaveLength(1);
    expect(r.container.querySelector(".tl-t3-park iframe")).toBeTruthy();
    expect(frames()[0]!.getAttribute("src")).toBe(`${ORIGIN}/?embed`);
  });

  it("waits to boot until the browser is idle, and boots nothing if it goes first", () => {
    let start: (() => void) | undefined;
    const cancel = vi.fn();
    const m = mount({
      defer: (s) => {
        start = s;
        return cancel;
      },
    });
    expect(frames()).toHaveLength(0);
    start!();
    expect(frames()).toHaveLength(1);
    m.r.unmount();
    expect(cancel).toHaveBeenCalled();
    expect(frames()).toHaveLength(0);
  });

  it("moves the parked frame into the pane that asks, and back when it lets go", () => {
    const m = mount();
    const booted = frames()[0]!;
    m.setWant(true);
    expect(frames()).toEqual([booted]);
    expect(m.r.container.querySelector(".pane .tl-t3-slot iframe")).toBe(booted);
    m.setWant(false);
    expect(frames()).toEqual([booted]);
    expect(m.r.container.querySelector(".tl-t3-park iframe")).toBe(booted);
    expect(booted.getAttribute("src")).toBe(`${ORIGIN}/?embed`);
  });

  it("sends a frame that is already up straight to the thread, with the chords", () => {
    const m = mount();
    const frame = frames()[0]!;
    stubPost(frame);
    fromFrame(frame, { type: "tl-ready", v: 1, environmentId: "env-9", threadId: null });
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "tl-open" }), ORIGIN);
    post.mockClear();
    m.setWant(true);
    expect(post).toHaveBeenCalledWith({ type: "tl-bindings", v: 1, chords: CHORDS }, ORIGIN);
    expect(post).toHaveBeenCalledWith({ type: "tl-open", v: 1, threadId: "auth" }, ORIGIN);
    expect(loadEnvironmentId(ORIGIN)).toBe("env-9");
  });

  it("opens the pane's thread once a frame still booting says it is up", () => {
    const m = mount();
    m.setWant(true);
    const frame = frames()[0]!;
    fromFrame(frame, { type: "tl-ready", v: 1, environmentId: "env-9", threadId: null });
    expect(post).toHaveBeenCalledWith({ type: "tl-open", v: 1, threadId: "auth" }, ORIGIN);
  });

  it("acts on no key and follows no route while the frame is parked", () => {
    const m = mount();
    const frame = frames()[0]!;
    stubPost(frame);
    fromFrame(frame, { type: "tl-ready", v: 1, environmentId: "env-9", threadId: null });
    post.mockClear();
    const keys: KeyboardEvent[] = [];
    const onKey = (e: KeyboardEvent): void => void keys.push(e);
    window.addEventListener("keydown", onKey, true);
    fromFrame(frame, altOne);
    fromFrame(frame, {
      type: "tl-route",
      v: 1,
      threadId: "5992c13c",
      session: { key: "bw8k5gt9v314", name: "say-hi" },
    });
    window.removeEventListener("keydown", onKey, true);
    expect(keys).toHaveLength(0);
    expect(m.onFollow).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("taking the park away drops a parked frame, and leaves one a pane holds", () => {
    const m = mount();
    m.setPark(false);
    expect(frames()).toHaveLength(0);
    m.setPark(true);
    const frame = frames()[0]!;
    m.setWant(true);
    m.setPark(false);
    expect(frames()).toEqual([frame]);
    // With no park, letting go drops it, as before the preload.
    m.setWant(false);
    expect(frames()).toHaveLength(0);
  });

  it("boots a fresh frame in the pane where the browser cannot move one", () => {
    const m = mount({ move: () => false });
    const parked = frames()[0]!;
    m.setWant(true);
    expect(frames()).toHaveLength(1);
    expect(frames()[0]).not.toBe(parked);
    expect(m.r.container.querySelector(".pane .tl-t3-slot iframe")).toBe(frames()[0]);
  });
});
