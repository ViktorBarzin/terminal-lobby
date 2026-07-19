import { describe, it, expect } from "vitest";
import {
  TMUX_API_PREFIX,
  apiUrl,
  TERMINAL_BASE,
  clipboardUrl,
  fileReadUrl,
  eventsUrl,
  promptUrl,
  cancelUrl,
  permissionUrl,
  PREFS_PATH,
} from "../src/lib/config";

describe("config — tmux-api prefix (PROD ingress: PathPrefix /api/sessions/ -> tmux-api, strip)", () => {
  it("TMUX_API_PREFIX is /api/sessions (matches frontend/index.html + the ingress)", () => {
    // Regression guard for the v2 integration bug: the SPA used to call /api/*,
    // which only works under the old dev proxy; the real ingress strips
    // /api/sessions. See docs/plans/2026-07-19-v2-integration-debt.md.
    expect(TMUX_API_PREFIX).toBe("/api/sessions");
  });

  it("apiUrl builds lobby-data URLs under /api/sessions", () => {
    expect(apiUrl("/whoami")).toBe("/api/sessions/whoami");
    expect(apiUrl("/sessions")).toBe("/api/sessions/sessions");
    expect(apiUrl("/layout")).toBe("/api/sessions/layout");
    expect(apiUrl("/dirs")).toBe("/api/sessions/dirs");
    // prefs roams through the same prefix (store/prefs.ts uses apiUrl(PREFS_PATH)).
    expect(apiUrl(PREFS_PATH)).toBe("/api/sessions/prefs");
  });

  it("apiUrl tolerates a path with or without a leading slash", () => {
    expect(apiUrl("whoami")).toBe("/api/sessions/whoami");
    expect(apiUrl("/whoami")).toBe("/api/sessions/whoami");
  });

  it("session-events control channel stays at the ROOT (NOT under /api/sessions)", () => {
    // These hit session-events, which the ingress maps at the root — moving them
    // under the prefix would break them, so the fix must leave them alone.
    expect(eventsUrl("s", 0)).toBe("/events/s");
    expect(promptUrl("s")).toBe("/prompt/s");
    expect(cancelUrl("s")).toBe("/cancel/s");
    expect(permissionUrl("r")).toBe("/permission/r");
  });

  it("clipboard + file-api keep their own prefixes (not moved by the fix)", () => {
    expect(clipboardUrl("/upload")).toBe("/clipboard/upload");
    expect(fileReadUrl("/home/x/f")).toBe("/files/read?path=%2Fhome%2Fx%2Ff");
  });
});

describe("config — terminal page base (avoids SPA-in-iframe recursion)", () => {
  it("TERMINAL_BASE defaults to /term.html (a separate static page, not '/')", () => {
    // The SPA is served at '/', so an iframe pointed at '/?arg=' would reload the
    // SPA. term.html is the standalone terminal-mode page it must attach against.
    expect(TERMINAL_BASE).toBe("/term.html");
  });
});
