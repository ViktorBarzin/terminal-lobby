/**
 * A stand-in for tmux-api and session-events on one ephemeral port: the
 * session list and layout, one session's event stream served from a recorded
 * fixture, and the POST routes recorded. Every request must carry the relayed
 * identity header and proxy secret, or a bearer listed in `bearers`, or it
 * gets 401, as the real ones answer.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeLobby {
  readonly url: string;
  readonly posts: Array<{ readonly path: string; readonly body: unknown }>;
  /** Each event stream opened, with the credential it came with ("bearer:<token>" or "proxy:<identity>"). */
  readonly streams: Array<{ readonly path: string; readonly auth: string }>;
  /** Extra frames to write to every open event stream. */
  readonly push: (raw: string) => void;
  /** What GET /pane answers from now on. */
  readonly setPane: (pane: string) => void;
  close(): Promise<void>;
}

export const SESSION_NAME = "running-echo-hi-with-bash-tool";
export const BORN_AS = "snx6yhgaqn8a";

export async function startFakeLobby(options: {
  readonly identity: string;
  readonly secret: string;
  readonly fixture: string;
  /** What GET /pane answers for the session; 404 when absent. */
  readonly pane?: string;
  /** Device tokens accepted as `Authorization: Bearer`; live, so a test can revoke one. */
  readonly bearers?: ReadonlySet<string>;
}): Promise<FakeLobby> {
  const posts: Array<{ path: string; body: unknown }> = [];
  const opened: Array<{ path: string; auth: string }> = [];
  let pane = options.pane;
  const streams = new Set<ServerResponse>();
  const opening = readFileSync(
    new URL(`../fixtures/lobby/${options.fixture}`, import.meta.url),
    "utf8",
  );
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const admitted =
      bearer !== undefined
        ? options.bearers?.has(bearer) === true
        : req.headers["x-authentik-username"] === options.identity &&
          req.headers["x-tl-proxy-secret"] === options.secret;
    if (!admitted) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    const auth = bearer !== undefined ? `bearer:${bearer}` : `proxy:${options.identity}`;
    const url = new URL(req.url ?? "/", "http://x");
    const json = (body: unknown) =>
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method === "GET" && url.pathname === "/sessions") {
      return json([
        {
          id: "$224",
          name: SESSION_NAME,
          bornAs: BORN_AS,
          title: "Running echo hi with Bash tool",
          tool: "claude",
          origin: "user",
          owner: "wizard",
          state: "done",
          created: 1_791_794_216,
          lastDrive: 1_791_794_230,
        },
      ]);
    }
    if (req.method === "GET" && url.pathname === "/layout") {
      return json({
        version: 1,
        projects: [{ name: "lobby", sessions: [SESSION_NAME], dir: "/home/wizard/code/lobby" }],
        ungrouped: [],
      });
    }
    if (req.method === "GET" && url.pathname === `/events/${SESSION_NAME}`) {
      opened.push({ path: url.pathname + url.search, auth });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(url.searchParams.has("lastEventId") ? "" : opening);
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    if (req.method === "GET" && url.pathname === `/pane/${SESSION_NAME}` && pane !== undefined) {
      return json({ pane, state: "done" });
    }
    if (req.method === "POST") {
      let raw = "";
      req.on("data", (c: Buffer) => {
        raw += c.toString("utf8");
      });
      req.on("end", () => {
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
        posts.push({ path: url.pathname + url.search, body });
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(404).end("session not registered");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    posts,
    streams: opened,
    push: (raw) => {
      for (const s of streams) s.write(raw);
    },
    setPane: (next) => {
      pane = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of streams) s.end();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
