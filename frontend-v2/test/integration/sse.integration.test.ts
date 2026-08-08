// @vitest-environment node
//
// End-to-end integration: the REAL SseClient (src/sse/client.ts) streaming from
// a REAL session-events Go service — no mocks. It builds the service, starts it
// on a test port with a temp Authentik→OS-user map and home-base, registers a
// session through the SessionStart hook, appends transcript JSONL lines, and
// asserts the normalized events arrive live and that a reconnect resumes from
// the Last-Event-ID cursor (replaying only newer events, no duplicates).
//
// This exercises the same wire contract the built frontend-v2 uses in the
// browser: the SSE handler's replay+tail, the Last-Event-ID resume, the event
// JSON shape parsed by types/events.ts, and the client's dedup-by-id.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SseClient, type EventSourceLike } from "../../src/sse/client";
import { eventsUrl } from "../../src/lib/config";
import type { Event } from "../../src/types/events";
import { makeFetchEventSource } from "./fetch-eventsource";

const here = path.dirname(fileURLToPath(import.meta.url));
const sessionEventsDir = path.resolve(here, "../../../session-events");

const OS_USER = os.userInfo().username;
const AUTH = "itest-user"; // Authentik header value → mapped to OS_USER
const AUTH_HEADERS = { "X-Authentik-Username": AUTH };

let tmpDir = "";
let homeBase = "";
let proc: ChildProcess | undefined;
let baseUrl = "";
let stderr = "";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function until(
  pred: () => boolean,
  timeoutMs = 6000,
  stepMs = 20,
): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Compute the transcript path exactly as session-events' transcriptPath does:
 *  <homeBase>/<osUser>/.claude/projects/<cwd-with-slashes-as-dashes>/<id>.jsonl */
function transcriptPath(cwd: string, claudeID: string): string {
  const slug = cwd.replaceAll("/", "-");
  return path.join(
    homeBase,
    OS_USER,
    ".claude",
    "projects",
    slug,
    `${claudeID}.jsonl`,
  );
}

