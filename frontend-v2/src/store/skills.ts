/**
 * The Skills settings group's store: one inventory, the actions that change it,
 * and the one-line outcome the panel shows afterwards.
 *
 * Loaded lazily — the panel asks for it when the group first renders, not on
 * boot, because most settings visits are about a theme or a font size and this
 * costs a scan of every account's skills. Every action reloads afterwards rather
 * than patching the list in place: the server already computes the verdicts and
 * the update markers, and a locally-patched row would be a second, divergent
 * implementation of that logic.
 */
import { createSignal, type Accessor } from "solid-js";
import {
  deleteSkill,
  inspectSource,
  installFromSource,
  fetchDiff,
  fetchInventory,
  installSkill,
  removeSkill,
  restartSession,
  SkillsApiError,
  toggleSkill,
  uninstallPlugin,
  updatePlugin,
  type Inventory,
  type SkillDiff,
  type SourceInfo,
} from "../lib/skills-api";
import { toasts } from "./toast";

export interface SkillsStore {
  inventory: Accessor<Inventory | null>;
  loading: Accessor<boolean>;
  /** Set when the inventory itself could not be read; the group says so instead
   *  of rendering an empty list that would read as "you have no skills". */
  error: Accessor<string>;
  /** The row currently expanded, as "<owner>/<name>"; "" for none. */
  expanded: Accessor<string>;
  /** The diff being shown for a collision, if any. */
  diff: Accessor<SkillDiff | null>;
  /** An action is in flight; the group disables its buttons rather than letting
   *  two installs of the same name race. */
  busy: Accessor<string>;
  load: () => Promise<void>;
  toggleExpanded: (owner: string, name: string) => void;
  showDiff: (owner: string, name: string) => Promise<void>;
  clearDiff: () => void;
  install: (owner: string, name: string, replace?: boolean) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  remove: (name: string) => Promise<void>;
  /** Permanent: the skill, its backups, its enabled state and its provenance. */
  deleteForever: (name: string) => Promise<void>;
  update: (plugin: string) => Promise<void>;
  uninstall: (plugin: string) => Promise<void>;
  restart: (session: string) => Promise<void>;
  /** What the last look at a source repo found; null when there is none. */
  source: Accessor<SourceInfo | null>;
  /** A look is in flight. */
  inspecting: Accessor<boolean>;
  /** Look at a repo without installing anything. */
  inspect: (source: string) => Promise<void>;
  /** Forget the current look. */
  clearSource: () => void;
  /** Install the chosen names from the looked-at repo. */
  installSource: (kind: "skills" | "plugins", names: string[]) => Promise<void>;
}

/** rowKey identifies an expanded row across both lists. */
export const rowKey = (owner: string, name: string) => `${owner}/${name}`;

