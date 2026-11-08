import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CookiePusher,
  pushable,
  readHubConfig,
  writeSnapshot,
} from "../lib/cookiepush.mjs";

/** @typedef {import("../lib/cookiepush.mjs").Cookie} Cookie */

const NOW = 1_800_000_000_000;
const LATER = NOW / 1000 + 86_400;

/**
 * @param {Partial<Cookie>} c
 * @returns {Cookie}
 */
function cookie(c) {
  return {
    name: "sid",
    value: "v1",
    domain: ".example.com",
    path: "/",
    expires: LATER,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    ...c,
  };
}

/** @param {import("node:test").TestContext} t */
function tempHome(t) {
  const home = mkdtempSync(path.join(tmpdir(), "tl-cookiepush-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/**
 * @param {string} home
 * @param {Record<string, string>} hub
 */
function writeHub(home, hub) {
  mkdirSync(path.join(home, ".config", "chrome-hub"), { recursive: true });
  writeFileSync(path.join(home, ".config", "chrome-hub", "hub.json"), JSON.stringify(hub), {
    mode: 0o600,
  });
}

/**
 * A stand-in hub: records each POST and serves a snapshot.
 * @param {import("node:test").TestContext} t
 * @param {{ status?: number }} [opts]
 */
async function stubHub(t, opts = {}) {
  /** @type {{ auth: string | undefined, body: { source: string, cookies: Cookie[] } }[]} */
  const posts = [];
  /** @type {(string | undefined)[]} */
  const gets = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/cookies") {
        posts.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        res.writeHead(opts.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: 1, skipped: 0, rejected: 0, snapshot_cookies: 7 }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/snapshot") {
        gets.push(req.headers.authorization);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ cookies: [cookie({ name: "merged" })], origins: [] }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  t.after(() => server.close());
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    posts,
    gets,
    hub: {
      user: "tester",
      namespace: "chrome-test",
      snapshot_url: `${base}/api/snapshot`,
      cookies_url: `${base}/api/cookies`,
      broker_url: base,
      read_token: "read-tok",
      write_token: "write-tok",
    },
  };
}

test("pushable keeps persistent cookies for public domains only", () => {
  const keep = [
    cookie({ domain: ".example.com" }),
    cookie({ domain: "accounts.google.com", name: "a" }),
    cookie({ domain: "notviktorbarzin.me", name: "b" }),
  ];
  const drop = [
    cookie({ expires: -1, name: "session-only" }),
    cookie({ expires: NOW / 1000 - 1, name: "expired" }),
    cookie({ domain: "viktorbarzin.me" }),
    cookie({ domain: ".viktorbarzin.me" }),
    cookie({ domain: "authentik.viktorbarzin.me" }),
    cookie({ domain: "Pages.ViktorBarzin.ME" }),
    cookie({ domain: "router.lan" }),
    cookie({ domain: ".viktorbarzin.lan" }),
    cookie({ domain: "localhost" }),
    cookie({ domain: "app.localhost" }),
    cookie({ domain: "10.0.10.10" }),
    cookie({ domain: "127.0.0.1" }),
    cookie({ domain: "::1" }),
    cookie({ domain: "[::1]" }),
  ];
  assert.deepEqual(pushable([...keep, ...drop], NOW), keep);
});

test("readHubConfig is null for a missing or broken hub.json", (t) => {
  const home = tempHome(t);
  assert.equal(readHubConfig(home), null);
  mkdirSync(path.join(home, ".config", "chrome-hub"), { recursive: true });
  const file = path.join(home, ".config", "chrome-hub", "hub.json");
  writeFileSync(file, "{not json");
  assert.equal(readHubConfig(home), null);
  writeFileSync(file, JSON.stringify({ cookies_url: "http://x/api/cookies" }));
  assert.equal(readHubConfig(home), null, "a write token and snapshot url are needed");
  writeHub(home, {
    cookies_url: "http://x/api/cookies",
    snapshot_url: "http://x/api/snapshot",
    read_token: "r",
    write_token: "w",
  });
  assert.deepEqual(readHubConfig(home), {
    cookiesUrl: "http://x/api/cookies",
    snapshotUrl: "http://x/api/snapshot",
    readToken: "r",
    writeToken: "w",
  });
  if (process.getuid?.() !== 0) {
    chmodSync(file, 0o000);
    assert.equal(readHubConfig(home), null);
  }
});

test("without a hub.json nothing is read, sent or logged", async (t) => {
  const home = tempHome(t);
  /** @type {string[]} */
  const logs = [];
  let reads = 0;
  const pusher = new CookiePusher({ home, log: (m) => logs.push(m), now: () => NOW });
  const result = await pusher.push("periodic", async () => {
    reads++;
    return [cookie({})];
  });
  assert.equal(result, null);
  assert.equal(reads, 0);
  assert.deepEqual(logs, []);
});

test("a push sends changed cookies once, then refreshes the snapshot", async (t) => {
  const home = tempHome(t);
  const { posts, gets, hub } = await stubHub(t);
  writeHub(home, hub);
  /** @type {string[]} */
  const logs = [];
  const pusher = new CookiePusher({ home, log: (m) => logs.push(m), now: () => NOW });
  let jar = [cookie({}), cookie({ domain: "router.lan", name: "lan" })];
  const read = async () => jar;

  assert.deepEqual(await pusher.push("periodic", read), { sent: 1 });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].auth, "Bearer write-tok");
  assert.equal(posts[0].body.source, "tl-browser");
  assert.deepEqual(posts[0].body.cookies, [cookie({})]);
  assert.deepEqual(gets, ["Bearer read-tok"]);
  const snap = path.join(home, ".cache", "playwright-shared-storage-state.json");
  assert.equal(JSON.parse(readFileSync(snap, "utf8")).cookies[0].name, "merged");
  assert.equal(statSync(snap).mode & 0o777, 0o600);

  // Nothing changed: no request at all.
  assert.deepEqual(await pusher.push("periodic", read), { sent: 0 });
  assert.equal(posts.length, 1);
  assert.equal(gets.length, 1);

  // A new value, a new expiry and a new cookie go; the unchanged one does not.
  jar = [
    cookie({ value: "v2" }),
    cookie({ name: "other", expires: LATER + 10 }),
    cookie({ name: "third", path: "/x" }),
  ];
  await pusher.push("periodic", read);
  assert.equal(posts.length, 2);
  assert.deepEqual(
    posts[1].body.cookies.map((c) => `${c.name}=${c.value}`),
    ["sid=v2", "other=v1", "third=v1"],
  );
  jar = [cookie({ value: "v2" }), cookie({ name: "other", expires: LATER + 99 })];
  await pusher.push("periodic", read);
  assert.deepEqual(
    posts[2].body.cookies.map((c) => c.name),
    ["other"],
  );

  // The log has counts, never a value or a token.
  const all = logs.join("\n");
  assert.match(all, /sent 1/);
  assert.doesNotMatch(all, /v1|v2|write-tok|read-tok/);
});

