/**
 * DOCS ⟷ CODE truth for frontend-v2.
 *
 * This README has drifted in BOTH directions, and both directions cost real
 * work:
 *
 *   - Shipped subsystems described as unbuilt. Gallery, command palette, the
 *     keybinding engine, PWA/SW, soft-keys and the Terminal view all sat under
 *     "Foundation stubs / follow-ups" long after they landed. That is not
 *     cosmetic: `public/sw.js` carries an explicit "a fetch listener is
 *     FORBIDDEN here" comment because a caching worker would serve a stale app
 *     across deploys — a contributor who reads "PWA/SW — later phase" and goes
 *     and writes one breaks the deploy path.
 *   - Deleted features described as live. `575d4f5` removed the web-mediated
 *     permission broker server-side, while the README, the vite dev proxy and
 *     the endpoint helper all kept presenting `POST /permission/<id>` as a
 *     working route.
 *
 * So every assertion below is derived from CODE on both sides — session-events'
 * own route table, the files on disk, the proxy record — never from a second
 * copy of the prose. Delete a subsystem and its row relaxes on its own; add a
 * server route and the doc is allowed to mention it again.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const FE = (p: string): string => resolve(__dirname, "..", p);
const REPO = (p: string): string => resolve(__dirname, "../..", p);

const README = readFileSync(FE("README.md"), "utf8");
const VITE_CONFIG = readFileSync(FE("vite.config.ts"), "utf8");
const CONFIG_TS = readFileSync(FE("src/lib/config.ts"), "utf8");
const MAIN_GO = readFileSync(REPO("session-events/main.go"), "utf8");

/** Every first capture group of `re` in `text`. */
function captures(re: RegExp, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const group = m[1];
    if (group !== undefined) out.push(group);
  }
  return out;
}

/**
 * The root paths session-events actually registers, parsed from its mux
 * registrations. Wildcards (`{session}`) are stripped so `/events/{session}`
 * reads as the route prefix `/events`; the bare `/` catch-all mount is not a
 * route of its own.
 */
function servedRoutes(): Set<string> {
  const out = new Set<string>();
  for (const p of captures(/Handle(?:Func)?\(\s*"(?:[A-Z]+ )?(\/[^"]*)"/g, MAIN_GO)) {
    const route = p.replace(/\{[^}]*\}/g, "").replace(/\/+$/, "");
    if (route !== "") out.add(route);
  }
  return out;
}

/** The path prefixes the vite dev proxy forwards to session-events. */
function proxiedToSessionEvents(): string[] {
  return captures(/"(\/[a-z0-9/-]+)":\s*sessionEventsProxy\b/g, VITE_CONFIG);
}

/** Every prefix the dev proxy handles, whatever its target. */
function proxiedPrefixes(): string[] {
  const body = VITE_CONFIG.slice(
    VITE_CONFIG.indexOf("const proxy: Record<string, ProxyOptions>"),
  );
  return captures(/^ {2}"(\/[a-z0-9/-]+)":/gm, body);
}

interface Helper {
  readonly name: string;
  readonly path: string;
  readonly deprecated: boolean;
}

/**
 * The exported URL builders in `lib/config.ts` that target session-events —
 * identified by their own doc comment naming the service — paired with the root
 * path each one builds.
 */
