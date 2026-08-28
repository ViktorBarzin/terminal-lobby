/* @refresh reload */
// FIRST, and a side-effect import so it really is first: `import` declarations
// hoist, so a call written here would run after every module body below. On
// Safari 15.6 (iPadOS 15.8) `AbortSignal.timeout` does not exist, and it is
// read on the way into EVERY lobby request — without this the session list
// never loads, the sidebar reads "Failed to load", and with nothing to select
// there is no terminal either.
import "./lib/baseline-polyfills";
import { render } from "solid-js/web";
import "./theme/theme.css";
import "./app.css";
import "./sidebar.css";
import { App } from "./components/App";
import { installSlowRequestTracking } from "./store/toast";
import { logBuildId } from "./deploy/healer";
import { startDiagnostics } from "./telemetry/diag";
import { recordMeasurement } from "./diagnostics/connection";

// Build-id marker (inventory Cat.10): logs `terminal-lobby build: <id>` and
// stamps documentElement.dataset.tlBuild. Emitting the marker literal is what
// plants the substring the stale-tab healer's fetchSelf validates against, so
// the served single-file index.html always carries it. Runs first at boot.
logBuildId();

// Client diagnostics (ADR-0008). Started before the app renders so a failure
// during boot is still recorded; the measurement core itself was installed by
// the inlined script in <head>, ahead of every module here.
startDiagnostics();

// Auto-track same-origin lobby/session requests for the slow-request toast.
installSlowRequestTracking();

// Connection diagnostics: measure THIS load and record the verdict for the next
// one. It has to run after `load`, because the numbers it reads (how many bytes
// the document cost and how long they took) do not exist until then — which is
// also why the verdict is applied to the NEXT load rather than this one. Costs
// no extra request: it reads Navigation Timing, which every browser including
// iOS Safari has, unlike navigator.connection.
if (typeof window !== "undefined") {
  const measure = (): void => {
    try {
      recordMeasurement();
    } catch {
      /* a missing verdict costs the next load its head start, nothing more */
    }
  };
  if (document.readyState === "complete") measure();
  else window.addEventListener("load", measure, { once: true });
}

const root = document.getElementById("root");
if (root) {
  render(() => <App />, root);
}
