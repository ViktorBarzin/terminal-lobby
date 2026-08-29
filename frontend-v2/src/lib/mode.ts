import type { Whoami } from "../types/lobby";

/**
 * Which features this box has.
 *
 * A single-user install has one account: no user map, no sudo, nobody to share
 * with and nobody to act as. The act-as picker is hidden there rather than
 * offered-and-empty, because a picker that opens onto nobody reads as a defect
 * rather than as a mode.
 *
 * multiUser() is exported for the surfaces that do not exist in the SPA yet.
 * The share and member controls live in tmux-api's API and have no frontend; when
 * they get one it gates on this rather than on an empty /users response, which
 * would conflate single-user with a failed request.
 *
 * The server answers this on /whoami. The frontend does not infer it from an
 * empty /users list, which would conflate "single-user" with "the request
 * failed".
 */

/** Whether this box runs multi-user. An older server sends no flag; treating
 *  that as multi-user leaves its behaviour exactly as it is today. */
export function multiUser(w: Whoami | null | undefined): boolean {
  return w?.multiUser !== false;
}

/** Whether to offer the act-as picker. Both conditions, not either: single-user
 *  has one account, so there is nobody to act as even for an administrator. */
export function canActAs(w: Whoami | null | undefined): boolean {
  return w?.admin === true && multiUser(w);
}