function sessionEventsHelpers(): Helper[] {
  const out: Helper[] = [];
  const re = /\/\*\*([\s\S]*?)\*\/\s*export function (\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g;
  for (const m of CONFIG_TS.matchAll(re)) {
    const [, doc, name, body] = m;
    if (doc === undefined || name === undefined || body === undefined) continue;
    if (!/session-events/.test(doc)) continue;
    const path = body.match(/\$\{API_BASE\}(\/[a-z0-9-]+)/)?.[1];
    if (path !== undefined) out.push({ name, path, deprecated: /@deprecated/.test(doc) });
  }
  return out;
}

const SERVED = servedRoutes();

describe("session-events endpoints — the docs may only present a SERVED route", () => {
  it("parses a non-empty route table out of session-events/main.go", () => {
    // Guards the parser itself: an unparsed main.go would make every check
    // below vacuously strict, not vacuously loose, but it would still lie.
    expect([...SERVED].sort()).toContain("/events");
    expect(SERVED.size).toBeGreaterThanOrEqual(4);
  });

  it("the vite dev proxy forwards only routes session-events serves", () => {
    // The dev proxy is a stand-in for the prod ingress. A prefix it forwards
    // that the service does not register is a dead route in local dev too.
    for (const prefix of proxiedToSessionEvents()) {
      expect(
        [...SERVED].sort(),
        `vite.config.ts forwards ${prefix} to session-events, which does not serve it`,
      ).toContain(prefix);
    }
  });

  it("every client URL helper targets a served route, or is marked @deprecated", () => {
    const helpers = sessionEventsHelpers();
    expect(helpers.map((h) => h.name)).toContain("eventsUrl");
    for (const h of helpers) {
      if (SERVED.has(h.path)) continue;
      expect(
        h.deprecated,
        `config.ts ${h.name}() builds ${h.path}, which session-events does not serve — ` +
          `either the route is back (unmark it) or the helper needs an @deprecated note`,
      ).toBe(true);
    }
  });

  it("the README names no session-events path the service does not serve", () => {
    // Vocabulary = every session-events path this app knows about, from either
    // side. A dead one must not appear in the docs at all: naming it is how it
    // gets re-adopted. Record removals against the commit, not the path.
    const vocabulary = new Set([...SERVED, ...sessionEventsHelpers().map((h) => h.path)]);
    for (const path of vocabulary) {
      if (SERVED.has(path)) continue;
      expect(README, `frontend-v2/README.md still names the dead route ${path}`).not.toContain(
        path,
      );
    }
  });
});

interface Shipped {
  /** What the README calls it. */
  readonly named: RegExp;
  /** Files whose presence proves it ships. */
  readonly proof: readonly string[];
}

/**
 * Subsystems that are BUILT. Each row is anchored to files, so removing a
 * subsystem removes the obligation instead of leaving a rule to argue with.
 */
const SHIPPED: readonly Shipped[] = [
  { named: /\bgallery\b/i, proof: ["src/components/Gallery.tsx", "src/store/gallery.ts"] },
  {
    named: /command palette/i,
    proof: ["src/components/CommandPalette.tsx", "src/keybindings/palette-controller.ts"],
  },
  {
    named: /keybinding/i,
    proof: ["src/keybindings/engine.ts", "src/keybindings/bindings.logic.ts"],
  },
  { named: /\bPWA\b|service worker|\bSW\b/i, proof: ["src/pwa/register.ts", "public/sw.js"] },
  { named: /soft.?keys/i, proof: ["src/components/SoftKeys.tsx", "src/mobile/keybytes.ts"] },
  {
    named: /terminal (?:view|mode)/i,
    proof: ["src/components/TerminalView.tsx", "src/lib/terminal-url.ts"],
  },
  {
    named: /file (?:preview|editor)/i,
    proof: ["src/components/FilePreview.tsx", "src/lib/file-api.ts"],
  },
  { named: /settings panel|settings overlay/i, proof: ["src/components/SettingsPanel.tsx"] },
  { named: /self-update|healer/i, proof: ["src/deploy/healer.ts"] },
  { named: /telemetry/i, proof: ["src/telemetry/track.ts"] },
];

/** Phrases that say "this does not exist yet". */
const UNBUILT =
  /\bstubs?\b|\bplaceholder\b|later phases?|not (?:yet )?(?:built|wired|implemented)|unbuilt|follow-ups?|\bP2\b|\bTODO\b/i;

describe("the README describes nothing that ships as unbuilt", () => {
  it.each(SHIPPED.map((s) => [String(s.named), s] as const))(
    "%s — the files that prove it still exist",
    (_label, s) => {
      for (const p of s.proof) {
        expect(existsSync(FE(p)), `${p} is gone — drop or repoint this row`).toBe(true);
      }
    },
  );

  it("no shipped subsystem sits under an 'unbuilt' heading or on an 'unbuilt' line", () => {
    const lies: string[] = [];
    let heading = "";
    README.split("\n").forEach((line, i) => {
      if (line.startsWith("#")) heading = line;
      const context = `${heading}\n${line}`;
      if (!UNBUILT.test(context)) return;
      for (const s of SHIPPED) {
        if (!s.named.test(context)) continue;
        lies.push(`README.md:${i + 1}  ${line.trim()}   [proof: ${s.proof[0]}]`);
      }
    });
    expect(lies, "shipped subsystems described as unbuilt").toEqual([]);
  });
});

describe("the README's Layout map is the whole source tree", () => {
  /** The first fenced block under `## Layout`. */
  const fence = ((): string => {
    const at = README.indexOf("## Layout");
    expect(at, "README needs a '## Layout' section").toBeGreaterThan(-1);
    const open = README.indexOf("```", at);
    const close = README.indexOf("```", open + 3);
    expect(close).toBeGreaterThan(open);
    return README.slice(open + 3, close);
  })();

  const srcFiles = ((): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else out.push(relative(FE("src"), p));
      }
    };
    walk(FE("src"));
    return out;
  })();

  it("finds a source tree to check against", () => {
    expect(srcFiles.length).toBeGreaterThan(50);
  });

  it("names every file under src/", () => {
    // The map reads as exhaustive — it goes down to Mermaid.tsx — so a file
    // missing from it reads as a file that does not exist. That is exactly how
    // the whole file-preview/editor surface went undocumented.
    const missing = srcFiles.filter((f) => {
      const base = f.slice(f.lastIndexOf("/") + 1).replace(/\./g, "\\.");
      return !new RegExp(`(?:^|[\\s/])${base}`, "m").test(fence);
    });
    expect(missing, "src/ files absent from the README Layout map").toEqual([]);
  });
});

describe("the README documents the dev proxy that exists", () => {
  it("names every prefix vite.config.ts proxies", () => {
    const prefixes = proxiedPrefixes();
    expect(prefixes.length).toBeGreaterThanOrEqual(5);
    const missing = prefixes.filter((p) => !README.includes(p));
    expect(missing, "dev-proxy prefixes the README never mentions").toEqual([]);
  });
});
