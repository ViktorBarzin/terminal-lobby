import {
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Component,
  type JSX,
} from "solid-js";
import type { GalleryStore } from "../store/gallery";
import { badgeLabel } from "../store/gallery.logic";
import { clipboardImgUrl } from "../lib/config";
import { refocusTerminal } from "../keybindings/refocus";

/**
 * The session image-gallery overlay (feature-inventory Cat.8). A pure view over
 * the gallery store: a backdrop + panel grid of the session's stored images
 * (newest-first, show-image renders badged "shown"), and — on top, when a
 * thumbnail is clicked — the shared lightbox. Escape or a backdrop/lightbox
 * click steps back one view (lightbox → grid → closed).
 *
 * Rendered by the shell inside <Show when={store.view() !== "closed"}> so this
 * mounts/unmounts with visibility, and its Escape listener lives only while the
 * gallery is open. mousedown is preventDefault'd so browsing never moves focus
 * off the panel (the vanilla focus-return trick), while clicks still fire.
 *
 * The panel TAKES the keyboard on open and hands it back on close, the way
 * ShortcutsHelp does. Opened from inside a session it used to inherit the
 * terminal IFRAME's focus — a separate document, whose keydowns never reach
 * this one — so the Escape listener below could not fire, the key went to the
 * pty instead (interrupting whatever was running), and the mouse was the only
 * way out.
 *
 * A thumbnail that fails to decode falls back to a labelled placeholder. The
 * store can hold files no browser will draw — /upload now refuses bytes that
 * are not an image, but a truncated PNG still passes its sniff by design, and
 * files accepted before that check exist already. Without a fallback those
 * render as an empty cell (measured: 141x141, naturalWidth 0) that looks
 * identical to a slow load, and the gallery is list+lightbox only, so there is
 * no delete control to clear it.
 */

// Placeholder styling is inline rather than in app.css so this fix stays inside
// the one component that owns the behaviour — app.css is shared by every other
// surface, and .tl-gallery-broken has no reuse outside these two spots.
const brokenTileStyle: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  "align-items": "center",
  "justify-content": "center",
  gap: "4px",
  width: "100%",
  height: "100%",
  padding: "6px",
  "box-sizing": "border-box",
  color: "var(--text-muted)",
  "font-size": "11px",
  "line-height": "1.3",
  "text-align": "center",
  "overflow-wrap": "anywhere",
};

const brokenLightboxStyle: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  "align-items": "center",
  gap: "8px",
  padding: "24px",
  color: "var(--text-muted)",
  "font-size": "14px",
  "text-align": "center",
  "overflow-wrap": "anywhere",
};

export const Gallery: Component<{ store: GalleryStore }> = (props) => {
  const s = props.store;

  const src = (name: string): string => clipboardImgUrl(s.session() ?? "", name);
  const current = createMemo(() => s.images()[s.lightboxIndex()]);

  // Names whose <img> reported an error. Keyed by name (unique per session —
  // the store stamps every write) so a thumbnail failure and its lightbox agree
  // without re-fetching. Resets on close: the component unmounts with the
  // overlay, so a re-upload under a new name always gets a fresh try.
  const [failed, setFailed] = createSignal<ReadonlySet<string>>(new Set());
  const isBroken = (name: string): boolean => failed().has(name);
  const markBroken = (name: string): void => {
    setFailed((prev) => (prev.has(name) ? prev : new Set(prev).add(name)));
  };

  // Escape steps back one view; while the lightbox is up it lands on the grid,
  // from the grid it closes. Capture + stop so it never leaks to other chrome.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    s.stepBack();
  };
  onMount(() => document.addEventListener("keydown", onKey, true));
  onCleanup(() => document.removeEventListener("keydown", onKey, true));

  // Take the keyboard on open (deferred so the node is in the document), and
  // hold it: gallery.open is reachable from the palette, and runItem() closes
  // the palette — handing focus BACK to the terminal — before running the
  // action, so the iframe's handback (rAF/50ms inside term.html) lands after
  // this mount and would pull focus straight out again.
  let panelEl: HTMLDivElement | undefined;
  onMount(() => queueMicrotask(() => panelEl?.focus()));
  const onFocusOut = (): void => {
    // focusout fires BEFORE the new target is focused, and a dismiss unmounts
    // us — both need the deferral to read the settled state.
    queueMicrotask(() => {
      if (!panelEl?.isConnected) return;
      if (panelEl.contains(document.activeElement)) return;
      panelEl.focus();
    });
  };
  // ...and give it back on every dismiss path (Escape, backdrop, lightbox
  // click, a session switch closing us): this component IS the overlay, so its
  // disposal is the close. Without the handback, taking focus here would leave
  // the pty deaf afterwards.
  onCleanup(() => void refocusTerminal());

  return (
    <>
      <div
        class="tl-gallery-backdrop"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          if (e.target === e.currentTarget) s.stepBack(); // backdrop only
        }}
      >
        <div
          ref={panelEl}
          class="tl-gallery-panel"
          role="dialog"
          aria-label="Session images"
          tabindex="-1"
          onFocusOut={onFocusOut}
        >
          <h2 class="tl-gallery-title">Session images</h2>
          <div class="tl-gallery-grid">
            <Switch>
              <Match when={s.status() === "loading"}>
                <div class="tl-gallery-note">Loading…</div>
              </Match>
              <Match when={s.status() === "error"}>
                <div class="tl-gallery-note">
                  Loading images failed: {s.error()}
                </div>
              </Match>
              <Match when={s.images().length === 0}>
                <div class="tl-gallery-note">
                  Nothing pasted or shown in this session yet
                </div>
              </Match>
              <Match when={s.images().length > 0}>
                <For each={s.images()}>
                  {(im, i) => (
                    <button
                      type="button"
                      class="tl-gallery-cell"
                      title={
                        isBroken(im.name)
                          ? `${im.name} — not a readable image`
                          : im.name
                      }
                      onClick={() => s.openLightbox(i())}
                    >
                      <Show
                        when={!isBroken(im.name)}
                        fallback={
                          <span class="tl-gallery-broken" style={brokenTileStyle}>
                            <span aria-hidden="true" style={{ "font-size": "18px" }}>
                              ⚠
                            </span>
                            <span>{im.name}</span>
                            <span>not a readable image</span>
                          </span>
                        }
                      >
                        <img
                          loading="lazy"
                          alt={im.name}
                          src={src(im.name)}
                          onError={() => markBroken(im.name)}
                        />
                      </Show>
                      <Show when={badgeLabel(im)}>
                        {(label) => (
                          <span class="tl-gallery-badge">{label()}</span>
                        )}
                      </Show>
                    </button>
                  )}
                </For>
              </Match>
            </Switch>
          </div>
        </div>
      </div>

      <Show when={s.view() === "lightbox" && current()}>
        {(img) => (
          <div
            class="tl-lightbox"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => s.stepBack()}
          >
            <Show
              when={!isBroken(img().name)}
              fallback={
                <div class="tl-gallery-broken" style={brokenLightboxStyle}>
                  <span aria-hidden="true" style={{ "font-size": "32px" }}>
                    ⚠
                  </span>
                  <span>{img().name}</span>
                  <span>This file is not a readable image.</span>
                </div>
              }
            >
              <img
                alt={img().name}
                src={src(img().name)}
                onError={() => markBroken(img().name)}
              />
            </Show>
            <Show when={s.images().length > 1}>
              <div class="tl-lightbox-chip">
                {s.lightboxIndex() + 1}/{s.images().length}
              </div>
            </Show>
          </div>
        )}
      </Show>
    </>
  );
};
