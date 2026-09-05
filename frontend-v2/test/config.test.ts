import { describe, it, expect } from "vitest";
import {
  TMUX_API_PREFIX,
  apiUrl,
  clipboardUrl,
  fileListUrl,
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
    // `rev=1` asks for the reverse open; the route is still at the root.
    expect(eventsUrl("s", 0)).toBe("/events/s?rev=1");
    expect(promptUrl("s")).toBe("/prompt/s");
    expect(cancelUrl("s")).toBe("/cancel/s");
    expect(permissionUrl("r")).toBe("/permission/r");
  });

  it("clipboard + file-api keep their own prefixes (not moved by the fix)", () => {
    expect(clipboardUrl("/upload")).toBe("/clipboard/upload");
    expect(fileReadUrl("/home/x/f")).toBe("/files/read?path=%2Fhome%2Fx%2Ff");
  });
});

// The Browse pane's show-hidden toggle rides on this one query parameter, so the
// contract is pinned here: the flag is opt-in, and off must produce byte-identical
// URLs to the ones the app has always sent.
describe("config — fileListUrl carries the dotfile opt-in", () => {
  const dir = "/home/wizard/qa-verify-fp";
  const enc = encodeURIComponent(dir);

  it("omits all=1 by default and when explicitly off", () => {
    expect(fileListUrl(dir)).toBe(`/files/list?dir=${enc}`);
    expect(fileListUrl(dir, false)).toBe(`/files/list?dir=${enc}`);
  });

  it("appends &all=1 when hidden files are requested", () => {
    expect(fileListUrl(dir, true)).toBe(`/files/list?dir=${enc}&all=1`);
  });

  it("keeps the directory percent-encoded so spaces and & survive", () => {
    const odd = "/home/wizard/a b&c";
    expect(fileListUrl(odd, true)).toBe(
      `/files/list?dir=${encodeURIComponent(odd)}&all=1`,
    );
  });
});

