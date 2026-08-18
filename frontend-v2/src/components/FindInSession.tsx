import { For, Show, createSignal, onMount, type Component } from "solid-js";
import type { SearchHit } from "../types/events";
import { hitLabel, hitWhen } from "./find.logic";

/**
 * Find something in this session.
 *
 * The search runs on the server across the WHOLE transcript, not the window this
 * client holds: the view opens on 20 turns, and on the largest session here that
 * is a few hundred events out of 7,964. A find that only covered what was
 * already in the browser would answer "no matches" for most of what a reader is
 * actually looking for.
 *
 * It runs on submit rather than per keystroke — one pass over the transcript per
 * query, not one per letter.
 *
 * The overlay follows the command palette's shape (backdrop, input, list) so it
 * reads as part of the same surface, but it is its own component: the palette
 * ranks sessions and actions it already holds, while this waits on a server.
 */
export const FindInSession: Component<{
  onSearch: (q: string) => Promise<SearchHit[]>;
  /** Scroll the timeline to an event, loading earlier windows to reach it. */
  onJump: (id: number) => Promise<void>;
  onClose: () => void;
}> = (props) => {
  const [q, setQ] = createSignal("");
  const [hits, setHits] = createSignal<SearchHit[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [ran, setRan] = createSignal(false);
  const [sel, setSel] = createSignal(0);
  let inputEl: HTMLInputElement | undefined;
  onMount(() => queueMicrotask(() => inputEl?.focus()));

  const run = async () => {
    const query = q().trim();
    if (!query || busy()) return;
    setBusy(true);
    const found = await props.onSearch(query);
    setHits(found);
    setSel(0);
    setRan(true);
    setBusy(false);
  };

  const jump = async (h: SearchHit) => {
    props.onClose();
    await props.onJump(h.id);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      // Enter searches while there is nothing to walk, and opens the selected
      // hit once there is — so a query and its result need no mode switch.
      const h = hits()[sel()];
      if (ran() && h) void jump(h);
      else void run();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      setSel(Math.min(sel() + 1, hits().length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      setSel(Math.max(sel() - 1, 0));
    }
  };

  return (
    <div
      class="tl-cmdpalette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
      onKeyDown={onKey}
    >
      <div class="tl-cmdpalette tl-find" role="dialog" aria-label="Find in session">
        <div class="tl-find-bar">
          <input
            ref={inputEl}
            class="tl-cp-input"
            type="text"
            placeholder="Find in this session…"
            aria-label="Find in this session"
            value={q()}
            onInput={(e) => {
              setQ(e.currentTarget.value);
              setRan(false);
            }}
          />
          <Show when={ran() && !busy()}>
            <span class="tl-find-count">
              {hits().length}
              {/* The server caps a search; saying so beats implying the session
                  holds exactly this many. */}
              {hits().length >= 50 ? "+" : ""}
            </span>
          </Show>
        </div>

        <div class="tl-cp-list" role="listbox">
          <Show when={busy()}>
            <div class="tl-cp-note">searching the whole session…</div>
          </Show>
          <Show when={!busy() && ran() && hits().length === 0}>
            <div class="tl-cp-note">No matches in this session.</div>
          </Show>
          <Show when={!busy() && !ran()}>
            <div class="tl-cp-note">
              Enter to search. Messages, thinking, commands and their output.
            </div>
          </Show>
          <For each={hits()}>
            {(h, i) => (
              <div
                class="tl-cp-item tl-find-hit"
                classList={{ "tl-cp-sel": sel() === i() }}
                role="option"
                aria-selected={sel() === i()}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setSel(i())}
                onClick={() => void jump(h)}
              >
                <div class="tl-find-meta">
                  <span class="tl-find-where">{hitLabel(h)}</span>
                  <Show when={hitWhen(h.at)}>
                    <span class="tl-find-when">{hitWhen(h.at)}</span>
                  </Show>
                </div>
                <div class="tl-find-snippet">{h.snippet}</div>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
};
