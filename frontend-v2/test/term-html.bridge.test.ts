import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { createRunAppCommand } from "../src/keybindings/commands";
import type { LobbyStore } from "../src/store/lobby";
import type { PaletteController } from "../src/keybindings/palette-controller";
import type { HelpController } from "../src/components/ShortcutsHelp";

/**
 * frontend/term.html ⟷ frontend-v2 BRIDGE contracts.
 *
 * term.html has no build step and therefore no test harness of its own, and the
 * two ends of its postMessage bridge live in different languages in different
 * files — which is exactly how Ctrl+J came to dead-end: the terminal page
 * swallowed the chord and forwarded a command name (`session.new.shell`) that
 * the v2 dispatcher had no branch for. These tests slice the shipped source and
 * run it, so the contract is checked rather than assumed.
 */

const TERM_HTML = resolve(__dirname, "../..", "frontend/term.html");
const html = (): string => readFileSync(TERM_HTML, "utf8");

/** The `const NAME = [ … ];` literal, sliced out of the page source. */
function sliceArrayLiteral(src: string, name: string): string {
  const decl = `const ${name} = [`;
  const start = src.indexOf(decl);
  expect(start, `${name} declaration`).toBeGreaterThan(-1);
  const end = src.indexOf("];", start);
  expect(end, `${name} terminator`).toBeGreaterThan(start);
  return src.slice(start, end + 2);
}

/** The source between a pair of `// >>> name` / `// <<< name` sentinels. */
function sliceKernel(src: string, name: string): string {
  const start = src.indexOf(`// >>> ${name}`);
  const end = src.indexOf(`// <<< ${name}`);
  expect(start, `opening ${name} sentinel`).toBeGreaterThan(-1);
  expect(end, `closing ${name} sentinel`).toBeGreaterThan(start);
  return src.slice(start, end);
}

interface AlwaysBinding {
  key: string;
  command: string;
  when?: string;
}

/** term.html's always-on binding table, evaluated for a non-Mac keyboard. */
function alwaysBindings(framed: boolean): AlwaysBinding[] {
  const src = sliceArrayLiteral(html(), "KB_ALWAYS_BINDINGS");
  return runInNewContext(`${src}; KB_ALWAYS_BINDINGS`, {
    IS_MAC: false,
    FRAMED_BY_LOBBY: framed,
  }) as AlwaysBinding[];
}

const jChord = (framed: boolean): AlwaysBinding | undefined =>
  alwaysBindings(framed).find((b) => b.key === "ctrl+j");

const noop = (): void => {};

describe("term.html — the framed Ctrl+J chord reaches the v2 dispatcher", () => {
  it("binds Ctrl+J only while a lobby owns the keys", () => {
    const j = jChord(true);
    expect(j, "an always-on ctrl+j binding").toBeDefined();
    // `lobbyOpen` is `isFramed` in term.html's TERMINAL-mode getContext, so a
    // bare deep-linked ?arg= tab never matches this chord and Ctrl+J stays the
    // LF byte it is in every other terminal.
    expect(j?.when).toBe("lobbyOpen && !galleryOpen");
  });

  it("keeps the scratch-shell-dock meaning when NOT framed", () => {
    // /term.html with no ?arg= is a lobby of its own (lobbyOpen: true, a dock,
    // and a `session.new.shell` branch in its own runAppCommand) and is served
    // to the stable tier from the same shared asset dir. Only the framed
    // meaning may change.
    expect(jChord(false)?.command).toBe("session.new.shell");
  });

  it("forwards a command the lobby dispatcher actually handles", () => {
    const j = jChord(true);
    // The framed meaning is the dock now: the v2 SPA grew one, so both lobbies
    // get the same command and Ctrl+J opens a shell from inside a session — the
    // only path it has, since a keydown in the frame never reaches the lobby's
    // own listener.
    expect(j?.command).toBe("session.new.shell");
    const toggleDock = vi.fn();
    const toggleView = vi.fn(() => true);
    const notify = vi.fn();
    const run = createRunAppCommand({
      store: {
        selected: () => null,
        model: () => [],
        sessions: [],
        select: noop,
        kill: noop,
        rename: noop,
      } as unknown as LobbyStore,
      palette: {
        isOpen: () => false,
        open: noop,
        close: noop,
        toggle: noop,
      } as unknown as PaletteController,
      help: { isOpen: () => false, open: noop, close: noop, toggle: noop } as HelpController,
      toggleSidebar: noop,
      focusNewSession: noop,
      notify,
      openGallery: noop,
      forwardToTerminal: () => false,
      pasteToTerminal: () => true,
      toggleDock,
      toggleView,
    });

    // Exactly what App.tsx does with a `tl-command` postMessage from the frame.
    run(j?.command ?? "");
    expect(toggleDock).toHaveBeenCalledTimes(1);
    expect(toggleView).not.toHaveBeenCalled();
  });
});