test("a cookie in another partition is its own cookie", async (t) => {
  const home = tempHome(t);
  const { posts, hub } = await stubHub(t);
  writeHub(home, hub);
  const pusher = new CookiePusher({ home, log: () => {}, now: () => NOW });
  await pusher.push("periodic", async () => [cookie({})]);
  await pusher.push("periodic", async () => [
    cookie({}),
    cookie({ partitionKey: "https://top.example" }),
  ]);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].body.cookies, [cookie({ partitionKey: "https://top.example" })]);
});

test("a refused push is retried next time and the snapshot is left alone", async (t) => {
  const home = tempHome(t);
  const { posts, gets, hub } = await stubHub(t, { status: 500 });
  writeHub(home, hub);
  /** @type {string[]} */
  const logs = [];
  const pusher = new CookiePusher({ home, log: (m) => logs.push(m), now: () => NOW });
  assert.equal(await pusher.push("periodic", async () => [cookie({})]), null);
  assert.equal(await pusher.push("periodic", async () => [cookie({})]), null);
  assert.equal(posts.length, 2, "nothing was marked pushed, so it goes again");
  assert.equal(gets.length, 0);
  assert.match(logs.join("\n"), /500/);
});

test("an unreachable hub or a failing read is logged, never thrown", async (t) => {
  const home = tempHome(t);
  writeHub(home, {
    cookies_url: "http://127.0.0.1:1/api/cookies",
    snapshot_url: "http://127.0.0.1:1/api/snapshot",
    read_token: "r",
    write_token: "w",
  });
  /** @type {string[]} */
  const logs = [];
  const pusher = new CookiePusher({ home, log: (m) => logs.push(m), now: () => NOW });
  assert.equal(await pusher.push("periodic", async () => [cookie({})]), null);
  assert.equal(
    await pusher.push("periodic", async () => {
      throw new Error("Target closed");
    }),
    null,
  );
  assert.equal(logs.length, 2);
});

test("pushes overlap into one", async (t) => {
  const home = tempHome(t);
  const { posts, hub } = await stubHub(t);
  writeHub(home, hub);
  const pusher = new CookiePusher({ home, log: () => {}, now: () => NOW });
  let reads = 0;
  const read = async () => {
    reads++;
    return [cookie({})];
  };
  await Promise.all([pusher.push("periodic", read), pusher.push("freeze", read)]);
  assert.equal(reads, 1);
  assert.equal(posts.length, 1);
});

test("a large jar goes in batches under the hub's limits", async (t) => {
  const home = tempHome(t);
  const { posts, hub } = await stubHub(t);
  writeHub(home, hub);
  const pusher = new CookiePusher({ home, log: () => {}, now: () => NOW });
  const many = Array.from({ length: 3500 }, (_, i) => cookie({ name: `c${i}` }));
  assert.deepEqual(await pusher.push("periodic", async () => many), { sent: 3500 });
  assert.ok(posts.length >= 2);
  for (const p of posts) {
    assert.ok(p.body.cookies.length <= 3000);
    assert.ok(Buffer.byteLength(JSON.stringify(p.body)) <= 2_000_000);
  }
  assert.equal(
    posts.reduce((n, p) => n + p.body.cookies.length, 0),
    3500,
  );
});

test("writeSnapshot waits for the flock(1) the refresh script holds", async (t) => {
  const home = tempHome(t);
  const dest = path.join(home, ".cache", "playwright-shared-storage-state.json");
  mkdirSync(path.dirname(dest), { recursive: true });
  const holder = spawn("flock", [`${dest}.lock`, "sleep", "1"], { stdio: "ignore" });
  t.after(() => holder.kill());
  // Give flock a moment to take the lock first.
  await new Promise((r) => setTimeout(r, 200));
  const started = Date.now();
  await writeSnapshot(dest, '{"cookies":[],"origins":[]}');
  assert.ok(Date.now() - started >= 600, "it waited for the holder to let go");
  assert.equal(readFileSync(dest, "utf8"), '{"cookies":[],"origins":[]}');
  assert.equal(statSync(dest).mode & 0o777, 0o600);

  // And the lock is free again for the script.
  const after = spawn("flock", ["-n", `${dest}.lock`, "true"], { stdio: "ignore" });
  const code = await new Promise((resolve) => after.once("exit", resolve));
  assert.equal(code, 0);
});