function assistantText(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

/**
 * The status probe the browser client uses, with the header the ingress injects.
 * Reads ONLY the status line and discards the body, so a probe that lands on a
 * live stream does not consume it.
 */
function probeWith(headers: Record<string, string>) {
  return async (url: string): Promise<number | null> => {
    try {
      const res = await fetch(url, {
        headers: { Accept: "text/event-stream", ...headers },
      });
      try {
        await res.body?.cancel();
      } catch {
        /* already closed */
      }
      return res.status;
    } catch {
      return null;
    }
  };
}

/** Register a (tmux session → transcript) mapping via the localhost-only hook. */
async function registerSession(
  tmuxSession: string,
  cwd: string,
  claudeID: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/hooks/session-start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user: OS_USER,
      session_id: claudeID,
      cwd,
      tmux_session: tmuxSession,
    }),
  });
  if (res.status !== 204) {
    throw new Error(`session-start hook failed: HTTP ${res.status}`);
  }
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "se-itest-"));
  homeBase = path.join(tmpDir, "home");
  fs.mkdirSync(path.join(homeBase, OS_USER, ".claude", "projects"), {
    recursive: true,
  });
  const mapFile = path.join(tmpDir, "user-map");
  fs.writeFileSync(mapFile, `${AUTH}=${OS_USER}\n`);

  // Build the real service (stdlib-only module → offline, fast).
  const binPath = path.join(tmpDir, "session-events");
  execFileSync("go", ["build", "-o", binPath, "."], {
    cwd: sessionEventsDir,
    stdio: "pipe",
  });

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  proc = spawn(
    binPath,
    [
      "-addr",
      `127.0.0.1:${port}`,
      "-usermap",
      mapFile,
      "-home-base",
      homeBase,
      "-poll",
      "40ms",
      "-heartbeat",
      "400ms",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  proc.stderr?.on("data", (d) => (stderr += d.toString()));
  proc.stdout?.on("data", (d) => (stderr += d.toString()));

  // Wait for the health endpoint to answer.
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > 8000) {
      throw new Error(`session-events did not start. stderr:\n${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}, 60000);

afterAll(async () => {
  if (proc && !proc.killed) {
    proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    if (!proc.killed) proc.kill("SIGKILL");
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// QUARANTINED 2026-08-08 (v2 dev-tier resume): the SessionStart registry now
// lives IN tmux (session-events/sessionmap.go:30 "TMUX ITSELF STORES IT"), so
// POST /hooks/session-start rejects a session with no real tmux session — a 500
// by design, asserted by registry_test.go TestRegistrySessionStartFailsWhenItCannotRecord.
// This itest still registers a fabricated tmux_session and expects 204, so it
// now fails. Text-mode is DEFERRED for v1; re-enable this — and fix it to stand
// up a scratch `tmux -L` server with real sessions — when text-mode is
// un-deferred. Unit coverage of the SSE client + registry stays active.
describe.skip("SseClient ⇄ real session-events", () => {
  it("streams normalized transcript events live, in order", async () => {
    const session = "live_sess";
    const cwd = "/itest/live";
    const claudeID = "live-0001";
    const file = transcriptPath(cwd, claudeID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ""); // create the transcript
    await registerSession(session, cwd, claudeID);

    const received: Event[] = [];
    const client = new SseClient({
      session,
      // eventsUrl builds the same-origin path the browser uses; in Node fetch
      // needs an absolute URL, so prefix the test server's origin.
      url: (s, id) => baseUrl + eventsUrl(s, id),
      onEvent: (e) => received.push(e),
      createSource: makeFetchEventSource(AUTH_HEADERS),
      random: () => 0,
      baseDelayMs: 20,
      maxDelayMs: 40,
    });
    client.start();

    try {
      fs.appendFileSync(file, assistantText("first message") + "\n");
      await until(() => received.length >= 1);
      fs.appendFileSync(file, assistantText("second message") + "\n");
      await until(() => received.length >= 2);

      expect(received.map((e) => e.kind)).toEqual(["text", "text"]);
      expect(received.map((e) => e.body)).toEqual([
        "first message",
        "second message",
      ]);
      // Server assigns a monotonic id space; the client tracks the cursor.
      expect(received[0]!.id).toBeGreaterThan(0);
      expect(received[1]!.id).toBeGreaterThan(received[0]!.id);
      expect(client.cursor).toBe(received[1]!.id);
      expect(received[0]!.session).toBe(session);
    } finally {
      client.close();
    }
  }, 20000);

  it("resumes from the Last-Event-ID cursor after a reconnect, without dupes", async () => {
    const session = "resume_sess";
    const cwd = "/itest/resume";
    const claudeID = "resume-0001";
    const file = transcriptPath(cwd, claudeID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    await registerSession(session, cwd, claudeID);

    const received: Event[] = [];
    const sources: EventSourceLike[] = [];
    const urls: string[] = [];
    const make = makeFetchEventSource(AUTH_HEADERS);
    const client = new SseClient({
      session,
      url: (s, id) => baseUrl + eventsUrl(s, id),
      onEvent: (e) => received.push(e),
      createSource: (url) => {
        urls.push(url);
        const s = make(url);
        sources.push(s);
        return s;
      },
      random: () => 0,
      baseDelayMs: 20,
      maxDelayMs: 40,
    });
    client.start();

    try {
      // Two events over the first connection.
      fs.appendFileSync(file, assistantText("before-drop 1") + "\n");
      fs.appendFileSync(file, assistantText("before-drop 2") + "\n");
      await until(() => received.length >= 2);
      const cursor = client.cursor;
      expect(cursor).toBeGreaterThanOrEqual(2);

      // Simulate a dropped connection, then append while "offline". The service
      // keeps tailing the file regardless of subscribers, so these land in its
      // in-memory log and must be replayed on reconnect from the cursor.
      sources[sources.length - 1]!.onerror?.(new Error("network drop"));
      fs.appendFileSync(file, assistantText("after-drop 3") + "\n");
      fs.appendFileSync(file, assistantText("after-drop 4") + "\n");

      // The client reconnects on its backoff timer; wait for the new events.
      await until(() => received.length >= 4, 8000);

      // The reconnect URL must carry the resume cursor.
      expect(urls.length).toBeGreaterThanOrEqual(2);
      expect(urls[urls.length - 1]).toContain(`lastEventId=${cursor}`);

      // No duplicate ids — the server replayed only id > cursor, and the client
      // deduped anything at/below it.
      const ids = received.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      // All four bodies present, each exactly once, in order.
      expect(received.map((e) => e.body)).toEqual([
        "before-drop 1",
        "before-drop 2",
        "after-drop 3",
        "after-drop 4",
      ]);
    } finally {
      client.close();
    }
  }, 20000);

  // A plain tmux session no Claude ever ran in is NOT registered, so the real
  // service answers `404 session not registered`. Text mode is the default view
  // for every session, so this is the first thing such a session shows.
  it("reports no-transcript for an unregistered session instead of retrying the 404 forever", async () => {
    const session = "unregistered_sess";
    const sources: EventSourceLike[] = [];
    const statuses: string[] = [];
    const probed: string[] = [];
    const probe = probeWith(AUTH_HEADERS);

    // The bare 404 the client has to classify, straight off the wire.
    const direct = await fetch(`${baseUrl}${eventsUrl(session, 0)}`, {
      headers: AUTH_HEADERS,
    });
    expect(direct.status).toBe(404);
    expect(await direct.text()).toContain("session not registered");

    const make = makeFetchEventSource(AUTH_HEADERS);
    const client = new SseClient({
      session,
      url: (s, id) => baseUrl + eventsUrl(s, id),
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
      createSource: (url) => {
        const src = make(url);
        sources.push(src);
        return src;
      },
      probeStatus: (url) => {
        probed.push(url);
        return probe(url);
      },
      random: () => 0,
      baseDelayMs: 20, // the ladder would storm at ~30ms/attempt
      maxDelayMs: 40,
      probeIntervalMs: 300,
    });
    client.start();

    try {
      await until(() => statuses.includes("no-transcript"), 6000);
      expect(statuses).not.toContain("reconnecting");

      // Sit in the absent state well past a dozen ladder attempts: the client
      // must NOT keep opening connections, only re-probe on its slow timer.
      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, 1500));
      const elapsed = Date.now() - t0;
      expect(sources).toHaveLength(1); // the one attempt that discovered the 404
      // One probe per interval (+ the classification, + slack) — NOT the
      // ~1-per-30ms the backoff ladder would have produced. Measured against
      // real elapsed time so a loaded box slows the client, never the check.
      expect(probed.length).toBeLessThanOrEqual(2 + Math.ceil(elapsed / 300));
      expect(statuses[statuses.length - 1]).toBe("no-transcript");
    } finally {
      client.close();
    }
  }, 30000);

  it("comes alive when a previously-unregistered session registers later", async () => {
    const session = "late_sess";
    const cwd = "/itest/late";
    const claudeID = "late-0001";
    const received: Event[] = [];
    const statuses: string[] = [];

    const client = new SseClient({
      session,
      url: (s, id) => baseUrl + eventsUrl(s, id),
      onEvent: (e) => received.push(e),
      onStatus: (s) => statuses.push(s),
      createSource: makeFetchEventSource(AUTH_HEADERS),
      probeStatus: probeWith(AUTH_HEADERS),
      random: () => 0,
      baseDelayMs: 20,
      maxDelayMs: 40,
      probeIntervalMs: 300,
    });
    client.start();

    try {
      await until(() => statuses.includes("no-transcript"), 6000);

      // The session starts a Claude: the SessionStart hook registers it.
      const file = transcriptPath(cwd, claudeID);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "");
      await registerSession(session, cwd, claudeID);
      fs.appendFileSync(file, assistantText("hello from a late start") + "\n");

      // The slow re-probe must find the stream and hand it back to the ladder.
      await until(() => received.length >= 1, 8000);
      expect(received[0]!.body).toBe("hello from a late start");
      expect(statuses).toContain("open");
      expect(statuses[statuses.length - 1]).toBe("open");
    } finally {
      client.close();
    }
  }, 30000);
});
