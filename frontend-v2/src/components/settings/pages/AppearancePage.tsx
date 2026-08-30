import { For, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { THEMES, THEME_LABELS, setTheme, theme } from "../../../theme/theme";
import { Group, Row } from "../controls";

/**
 * Which theme's colours a swatch should paint.
 *
 * Eight of the nine are themselves. "System" has no palette of its own — it
 * follows the OS — so its swatch borrows whichever of the two T3 themes the OS
 * is currently asking for, and follows a change to that live.
 */
const resolvePreview = (name: string, prefersDark: boolean): string =>
  name === "system" ? (prefersDark ? "t3-dark" : "t3-light") : name;

/**
 * The theme picker.
 *
 * It was nine buttons carrying nine names, which asks you to remember what
 * "Ink" looked like. Each swatch now paints its own theme: theme.css defines
 * every variable a preview needs, and the selectors there are widened to reach
 * `.tl-swatch--<name>` so the values cascade into the card without a second
 * copy of them living here.
 */
export const AppearancePage: Component = () => {
  const [prefersDark, setPrefersDark] = createSignal(
    typeof matchMedia === "function"
      ? matchMedia("(prefers-color-scheme: dark)").matches
      : true,
  );

  // Only the "System" swatch depends on this, but it depends on it while the
  // panel is open: changing the OS appearance with Settings on screen should
  // repaint that one card, the same way it repaints the app.
  onMount(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mq.addEventListener("change", onChange);
    onCleanup(() => mq.removeEventListener("change", onChange));
  });

  return (
    <Group>
      <Row
        label="Theme"
        deviceOnly
        stacked
        hint={
          <>
            Stored in this browser under <code>tmux-theme</code>. A change
            applies to the attached terminal straight away, without a reload.
          </>
        }
      >
        <div class="tl-set-swatches" role="group" aria-label="Theme">
          <For each={THEMES}>
            {(t) => (
              <button
                type="button"
                class="tl-set-swatch"
                classList={{ active: theme() === t }}
                aria-pressed={theme() === t}
                onClick={() => setTheme(t)}
              >
                <span
                  class={`tl-set-swatch-art tl-swatch--${resolvePreview(t, prefersDark())}`}
                  aria-hidden="true"
                >
                  <span class="tl-set-swatch-side" />
                  <span class="tl-set-swatch-body">
                    <span class="tl-set-swatch-line is-accent" />
                    <span class="tl-set-swatch-line" />
                    <span class="tl-set-swatch-line is-short" />
                  </span>
                </span>
                <span class="tl-set-swatch-name">{THEME_LABELS[t] ?? t}</span>
              </button>
            )}
          </For>
        </div>
      </Row>
    </Group>
  );
};
