// playwright-mcp's own record of a page's open dialog or file chooser.
//
// playwright-mcp keeps a Tab per page and, while a dialog or file chooser is
// open on it, a "modal state" that refuses every tool except the one that
// answers it (browser_handle_dialog, browser_file_upload). When a person in
// control answers the dialog from the panel, that state would stay behind,
// and the agent's next call after the hand-back would fail on a dialog that
// is already gone. So the host clears it.
//
// The Tab is not exported: playwright-mcp stores it on the page under a
// private symbol named "tabSymbol" (playwright-core's tools/backend/tab.ts,
// at the version package.json pins). This module finds it by that name and
// by the two methods it calls, and does nothing when either is missing, so a
// version that moves it costs the agent one failed call, not a crash. The
// integration test fails on such a version.

/**
 * @typedef {{ type: string, dialog?: unknown, fileChooser?: unknown }} ModalState
 * @typedef {{ modalStates: () => ModalState[], clearModalState: (s: ModalState) => void }} McpTab
 */

/**
 * @param {object} page
 * @returns {McpTab | null}
 */
function mcpTab(page) {
  for (const sym of Object.getOwnPropertySymbols(page)) {
    if (sym.description !== "tabSymbol") continue;
    /** @type {unknown} */
    const tab = Reflect.get(page, sym);
    if (
      tab !== null &&
      typeof tab === "object" &&
      typeof Reflect.get(tab, "modalStates") === "function" &&
      typeof Reflect.get(tab, "clearModalState") === "function"
    )
      return /** @type {McpTab} */ (tab);
  }
  return null;
}

/**
 * @param {McpTab} tab
 * @param {unknown} modal the Dialog or FileChooser
 * @returns {ModalState | undefined}
 */
function stateOf(tab, modal) {
  return tab.modalStates().find((s) => s.dialog === modal || s.fileChooser === modal);
}

/**
 * Forgets a dialog or file chooser a person dealt with, so it does not block
 * the agent's next tool call.
 * @param {object} page
 * @param {unknown} modal the Dialog or FileChooser
 * @returns {boolean} whether playwright-mcp had it
 */
export function clearMcpModal(page, modal) {
  const tab = mcpTab(page);
  const state = tab && stateOf(tab, modal);
  if (!tab || !state) return false;
  tab.clearModalState(state);
  return true;
}

/**
 * Whether playwright-mcp still holds a dialog, i.e. the agent has not
 * answered it. True when that cannot be told, so a person may still try.
 * @param {object} page
 * @param {unknown} modal
 * @returns {boolean}
 */
export function mcpModalPending(page, modal) {
  const tab = mcpTab(page);
  return tab ? stateOf(tab, modal) !== undefined : true;
}
