import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  type Accessor,
  type Component,
} from "solid-js";
import { runSummary, streamWanted, type BrowsingRun } from "./browser.logic";
import {
  createBrowserStream,
  createVisibility,
  keptFrame,
  type BrowserState,
} from "../lib/browser-stream";
import { BrowserGlyph } from "./Icons";

/** What a Browser card needs from the session it belongs to. */
export interface BrowserCardHost {
  session: string;
  /** The session's owner when it is somebody else's (a share). */
  owner?: string;
  /** The session list's word on the session's browser, absent when it has none. */
  state: () => BrowserState | undefined;
  /** The Text view is on screen, showing, and its stream is not parked. */
  active: () => boolean;
  /** Open the Browser panel beside the conversation. */
  onOpen: () => void;
}

/**
 * The Browser card: the conversation's record of one Browsing run
 * (CONTEXT.md "Browser card"). It says what the browser is doing and shows a
 * picture of its page, live while the run is the current one and the card can
 * be seen. Once the run ends it keeps the last frame it held in this page's
 * memory, and after a reload it keeps only its words.
 *
 * It never wakes a Frozen browser: its stream is created with `wake: false`, so
 * a card on a frozen browser stays quiet until something else wakes it. Opening
 * the panel is that something.
 */
export const BrowserCard: Component<{
  run: Accessor<BrowsingRun | undefined>;
  host: BrowserCardHost;
}> = (props) => {
  const [node, setNode] = createSignal<HTMLDivElement>();
  const seen = createVisibility(node);
  const current = (): boolean => props.run()?.current === true;
  // Read once: the key is the run's, and a card is mounted per run key.
  const keepKey = `${props.host.owner ?? ""}/${props.host.session}|${props.run()?.key ?? ""}`;
  const earlier = keptFrame(keepKey);

  const stream = createBrowserStream({
    session: props.host.session,
    owner: props.host.owner,
    wake: false,
    keep: keepKey,
    active: () =>
      streamWanted({
        wanted: current() && props.host.state() !== "frozen",
        intersecting: seen.intersecting(),
        documentVisible: seen.documentVisible(),
        parked: !props.host.active(),
      }),
  });
  // The session list noticed a browser starting: try again now rather than at
  // the next backoff step, since the first call is when a card matters most.
  createEffect(
    on(
      () => props.host.state(),
      (s) => {
        if (s && current()) stream.retry();
      },
      { defer: true },
    ),
  );

  const frame = () => stream.frame() ?? earlier;
  const summary = createMemo(() => {
    const live = current() ? stream.activity() : null;
    const run = props.run();
    return live ?? (run ? runSummary(run) : "");
  });
  const streaming = () => current() && stream.frame() !== null && stream.state() === "live";
  const canOpen = () => current() || props.host.state() !== undefined;

  return (
    <div class="tl-row tl-row-browser" ref={setNode}>
      <div class="tl-browser-card" data-live={streaming() ? "" : undefined}>
        <div class="tl-browser-card-head">
          <span
            class="tl-group-dot tl-browser-card-dot"
            data-status={current() ? "live" : "ok"}
            aria-hidden="true"
          />
          <BrowserGlyph size={16} />
          <span class="tl-browser-card-title">Browser</span>
          <span class="tl-browser-card-sum" title={summary()}>
            {summary()}
          </span>
        </div>
        <Show when={frame()}>
          {(f) => (
            <button
              type="button"
              class="tl-browser-card-shot"
              aria-label="Open the browser"
              onClick={() => props.host.onOpen()}
              disabled={!canOpen()}
            >
              <img src={f().src} alt="" width={f().w} height={f().h} draggable={false} />
            </button>
          )}
        </Show>
        <Show when={canOpen()}>
          <div class="tl-browser-card-foot">
            <button type="button" class="tl-btn" onClick={() => props.host.onOpen()}>
              Open browser
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
};
