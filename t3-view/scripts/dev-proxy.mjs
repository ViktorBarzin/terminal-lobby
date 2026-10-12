#!/usr/bin/env node
// Plays Traefik in front of a local tl-t3-view, for driving the real T3 web
// client from a browser on this box:
//
//   node scripts/dev-proxy.mjs --listen 127.0.0.1:17691 --target 127.0.0.1:17690 \
//     --identity vbarzin --secret-file <mode-600 file holding TL_PROXY_SECRET>
//
// Every request and WebSocket upgrade is forwarded with the identity header
// and X-TL-Proxy-Secret set, and any copies the client sent are dropped, as the
// real middleware chain does. The secret is read from a file (never argv or
// the environment) and never logged. Options:
//   --header <name>   identity header (default: X-Authentik-Username)
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

function proxiedHeaders(incoming) {
  const headers = { ...incoming };
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (lower === identityHeader || lower === "x-tl-proxy-secret") delete headers[name];
  }
  headers[identityHeader] = values.identity;
  headers["x-tl-proxy-secret"] = secret;
  return headers;
}

const server = createServer((req, res) => {
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
  process.stderr.write(
    `dev-proxy: http://${values.listen} -> ${values.target} as ${values.identity} (${values.header})\n`,
  );
});
