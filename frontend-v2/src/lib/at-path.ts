/**
 * The directory an `@` completion lists, as an absolute path, or null when a
 * relative token has no directory to start from.
 *
 * A relative token is the session's: its pane's working directory first (the
 * session list's `cwd`), then the project it is filed under. Before the first
 * deployed review (2026-09-28) it used only the project, so a session outside
 * one listed "/", which file-api refuses, and the menu never opened.
 */
export function atListTarget(
  dir: string,
  where: { cwd?: string | undefined; projectDir?: string | undefined },
): string | null {
  if (dir.startsWith("/")) return dir;
  const base = where.cwd || where.projectDir || "";
  if (!base) return null;
  return `${base}/${dir}`.replace(/\/+/g, "/");
}
