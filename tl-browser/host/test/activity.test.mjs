import assert from "node:assert/strict";
import { test } from "node:test";
import { summarize } from "../lib/activity.mjs";

const cases = [
  ["browser_navigate", { url: "https://en.wikipedia.org/wiki/Tmux" }, "Loading en.wikipedia.org"],
  ["browser_navigate", { url: "https://www.wikipedia.org/" }, "Loading wikipedia.org"],
  ["browser_navigate", { url: "data:text/html,<h1>hi</h1>" }, "Loading a page"],
  ["browser_navigate", { url: "not a url" }, "Loading not a url"],
  ["browser_navigate", {}, "Loading a page"],
  ["browser_navigate_back", {}, "Going back"],
  ["browser_click", { element: "Sign in button", ref: "e12" }, "Clicking Sign in button"],
  ["browser_click", { ref: "e12" }, "Clicking on the page"],
  ["browser_type", { element: "Search box", text: "secret" }, "Typing into Search box"],
  ["browser_hover", { element: "Menu" }, "Hovering over Menu"],
  ["browser_press_key", { key: "Enter" }, "Pressing Enter"],
  ["browser_snapshot", {}, "Reading the page"],
  ["browser_take_screenshot", {}, "Taking a screenshot"],
  ["browser_fill_form", { fields: [] }, "Filling in a form"],
  ["browser_select_option", { element: "Country" }, "Choosing an option in Country"],
  ["browser_wait_for", { text: "Done" }, 'Waiting for "Done"'],
  ["browser_wait_for", { time: 2 }, "Waiting"],
  ["browser_tabs", { action: "new" }, "Opening a tab"],
  ["browser_tabs", { action: "close" }, "Closing a tab"],
  ["browser_tabs", { action: "select" }, "Switching tabs"],
  ["browser_tabs", { action: "list" }, "Listing tabs"],
  ["browser_evaluate", { function: "() => 1" }, "Running a script on the page"],
  ["browser_run_code_unsafe", { code: "x" }, "Running a script on the page"],
  ["browser_file_upload", {}, "Uploading a file"],
  ["browser_handle_dialog", { accept: true }, "Answering a dialog"],
  ["browser_drag", { startElement: "A", endElement: "B" }, "Dragging A to B"],
  ["browser_console_messages", {}, "Reading the console"],
  ["browser_network_requests", {}, "Reading network requests"],
  ["browser_network_request", { index: 3 }, "Reading a network request"],
  ["browser_drop", { element: "Upload area" }, "Dropping onto Upload area"],
  ["browser_drop", {}, "Dropping onto the page"],
  ["browser_resize", { width: 1, height: 1 }, "Resizing the window"],
  ["browser_close", {}, "Closing the browser"],
  ["browser_something_new", {}, "Using something new"],
];

for (const [name, args, want] of cases) {
  test(`${name} ${JSON.stringify(args)} reads "${want}"`, () => {
    assert.equal(summarize(name, args), want);
  });
}

test("a long element description is cut short", () => {
  const got = summarize("browser_click", { element: "x".repeat(200) });
  assert.ok(got.length <= 80, got);
  assert.ok(got.endsWith("…"));
});

test("arguments that are not an object do not throw", () => {
  assert.equal(summarize("browser_click", null), "Clicking on the page");
  assert.equal(summarize("browser_click", "nope"), "Clicking on the page");
});
