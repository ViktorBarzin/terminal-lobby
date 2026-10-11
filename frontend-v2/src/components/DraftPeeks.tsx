import { createMemo, Index, Show, type Component } from "solid-js";
import { usePresence } from "../store/presence";
import { draftState, othersPresent } from "./presence.logic";

/**
 * What the other people on a shared session are typing, live, above the
 * composer (ADR-0043). One line per person with an unsent draft: their name,
 * whether they are typing now or have stopped, and the draft itself, read-only
 * and capped to a few lines so it cannot push the conversation off screen.
 * Draws nothing on a session nobody else has open.
 */
export const DraftPeeks: Component = () => {
  const view = usePresence();
  const drafting = createMemo(() => {
    if (!view) return [];
    const now = view.presence.serverNow();
    return othersPresent(view.presence.people(), view.me)
      .map((p) => ({ p, state: draftState(p, now) }))
      .filter((d) => d.state !== "none");
  });
  return (
    <Show when={drafting().length > 0}>
      <div class="tl-draft-peeks">
        {/* Index, not For: the list is rebuilt every second as typing
            turns to resting, and a row must not remount (and restart its
            dots) each time. */}
        <Index each={drafting()}>
          {(d) => (
            <div class="tl-draft-peek" data-state={d().state}>
              <span class="tl-draft-peek-who">
                {d().p.name}
                <span class="tl-draft-peek-what">
                  {d().state === "typing" ? " is typing" : " has an unsent message"}
                </span>
                <Show when={d().state === "typing"}>
                  <span class="tl-draft-peek-dots" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                </Show>
              </span>
              <pre class="tl-draft-peek-text">{d().p.draft}</pre>
            </div>
          )}
        </Index>
      </div>
    </Show>
  );
};