export function createSkillsStore(): SkillsStore {
  const [inventory, setInventory] = createSignal<Inventory | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [expanded, setExpanded] = createSignal("");
  const [diff, setDiff] = createSignal<SkillDiff | null>(null);
  const [busy, setBusy] = createSignal("");
  const [source, setSource] = createSignal<SourceInfo | null>(null);
  const [inspecting, setInspecting] = createSignal(false);

  const load = async () => {
    setLoading(true);
    try {
      setInventory(await fetchInventory());
      setError("");
    } catch (e) {
      setError(loadMessage(e));
    } finally {
      setLoading(false);
    }
  };

  /** Run one action, then reload. The label doubles as the busy key, so the row
   *  that is working is the row that looks like it.
   *
   *  No client-side telemetry here: skills-api emits skill.installed and friends
   *  itself, and emitting from both ends would double-count every action.
   */
  const act = async (label: string, run: () => Promise<string>) => {
    if (busy()) return;
    setBusy(label);
    try {
      const said = await run();
      if (said) toasts.push({ kind: "success", message: said });
      await load();
    } catch (e) {
      toasts.push({ kind: "error", message: message(e) });
      // A 404 means the list is stale — someone removed that skill since it was
      // drawn — so the reload is the useful part of the failure.
      if (e instanceof SkillsApiError && e.status === 404) await load();
    } finally {
      setBusy("");
    }
  };

  return {
    inventory,
    loading,
    error,
    expanded,
    diff,
    busy,
    load,
    toggleExpanded: (owner, name) => {
      const key = rowKey(owner, name);
      setExpanded(expanded() === key ? "" : key);
      setDiff(null);
    },
    showDiff: async (owner, name) => {
      try {
        setDiff(await fetchDiff(owner, name));
      } catch (e) {
        toasts.push({ kind: "error", message: message(e) });
      }
    },
    clearDiff: () => setDiff(null),
    install: async (owner, name, replace = false) =>
      act(rowKey(owner, name), async () => {
        const res = await installSkill(owner, name, replace);
        setDiff(null);
        return res.backup
          ? `Replaced ${name} with ${owner}'s. Yours is in ${short(res.backup)}`
          : `Installed ${name} from ${owner}. It loads in new sessions.`;
      }),
    setEnabled: async (id, enabled) =>
      act(id, async () => {
        await toggleSkill(id, enabled);
        return `${id.split("@")[0]} ${enabled ? "enabled" : "disabled"} — takes effect in new sessions.`;
      }),
    remove: async (name) =>
      act(name, async () => {
        const res = await removeSkill(name);
        setExpanded("");
        return `Removed ${name}. A copy is in ${short(res.backup)}`;
      }),
    deleteForever: async (name) =>
      act(name, async () => {
        const res = await deleteSkill(name);
        setExpanded("");
        const d = res.deleted;
        if (d?.wasSymlink) {
          return `Deleted ${name}. It was a link — ${d.target ?? "its target"} is left alone.`;
        }
        const backups = d?.purgedBackups
          ? `, with ${d.purgedBackups} backup${d.purgedBackups === 1 ? "" : "s"}`
          : "";
        return `Deleted ${name} permanently${backups} — ${human(d?.bytes ?? 0)} freed.`;
      }),
    update: async (plugin) =>
      act(plugin, async () => {
        await updatePlugin(plugin);
        return `${plugin.split("@")[0]} updated — restart a session to load it.`;
      }),
    uninstall: async (plugin) =>
      act(plugin, async () => {
        const res = await uninstallPlugin(plugin);
        const name = plugin.split("@")[0];
        return res.freed
          ? `Uninstalled ${name} — ${human(res.freed)} freed.`
          : `Uninstalled ${name}.`;
      }),
    source,
    inspecting,
    inspect: async (input) => {
      setInspecting(true);
      try {
        setSource(await inspectSource(input));
      } catch (e) {
        setSource(null);
        toasts.push({ kind: "error", message: message(e) });
      } finally {
        setInspecting(false);
      }
    },
    clearSource: () => setSource(null),
    installSource: async (kind, names) => {
      const info = source();
      if (!info) return;
      await act(`source:${kind}`, async () => {
        await installFromSource(`${info.owner}/${info.repo}`, kind, names);
        setSource(null);
        const what = names.length === 1 ? names[0] : `${names.length} ${kind}`;
        return `Installed ${what} from ${info.owner}/${info.repo}. It loads in new sessions.`;
      });
    },
    restart: async (session) =>
      act(`session:${session}`, async () => {
        await restartSession(session);
        return `Restarted ${session} with its conversation intact.`;
      }),
  };
}

/** message turns a failure into the one sentence the panel shows. The status is
 *  what makes each case distinguishable, and the server's own text is used where
 *  it is more specific than anything this layer could say. */
function message(e: unknown): string {
  if (e instanceof SkillsApiError) {
    switch (e.status) {
      case 0:
        return "Could not reach the skills service.";
      case 403:
        return "Not permitted for that account.";
      case 404:
        return "That skill is no longer there — refreshing.";
      case 409:
        return e.message || "That name is already taken.";
      default:
        return e.message || `Request failed (${e.status}).`;
    }
  }
  return e instanceof Error ? e.message : "Something went wrong.";
}

/**
 * loadMessage is message() with one case that has to differ: a 404.
 *
 * On an action, 404 means the skill went away between the list being drawn and
 * the click. On the INVENTORY it cannot mean that — there is no skill in the
 * request — so it means nothing is serving GET /skills, and the most likely
 * reason is routing. Reporting it as a missing skill is what let a route that
 * matched only /skills/* look like a data problem for hours (2026-08-19).
 */
function loadMessage(e: unknown): string {
  if (e instanceof SkillsApiError && e.status === 404) {
    return "Nothing is answering /skills — the skills service is not reachable from here.";
  }
  return message(e);
}

/** human is a size for a sentence, not a table: whole units, no decimals below a
 *  megabyte. */
function human(bytes: number): string {
  if (bytes <= 0) return "nothing";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** short trims a backup path to the part a person reads: the last two segments. */
function short(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}