interface FitGuard {
  fit: () => boolean;
  owed: () => boolean;
}

/** term.html's fit guard, wired to a settable box and a counting fit. */
function loadFitGuard(box: { width: number; height: number }): {
  guard: FitGuard;
  fits: () => number;
} {
  let fits = 0;
  const src = sliceKernel(html(), "tl-fit-guard");
  const guard = runInNewContext(
    `${src}; createFitGuard(measure, doFit)`,
    { measure: () => box, doFit: () => void fits++ },
  ) as FitGuard;
  return { guard, fits: () => fits };
}

describe("term.html — a fit is never taken against a zero-size viewport", () => {
  // The v2 lobby keeps this iframe MOUNTED but display:none while its Text view
  // shows (SessionView's .tl-hidden). Fitting xterm against that 0x0 box yields
  // a ~13x7 grid, xterm emits it as a resize, and ttyd's tmux client drags the
  // REAL window — and every other client attached to it — down to 13 columns.
  it("skips the fit while the container has no box, and records one is owed", () => {
    const { guard, fits } = loadFitGuard({ width: 0, height: 0 });
    expect(guard.fit()).toBe(false);
    expect(fits()).toBe(0);
    expect(guard.owed()).toBe(true);
  });

  it("skips on a zero height alone (a collapsed row is still unmeasurable)", () => {
    const { guard, fits } = loadFitGuard({ width: 1180, height: 0 });
    expect(guard.fit()).toBe(false);
    expect(fits()).toBe(0);
  });

  it("fits — and clears the debt — once a real box exists", () => {
    const box = { width: 0, height: 0 };
    const { guard, fits } = loadFitGuard(box);
    guard.fit(); // hidden boot: skipped
    box.width = 1180;
    box.height = 814;
    expect(guard.fit()).toBe(true);
    expect(fits()).toBe(1);
    expect(guard.owed()).toBe(false);
  });

  it("routes EVERY fit through the guard — no bare fitAddon.fit() is left", () => {
    // Five call sites shared one unguarded fitAddon.fit(): the post-open boot
    // fit, the late-font refit, the debounced resize refit, the boot-end fit and
    // the prefs metric swap. Guarding one and leaving four is not a fix, so the
    // invariant is pinned as "the page calls fitAddon.fit() in exactly one
    // place" — inside the guard.
    const sites = html().match(/fitAddon\.fit\(\)/g) ?? [];
    expect(sites).toHaveLength(1);
  });
});

interface FramedChrome {
  FRAMED_CHROME_IDS: string[];
  hideFramedChrome: (doc: unknown, framed: boolean) => string[];
}

/** term.html's framed-chrome kernel + a fake document of the five buttons. */
function loadFramedChrome(): { kernel: FramedChrome; classes: Record<string, string[]> } {
  const src = sliceKernel(html(), "tl-framed-chrome");
  const kernel = runInNewContext(
    `${src}; ({ FRAMED_CHROME_IDS, hideFramedChrome })`,
    {},
  ) as FramedChrome;
  const classes: Record<string, string[]> = {};
  for (const id of kernel.FRAMED_CHROME_IDS) classes[id] = [];
  return { kernel, classes };
}

function fakeDoc(classes: Record<string, string[]>): {
  getElementById: (id: string) => { classList: { add: (c: string) => void } } | null;
} {
  return {
    getElementById: (id) =>
      classes[id]
        ? { classList: { add: (c: string) => void classes[id]!.push(c) } }
        : null,
  };
}

describe("term.html — the in-frame image/font cluster yields to the lobby's own", () => {
  it("hides the whole cluster when the v2 SPA is the frame", () => {
    const { kernel, classes } = loadFramedChrome();
    const hidden = kernel.hideFramedChrome(fakeDoc(classes), true);
    expect(hidden.sort()).toEqual(
      ["font-dec-btn", "font-inc-btn", "gallery-btn", "img-btn", "paste-btn"],
    );
    for (const id of kernel.FRAMED_CHROME_IDS) expect(classes[id]).toContain("hidden");
  });

  it("leaves a STANDALONE /term.html tab its only chrome", () => {
    const { kernel, classes } = loadFramedChrome();
    expect(kernel.hideFramedChrome(fakeDoc(classes), false)).toEqual([]);
    for (const id of kernel.FRAMED_CHROME_IDS) expect(classes[id]).toEqual([]);
  });
});

interface AttentionKernel {
  attentionHidden: () => boolean;
  setViewHidden: (v: boolean) => void;
  rearmHiddenOutput: () => void;
  noteHiddenOutput: () => void;
}

function loadAttentionKernel(): {
  kernel: AttentionKernel;
  doc: { hidden: boolean };
  signalled: string[];
} {
  const doc = { hidden: false };
  const signalled: string[] = [];
  const src = sliceKernel(html(), "tl-attention-kernel");
  const kernel = runInNewContext(
    `${src}; ({ attentionHidden, setViewHidden, rearmHiddenOutput, noteHiddenOutput })`,
    {
      document: doc,
      signalAttention: (kind: string) => signalled.push(kind),
    },
  ) as AttentionKernel;
  return { kernel, doc, signalled };
}

