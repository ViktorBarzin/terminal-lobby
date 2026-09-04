import type { SlashCommand } from "../components/compose.logic";

/**
 * The session's own slash commands, and whether reading them worked.
 *
 * The two used to be one value. `store.commands` returned `[]` for a failed
 * fetch and `[]` for a user with no skills, so a `/` menu that had lost its
 * per-user half was indistinguishable from a complete one — and the failure is
 * quiet by design: every route the ingress does not carry reaches ttyd's
 * `location /` and comes back as the SPA's own index.html, 200 OK and
 * `text/html`, on which `res.json()` throws.
 *
 * Measured 2026-09-04 with `/commands/{session}` unrouted in the dev proxy: 9,406
 * bytes of HTML, the catch swallowing it, and the menu offering the 95 built-ins
 * the page ships and none of this user's 34 skills. Nothing logged, nothing on
 * screen, and a phone with a dropped request lands in the same state.
 */
export interface Catalogue {
  commands: SlashCommand[];
  /** False when the catalogue could not be read, which is not the same as empty. */
  ok: boolean;
}

/** A catalogue that could not be read. The menu still has its built-ins. */
const UNREADABLE: Catalogue = { commands: [], ok: false };

/**
 * Read one catalogue through `get`.
 *
 * `get` is injected rather than called here so the failure shapes are testable
 * without a server: a non-2xx, HTML where JSON was expected, an aborted fetch,
 * and a body that parses but is not a list.
 */
export async function readCatalogue(get: () => Promise<Response>): Promise<Catalogue> {
  let body: unknown;
  try {
    const res = await get();
    if (!res.ok) return UNREADABLE;
    body = await res.json();
  } catch {
    // A dropped request, a deadline, or `res.json()` on the index.html that a
    // missing route serves. None of them is an empty catalogue.
    return UNREADABLE;
  }
  // Go writes `null` for a nil slice, so a user with no skills and no commands
  // arrives as null. That IS an empty catalogue, read successfully.
  if (body === null || body === undefined) return { commands: [], ok: true };
  if (!Array.isArray(body)) return UNREADABLE;
  const commands = (body as SlashCommand[]).filter(
    (c) => !!c && typeof c.name === "string" && c.name !== "",
  );
  return { commands, ok: true };
}
