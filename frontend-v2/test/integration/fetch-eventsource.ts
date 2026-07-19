import type { EventSourceLike } from "../../src/sse/client";

/**
 * A minimal EventSource implemented over `fetch` + a streaming body reader, used
 * ONLY by the integration test to drive the real SseClient against a live
 * session-events in a Node environment (Node has no global EventSource).
 *
 * It is deliberately faithful to the browser EventSource contract the SseClient
 * relies on: it fires onopen once the response headers arrive, parses SSE frames
 * (`id:` + `data:` lines separated by a blank line, `:`-comment heartbeats
 * ignored), and fires onerror on a network/stream failure. The one addition over
 * the browser is a custom request header — in production the ingress injects
 * X-Authentik-Username; here the test harness supplies it, which is exactly the
 * seam the browser can't set but the deployment always does.
 */
export function makeFetchEventSource(headers: Record<string, string>) {
  return (url: string): EventSourceLike => new FetchEventSource(url, headers);
}

class FetchEventSource implements EventSourceLike {
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string; lastEventId?: string }) => void) | null =
    null;

  private readonly controller = new AbortController();
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {
    void this.run();
  }

  close(): void {
    this.closed = true;
    try {
      this.controller.abort();
    } catch {
      /* already aborted */
    }
  }

  private fail(err: unknown): void {
    if (this.closed) return;
    this.onerror?.(err);
  }

  private async run(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        headers: { Accept: "text/event-stream", ...this.headers },
        signal: this.controller.signal,
      });
    } catch (err) {
      this.fail(err);
      return;
    }
    if (!res.ok || !res.body) {
      this.fail(new Error(`HTTP ${res.status}`));
      return;
    }
    this.onopen?.(null);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          this.dispatch(frame);
        }
      }
      // Stream ended (server closed / context cancelled) — treat as an error so
      // the SseClient's reconnect ladder engages, matching the browser.
      this.fail(new Error("stream closed"));
    } catch (err) {
      this.fail(err);
    }
  }

  private dispatch(frame: string): void {
    let data = "";
    let id: string | undefined;
    for (const raw of frame.split("\n")) {
      if (raw.startsWith(":")) continue; // comment / heartbeat
      const colon = raw.indexOf(":");
      const field = colon === -1 ? raw : raw.slice(0, colon);
      let val = colon === -1 ? "" : raw.slice(colon + 1);
      if (val.startsWith(" ")) val = val.slice(1);
      if (field === "data") data += (data ? "\n" : "") + val;
      else if (field === "id") id = val;
    }
    if (data !== "") this.onmessage?.({ data, lastEventId: id });
  }
}
