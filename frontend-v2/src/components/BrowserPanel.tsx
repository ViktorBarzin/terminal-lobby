import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import {
  clientBox,
  listPlacement,
  pagePoint,
  streamWanted,
  type ListPlacement,
  type PageRect,
} from "./browser.logic";
import { BrowserPopups } from "./BrowserPopups";
import {
  createBrowserStream,
  createVisibility,
  type BrowserPopup,
  type BrowserState,
  type ViewerMessage,
} from "../lib/browser-stream";
import { closeOnBack } from "../lib/back-closes";
import { track } from "../telemetry/track";
import { ArrowLeftGlyph, ArrowRightGlyph, BrowserGlyph, ReloadGlyph } from "./Icons";

/** The furthest a pinch zooms the scaled page in. */
const MAX_ZOOM = 4;
/** A touch that moves less than this, and lifts within TAP_MS, is a tap. */
const TAP_SLOP_PX = 10;
const TAP_MS = 600;
/** A wheel in lines or pages, in pixels, for a host that scrolls in pixels. */
const LINE_PX = 16;
/** Keys a keyboard reports that are not keys the page can be sent. */
const NOT_KEYS = new Set(["Unidentified", "Dead", "Process"]);

const BUTTONS = ["left", "middle", "right"] as const;

/**
 * The Browser panel (CONTEXT.md "Browser panel"): the live view of a session's
 * browser, opened beside its chat or terminal inside the session's own pane,
 * and over the whole screen on a phone.
 *
 * A header with the page's title and address, Stop, Take control or Hand back,
 * and close; a strip of the browser's tabs; an address bar with back, forward
 * and reload; then the page, scaled to fit. It follows the tab the agent last
 * acted on until the viewer picks another.
 *
 * Driving needs Control. Taking it locks the agent out, which the host
 * enforces, and handing back tells the agent nothing (design, "Decisions").
 * Who may take it at all follows the session's Attach mode, which
 * session-events enforces before anything reaches the host; `canControl` only
 * hides the controls a watch-only viewer could not use.
 */