describe("term.html — output attention while the VIEW (not the tab) is hidden", () => {
  it("stays quiet while both the tab and the view are showing", () => {
    const { kernel, signalled } = loadAttentionKernel();
    kernel.noteHiddenOutput();
    expect(signalled).toEqual([]);
  });

  it("signals once per hidden period when the lobby CSS-hides the view", () => {
    const { kernel, signalled } = loadAttentionKernel();
    kernel.setViewHidden(true); // the SPA switched to its text view
    kernel.noteHiddenOutput();
    kernel.noteHiddenOutput();
    kernel.noteHiddenOutput();
    expect(signalled).toEqual(["output"]);
  });

  it("re-arms when the view comes back, so the next burst signals again", () => {
    const { kernel, signalled } = loadAttentionKernel();
    kernel.setViewHidden(true);
    kernel.noteHiddenOutput();
    kernel.setViewHidden(false); // back on the Terminal segment
    kernel.noteHiddenOutput(); // visible now — nothing to badge
    kernel.setViewHidden(true);
    kernel.noteHiddenOutput();
    expect(signalled).toEqual(["output", "output"]);
  });

  it("keeps the original tab-hidden behaviour", () => {
    const { kernel, doc, signalled } = loadAttentionKernel();
    doc.hidden = true;
    kernel.noteHiddenOutput();
    kernel.noteHiddenOutput();
    expect(signalled).toEqual(["output"]);
    doc.hidden = false;
    kernel.rearmHiddenOutput();
    doc.hidden = true;
    kernel.noteHiddenOutput();
    expect(signalled).toEqual(["output", "output"]);
  });

  it("stays armed on a tab return while the view is still hidden", () => {
    const { kernel, doc, signalled } = loadAttentionKernel();
    kernel.setViewHidden(true);
    doc.hidden = true;
    kernel.noteHiddenOutput();
    doc.hidden = false;
    kernel.rearmHiddenOutput(); // visibilitychange fires, but the view is hidden
    kernel.noteHiddenOutput();
    expect(signalled).toEqual(["output"]);
  });
});

/**
 * THE DEAD PATH: the tab going away while the view was ALREADY hidden.
 *
 * The lobby only latches its tab badge for a signal that arrives while the tab
 * is away — a signal sent while you are looking at the tab is dropped on the
 * floor. So when the view-hidden period opened with a frame of output (the
 * attach paint, or the redraw the view switch itself causes) the one-shot was
 * burned on a signal nobody could use, and every later output — including the
 * one that arrives after you tab away — was silent. The bell path always worked,
 * which is what made this look like "output attention is just broken".
 */
describe("term.html — the tab going away RE-ARMS an already-hidden view", () => {
  it("signals again when the tab hides on top of a spent view-hidden shot", () => {
    const { kernel, doc, signalled } = loadAttentionKernel();
    kernel.setViewHidden(true); // SPA shows its Text view
    kernel.noteHiddenOutput(); // the attach paint — lobby drops it (not away)
    expect(signalled).toEqual(["output"]);

    doc.hidden = true; // the user tabs away
    kernel.rearmHiddenOutput(); // visibilitychange
    kernel.noteHiddenOutput(); // `echo probe` lands in the pty
    expect(signalled).toEqual(["output", "output"]);
  });

  it("is still one signal per away period, not one per output frame", () => {
    const { kernel, doc, signalled } = loadAttentionKernel();
    kernel.setViewHidden(true);
    doc.hidden = true;
    kernel.rearmHiddenOutput();
    kernel.noteHiddenOutput();
    kernel.noteHiddenOutput();
    kernel.noteHiddenOutput();
    expect(signalled).toEqual(["output"]);
  });

  it("re-arms for the terminal view too (tab hides with the view on screen)", () => {
    const { kernel, doc, signalled } = loadAttentionKernel();
    doc.hidden = true;
    kernel.rearmHiddenOutput();
    kernel.noteHiddenOutput();
    doc.hidden = false;
    kernel.rearmHiddenOutput();
    doc.hidden = true;
    kernel.rearmHiddenOutput();
    kernel.noteHiddenOutput();
    expect(signalled).toEqual(["output", "output"]);
  });

  it("the visibilitychange listener re-arms on the way OUT as well as back", () => {
    // The handler used to `return` before re-arming whenever the tab was going
    // hidden, so becoming hidden could never open a new period.
    const src = html();
    // term.html has several visibilitychange listeners; this is the attention
    // one — the one that calls rearmHiddenOutput.
    const rearm = src.indexOf("rearmHiddenOutput();\n", src.indexOf("// <<< tl-attention-kernel"));
    expect(rearm, "the attention visibilitychange listener").toBeGreaterThan(-1);
    const start = src.lastIndexOf("document.addEventListener('visibilitychange'", rearm);
    expect(start, "its addEventListener").toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n        });", start));
    expect(body).toContain("rearmHiddenOutput();");
    expect(body).toContain("if (document.hidden) return;");
    expect(body.indexOf("rearmHiddenOutput();")).toBeLessThan(
      body.indexOf("if (document.hidden) return;"),
    );
  });
});

