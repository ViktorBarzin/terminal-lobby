import assert from "node:assert/strict";
import { test } from "node:test";
import { clearMcpModal, mcpModalPending } from "../lib/mcptab.mjs";

/**
 * A page as playwright-mcp leaves it: its Tab under a private symbol named
 * "tabSymbol", holding the modal states that block the agent's other tools.
 * @param {{ type: string, dialog?: object, fileChooser?: object }[]} states
 */
function mcpPage(states) {
  const tab = {
    _modalStates: states,
    modalStates() {
      return this._modalStates;
    },
    /** @param {object} s */
    clearModalState(s) {
      this._modalStates = this._modalStates.filter((x) => x !== s);
    },
  };
  return { page: { [Symbol("tabSymbol")]: tab }, tab };
}

test("a dialog a person answered no longer blocks the agent", () => {
  const dialog = {};
  const other = {};
  const { page, tab } = mcpPage([
    { type: "dialog", dialog },
    { type: "dialog", dialog: other },
  ]);
  assert.equal(clearMcpModal(page, dialog), true);
  assert.deepEqual(tab.modalStates(), [{ type: "dialog", dialog: other }]);
});

test("a file chooser a person cancelled no longer blocks the agent", () => {
  const fileChooser = {};
  const { page, tab } = mcpPage([{ type: "fileChooser", fileChooser }]);
  assert.equal(clearMcpModal(page, fileChooser), true);
  assert.deepEqual(tab.modalStates(), []);
});

test("a dialog is pending while playwright-mcp still holds it", () => {
  const dialog = {};
  const { page, tab } = mcpPage([{ type: "dialog", dialog }]);
  assert.equal(mcpModalPending(page, dialog), true);
  tab.clearModalState(tab.modalStates()[0]);
  assert.equal(mcpModalPending(page, dialog), false);
});

test("a page playwright-mcp does not track changes nothing and counts as pending", () => {
  const dialog = {};
  for (const page of [
    {},
    { [Symbol("tabSymbol")]: null },
    { [Symbol("tabSymbol")]: { modalStates: 1 } },
    { [Symbol("other")]: { modalStates: () => [], clearModalState: () => {} } },
  ]) {
    assert.equal(clearMcpModal(page, dialog), false);
    assert.equal(mcpModalPending(page, dialog), true, "unknown, so the person may still answer it");
  }
});