export const BrowserPanel: Component<{
  session: string;
  /** The session's owner when it is somebody else's (a share). */
  owner?: string;
  /** The session list's word on the session's browser. */
  state: () => BrowserState | undefined;
  /** The session is on screen and its stream is not parked. */
  active: () => boolean;
  /** This viewer may take control: rw, not a ro share and not a Lens. */
  canControl: () => boolean;
  /** Full screen, with taps for clicks and the soft keyboard for typing. */
  phone: () => boolean;
  /** Over the whole pane rather than beside the view: the pane is too narrow
   *  for both (browser.logic `panelLayout`). Layout only; input is unchanged. */
  full?: () => boolean;
  /** Interrupt the agent's turn, the same as Esc. */
  onStop: () => void;
  onClose: () => void;
}> = (props) => {
  const [stage, setStage] = createSignal<HTMLDivElement>();
  /** The box the page and its popups share; popups are placed in its pixels. */
  let pagebox: HTMLDivElement | undefined;
  let img: HTMLImageElement | undefined;
  let ime: HTMLInputElement | undefined;
  const seen = createVisibility(stage);
  /** The tab the viewer picked, or null to follow the agent's. */
  const [picked, setPicked] = createSignal<string | null>(null);

  const stream = createBrowserStream({
    session: props.session,
    owner: props.owner,
    wake: true,
    tab: picked,
    active: () =>
      streamWanted({
        wanted: true,
        intersecting: seen.intersecting(),
        documentVisible: seen.documentVisible(),
        parked: !props.active(),
      }),
    onCopied: (text) => {
      void navigator.clipboard?.writeText(text).catch(() => undefined);
    },
  });
  // A browser (re)appearing on the session list is worth trying at once: the
  // panel may have been opened on a closed browser that the agent reopened.
  createEffect(
    on(
      () => props.state(),
      (s) => {
        if (s) stream.retry();
      },
      { defer: true },
    ),
  );

  closeOnBack(() => props.phone(), props.onClose);

  // ---- control ------------------------------------------------------------
  //
  // Control is held by a connection, not a person (design, "The viewer
  // protocol"). The host gives this connection an id in its hello (`you`) and
  // names the holding connection in every `control` (`holderId`), so this
  // panel holds control exactly when the two match. The same person's phone
  // taking over is somebody else here. `holder` is only the name to show, the
  // one session-events stamped from the lobby's identity.
  let takenAt = 0;
  const inControl = () => {
    const you = stream.you();
    return you !== null && stream.control().holderId === you;
  };
  const someoneElse = () => stream.control().holderId !== null && !inControl();
  const holderName = () => stream.control().holder ?? "Someone";

  const takeControl = (): void => {
    takenAt = Date.now();
    stream.send({ t: "takeControl" });
    track("browser.take_control");
    stage()?.focus();
  };
  const handBack = (): void => {
    stream.send({ t: "handBack" });
    track("browser.hand_back", { "tl.ms": takenAt ? Date.now() - takenAt : null });
  };
  /** Send a message that drives the page, only while this viewer holds control. */
  const drive = (msg: ViewerMessage): void => {
    if (inControl()) stream.send(msg);
  };

  // ---- what is on screen --------------------------------------------------

  const shownTab = () => picked() ?? stream.agentTab();
  const tab = createMemo(() => stream.tabs().find((t) => t.id === shownTab()));
  const [address, setAddress] = createSignal("");
  const [editing, setEditing] = createSignal(false);
  createEffect(() => {
    const url = tab()?.url ?? "";
    if (!editing()) setAddress(url);
  });

  const pick = (id: string): void => {
    // Picking the agent's tab goes back to following it, so the panel moves
    // with the agent again when it opens or navigates another.
    setPicked(id === stream.agentTab() ? null : id);
  };

  const note = (): string | null => {
    if (stream.state() === "closed") return "The browser closed.";
    if (stream.frame()) return null;
    if (stream.status() === "unavailable")
      return props.state() ? "Connecting to the browser…" : "This session has no browser open.";
    return "Connecting to the browser…";
  };

  // ---- popups the frame does not show ---------------------------------------
  //
  // The host sends them only to the person in control, and a change of hands
  // clears them, so `inControl` here only covers the moment before the
  // stream hears about it.

  const popup = createMemo((): BrowserPopup | null => {
    if (!inControl()) return null;
    const all = stream.popups();
    const here = shownTab();
    const ofKind = (kind: BrowserPopup["kind"]) => all.filter((p) => p.kind === kind);
    // A dialog stops the page whichever tab raised it, so it shows from any
    // tab; a select's list belongs over its own tab's picture.
    const dialogs = ofKind("dialog");
    const notices = ofKind("filechooser");
    return (
      dialogs.find((p) => p.tab === here) ??
      dialogs[0] ??
      ofKind("select").find((p) => p.tab === here) ??
      notices.find((p) => p.tab === here) ??
      notices[0] ??
      null
    );
  });

  /** Where a select's list goes, in the page box's pixels, over the drawn picture. */
  const placeList = (rect: PageRect): ListPlacement | null => {
    const f = stream.frame();
    const st = stage();
    if (!img || !f || !st || !pagebox) return null;
    const r = img.getBoundingClientRect();
    const anchor = clientBox(
      rect,
      { left: r.left, top: r.top, width: r.width, height: r.height },
      f,
      stream.viewport(),
    );
    if (!anchor) return null;
    const s = st.getBoundingClientRect();
    const at = listPlacement(anchor, {
      left: s.left,
      top: s.top,
      width: s.width,
      height: s.height,
    });
    const p = pagebox.getBoundingClientRect();
    return { ...at, left: at.left - p.left, top: at.top - p.top };
  };

  const popupDone = (p: BrowserPopup): void => {
    stream.dismissPopup(p.tab);
    stage()?.focus({ preventScroll: true });
  };

  // ---- input --------------------------------------------------------------

  const point = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const f = stream.frame();
    if (!img || !f) return null;
    const r = img.getBoundingClientRect();
    return pagePoint(
      clientX,
      clientY,
      { left: r.left, top: r.top, width: r.width, height: r.height },
      f,
      stream.viewport(),
    );
  };

  // Pinch zoom on a phone: the picture's box grows inside a scrolling stage,
  // so the client rect `point` reads stays the truth about where it is drawn.
  const [zoom, setZoom] = createSignal(1);
  const touches = new Map<number, { x: number; y: number }>();
  let pinch: { d0: number; z0: number } | null = null;
  let tap: { id: number; x: number; y: number; at: number } | null = null;
  let moveQueued: PointerEvent | null = null;

  const distance = (): number => {
    const [a, b] = [...touches.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        pinch = { d0: distance(), z0: zoom() };
        tap = null;
      } else if (touches.size === 1) {
        tap = { id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now() };
      }
      return;
    }
    if (!inControl()) return;
    const p = point(e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    stage()?.focus();
    stage()?.setPointerCapture?.(e.pointerId);
    drive({
      t: "mouse",
      type: "down",
      ...p,
      button: BUTTONS[e.button] ?? "left",
      clickCount: Math.max(1, e.detail || 1),
    });
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === "touch") {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size === 2) {
        const el = stage();
        const before = zoom();
        const next = Math.min(MAX_ZOOM, Math.max(1, (pinch.z0 * distance()) / (pinch.d0 || 1)));
        setZoom(next);
        // Keep the point between the fingers where it was.
        if (el && before !== next) {
          const r = el.getBoundingClientRect();
          const [a, b] = [...touches.values()];
          const mx = ((a?.x ?? 0) + (b?.x ?? 0)) / 2 - r.left;
          const my = ((a?.y ?? 0) + (b?.y ?? 0)) / 2 - r.top;
          el.scrollLeft = (el.scrollLeft + mx) * (next / before) - mx;
          el.scrollTop = (el.scrollTop + my) * (next / before) - my;
        }
      }
      return;
    }
    if (!inControl()) return;
    // One move per frame is plenty for the host, which acts on each one.
    if (moveQueued) {
      moveQueued = e;
      return;
    }
    moveQueued = e;
    requestAnimationFrame(() => {
      const last = moveQueued;
      moveQueued = null;
      if (!last) return;
      const p = point(last.clientX, last.clientY);
      if (p)
        drive({
          t: "mouse",
          type: "move",
          ...p,
          button: BUTTONS[last.button] ?? "left",
          clickCount: 0,
        });
    });
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType === "touch") {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
      const t = tap;
      tap = null;
      if (
        !t ||
        t.id !== e.pointerId ||
        !inControl() ||
        performance.now() - t.at > TAP_MS ||
        Math.hypot(e.clientX - t.x, e.clientY - t.y) > TAP_SLOP_PX
      )
        return;
      const p = point(e.clientX, e.clientY);
      if (!p) return;
      drive({ t: "mouse", type: "click", ...p, button: "left", clickCount: 1 });
      // A tap on a field should raise the keyboard, and only a focused input
      // of this page's own can: what is typed there is sent on as text.
      ime?.focus({ preventScroll: true });
      holdTap();
      return;
    }
    if (!inControl()) return;
    const p = point(e.clientX, e.clientY);
    if (!p) return;
    drive({
      t: "mouse",
      type: "up",
      ...p,
      button: BUTTONS[e.button] ?? "left",
      clickCount: Math.max(1, e.detail || 1),
    });
  };

  /**
   * The rest of the tap that focused the keyboard's field is the field's.
   *
   * The browser sends a tap's compat mousedown and click after touchend, and a
   * mousedown on the stage, which is focusable, takes the focus off the field
   * and the keyboard goes down as it comes up. Measured in Chrome's touch
   * emulation on 2026-10-01: focus went to the field on pointerup and back to
   * the stage on the mousedown that followed, so typing went nowhere. Same
   * mechanism as the composer's (PromptField `holdTap`) and the terminal's
   * (terminal/keepfocus.ts). So that mousedown has its default (moving the
   * focus) cancelled, and its click is eaten: the tap already clicked the
   * page, and with the keyboard moving the layout it could land on a button.
   * One tap's worth, within the time a tap takes, and nothing after it.
   */
  let releaseTap: (() => void) | null = null;
  const holdTap = (): void => {
    releaseTap?.();
    const offField = (ev: Event): boolean =>
      !(ev.target instanceof Node && ime?.contains(ev.target));
    const onDown = (ev: Event): void => {
      if (offField(ev)) ev.preventDefault();
    };
    const onClick = (ev: Event): void => {
      if (offField(ev)) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      done();
    };
    const done = (): void => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("click", onClick, true);
      releaseTap = null;
    };
    const timer = setTimeout(done, 700);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("click", onClick, true);
    releaseTap = done;
  };
  onCleanup(() => releaseTap?.());

  const onPointerCancel = (e: PointerEvent): void => {
    // The browser took the touch over to pan the zoomed page.
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    if (tap?.id === e.pointerId) tap = null;
  };

  const onWheel = (e: WheelEvent): void => {
    if (!inControl()) return;
    const p = point(e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? 800 : 1;
    drive({ t: "wheel", ...p, dx: e.deltaX * unit, dy: e.deltaY * unit });
  };
  onMount(() => {
    // Not a JSX handler: Solid delegates those as passive on some engines,
    // and a wheel over the page must not scroll the lobby behind it.
    const el = stage();
    el?.addEventListener("wheel", onWheel, { passive: false });
    onCleanup(() => el?.removeEventListener("wheel", onWheel));
  });

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!inControl() || e.isComposing || NOT_KEYS.has(e.key)) return;
    const mod = e.metaKey || e.ctrlKey;
    // Paste goes through the paste event below, which carries the clipboard's
    // text without asking for permission to read it.
    if (mod && (e.key === "v" || e.key === "V")) return;
    if (mod && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      drive({ t: "copy" });
      return;
    }
    e.preventDefault();
    drive({ t: "key", type: "down", key: e.key });
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (!inControl() || e.isComposing || NOT_KEYS.has(e.key)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === "v" || e.key === "V" || e.key === "c" || e.key === "C")) return;
    e.preventDefault();
    drive({ t: "key", type: "up", key: e.key });
  };
  const onPaste = (e: ClipboardEvent): void => {
    if (!inControl()) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    e.preventDefault();
    if (text) drive({ t: "insertText", text });
  };

  // The phone's soft keyboard types into a hidden field, and what lands there
  // is sent on and cleared, so the field never holds anything.
  const onImeBeforeInput = (e: InputEvent): void => {
    if (e.inputType === "deleteContentBackward") {
      e.preventDefault();
      drive({ t: "key", type: "press", key: "Backspace" });
    } else if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
      e.preventDefault();
      drive({ t: "key", type: "press", key: "Enter" });
    }
  };
  const onImeInput = (): void => {
    if (!ime) return;
    const text = ime.value;
    ime.value = "";
    if (text) drive({ t: "insertText", text });
  };

  const onAddress = (e: SubmitEvent): void => {
    e.preventDefault();
    const url = address().trim();
    if (!url) return;
    drive({ t: "navigate", url });
    setEditing(false);
    stage()?.focus();
  };

  return (
    <aside
      class="tl-browser-panel"
      data-phone={props.phone() ? "" : undefined}
      data-full={props.full?.() ? "" : undefined}
      aria-label="Session browser"
    >
      <header class="tl-browser-head">
        <BrowserGlyph size={18} />
        <div class="tl-browser-titles">
          <span class="tl-browser-title">{tab()?.title || "Browser"}</span>
          <span class="tl-browser-url">{tab()?.url ?? ""}</span>
        </div>
        <button type="button" class="tl-btn tl-browser-stop" onClick={() => props.onStop()}>
          Stop
        </button>
        <Show when={props.canControl() && stream.state() !== "closed"}>
          <button
            type="button"
            class="tl-btn tl-browser-take"
            classList={{ "tl-btn-approve": inControl() }}
            disabled={stream.status() !== "open"}
            onClick={() => (inControl() ? handBack() : takeControl())}
          >
            {inControl() ? "Hand back" : "Take control"}
          </button>
        </Show>
        <button
          type="button"
          class="tl-icon-btn tl-browser-close"
          aria-label="Close the browser panel"
          title="Close the browser panel"
          onClick={() => props.onClose()}
        >
          ✕
        </button>
      </header>
      <Show when={someoneElse()}>
        <div class="tl-browser-note" role="status">
          {holderName()} has control
        </div>
      </Show>
      <Show when={stream.tabs().length > 1}>
        <div class="tl-browser-tabs" role="tablist" aria-label="Browser tabs">
          <For each={stream.tabs()}>
            {(t) => (
              <button
                type="button"
                role="tab"
                class="tl-browser-tab"
                aria-selected={t.id === shownTab()}
                data-agent={t.id === stream.agentTab() ? "" : undefined}
                title={t.url}
                onClick={() => pick(t.id)}
              >
                <span class="tl-browser-tab-label">{t.title || t.url || "New tab"}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <form class="tl-browser-urlbar" onSubmit={onAddress}>
        <button
          type="button"
          class="tl-icon-btn"
          aria-label="Back"
          title="Back"
          disabled={!inControl()}
          onClick={() => drive({ t: "back" })}
        >
          <ArrowLeftGlyph />
        </button>
        <button
          type="button"
          class="tl-icon-btn"
          aria-label="Forward"
          title="Forward"
          disabled={!inControl()}
          onClick={() => drive({ t: "forward" })}
        >
          <ArrowRightGlyph />
        </button>
        <button
          type="button"
          class="tl-icon-btn"
          aria-label="Reload"
          title="Reload"
          disabled={!inControl()}
          onClick={() => drive({ t: "reload" })}
        >
          <ReloadGlyph />
        </button>
        <input
          class="tl-browser-address"
          type="text"
          inputmode="url"
          autocomplete="off"
          spellcheck={false}
          aria-label="Address"
          readOnly={!inControl()}
          value={address()}
          onFocus={() => setEditing(inControl())}
          onBlur={() => setEditing(false)}
          onInput={(e) => setAddress(e.currentTarget.value)}
        />
      </form>
      <div ref={pagebox} class="tl-browser-pagebox">
        <div
          ref={setStage}
          class="tl-browser-stage"
          // The page takes raw pointer and key input while in control, which is
          // what the application role tells assistive tech to pass through.
          role="application"
          data-control={inControl() ? "" : undefined}
          data-zoomed={zoom() > 1 ? "" : undefined}
          tabIndex={0}
          aria-label={inControl() ? "The page. You have control." : "The page"}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onContextMenu={(e) => inControl() && e.preventDefault()}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onPaste={onPaste}
        >
          <div
            class="tl-browser-canvas"
            style={{ width: `${zoom() * 100}%`, height: `${zoom() * 100}%` }}
          >
            <Show when={stream.frame()}>
              {(f) => (
                <img
                  ref={img}
                  class="tl-browser-frame"
                  src={f().src}
                  alt={tab()?.title ? `The page: ${tab()?.title}` : "The page"}
                  draggable={false}
                />
              )}
            </Show>
          </div>
          <Show when={note()}>{(n) => <div class="tl-browser-empty">{n()}</div>}</Show>
          <Show when={stream.error()}>
            {(m) => (
              <div class="tl-browser-error" role="alert">
                {m()}
              </div>
            )}
          </Show>
          <Show when={props.phone() && inControl()}>
            <input
              ref={ime}
              class="tl-browser-ime"
              type="text"
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              aria-label="Type into the page"
              onBeforeInput={onImeBeforeInput}
              onInput={onImeInput}
            />
          </Show>
        </div>
        <BrowserPopups
          popup={popup()}
          phone={props.phone()}
          place={placeList}
          onChoose={(p, values) => {
            const [first] = values;
            if (p.multiple) drive({ t: "choose", values, tab: p.tab });
            else if (first !== undefined) drive({ t: "choose", value: first, tab: p.tab });
            popupDone(p);
          }}
          onAnswer={(p, accept, text) => {
            drive({ t: "dialog", accept, ...(text === undefined ? {} : { text }), tab: p.tab });
            popupDone(p);
          }}
          onDismiss={popupDone}
        />
      </div>
    </aside>
  );
};
