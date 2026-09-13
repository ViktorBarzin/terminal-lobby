/**
 * The modes a departed program leaves behind, and why a reattach clears them.
 *
 * Mouse tracking and focus reporting are the only two things xterm puts on the
 * wire that nobody asked it for. Every other byte a terminal sends is a key
 * someone pressed, a paste someone made, or an answer to a question the program
 * on the other end asked. These two are the terminal volunteering: once a
 * program sets `?1002h`, moving the pointer across the grid emits a report per
 * motion event, for as long as the mode stays set.
 *
 * The mode stays set across a disconnect, because the modes belong to the
 * xterm instance and the lobby keeps that instance alive. `keepalive.ts` holds
 * every visited session mounted for 24 h, and a session 30 s off screen parks:
 * the socket closes, the pty dies, the tmux client goes with it, and the
 * terminal sits there still in whatever tracking mode the dead tmux had asked
 * for. Come back and it starts reporting the pointer into a socket whose other
 * end is a shell script that has not exec'd tmux yet.
 *
 * WHAT THAT LOOKS LIKE, measured on this box 2026-09-12 against the deployed
 * build. A pty is created in the line discipline's default state, which is
 * canonical mode with ECHO on, and stays there until tmux attaches and asks for
 * raw. ttyd forking `tmux-attach.sh`, sudo, and the tmux attach take ~500 ms,
 * and every byte that arrives inside that window is echoed straight back:
 *
 *     t=53 ms    handshake, socket open
 *     t=58 ms    ^[[<35;7;3M      <- first pointer motion, echoed onto the grid
 *     ...        24 more reports, all echoed
 *     t=560 ms   tmux's first output frame wipes the screen and redraws
 *
 * So switching to a session showed half a second of `^[[<35;19;3M^[[<35;22;5M`
 * accumulating across the top of the terminal before the redraw cleared it.
 * That is the bug this exists to stop, reported as "characters printed into the
 * stream ... the same characters from moving my cursor".
 *
 * CLEARING THE MODES IS THE FIX RATHER THAN GATING THE SOCKET, because it is
 * true rather than merely effective. A terminal with no program attached is not
 * in mouse-tracking mode; it is a terminal nobody has asked anything of yet.
 * Holding the reports back at the send path would leave xterm generating them,
 * and would mean deciding what to do with a report that has nowhere to go —
 * held.ts refuses one (`isHoldable` rejects the ESC it starts with) and the
 * component words that refusal as "Tab, arrows and control keys need the
 * session", which is a toast per pointer movement.
 *
 * TRACKING AND FOCUS ONLY. Three modes are deliberately NOT here:
 *
 * - The ENCODINGS (`?1005`, `?1006`, `?1015`) decide the shape of a report, not
 *   whether one is sent. With tracking off they produce nothing, and tmux sets
 *   the one it wants in the same breath as the tracking mode — the redraw above
 *   carries `?1006h?1000h?1002h` as one write.
 * - BRACKETED PASTE (`?2004`) changes what a paste MEANS. Claude Code reads the
 *   wrapper to tell a paste from typing, so dropping it would turn a paste that
 *   lands in the gap into keystrokes. A paste is a person asking for something;
 *   it should arrive, wrapper and all.
 * - APPLICATION CURSOR KEYS (`?1h`) likewise: an arrow pressed in the gap is
 *   intent, and it should reach the session in the encoding the session
 *   expects.
 *
 * The rule that separates the two lists is whether a person did something. A
 * pointer crossing the grid is not an act of communication, and neither is a
 * window taking focus.
 */

/**
 * DECRST for every mode that makes xterm speak on its own.
 *
 * Written INTO the terminal, never onto the socket: this is the client-side
 * state changing, the same way it would change if a program had sent the
 * sequence. `?1000` is click tracking, `?1002` adds drag, `?1003` adds plain
 * motion (the `<35` reports above are its work — 32 for motion plus 3 for no
 * button held), and `?1004` is focus reporting, the source of the `\x1b[I` and
 * `\x1b[O` that go out when a session switch moves the keyboard.
 *
 * Order does not matter; they are independent flags. Kept as one string so a
 * reattach is one write.
 */
export const DETACHED_MODE_RESET = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l";
