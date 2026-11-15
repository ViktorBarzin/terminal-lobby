// The virtual screen the session's Chrome draws on. Chrome runs headed, not
// headless: Cloudflare Turnstile rejects headless Chrome with error 600010
// however it is dressed (a normal user agent and the stealth patches did not
// help, measured 2026-11-15), and passes the same Chrome headed under Xvfb.
// Each host starts its own Xvfb, so no two sessions share a screen.

import { spawn as nodeSpawn } from "node:child_process";

/** The virtual screen: room for a 1280x800 page plus Chrome's own toolbar. */
export const SCREEN = { width: 1920, height: 1080 };

/** How long Xvfb may take to report its display before the host goes headless. */
const START_TIMEOUT_MS = 5000;

/**
 * Headed is the default. Only an explicit TL_BROWSER_HEADLESS=1 asks for
 * headless, for a box without Xvfb or a check of the old behaviour.
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function headlessForced(env) {
  return env.TL_BROWSER_HEADLESS === "1";
}

/**
 * -displayfd makes Xvfb pick a free display and write its number to fd 3, so
 * concurrent hosts never race for one. -terminate ends it when its last
 * client goes, so a host killed outright leaves no Xvfb behind: Chrome exits
 * with the host's pipe, and Xvfb follows Chrome.
 * @param {{ width: number, height: number }} size
 * @returns {string[]}
 */
export function xvfbArgs({ width, height }) {
  return [
    "-displayfd",
    "3",
    "-screen",
    "0",
    `${width}x${height}x24`,
    "-nolisten",
    "tcp",
    "-terminate",
  ];
}

/**
 * @typedef {{ display: string, pid: number, stop: () => void }} Display
 */

/**
 * Starts an Xvfb. Resolves null when there is none to start or it never
 * reports a display, so the caller falls back to headless.
 * @param {{ width: number, height: number }} size
 * @param {{ spawn?: typeof nodeSpawn, timeoutMs?: number, log?: (msg: string) => void }} [o]
 * @returns {Promise<Display | null>}
 */
export function startDisplay(size, o = {}) {
  const spawn = o.spawn ?? nodeSpawn;
  const timeoutMs = o.timeoutMs ?? START_TIMEOUT_MS;
  const log = o.log ?? (() => {});
  return new Promise((resolve) => {
    /** @type {import("node:child_process").ChildProcess} */
    let child;
    try {
      child = spawn("Xvfb", xvfbArgs(size), { stdio: ["ignore", "ignore", "pipe", "pipe"] });
    } catch (err) {
      log(`no Xvfb (${err instanceof Error ? err.message : String(err)}); running headless`);
      resolve(null);
      return;
    }
    let settled = false;
    let out = "";
    let errText = "";
    /** @param {Display | null} d */
    const finish = (d) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(d);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      log(`Xvfb reported no display in ${timeoutMs} ms; running headless. ${errText.trim()}`);
      finish(null);
    }, timeoutMs);
    child.on("error", (err) => {
      log(`no Xvfb (${err.message}); running headless`);
      finish(null);
    });
    child.on("exit", (code) => {
      if (!settled) log(`Xvfb exited with ${code} before reporting a display. ${errText.trim()}`);
      finish(null);
    });
    child.stdio[2]?.on("data", (chunk) => {
      if (errText.length < 4096) errText += String(chunk);
    });
    child.stdio[3]?.on("data", (chunk) => {
      out += String(chunk);
      const m = /^(\d+)\n/.exec(out);
      if (!m) return;
      finish({
        display: `:${m[1]}`,
        pid: child.pid ?? 0,
        stop: () => {
          if (child.exitCode === null) child.kill("SIGTERM");
        },
      });
    });
  });
}
