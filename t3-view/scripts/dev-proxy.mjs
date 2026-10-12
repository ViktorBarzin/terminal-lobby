#!/usr/bin/env node
// Plays Traefik in front of a local tl-t3-view, for driving the real T3 web
// client from a browser on this box:
//
//   node scripts/dev-proxy.mjs --listen 127.0.0.1:17691 --target 127.0.0.1:17690 \
//     --identity vbarzin --secret-file <mode-600 file holding TL_PROXY_SECRET>
//
// then open the ?token= link it prints.
//
// Every request and WebSocket upgrade is forwarded with the identity header
// and X-TL-Proxy-Secret set, and any copies the client sent are dropped, as the
// real middleware chain does. The secret is read from a file (never argv or
// the environment) and never logged. Options:
//   --header <name>   identity header (default: X-Authentik-Username)
//
// Loopback is reachable by every OS user on the devvm, and whoever gets
// through acts as --identity with the real secret. So the proxy mints a
// random token at startup and prints a link carrying it, once, on stderr.
// Opening the link trades the token for an HttpOnly cookie; every request and
// upgrade without that cookie gets 401 and is never forwarded.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    listen: { type: "string" },
    target: { type: "string" },
    identity: { type: "string" },
    "secret-file": { type: "string" },
    header: { type: "string", default: "X-Authentik-Username" },
  },
});
for (const key of ["listen", "target", "identity", "secret-file"]) {
  if (!values[key]) {
    process.stderr.write(`dev-proxy: --${key} is required\n`);
    process.exit(2);
  }
}

const split = (hostPort) => {
  const at = hostPort.lastIndexOf(":");
  return { host: hostPort.slice(0, at), port: Number(hostPort.slice(at + 1)) };
};
const listen = split(values.listen);
const target = split(values.target);
const secret = readFileSync(values["secret-file"], "utf8").trim();
const identityHeader = values.header.toLowerCase();
const token = randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest();
const tokenDigest = digest(token);
const matchesToken = (value) =>
  typeof value === "string" && timingSafeEqual(digest(value), tokenDigest);
// Cookies are scoped by host, not port: name it after the port so two
// proxies on one box do not overwrite each other's.
let cookieName = "tl_dev_proxy";

/** The request's cookie pairs, split into ours and the rest. */
function readCookies(header) {
  let ours;
  const rest = [];
  for (const pair of (header ?? "").split(";")) {
    const trimmed = pair.trim();
    if (trimmed === "") continue;
    const at = trimmed.indexOf("=");
    if (at > 0 && trimmed.slice(0, at) === cookieName) ours = trimmed.slice(at + 1);
    else rest.push(trimmed);
  }
  return { ours, rest };
}

const authorized = (req) => matchesToken(readCookies(req.headers.cookie).ours);

function proxiedHeaders(incoming) {
  const headers = { ...incoming };
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (lower === identityHeader || lower === "x-tl-proxy-secret") delete headers[name];
  }
  const { rest } = readCookies(incoming.cookie);
  if (rest.length > 0) headers.cookie = rest.join("; ");
  else delete headers.cookie;
  headers[identityHeader] = values.identity;
  headers["x-tl-proxy-secret"] = secret;
  return headers;
}

const server = createServer((req, res) => {
  if (!authorized(req)) {
    const url = new URL(req.url ?? "/", "http://dev-proxy");
    if (!matchesToken(url.searchParams.get("token") ?? undefined)) {
      res
        .writeHead(401, { "content-type": "text/plain" })
        .end("dev-proxy: open the link it printed\n");
      return;
    }
    url.searchParams.delete("token");
    res
      .writeHead(302, {
        location: url.pathname + url.search,
        "set-cookie": `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`,
      })
      .end();
    return;
  }
  const upstream = httpRequest(
    { ...target, method: req.method, path: req.url, headers: proxiedHeaders(req.headers) },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    res.writeHead(502).end(`dev-proxy: ${error.message}`);
  });
  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  if (!authorized(req)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstream = connect(target.port, target.host, () => {
    const headers = proxiedHeaders(req.headers);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", close);
  socket.on("error", close);
});

server.listen(listen.port, listen.host, () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : listen.port;
  cookieName = `tl_dev_proxy_${port}`;
  process.stderr.write(
    `dev-proxy: ${listen.host}:${port} -> ${values.target} as ${values.identity} (${values.header})\n` +
      `dev-proxy: open http://${listen.host}:${port}/?token=${token}\n`,
  );
});
