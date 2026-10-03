/**
 * The terminal size this device last drew, in columns and rows.
 *
 * The New-session composer claims a warm slot at Send, before the new
 * session's terminal attaches (lobby-api `claimSlot`). A slot is started
 * detached at 80x24, so Claude would write its first reply wrapped at 80
 * columns into a phone's 45. The claim carries this size instead, and tmux-api
 * sizes the session to it. The terminal the session then attaches measures
 * itself as usual; this is only the guess that covers the seconds before.
 *
 * Per device, in localStorage: the screen is what decides the size. Storage can
 * be missing or blocked, and then there is no guess and the claim goes without
 * one.
 */

const KEY = "tl:term-size:v1";

/** Records a size a terminal on this device just fitted to. */
export function rememberTermSize(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return;
  try {
    localStorage.setItem(KEY, `${cols}x${rows}`);
  } catch {
    /* no storage: no guess */
  }
}

/** The size last remembered, or nothing. */
export function lastTermSize(): { cols?: number; rows?: number } {
  try {
    const m = /^(\d+)x(\d+)$/.exec(localStorage.getItem(KEY) ?? "");
    return m ? { cols: Number(m[1]), rows: Number(m[2]) } : {};
  } catch {
    return {};
  }
}
