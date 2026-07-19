/* @refresh reload */
import { render } from "solid-js/web";
import "./theme/theme.css";
import "./app.css";
import { App } from "./components/App";

const root = document.getElementById("root");
if (root) {
  render(() => <App />, root);
}
