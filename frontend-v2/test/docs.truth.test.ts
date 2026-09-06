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
 * So every assertion below is derived from CODE on both sides — each service's
 * own route table, the files on disk, the proxy record — never from a second
 * copy of the prose. Delete a subsystem and its row relaxes on its own; add a
 * server route and the doc is allowed to mention it again.
 *
 * The route half used to read session-events alone, which left the four other
 * backends this app calls unguarded. It reads all five now, off one table.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const FE = (p: string): string => resolve(__dirname, "..", p);
const REPO = (p: string): string => resolve(__dirname, "../..", p);

const README = readFileSync(FE("README.md"), "utf8");
const VITE_CONFIG = readFileSync(FE("vite.config.ts"), "utf8");
const CONFIG_TS = readFileSync(FE("src/lib/config.ts"), "utf8");

/** Every first capture group of `re` in `text`. */
function captures(re: RegExp, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const group = m[1];
    if (group !== undefined) out.push(group);
  }
  return out;
}

interface Service {
  /** The repo directory holding it, which is also what its docs call it. */
  readonly name: string;
  /** The prefix the BROWSER calls it under. "" for session-events, at the root. */
  readonly prefix: string;
  /**
   * Whether the ingress strips the prefix before the service sees it. Stripped:
   * the service registers root paths and a browser path is prefix + route (the
   * tmux-api and clipboard-upload shape). Not stripped: its own routes already
   * carry the prefix (the file-api and skills-api shape).
   */
  readonly stripped: boolean;
  /** The vite.config.ts origin constant the dev proxy points at it. */
  readonly viteTarget: string;
  /** Browser paths it answers WITHOUT a mux registration, and why. */
  readonly alsoServes?: readonly string[];
}

/**
 * The five backends this app calls. Every row's mapping is stated twice in the
 * tree already — once in `lib/config.ts`'s prefix docs, once in the dev proxy —
 * so this table is the third statement and the one the checks below run on.
 */
const SERVICES: readonly Service[] = [
  { name: "session-events", prefix: "", stripped: false, viteTarget: "SESSION_EVENTS" },
  { name: "tmux-api", prefix: "/api/sessions", stripped: true, viteTarget: "TMUX_API" },
  {
    name: "clipboard-upload",
    prefix: "/clipboard",
    stripped: true,
    viteTarget: "CLIPBOARD_UPLOAD",
    // The webfonts come off the fixed table in clipboard-upload/assets.go, not
    // off the mux, so the route parser cannot see them.
    alsoServes: ["/fonts"],
  },
  { name: "file-api", prefix: "/files", stripped: false, viteTarget: "FILE_API" },
  { name: "skills-api", prefix: "/skills", stripped: false, viteTarget: "SKILLS_API" },
];

/** The non-test Go sources of one service. */
function goSources(service: string): string[] {
  const dir = REPO(service);
  return readdirSync(dir)
    .sort()
    .filter((n) => n.endsWith(".go") && !n.endsWith("_test.go"))
    .map((n) => join(dir, n));
}

/**
 * The browser paths a service actually answers, parsed from its mux
 * registrations. A wildcard SEGMENT is dropped so `/events/{session}` reads as
 * `/events`, but the segments before it are kept: skills-api registers
 * `/skills/source/install`, and truncating that to `/skills` would make the
 * check vacuous. The bare `/` catch-all mount is not a route of its own.
 */
function servedRoutes(svc: Service): Set<string> {
  const out = new Set<string>(svc.alsoServes ?? []);
  for (const file of goSources(svc.name)) {
    const src = readFileSync(file, "utf8");
    for (const p of captures(/Handle(?:Func)?\(\s*"(?:[A-Z]+ )?(\/[^"]*)"/g, src)) {
      const route = p.replace(/\/\{[^}]*\}/g, "").replace(/\/+$/, "");
      if (route === "") continue;
      out.add(svc.stripped ? `${svc.prefix}${route}` : route);
    }
  }
  return out;
}

const SERVED = new Map(SERVICES.map((s) => [s.name, servedRoutes(s)] as const));

/** The service a browser path belongs to: the longest prefix that owns it. */
function serviceOf(path: string): string {
  let name = "session-events";
  let owned = -1;
  for (const svc of SERVICES) {
    if (svc.prefix === "") continue;
    if (path !== svc.prefix && !path.startsWith(`${svc.prefix}/`)) continue;
    if (svc.prefix.length > owned) {
      name = svc.name;
      owned = svc.prefix.length;
    }
  }
  return name;
}

