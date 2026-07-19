/* @refresh reload */
import { render } from "solid-js/web";
import "./theme/theme.css";
import "./app.css";
import "./sidebar.css";
import { App } from "./components/App";
import { installSlowRequestTracking } from "./store/toast";
import { logBuildId } from "./deploy/healer";

// Build-id marker (inventory Cat.10): logs `terminal-lobby build: <id>` and
// stamps documentElement.dataset.tlBuild. Emitting the marker literal is what
// plants the substring the stale-tab healer's fetchSelf validates against, so
// the served single-file index.html always carries it. Runs first at boot.
logBuildId();

// Auto-track same-origin lobby/session requests for the slow-request toast.
installSlowRequestTracking();

const root = document.getElementById("root");
if (root) {
  render(() => <App />, root);
}
