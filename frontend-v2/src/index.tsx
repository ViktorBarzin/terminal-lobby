/* @refresh reload */
import { render } from "solid-js/web";
import "./theme/theme.css";
import "./app.css";
import "./sidebar.css";
import { App } from "./components/App";
import { installSlowRequestTracking } from "./store/toast";

// Auto-track same-origin lobby/session requests for the slow-request toast.
installSlowRequestTracking();

const root = document.getElementById("root");
if (root) {
  render(() => <App />, root);
}