interface ProxyEntry {
  readonly prefix: string;
  /** The vite origin constant it forwards to, resolved through any alias. */
  readonly target: string;
}

/** The origin constant a named ProxyOptions alias forwards to. */
function targetOfAlias(alias: string): string {
  const at = VITE_CONFIG.indexOf(`const ${alias}: ProxyOptions = {`);
  if (at < 0) return "";
  return /target:\s*(\w+)/.exec(VITE_CONFIG.slice(at))?.[1] ?? "";
}

/** The dev proxy table, read as prefix → origin constant. */
function proxyEntries(): ProxyEntry[] {
  const body = VITE_CONFIG.slice(
    VITE_CONFIG.indexOf("const proxy: Record<string, ProxyOptions>"),
  );
  const out: ProxyEntry[] = [];
  for (const m of body.matchAll(/^ {2}"(\/[a-z0-9/-]+)":\s*([\s\S]*?)(?=^ {2}"\/|^\};)/gm)) {
    const [, prefix, value] = m;
    if (prefix === undefined || value === undefined) continue;
    const inline = /target:\s*(\w+)/.exec(value)?.[1];
    const alias = /^(\w+),/.exec(value.trim())?.[1];
    const target = inline ?? (alias === undefined ? "" : targetOfAlias(alias));
    out.push({ prefix, target });
  }
  return out;
}

const PROXY = proxyEntries();

/**
 * The string constants `lib/config.ts` exports, so a builder that interpolates
 * one resolves to a real path. `API_BASE` is "" unless `?api=` moves the origin,
 * which changes the host and not the path.
 */
function stringConstants(): Map<string, string> {
  const out = new Map<string, string>([["API_BASE", ""]]);
  for (const m of CONFIG_TS.matchAll(/export const (\w+) = "([^"]*)";/g)) {
    const [, name, value] = m;
    if (name !== undefined && value !== undefined) out.set(name, value);
  }
  return out;
}

const CONSTS = stringConstants();

interface Helper {
  readonly name: string;
  readonly doc: string;
  readonly params: string;
  readonly body: string;
}

/** Every exported URL builder in `lib/config.ts`, with its doc and its body. */
function helpers(): Helper[] {
  const out: Helper[] = [];
  const re = /\/\*\*([\s\S]*?)\*\/\s*export function (\w+)\(([^)]*)\)[^{]*\{([\s\S]*?)\n\}/g;
  for (const m of CONFIG_TS.matchAll(re)) {
    const [, doc, name, params, body] = m;
    if (doc === undefined || name === undefined) continue;
    if (params === undefined || body === undefined) continue;
    out.push({ name, doc, params, body });
  }
  return out;
}

/** A body's template literals, with the exported constants resolved. */
function templates(body: string): string[] {
  return captures(/`([^`]*)`/g, body).map((t) =>
    t.replace(/\$\{(\w+)\}/g, (whole, id: string) => CONSTS.get(id) ?? whole),
  );
}

/**
 * The builders that take the PATH from their caller — `apiUrl` and
 * `clipboardUrl`. Each resolves to a bare service prefix with an interpolation
 * straight after it, so it names no route of its own; what it does is put a
 * delegating helper's fragment on the right service.
 */
function prefixBuilders(): Map<string, string> {
  const out = new Map<string, string>();
  for (const h of helpers()) {
    for (const t of templates(h.body)) {
      for (const svc of SERVICES) {
        if (svc.prefix !== "" && t.startsWith(`${svc.prefix}\${`)) out.set(h.name, svc.prefix);
      }
    }
  }
  return out;
}

/**
 * A path whose interpolated segment is a parameter declared as a union of
 * string literals is really one path per member — that is skillActionUrl's ten
 * actions, two of them two segments deep.
 */
function expandUnions(tpl: string, params: string): string[] {
  const id = /\$\{(\w+)\}/.exec(tpl)?.[1];
  if (id === undefined || !new RegExp(`\\b${id}\\s*:`).test(params)) return [tpl];
  const members = captures(/"([a-z][a-z0-9/-]*)"/g, params);
  if (members.length === 0) return [tpl];
  return members.map((v) => tpl.replace(`\${${id}}`, v));
}

interface HelperPath {
  readonly name: string;
  /** The browser path it builds, prefix included. */
  readonly path: string;
  readonly deprecated: boolean;
}

/** Every concrete browser path `lib/config.ts` can build. */
function helperPaths(): HelperPath[] {
  const builders = prefixBuilders();
  const out: HelperPath[] = [];
  for (const h of helpers()) {
    if (builders.has(h.name)) continue;
    // A builder that never names API_BASE goes through one of the prefix
    // builders, so its fragment is relative to that service's prefix.
    let base = "";
    if (!h.body.includes("${API_BASE}")) {
      for (const [builder, prefix] of builders) {
        if (new RegExp(`\\b${builder}\\(`).test(h.body)) base = prefix;
      }
    }
    const deprecated = /@deprecated/.test(h.doc);
    for (const t of templates(h.body)) {
      for (const full of expandUnions(base + t, h.params)) {
        // Everything from the first interpolation or query is a value, not a
        // route: /result/{id} and /files/read?path= are both their prefix.
        const path = (full.split("${")[0] ?? "").split("?")[0]?.replace(/\/+$/, "") ?? "";
        if (!path.startsWith("/")) continue;
        out.push({ name: h.name, path, deprecated });
      }
    }
  }
  return out;
}

const HELPER_PATHS = helperPaths();

describe("the route and helper parsers found something to check against", () => {
  it("parses a route table out of every service", () => {
    // Guards the parsers themselves: an unparsed service would make every check
    // below vacuously strict, not vacuously loose, but it would still lie. The
    // canaries cover all three route shapes — a root path, a stripped prefix,
    // and a route two segments deep.
    expect([...(SERVED.get("session-events") ?? [])]).toContain("/events");
    expect([...(SERVED.get("tmux-api") ?? [])]).toContain("/api/sessions/whoami");
    expect([...(SERVED.get("skills-api") ?? [])]).toContain("/skills/source/install");
    const total = SERVICES.reduce((n, s) => n + (SERVED.get(s.name)?.size ?? 0), 0);
    expect(total, "the five route tables parsed to almost nothing").toBeGreaterThanOrEqual(40);
  });

  it("resolves the client's URL builders to concrete paths", () => {
    expect(HELPER_PATHS.length).toBeGreaterThanOrEqual(20);
    // tmux-api contributes none on purpose: its one builder takes the path from
    // its caller, so what can be pinned there is the PREFIX, which the dev-proxy
    // row below and the "spelled-out prefix" test further down both cover.
    const covered = new Set(HELPER_PATHS.map((h) => serviceOf(h.path)));
    expect([...covered].sort()).toEqual([
      "clipboard-upload",
      "file-api",
      "session-events",
      "skills-api",
    ]);
  });

  it("reads the dev proxy table as prefix -> service", () => {
    expect(PROXY.length).toBeGreaterThanOrEqual(15);
    expect(PROXY.filter((p) => p.target === "SESSION_EVENTS").length).toBeGreaterThanOrEqual(10);
    expect(PROXY.filter((p) => p.target === "TMUX_API").map((p) => p.prefix)).toEqual([
      "/api/sessions",
    ]);
  });

  it("nothing calls a URL builder marked @deprecated", () => {
    // The older guard asked only that a dead route be MARKED, which left
    // permissionUrl carrying a full "@deprecated DEAD ROUTE" note while
    // store/session.ts called it on every Allow and Deny — a 404 per click for
    // seven weeks. Marking is a note to a reader; this is the part that bites.
    const marked = helpers()
      .filter((h) => /@deprecated/.test(h.doc))
      .map((h) => h.name);
    const callers: string[] = [];
    for (const file of srcTree()) {
      const rel = relative(FE("."), file);
      if (rel === "src/lib/config.ts") continue;
      const text = readFileSync(file, "utf8");
      for (const name of marked) {
        if (new RegExp(`\\b${name}\\s*\\(`).test(text)) callers.push(`${rel} calls ${name}()`);
      }
    }
    expect(callers, "a URL builder marked @deprecated is still being called").toEqual([]);
  });
});

describe.each(SERVICES.map((s) => [s.name, s] as const))(
  "%s — the docs and the client may only present a SERVED route",
  (name, svc) => {
    const served = SERVED.get(name) ?? new Set<string>();
    const mine = HELPER_PATHS.filter((h) => serviceOf(h.path) === name);

    it("registers a handful of routes", () => {
      expect(served.size, `no routes parsed out of ${name}/`).toBeGreaterThanOrEqual(3);
    });

    it("the vite dev proxy forwards only prefixes it answers", () => {
      // The dev proxy is a stand-in for the prod ingress. A prefix it forwards
      // that the service registers nothing under is a dead route in local dev
      // too — and a prefix MISSING from the proxy falls through to ttyd, which
      // answers 200 with the SPA's own index.html, so the caller's res.json()
      // throws and the feature is quietly absent rather than broken.
      for (const entry of PROXY.filter((p) => p.target === svc.viteTarget)) {
        const covered =
          served.has(entry.prefix) || [...served].some((r) => r.startsWith(`${entry.prefix}/`));
        expect(
          covered,
          `vite.config.ts forwards ${entry.prefix} to ${name}, which registers nothing under it`,
        ).toBe(true);
      }
    });

    it("every client URL helper targets a served route, or is marked @deprecated", () => {
      for (const h of mine) {
        if (served.has(h.path)) continue;
        expect(
          h.deprecated,
          `config.ts ${h.name}() builds ${h.path}, which ${name} does not serve — ` +
            `either the route is back (unmark it) or the helper needs an @deprecated note`,
        ).toBe(true);
      }
    });

    it("the README names no path of this service that it does not serve", () => {
      // Vocabulary = every path of this service the app knows about, from either
      // side. A dead one must not appear in the docs at all: naming it is how it
      // gets re-adopted. Record removals against the commit, not the path.
      const vocabulary = new Set([...served, ...mine.map((h) => h.path)]);
      for (const path of vocabulary) {
        if (served.has(path)) continue;
        expect(README, `frontend-v2/README.md still names the dead route ${path}`).not.toContain(
          path,
        );
      }
    });
  },
);

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
    proof: ["src/components/TerminalNative.tsx", "src/lib/terminal-url.ts"],
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

  /**
   * The fence read as a tree, so a name is checked against the DIRECTORY it
   * lives in rather than against the whole map.
   *
   * The map is indented: a directory line is `  terminal/`, its files sit
   * deeper, and a nested directory such as `    settings/` opens its own block.
   * Parsing that gives a set of "dir/basename" keys.
   *
   * WHY THIS IS NOT A BASENAME MATCH, measured 2026-09-04. It used to take the
   * basename and ask whether the fence mentioned it ANYWHERE, so a name reused
   * in a second directory satisfied the check for both. Two files landed
   * invisible to it on one afternoon: src/terminal/attention.ts was covered by
   * src/notify/attention.ts's row, and src/terminal/viewport.ts by
   * src/mobile/viewport.ts's. Six new modules arrived, the guard reported four,
   * and the two it missed were exactly the two whose names collided. A guard
   * whose whole job is noticing a new module cannot be blind to the modules
   * most likely to be named after an existing one.
   */
  const documented = ((): Set<string> => {
    const keys = new Set<string>();
    /** A directory currently open, with the indent it opened at. */
    type Open = { indent: number; path: string };
    const stack: Open[] = [];
    // tsconfig has noUncheckedIndexedAccess, so stack[n] is possibly undefined.
    // One accessor rather than a cast at each use: the empty stack is a real
    // state (a row at the fence's own root) and it answers "" for it.
    const openPath = (): string => (stack.length ? (stack[stack.length - 1] as Open).path : "");
    const openIndent = (): number =>
      stack.length ? (stack[stack.length - 1] as Open).indent : -1;

    for (const raw of fence.split("\n")) {
      if (!raw.trim()) continue;
      const indent = raw.length - raw.trimStart().length;
      const trimmed = raw.trimStart();
      while (stack.length && indent <= openIndent()) stack.pop();

      const dir = /^([A-Za-z0-9_.-]+)\/(\s|$)/.exec(trimmed);
      if (dir?.[1]) {
        const parent = openPath();
        stack.push({ indent, path: parent ? `${parent}/${dir[1]}` : dir[1] });
        continue;
      }
      // Two row styles, both in use. Most rows are a bare name inside a
      // directory block; some spell the path out instead, as `types/events.ts`
      // and `telemetry/track.ts` do, and those carry their own directory.
      const file = /^((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)(\s|$)/.exec(
        trimmed,
      );
      const named = file?.[1];
      if (!named) continue;
      if (named.includes("/")) {
        keys.add(named.replace(/^src\//, ""));
        continue;
      }
      // The fence roots at `src/`, which is not part of a path relative to src.
      const rel = openPath().replace(/^src\/?/, "");
      keys.add(rel ? `${rel}/${named}` : named);
    }
    return keys;
  })();

  it("parsed the map into something to check against", () => {
    // Without this, a parser that matched nothing would report every file
    // missing, and a parser that matched everything would report none. The
    // count is a sanity floor on the first and the test below covers the second.
    expect(documented.size, "the Layout fence parsed to no file rows").toBeGreaterThan(50);
  });

  it("names every file under src/, in the directory it actually lives in", () => {
    // The map reads as exhaustive — it goes down to Mermaid.tsx — so a file
    // missing from it reads as a file that does not exist. That is exactly how
    // the whole file-preview/editor surface went undocumented.
    const missing = srcFiles.filter((f) => !documented.has(f));
    expect(missing, "src/ files absent from the README Layout map").toEqual([]);
  });
});

interface GoPointer {
  /** The v2 source file doing the naming, relative to `frontend-v2/`. */
  readonly from: string;
  /** The repo-root-relative Go path it names. */
  readonly path: string;
}

/** Absolute paths of every file under `frontend-v2/src`. */
function srcTree(dir: string = FE("src")): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...srcTree(p));
    else out.push(p);
  }
  return out;
}

/**
 * Every `<service>/<file>.go` path named in a v2 source file. frontend-v2 owns
 * no Go, so such a path is always a "source of truth" pointer in a docstring,
 * aimed at a sibling service at the repo root.
 */
function goPointers(): GoPointer[] {
  const out: GoPointer[] = [];
  for (const file of srcTree()) {
    for (const path of captures(
      /\b([a-z][a-z0-9-]*\/[a-z0-9_.-]+\.go)\b/g,
      readFileSync(file, "utf8"),
    )) {
      out.push({ from: relative(FE("."), file), path });
    }
  }
  return out;
}

describe("the wire-contract docstrings point at Go that exists", () => {
  it("finds the cross-service pointers to check", () => {
    const pointers = goPointers();
    expect(pointers.length).toBeGreaterThanOrEqual(5);
    // The canary: the event wire contract's own pointer. It moved out of
    // session-events into sessionio when the package was shared.
    expect(pointers.map((p) => p.path)).toContain("sessionio/event.go");
  });

  it("names no Go file that is not on disk", () => {
    // A deleted service file leaves its callers compiling and its READERS
    // stranded: `575d4f5` removed session-events/permission.go, and
    // types/events.ts — the module that DEFINES the permission_request /
    // permission_resolved wire shape — kept citing it as the source of truth.
    // Every sibling pointer of that class was corrected in 8c1b6fb; this is
    // the check that would have caught the one that was missed.
    const dangling = goPointers()
      .filter((p) => !existsSync(REPO(p.path)))
      .map((p) => `${p.from} names ${p.path}`);
    expect(dangling, "v2 source citing a Go file that no longer exists").toEqual([]);
  });
});

describe("the README documents the dev proxy that exists", () => {
  it("names every prefix vite.config.ts proxies", () => {
    const prefixes = PROXY.map((p) => p.prefix);
    expect(prefixes.length).toBeGreaterThanOrEqual(5);
    const missing = prefixes.filter((p) => !README.includes(p));
    expect(missing, "dev-proxy prefixes the README never mentions").toEqual([]);
  });
});

/**
 * The telemetry catalog in `telemetry/events.go` is a gate, not a list: `Emit`
 * returns early on a name it does not carry, with no error, no log line and
 * nothing that fails a build. A name that misses it is a series that silently
 * never reaches the journal — which is how session.retitled, session.autonamed,
 * claude.answered, file.attached, session.grid_repinned, skill.edited and
 * watch.switched were all being emitted and all being dropped.
 */
describe("telemetry — an event name that is emitted is a name the catalog carries", () => {
  const EVENTS_GO = readFileSync(REPO("telemetry/events.go"), "utf8");
  const TRACK_TS = readFileSync(FE("src/telemetry/track.ts"), "utf8");

  /** The catalog itself. */
  const catalog = new Set(captures(/^\t"([a-z][a-z0-9_.]*)":\s*true,/gm, EVENTS_GO));

  /**
   * The `TlEvent` union — every name a browser tab can send. Read line by line
   * rather than up to the first `;`, because a comment inside the union carries
   * one of its own.
   */
  const union = ((): string[] => {
    const out: string[] = [];
    const at = TRACK_TS.indexOf("export type TlEvent");
    for (const line of TRACK_TS.slice(at).split("\n")) {
      const name = /^\s*\|\s*"([a-z][a-z0-9_.]*)"/.exec(line)?.[1];
      if (name !== undefined) out.push(name);
      if (/";\s*$/.test(line)) break;
    }
    return out;
  })();

  interface Emitted {
    readonly name: string;
    readonly from: string;
  }

  /** Every literal event name a Go service emits, with the file that emits it. */
  const emitted = ((): Emitted[] => {
    const out: Emitted[] = [];
    for (const entry of readdirSync(REPO("."))) {
      const dir = REPO(entry);
      if (entry.startsWith(".") || !statSync(dir).isDirectory()) continue;
      for (const file of readdirSync(dir).sort()) {
        if (!file.endsWith(".go") || file.endsWith("_test.go")) continue;
        const src = readFileSync(join(dir, file), "utf8");
        for (const name of captures(/\bEmit\(\s*"([a-z][a-z0-9_.]*)"/g, src)) {
          out.push({ name, from: `${entry}/${file}` });
        }
      }
    }
    return out;
  })();

  /**
   * Names a Go service emits today that the catalog does not carry, so Emit
   * drops each one. They are listed rather than fixed because cataloguing them
   * is a volume decision someone has to take, not an oversight to close in a
   * test: two of the three are per-request.
   */
  const UNCATALOGUED: Readonly<Record<string, string>> = {
    "api.served": "one event per served HTTP request, in every service that mounts the middleware",
    "api.rollup": "the per-window rollup that rides with api.served",
    "claude.model_set": "POST /model, a model or effort change made from the lobby",
  };

  it("finds a catalog, a union and a set of emitters to check", () => {
    expect(catalog.size, "telemetry/events.go parsed to no catalog").toBeGreaterThanOrEqual(60);
    expect(union.length, "the TlEvent union parsed to nothing").toBeGreaterThanOrEqual(50);
    expect(emitted.length, "no Go Emit call sites found").toBeGreaterThanOrEqual(30);
  });

  it("every TlEvent name the browser can send is in the catalog", () => {
    // ONE direction only. The catalog legitimately carries names no browser ever
    // sends — every server-side event — so asserting equality would fail on
    // correct code and teach the next reader to delete the test.
    const missing = union.filter((n) => !catalog.has(n));
    expect(
      missing,
      "TlEvent names the browser intake would accept and Emit would then drop",
    ).toEqual([]);
  });

  it("every event name a Go service emits is in the catalog, or listed as dropped", () => {
    const dropped = emitted
      .filter((e) => !catalog.has(e.name) && UNCATALOGUED[e.name] === undefined)
      .map((e) => `${e.from} emits ${e.name}, which the catalog does not carry`);
    expect(dropped, "an emitted event name that Emit silently drops").toEqual([]);
  });

  it("the dropped list holds nothing that has since been fixed", () => {
    // Keeps the list from outliving its reasons: catalogue one of these and this
    // is what tells you to take the line out again.
    const names = new Set(emitted.map((e) => e.name));
    const stale = Object.keys(UNCATALOGUED).filter((n) => catalog.has(n) || !names.has(n));
    expect(stale, "listed as dropped, but no longer emitted or no longer uncatalogued").toEqual([]);
  });
});

/**
 * `lib/config.ts` owns the tmux-api prefix. Spelling `/api/sessions/` out
 * anywhere else forks it: `?as=` (the admin act-as switch) rides on apiUrl, the
 * ingress mapping is stated once, and a second copy is what silently keeps its
 * own answer when either changes.
 */
describe("the tmux-api prefix is spelled out in one place", () => {
  const ALLOWED: Readonly<Record<string, string>> = {
    "src/pwa/push.ts":
      "the service worker reads these same three paths, and a push subscription " +
      "deliberately carries no ?as= — going through apiUrl would enroll this browser " +
      "as one of the act-as target's devices",
    "src/telemetry/diag.ts":
      "the intake URL handed to the tlDiag core at bind time, which is not a fetch() " +
      "this module makes. It should come through apiUrl and does not yet",
  };

  const spellers = srcTree()
    .map((f) => relative(FE("."), f))
    .filter((rel) => rel !== "src/lib/config.ts")
    .filter((rel) => readFileSync(FE(rel), "utf8").includes('"/api/sessions/'));

  it("no file outside lib/config.ts spells the prefix, beyond the listed ones", () => {
    const unexpected = spellers.filter((rel) => ALLOWED[rel] === undefined);
    expect(unexpected, "hardcodes the tmux-api prefix instead of calling apiUrl()").toEqual([]);
  });

  it("every allowance is still being used", () => {
    // A file that stopped spelling the prefix out has stopped needing its
    // exemption, and an exemption nobody can see the need for is one the next
    // reader copies.
    const stale = Object.keys(ALLOWED).filter((rel) => !spellers.includes(rel));
    expect(stale, "listed as allowed to spell the prefix, but no longer does").toEqual([]);
  });
});
