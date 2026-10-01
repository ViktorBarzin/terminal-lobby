import assert from "node:assert/strict";
import { test } from "node:test";
import { OPT_SOCK, OPT_STATE, TmuxRegistration } from "../lib/tmux.mjs";

/**
 * Plays tmux for one session's options, shared by every registration made
 * from it, the way two hosts in one session share them.
 */
function fakeTmux() {
  /** @type {Map<string, string>} */
  const opts = new Map();
  /** @type {string[][]} */
  const calls = [];
  /** @param {string[]} args */
  const exec = (args) => {
    calls.push(args);
    if (args[0] === "show-options") return opts.has(args[4]) ? `${opts.get(args[4])}\n` : null;
    if (args[0] === "set-option" && args[1] === "-u") {
      opts.delete(args[4]);
      return "";
    }
    if (args[0] === "set-option") {
      opts.set(args[3], args[4]);
      return "";
    }
    if (args[0] === "display-message") return "$12\n";
    return null;
  };
  return {
    opts,
    calls,
    runner: { run: async (/** @type {string[]} */ a) => exec(a), runSync: exec },
  };
}

test("registering records the socket and the state on the session", async () => {
  const tm = fakeTmux();
  const reg = new TmuxRegistration("%7", tm.runner);
  await reg.register("/run/user/1000/tl-browser/s12.sock");
  assert.equal(tm.opts.get(OPT_SOCK), "/run/user/1000/tl-browser/s12.sock");
  assert.equal(tm.opts.get(OPT_STATE), "live");
  for (const c of tm.calls) if (c[0] !== "show-options") assert.equal(c[c.indexOf("-t") + 1], "%7");
});

test("a host clears the options when they are its own", async () => {
  const tm = fakeTmux();
  const reg = new TmuxRegistration("%7", tm.runner);
  await reg.register("/run/user/1000/tl-browser/s12.sock");
  reg.clearSync();
  assert.equal(tm.opts.size, 0);
});

// Two Claudes in one tmux session: the second host registered last, so the
// options name its socket. The first one exiting must not hide the second's
// browser from the lobby, and its freezes must not mislabel it.
test("a host leaves another live host's options alone", async () => {
  const tm = fakeTmux();
  const first = new TmuxRegistration("%7", tm.runner);
  const second = new TmuxRegistration("%8", tm.runner);
  await first.register("/run/user/1000/tl-browser/s12.sock");
  await second.register("/run/user/1000/tl-browser/s12-5151.sock");

  await first.setState("frozen");
  assert.equal(tm.opts.get(OPT_STATE), "live");

  first.clearSync();
  assert.equal(tm.opts.get(OPT_SOCK), "/run/user/1000/tl-browser/s12-5151.sock");
  assert.equal(tm.opts.get(OPT_STATE), "live");
});

test("a host reclaims options nobody holds when its state changes", async () => {
  const tm = fakeTmux();
  const first = new TmuxRegistration("%7", tm.runner);
  const second = new TmuxRegistration("%8", tm.runner);
  await first.register("/run/user/1000/tl-browser/s12.sock");
  await second.register("/run/user/1000/tl-browser/s12-5151.sock");
  second.clearSync();
  assert.equal(tm.opts.size, 0);

  await first.setState("frozen");
  assert.equal(tm.opts.get(OPT_SOCK), "/run/user/1000/tl-browser/s12.sock");
  assert.equal(tm.opts.get(OPT_STATE), "frozen");
});

test("a host updates its own state", async () => {
  const tm = fakeTmux();
  const reg = new TmuxRegistration("%7", tm.runner);
  await reg.register("/run/user/1000/tl-browser/s12.sock");
  await reg.setState("frozen");
  assert.equal(tm.opts.get(OPT_STATE), "frozen");
});

test("a host that never registered clears nothing", () => {
  const tm = fakeTmux();
  tm.opts.set(OPT_SOCK, "/run/user/1000/tl-browser/s12-5151.sock");
  tm.opts.set(OPT_STATE, "live");
  new TmuxRegistration("%7", tm.runner).clearSync();
  assert.equal(tm.opts.size, 2);
});

test("outside tmux nothing is called", async () => {
  const tm = fakeTmux();
  const reg = new TmuxRegistration(undefined, tm.runner);
  await reg.register("/tmp/tl-browser-1000/pid-1.sock");
  await reg.setState("frozen");
  reg.clearSync();
  assert.equal(await reg.sessionId(), null);
  assert.deepEqual(tm.calls, []);
});
