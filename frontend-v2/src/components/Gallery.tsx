import {
  For,
  Match,
  Show,
  Switch,
  createMemo,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import type { GalleryStore } from "../store/gallery";
import { badgeLabel } from "../store/gallery.logic";
import { clipboardImgUrl } from "../lib/config";

/**
 * The session image-gallery overlay (feature-inventory Cat.8). A pure view over
 * the gallery store: a backdrop + panel grid of the session's stored images
 * (newest-first, show-image renders badged "shown"), and — on top, when a
 * thumbnail is clicked — the shared lightbox. Escape or a backdrop/lightbox
 * click steps back one view (lightbox → grid → closed).
 *
 * Rendered by the shell inside <Show when={store.view() !== "closed"}> so this
 * mounts/unmounts with visibility, and its Escape listener lives only while the
 * gallery is open. mousedown is preventDefault'd so browsing never steals focus
 * from the terminal iframe (the vanilla focus-return trick), while clicks still
 * fire.
 */
export const Gallery: Component<{ store: GalleryStore }> = (props) => {
  const s = props.store;

  const src = (name: string): string => clipboardImgUrl(s.session() ?? "", name);
  const current = createMemo(() => s.images()[s.lightboxIndex()]);

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

  return (
    <>
      <div
        class="tl-gallery-backdrop"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          if (e.target === e.currentTarget) s.stepBack(); // backdrop only
        }}
      >
        <div class="tl-gallery-panel" role="dialog" aria-label="Session images">
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
                      title={im.name}
                      onClick={() => s.openLightbox(i())}
                    >
                      <img loading="lazy" alt={im.name} src={src(im.name)} />
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
            <img alt={img().name} src={src(img().name)} />
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
