import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";

/**
 * Which remark plugins this ENGINE can actually run.
 *
 * remark-gfm bundles the GFM extensions, and one of them —
 * autolink-literal — builds its email pattern with a lookbehind:
 *
 *   new RegExp("(?<=^|\\s|\\p{P}|\\p{S})([-.\\w+]+)@([-\\w]+(?:\\.[-\\w]+)+)", "gu")
 *
 * Lookbehind arrived in Safari 16.4. On iPadOS 15.8 — the oldest engine we
 * serve, and a device that cannot be upgraded past it — that constructor
 * throws, and it sits in a `transforms` entry that runs on EVERY render, so
 * the throw takes the whole message with it.
 *
 * This is the second half of the blank-iPad fix (2026-08-18). Building the
 * bundle for safari15 made esbuild rewrite that regex LITERAL into a
 * `new RegExp(...)` call, which is what stopped the page failing to PARSE — but
 * a literal only moved to a constructor still throws when the constructor runs.
 * Without this gate the iPad would trade a blank lobby for a text view that
 * breaks on the first message it draws.
 *
 * The trade on that one device is the GFM extras — tables, task lists,
 * strikethrough, bare-URL autolinking. Everything else still renders:
 * headings, lists, code fences, explicit links, images, mermaid.
 */
const WITH_GFM: PluggableList = [remarkGfm];
const WITHOUT_GFM: PluggableList = [];

/**
 * Pure so the choice is testable without an engine that lacks the feature.
 * Returns a STABLE array per branch: SolidMarkdown re-runs its pipeline when
 * the plugin list changes identity, and this is read on every render.
 */
export function remarkPluginsFor(hasLookbehind: boolean): PluggableList {
  return hasLookbehind ? WITH_GFM : WITHOUT_GFM;
}

/**
 * Probed once, the same way marked probes it — construct one and see. Feature
 * detection rather than a UA test: the question is what this engine can run,
 * and every browser on iPadOS answers it the same way regardless of its name.
 */
export const engineHasLookbehind: boolean = (() => {
  try {
    // eslint-disable-next-line no-new
    new RegExp("(?<=a)b");
    return true;
  } catch {
    return false;
  }
})();

/** The plugin list for this engine. */
export const remarkPlugins: PluggableList = remarkPluginsFor(engineHasLookbehind);
