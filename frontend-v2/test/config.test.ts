import { describe, it, expect } from "vitest";
import {
  TMUX_API_PREFIX,
  apiUrl,
  telemetryUrl,
  clipboardUrl,
  fileListUrl,
  fileReadUrl,
  eventsUrl,
  promptUrl,
  cancelUrl,
  pictureUrl,
  toolImageUrl,
  promptImageUrl,
  agentEventsUrl,
  agentEarlierUrl,
  agentResultUrl,
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

  it("telemetryUrl points at the intake under the same prefix", () => {
    // diag.ts used to spell this out as a literal, which is why a ?api= tab
    // sent its telemetry to whatever origin served the page instead of the
    // backend it was pointed at.
    expect(telemetryUrl()).toBe("/api/sessions/telemetry");
    expect(telemetryUrl()).toBe(apiUrl("/telemetry"));
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
    expect(eventsUrl("s", 7, "e1")).toBe("/events/s?lastEventId=7&epoch=e1&rev=1");
    expect(eventsUrl("s", 0, "e1")).toBe("/events/s?rev=1"); // nothing held, no log to name
    expect(promptUrl("s")).toBe("/prompt/s");
    expect(cancelUrl("s")).toBe("/cancel/s");
  });

  it("clipboard + file-api keep their own prefixes (not moved by the fix)", () => {
    expect(clipboardUrl("/upload")).toBe("/clipboard/upload");
    expect(fileReadUrl("/home/x/f")).toBe("/files/read?path=%2Fhome%2Fx%2Ff");
  });
});

// The drill-in reads one agent's transcript through the session's own routes:
// the production ingress routes by path prefix and /events/ is already one of
// its rules, so the three sit under it rather than under a prefix of their own.
describe("config — an agent's own transcript", () => {
  it("streams under the session's /events/ prefix, reverse open, resumable", () => {
    expect(agentEventsUrl("s", "a1b2", 0)).toBe("/events/s/agents/a1b2?rev=1");
    expect(agentEventsUrl("s", "a1b2", 42)).toBe("/events/s/agents/a1b2?lastEventId=42&rev=1");
  });

  it("pages back and fetches a full result beside the stream", () => {
    expect(agentEarlierUrl("s", "a1b2", 300, 40_000)).toBe(
      "/events/s/agents/a1b2/earlier?before=300&bytes=40000",
    );
    expect(agentResultUrl("s", "a1b2", "toolu_1")).toBe("/events/s/agents/a1b2/result/toolu_1");
  });

  it("keeps every name one path segment", () => {
    // A workflow member that never started is named <runId>#<index>, and an
    // unescaped # would end the path there.
    expect(agentEventsUrl("my s", "wf_1#3", 0)).toBe("/events/my%20s/agents/wf_1%233?rev=1");
    expect(agentResultUrl("s", "a/b", "t/u")).toBe("/events/s/agents/a%2Fb/result/t%2Fu");
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
    expect(fileListUrl(odd, true)).toBe(`/files/list?dir=${encodeURIComponent(odd)}&all=1`);
  });
});

// The Text view's pictures (2026-09-24). A picture on disk goes to the file-api's
// picture-only route, which reads any path the caller's OS user can read; a
// picture the transcript itself carries (a terminal paste, a Read of an image)
// has no file, so session-events reads its bytes back out of the transcript by
// block index. The byte routes end in the index and never in an extension:
// frontend/diag.js files any path ending in .png under "app".
describe("config — picture URLs", () => {
  it("sends a picture on disk to file-api's picture route, path encoded", () => {
    expect(pictureUrl("/tmp/claude-1000/x/scratchpad/a b.png")).toBe(
      "/files/image?path=%2Ftmp%2Fclaude-1000%2Fx%2Fscratchpad%2Fa%20b.png",
    );
  });

  it("reads a tool result's n-th image block back from session-events", () => {
    expect(toolImageUrl("deploy-the-thing", "toolu_01EaDF17CdmXP8Wc3ctiXaL2", 0)).toBe(
      "/result/deploy-the-thing/toolu_01EaDF17CdmXP8Wc3ctiXaL2/image/0",
    );
  });

  it("reads a prompt's n-th image block back by the user record's uuid", () => {
    expect(promptImageUrl("s", "1ecbc9e7-ef70-4213-bd81-82c2dfcb5169", 2)).toBe(
      "/result/s/user/1ecbc9e7-ef70-4213-bd81-82c2dfcb5169/image/2",
    );
  });

  it("encodes the session and the ids, which go into path segments", () => {
    expect(toolImageUrl("a/b", "t?1", 1)).toBe("/result/a%2Fb/t%3F1/image/1");
    expect(promptImageUrl("a b", "r#1", 0)).toBe("/result/a%20b/user/r%231/image/0");
  });
});
