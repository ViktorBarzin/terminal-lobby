import { type Component } from "solid-js";
import { closeT3Sheet, openInApp, openInBrowser, type T3Target } from "../lib/t3-open";

/**
 * The phone's way into a T3 thread (lib/t3-open.ts): the T3 app, or T3's web
 * client in the browser. Built from the model sheet's parts, so it slides up
 * from the bottom the way every other choice on a phone does.
 */
export const T3OpenSheet: Component<{ target: T3Target }> = (props) => {
  // The target is read before the sheet closes: closing unmounts this, and a
  // read after that would be of a sheet that is gone.
  const app = () => {
    const { appUrl } = props.target;
    closeT3Sheet();
    openInApp(appUrl);
  };
  const browser = () => {
    const { url } = props.target;
    closeT3Sheet();
    openInBrowser(url);
  };
  return (
    <div class="tl-ms-layer tl-t3-open">
      <button
        type="button"
        class="tl-ms-scrim"
        aria-label="Close"
        tabindex={-1}
        onClick={closeT3Sheet}
      />
      <div
        class="tl-ms-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Open ${props.target.title || "the T3 session"}`}
        tabindex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") closeT3Sheet();
        }}
      >
        <div class="tl-ms-grab" aria-hidden="true" />
        <div class="tl-ms-h">{props.target.title || "T3 session"}</div>
        {/* The app first: it is the one a phone is for. It needs pairing with
            this host, which the browser does not. */}
        <button
          type="button"
          class="tl-ms-row"
          disabled={!props.target.appUrl}
          onClick={app}
        >
          <span>Open in T3 app</span>
        </button>
        <button type="button" class="tl-ms-row" onClick={browser}>
          <span>Open in browser</span>
        </button>
      </div>
    </div>
  );
};