/** A `const NAME = <number>;` from the page source. */
function sliceNumberConst(src: string, name: string): number {
  const m = new RegExp(`const ${name} = (\\d+);`).exec(src);
  expect(m, `${name} declaration`).not.toBeNull();
  return Number(m![1]);
}

/** A top-level `function name(…) { … }` body, sliced by its 8-space indent. */
function sliceFunction(src: string, name: string): string {
  const start = src.indexOf(`        function ${name}(`);
  expect(start, `${name} declaration`).toBeGreaterThan(-1);
  const end = src.indexOf("\n        }", start);
  expect(end, `${name} terminator`).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** term.html's retry-delay picker, over a settable attempt count + onLine. */
function loadRetryDelay(): (attempts: number, onLine: boolean) => number {
  const src = html();
  return runInNewContext(
    `${sliceArrayLiteral(src, "RETRY_DELAYS_MS")}
     const OFFLINE_RETRY_MS = ${sliceNumberConst(src, "OFFLINE_RETRY_MS")};
     ${sliceKernel(src, "tl-retry-delay")}
     (function (a, o) { connAttempts = a; navigator.onLine = o; return nextRetryDelay(); })`,
    { navigator: { onLine: true }, connAttempts: 0 },
  ) as (attempts: number, onLine: boolean) => number;
}

/**
 * THE THUNDERING HERD: an outage ends for every client in the same instant.
 *
 * Unjittered rungs meant every open terminal — every tab, every phone — came
 * back at ttyd on the same millisecond, and a server that then struggles drops
 * them all again into the same next rung. And while the browser itself says
 * there is no network, the bottom rung was still burning a doomed attempt a
 * second, climbing the ladder out of usefulness before the network returned.
 */
describe("term.html — the reconnect ladder is jittered, and parks while offline", () => {
  it("spreads each rung across [delay/2, delay]", () => {
    const pick = loadRetryDelay();
    const rungs = [1000, 2000, 4000, 8000, 16000];
    rungs.forEach((rung, attempt) => {
      for (let i = 0; i < 50; i++) {
        const d = pick(attempt, true);
        expect(d, `attempt ${attempt}`).toBeGreaterThanOrEqual(rung / 2);
        expect(d, `attempt ${attempt}`).toBeLessThanOrEqual(rung);
      }
    });
  });

  it("actually varies — a fixed rung would defeat the whole point", () => {
    const pick = loadRetryDelay();
    const seen = new Set(Array.from({ length: 100 }, () => pick(0, true)));
    expect(seen.size).toBeGreaterThan(1);
  });

  it("holds the top rung past the end of the table", () => {
    const pick = loadRetryDelay();
    expect(pick(99, true)).toBeLessThanOrEqual(16000);
    expect(pick(99, true)).toBeGreaterThanOrEqual(8000);
  });

  it("parks on the long safety delay when the browser says there is no path", () => {
    const pick = loadRetryDelay();
    const offline = sliceNumberConst(html(), "OFFLINE_RETRY_MS");
    // Not jittered: this one is a safety net, not a rung — onLine lies true
    // behind a captive portal and some platforms never fire `online` at all,
    // so the tab must still be able to wake itself.
    expect(pick(0, false)).toBe(offline);
    expect(pick(4, false)).toBe(offline);
    expect(offline).toBeGreaterThan(16000);
  });
});

interface HeldInput {
  text: string;
  enter: boolean;
  since: number;
  offer(data: string): string;
  clear(): void;
  flush(send: (data: string) => void): string | null;
}

interface PendingEnv {
  hasConnectedOnce: boolean;
  batterySuspended: boolean;
}

/** term.html's held-input kernel, over a controllable clock. */
function loadHeldInput(env: Partial<PendingEnv> = {}): {
  q: HeldInput;
  sent: string[];
  tick: (ms: number) => void;
} {
  const sent: string[] = [];
  let clock = 1_000_000;
  const ctx = {
    hasConnectedOnce: env.hasConnectedOnce ?? true,
    batterySuspended: env.batterySuspended ?? false,
    console: { log: () => {} },
    Date: { now: () => clock },
    Intl,
  };
  const q = runInNewContext(
    `${sliceKernel(html(), "tl-pending-input")}; heldInput`,
    ctx,
  ) as HeldInput;
  return { q, sent, tick: (ms) => { clock += ms; } };
}

const DEL = "\x7f";
const CR = "\r";

/**
 * THE SWALLOWED KEYSTROKE, part two: the keys are held, and now they are
 * VISIBLE — so the hold no longer has to expire to stay safe.
 *
 * Before this, anything past PENDING_INPUT_TTL_MS was thrown away with a toast
 * ("what you typed while offline was discarded"), which is what a real drop —
 * a lift, a tube stop, a corp proxy mangling the WebSocket — always cost. The
 * text now survives any outage; only the trailing Enter is time-limited, since
 * running a command blind against a prompt that has moved on is the part that
 * cannot be taken back.
 */
describe("term.html — keys typed while the socket is down", () => {
  it("holds printable characters in order", () => {
    const { q } = loadHeldInput();
    for (const ch of "git commit") expect(q.offer(ch)).toBe("held");
    expect(q.text).toBe("git commit");
  });

  it("holds a bracketed paste as the text inside the wrapper", () => {
    const { q } = loadHeldInput();
    expect(q.offer("\x1b[200~npm run build\x1b[201~")).toBe("held");
    expect(q.text).toBe("npm run build");
  });

  it("refuses a paste carrying a newline — it would run blind on replay", () => {
    const { q } = loadHeldInput();
    expect(q.offer("\x1b[200~one\ntwo\x1b[201~")).toBe("refused:key");
    expect(q.text).toBe("");
  });

  it.each([
    ["Tab", "\t"],
    ["Ctrl-C", "\x03"],
    ["Ctrl-R", "\x12"],
    ["Up arrow", "\x1b[A"],
    ["Left arrow", "\x1b[D"],
    ["a bare Escape", "\x1b"],
  ])("refuses %s — only the pty can resolve it", (_label, bytes) => {
    const { q } = loadHeldInput();
    expect(q.offer(bytes)).toBe("refused:key");
    expect(q.text).toBe("");
  });

  it("pops exactly one held character per Backspace", () => {
    const { q } = loadHeldInput();
    for (const ch of "lsx") q.offer(ch);
    expect(q.offer(DEL)).toBe("popped");
    expect(q.text).toBe("ls");
  });

  it("pops a whole grapheme, not a code unit", () => {
    // An emoji is two code units; deleting half of one leaves a lone surrogate.
    const { q } = loadHeldInput();
    q.offer("hi 👋");
    expect(q.offer(DEL)).toBe("popped");
    expect(q.text).toBe("hi ");
  });

  it("refuses Backspace when nothing is held — it would blank a cell tmux drew", () => {
    const { q } = loadHeldInput();
    expect(q.offer(DEL)).toBe("refused:nothing-held");
  });

  it("closes the hold on Enter and refuses further keys", () => {
    const { q } = loadHeldInput();
    for (const ch of "ls") q.offer(ch);
    expect(q.offer(CR)).toBe("closed");
    expect(q.offer("x")).toBe("refused:closed");
    expect(q.text).toBe("ls");
  });

  it("reopens a closed hold on Backspace, so a reflex Enter is not a dead end", () => {
    const { q } = loadHeldInput();
    for (const ch of "ls") q.offer(ch);
    q.offer(CR);
    expect(q.offer(DEL)).toBe("reopened");
    expect(q.offer("x")).toBe("held");
    expect(q.text).toBe("lsx");
  });

  it("refuses Enter with nothing held", () => {
    const { q } = loadHeldInput();
    expect(q.offer(CR)).toBe("refused:nothing-held");
  });

  it("replays the text AND runs it when the gap was a blip", () => {
    const ttl = sliceNumberConst(html(), "PENDING_INPUT_TTL_MS");
    const { q, sent, tick } = loadHeldInput();
    for (const ch of "ls") q.offer(ch);
    q.offer(CR);
    tick(ttl - 1);
    expect(q.flush((d) => void sent.push(d))).toBe("ran");
    expect(sent).toEqual(["ls", CR]);
  });

  it("KEEPS the text past the window and drops only the Enter", () => {
    // The regression this whole change exists for: the text used to be
    // discarded outright once the gap outlived the replay window.
    const ttl = sliceNumberConst(html(), "PENDING_INPUT_TTL_MS");
    const { q, sent, tick } = loadHeldInput();
    for (const ch of "git commit") q.offer(ch);
    q.offer(CR);
    tick(ttl * 100); // a lift, a tube stop — minutes, not seconds
    expect(q.flush((d) => void sent.push(d))).toBe("held-enter");
    expect(sent).toEqual(["git commit"]);
    expect(q.text).toBe("");
  });

  it("replays a hold with no Enter as plain typing, however old", () => {
    const { q, sent, tick } = loadHeldInput();
    for (const ch of "cd /tmp") q.offer(ch);
    tick(600_000);
    expect(q.flush((d) => void sent.push(d))).toBe("typed");
    expect(sent).toEqual(["cd /tmp"]);
  });

  it("ages the Enter from the FIRST key, so a long burst cannot extend it", () => {
    const ttl = sliceNumberConst(html(), "PENDING_INPUT_TTL_MS");
    const { q, sent, tick } = loadHeldInput();
    q.offer("l");
    tick(ttl + 1);
    q.offer("s"); // still typing — but the window opened with the 'l'
    q.offer(CR);
    expect(q.flush((d) => void sent.push(d))).toBe("held-enter");
    expect(sent).toEqual(["ls"]);
  });

  it("caps the hold in BYTES and refuses rather than truncating", () => {
    const max = sliceNumberConst(html(), "PENDING_INPUT_MAX_BYTES");
    const { q } = loadHeldInput();
    expect(q.offer("a".repeat(max - 1))).toBe("held");
    expect(q.offer("é")).toBe("refused:full"); // 2 bytes into 1 byte of room
    expect(q.text.length).toBe(max - 1);
  });

  it("refuses to hold anything before a session has ever attached", () => {
    // Nothing to replay INTO: the pty does not exist yet, and the boot attach
    // is the one connect that always retries anyway.
    const { q } = loadHeldInput({ hasConnectedOnce: false });
    expect(q.offer("a")).toBe("refused:no-session");
    expect(q.text).toBe("");
  });

  it("refuses while the battery saver is holding the socket down", () => {
    const { q } = loadHeldInput({ batterySuspended: true });
    expect(q.offer("a")).toBe("refused:suspended");
  });

  it("clear() drops the text and the Enter together", () => {
    const { q, sent } = loadHeldInput();
    q.offer("a");
    q.offer(CR);
    q.clear();
    expect(q.text).toBe("");
    expect(q.enter).toBe(false);
    expect(q.flush((d) => void sent.push(d))).toBeNull();
    expect(sent).toEqual([]);
  });

  it("routes BOTH pty-bound input paths through the hold", () => {
    // sendInput and term.onBinary each had their own `if (!OPEN) return`.
    // Fixing one and leaving the other still eats paste and bracketed input.
    const src = html();
    expect(sliceFunction(src, "sendInput")).toContain("offerHeldInput(data)");
    const onBinary = src.slice(src.indexOf("term.onBinary("));
    expect(onBinary.slice(0, onBinary.indexOf("\n        });"))).toContain(
      "offerHeldInput(data)",
    );
  });

  it("flushes only after the init handshake and the resize have gone out", () => {
    const src = html();
    const open = src.slice(src.indexOf("ws.onopen = () => {"));
    const body = open.slice(0, open.indexOf("\n                    };"));
    expect(body.indexOf("ws.send(initMsg)")).toBeLessThan(body.indexOf("flushHeldInput()"));
    expect(body.indexOf("sendResize();")).toBeLessThan(body.indexOf("flushHeldInput()"));
  });

  it("clears the hold on the two states replay can never be safe from", () => {
    const src = html();
    // "Session ended." — there is no pty left to replay into. (Anchored on
    // the term.write, not the phrase: the phrase also appears in prose above.)
    const ended = src.indexOf("[33mSession ended.");
    expect(ended, "the Session ended. write").toBeGreaterThan(-1);
    expect(src.slice(ended - 400, ended)).toContain("discardHeldInput()");
    // A battery suspend lasts until the tab comes back: always stale.
    const suspend = sliceFunction(src, "suspendForBattery");
    expect(suspend).toContain("discardHeldInput()");
  });

  it("lets Esc discard the hold before the selection branch claims it", () => {
    // Both want Esc. While keys are held, discarding is the live intent — and
    // an Esc that reached the pty offline would only earn a refusal toast.
    const src = html();
    const handler = src.slice(src.indexOf("term.attachCustomKeyEventHandler("));
    const body = handler.slice(0, handler.indexOf("\n        });"));
    const discard = body.indexOf("discardHeldInput()");
    const selection = body.indexOf("clearSelectionBecause('Escape')");
    expect(discard, "the Esc discard branch").toBeGreaterThan(-1);
    expect(selection, "the Esc selection branch").toBeGreaterThan(-1);
    expect(discard).toBeLessThan(selection);
  });

  it("watches for an echo after every keystroke that goes out", () => {
    // A black-holed socket stays OPEN for LIVENESS_STRIKES × LIVENESS_PROBE_MS
    // (~75s) before the watchdog notices, and every key typed into that window
    // is lost with the pill still reading connected. Typing is the cheapest
    // possible trigger for the probe that already exists.
    const src = html();
    expect(sliceFunction(src, "sendInput")).toContain("armEchoWatch()");
    const output = src.slice(src.indexOf("case MSG_OUTPUT:"));
    expect(output.slice(0, output.indexOf("break;"))).toContain("noteEchoSeen()");
    expect(sliceFunction(src, "armEchoWatch")).toContain("runLivenessProbe()");
  });
});

/**
 * THE FROZEN-BUT-OPEN SOCKET: the signature mobile failure.
 *
 * ttyd's -P 30 keepalive runs server-to-client and the browser hides ping and
 * pong, so a black-holed path leaves readyState === OPEN forever with no
 * onclose to start the ladder. And a silence rule cannot stand in for one — an
 * idle terminal is legitimately quiet for hours — so the page has to probe.
 */
describe("term.html — the socket has to prove it is alive", () => {
  it("probes with a ttyd INPUT frame carrying NO payload", () => {
    // A probe with a payload would be typed into whatever is at the prompt.
    // Zero-length is a verified no-op in ttyd 1.7.7: protocol.c's INPUT case
    // hands pty_write a zero-length buffer, so no byte reaches the pty.
    const src = html();
    expect(src).toMatch(
      /const WS_PROBE_FRAME = Uint8Array\.of\(MSG_INPUT\.charCodeAt\(0\)\)\.buffer;/,
    );
    expect(src).toMatch(/const MSG_INPUT\s+= '0';/);
  });

  it("judges reachability on a response of ANY status, not on an ok one", () => {
    // A 500 from a briefly unhappy ttyd still proves the path carries packets;
    // treating it as death would reconnect a perfectly good socket.
    const probe = sliceFunction(html(), "runLivenessProbe");
    expect(probe).toContain("cache: 'no-store'");
    expect(probe).toContain(".then(() => true, () => false)");
    expect(probe).not.toContain(".ok");
  });

  it("holds its verdict when the tab is hidden at either end of a probe", () => {
    // Background throttling manufactures both symptoms — a stalled fetch and a
    // frozen buffer — on a socket that is fine.
    const probe = sliceFunction(html(), "runLivenessProbe");
    expect(probe).toContain("if (batterySuspended || document.hidden) return;");
    expect(probe).toContain("if (document.hidden) return;");
  });

  it("needs repeated failures before it drops a live-looking socket", () => {
    const src = html();
    expect(sliceNumberConst(src, "LIVENESS_STRIKES")).toBeGreaterThanOrEqual(2);
    const failed = sliceFunction(src, "livenessFailed");
    expect(failed).toContain("if (livenessStrikes < LIVENESS_STRIKES) return;");
    // And it must go out through the same door as a real close, or a session
    // killed elsewhere gets resurrected by `tmux new-session -A`.
    expect(failed).toContain("reconnectAfterDrop()");
  });

  it("runs only between an open socket and its teardown", () => {
    const src = html();
    expect(sliceFunction(src, "abandonAttempt")).toContain("stopLivenessProbe()");
    const open = src.slice(src.indexOf("ws.onopen = () => {"));
    expect(open.slice(0, open.indexOf("\n                    };"))).toContain("startLivenessProbe()");
    const close = src.slice(src.indexOf("ws.onclose = () => {"));
    expect(close.slice(0, close.indexOf("\n                    };"))).toContain("stopLivenessProbe()");
  });
});

/**
 * THE UNBOUNDED ATTEMPT: a connect that can hang for minutes.
 *
 * /token had no deadline and the WS handshake had none either, so a half-open
 * path parked the page on "Connecting…" with no ladder behind it. The instant
 * retries could not rescue it: retryNow started with `if (!retryTimer) return`
 * and an in-flight attempt leaves no timer, so `back online` and `tab visible`
 * were no-ops in exactly the case they exist for.
 */
describe("term.html — both hops of a connect are bounded", () => {
  it("gives the /token fetch an abort signal and a deadline", () => {
    const src = html();
    expect(src).toContain("fetch(tokenUrl, { credentials: 'same-origin', signal: ctrl.signal })");
    expect(sliceNumberConst(src, "TOKEN_TIMEOUT_MS")).toBeGreaterThan(0);
    expect(src).toContain("}, TOKEN_TIMEOUT_MS);");
  });

  it("gives the handshake a deadline, and clears it on both exits", () => {
    const src = html();
    expect(sliceNumberConst(src, "WS_OPEN_TIMEOUT_MS")).toBeGreaterThan(0);
    expect(src).toContain("if (!ws || ws.readyState !== WebSocket.CONNECTING) return;");
    // abandonAttempt + onopen + onclose: a deadline left armed would tear down
    // the NEXT socket.
    expect(src.match(/clearTimeout\(handshakeTimer\)/g) ?? []).toHaveLength(3);
  });

  it("lets an instant retry abandon a stalled attempt, not just a pending timer", () => {
    const retry = sliceFunction(html(), "retryNow");
    expect(retry).not.toContain("if (!retryTimer) return;");
    expect(retry).toContain("connAbort !== null");
    expect(retry).toContain("WebSocket.CONNECTING");
  });

  it("leaves a healthy open socket alone", () => {
    // `tab visible` fires on every app switch; reconnecting a live terminal
    // each time would cost a repaint for nothing.
    const retry = sliceFunction(html(), "retryNow");
    expect(retry).toContain("if (!pending && !inFlight) return;");
  });

  it("stamps every attempt with a generation, so a late reply cannot land", () => {
    const src = html();
    expect(sliceFunction(src, "abandonAttempt")).toContain("connGen++");
    // The token resolution, the handshake deadline, the watchdog verdict and
    // the kill-guard check all re-read it before acting.
    expect(src.match(/gen !== connGen/g) ?? []).toHaveLength(5);
  });
});

/**
 * The framed terminal must not paint its own slow-request warning: the lobby
 * runs the same coordinator over its own requests and owns the notification
 * surface, so painting in both put two "Some requests are slow" toasts on
 * screen at once, with different counts, for one condition.
 */
describe("term.html — one slow-request surface, not two", () => {
  const src = (): string => readFileSync(TERM_HTML, "utf8");

  it("stands down while framed, and still paints in a standalone tab", () => {
    const repaint = src().slice(src().indexOf("function repaint()"));
    expect(repaint.slice(0, 800)).toContain("window.parent !== window");
  });

  it("keeps telemetry out of the tracker entirely", () => {
    // fire-and-forget: the user cannot act on a slow beacon, and its own
    // module swallows failures by design.
    expect(src()).toMatch(/\/\\\/telemetry\$\/|\/telemetry\$\//);
  });
});

/**
 * The soft keyboard, across the frame boundary.
 *
 * BUG (mobile, reported 2026-08-17): tapping the terminal to raise the keyboard
 * made it flash open and shut, unless the tap was in the upper half of the
 * screen. A terminal tap focuses the ghost mirror field INSIDE this iframe; the
 * keyboard then opened, and the lobby reserved room for it by shrinking
 * `.tl-views` — the iframe's own container — by the keyboard's height. The tap's
 * delayed compat mousedown was then hit-tested where the finger had been, which
 * was no longer the iframe but a non-focusable shell element, and a mousedown
 * there blurs the focused field. Measured on a 390x844 phone: the container's
 * bottom edge jumped 793 -> 457, so every tap below ~54% of the screen lost its
 * keyboard.
 *
 * The fix moves the reservation INSIDE the frame: the lobby forwards the
 * keyboard height (tl-kb) and stops shrinking the container, so the iframe
 * element never moves out from under the tap while the terminal still ends up
 * above the keyboard.
 */
type KbReserveFn = (
  innerH: number,
  vvH: number,
  vvTop: number,
  forwarded: number,
) => { offset: number; shrink: number };

function loadKbReserve(): KbReserveFn {
  const src = sliceKernel(html(), "tl-kb-reserve");
  return runInNewContext(`${src}; keyboardReserve`, {}) as KbReserveFn;
}

describe("term.html — keyboard reservation, framed and standalone", () => {
  it("STANDALONE: believes its own viewport, and never double-subtracts it", () => {
    // A phone on term.html directly: visualViewport DOES shrink, so vvH already
    // excludes the keyboard. Lift the fixed accessories by it — but take
    // nothing further off the terminal, or the page leaves a keyboard-sized
    // gap under it.
    const r = loadKbReserve()(844, 508, 0, 0);
    expect(r.offset).toBe(336);
    expect(r.shrink).toBe(0);
  });

  it("FRAMED: an iframe's visualViewport does not see the keyboard, so it takes the forwarded height", () => {
    // The iframe's own reading is 0 (its viewport did not change); the lobby
    // forwards the real height, which must come off the terminal here because
    // nothing else has accounted for it.
    const r = loadKbReserve()(844, 844, 0, 336);
    expect(r.offset).toBe(336);
    expect(r.shrink).toBe(336);
  });

  it("no keyboard at all leaves both at zero", () => {
    const r = loadKbReserve()(844, 844, 0, 0);
    expect(r).toEqual({ offset: 0, shrink: 0 });
  });

  it("never returns a negative reserve", () => {
    // vvH can exceed innerHeight mid-rotation, and a forwarded value arriving
    // from another document is untrusted arithmetic.
    const r = loadKbReserve()(844, 900, 0, -50);
    expect(r.offset).toBe(0);
    expect(r.shrink).toBe(0);
  });

  it("takes the larger of the two rather than adding them", () => {
    // Both readings describe the SAME keyboard. Summing would lift the bar
    // twice as far as the keyboard is tall.
    const r = loadKbReserve()(844, 600, 0, 200);
    expect(r.offset).toBe(244);
  });
});

describe("term.html — the tl-kb bridge", () => {
  it("handles a tl-kb message from the lobby", () => {
    expect(html()).toContain("'tl-kb'");
  });

  it("re-syncs the viewport when one arrives, so the change is painted", () => {
    // Scoped to the branch rather than a byte count: the branch carries a long
    // comment, and a fixed window would fail on the prose instead of the code.
    const src = html();
    const at = src.indexOf("e.data.type === 'tl-kb'");
    expect(at).toBeGreaterThan(-1);
    const next = src.indexOf("} else if", at);
    expect(next).toBeGreaterThan(at);
    const branch = src.slice(at, next);
    expect(branch).toContain("syncViewport");
    // Parent-only, like every other bridge message.
    expect(branch).toContain("e.source === window.parent");
  });
});
