// One human-readable line per agent tool call, for the Browser card's header:
// "Loading wikipedia.org", "Clicking Sign in". Never includes what was typed.

const MAX = 80;

/**
 * @param {string} s
 * @returns {string}
 */
function clip(s) {
  return s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s;
}

/**
 * @param {Record<string, unknown>} args
 * @param {string} key
 * @returns {string}
 */
function str(args, key) {
  const v = args[key];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * @param {string} raw
 * @returns {string}
 */
function where(raw) {
  if (!raw) return "a page";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "a page";
    return url.hostname.replace(/^www\./, "");
  } catch {
    return raw;
  }
}

/**
 * @param {string} name a playwright-mcp tool name, e.g. browser_navigate
 * @param {unknown} rawArgs the call's arguments
 * @returns {string}
 */
export function summarize(name, rawArgs) {
  /** @type {Record<string, unknown>} */
  const args =
    rawArgs !== null && typeof rawArgs === "object"
      ? /** @type {Record<string, unknown>} */ (rawArgs)
      : {};
  const el = str(args, "element");
  switch (name) {
    case "browser_navigate":
      return clip(`Loading ${where(str(args, "url"))}`);
    case "browser_navigate_back":
      return "Going back";
    case "browser_click":
      return clip(el ? `Clicking ${el}` : "Clicking on the page");
    case "browser_type":
      return clip(el ? `Typing into ${el}` : "Typing");
    case "browser_hover":
      return clip(el ? `Hovering over ${el}` : "Hovering");
    case "browser_press_key":
      return clip(`Pressing ${str(args, "key") || "a key"}`);
    case "browser_snapshot":
      return "Reading the page";
    case "browser_take_screenshot":
      return "Taking a screenshot";
    case "browser_fill_form":
      return "Filling in a form";
    case "browser_select_option":
      return clip(el ? `Choosing an option in ${el}` : "Choosing an option");
    case "browser_wait_for": {
      const text = str(args, "text") || str(args, "textGone");
      return clip(text ? `Waiting for "${text}"` : "Waiting");
    }
    case "browser_tabs":
      return (
        { new: "Opening a tab", close: "Closing a tab", select: "Switching tabs" }[
          str(args, "action")
        ] ?? "Listing tabs"
      );
    case "browser_evaluate":
    case "browser_run_code_unsafe":
      return "Running a script on the page";
    case "browser_file_upload":
      return "Uploading a file";
    case "browser_handle_dialog":
      return "Answering a dialog";
    case "browser_drag": {
      const from = str(args, "startElement");
      const to = str(args, "endElement");
      return clip(from && to ? `Dragging ${from} to ${to}` : "Dragging");
    }
    case "browser_console_messages":
      return "Reading the console";
    case "browser_network_requests":
      return "Reading network requests";
    case "browser_network_request":
      return "Reading a network request";
    case "browser_drop":
      return clip(el ? `Dropping onto ${el}` : "Dropping onto the page");
    case "browser_resize":
      return "Resizing the window";
    case "browser_close":
      return "Closing the browser";
    default:
      return clip(`Using ${name.replace(/^browser_/, "").replaceAll("_", " ")}`);
  }
}
