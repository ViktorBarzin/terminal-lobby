/**
 * The URL hash for a session someone else owns: `#name@owner`, optionally
 * followed by `!<tmux session id>` (ADR-0043).
 *
 * The id is what keeps an invite link working: a session is renamed by its
 * first prompt (ADR-0022), often moments after it was shared, and the name in
 * a link copied before that answers to nothing. The lobby finds the session
 * by its owner and id instead (store/lobby.ts). tmux ids are unique within one
 * owner's server, which is why the owner travels with it.
 */
export interface ForeignHash {
  name: string;
  owner: string;
  id?: string;
}

/** A tmux session id as it appears in the hash: `$` and digits. */
const ID_RE = /^\$\d{1,9}$/;

export function parseForeignHash(hash: string): ForeignHash | null {
  const h = hash.replace(/^#/, "");
  const at = h.indexOf("@");
  if (at <= 0) return null;
  const name = h.slice(0, at);
  const rest = h.slice(at + 1);
  const bang = rest.indexOf("!");
  if (bang < 0) return rest ? { name, owner: rest } : null;
  const owner = rest.slice(0, bang);
  if (!owner) return null;
  let id = rest.slice(bang + 1);
  try {
    id = decodeURIComponent(id);
  } catch {
    /* keep it as written */
  }
  return ID_RE.test(id) ? { name, owner, id } : { name, owner };
}

/** The hash an invite carries. */
export function foreignHash(owner: string, name: string, id?: string): string {
  return `#${name}@${owner}${id && ID_RE.test(id) ? `!${id}` : ""}`;
}
