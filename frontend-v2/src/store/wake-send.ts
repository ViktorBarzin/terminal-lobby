/**
 * Sending to a session the idle sweep has suspended.
 *
 * A suspended session's pane holds a dead claude behind a frozen scrollback
 * (tmux-api/suspend.go), and session-events refuses a prompt to it with 409.
 * So a Send there wakes the session first and then sends, in one act a person
 * started: it is their message, and nothing is typed on a schedule.
 *
 * WHY THE SEND WAITS ON THE SERVER. tmux-api clears the suspend mark right
 * after `respawn-pane`, while `claude --resume` takes 1.7-3.1 s more to draw
 * its input line. A prompt injected in that window lands in the input box and
 * its Enter never takes. Found in review on 2026-09-27 against 0.78.0: the
 * text sat unsent in Claude's input box while the view drew it as sent and
 * showed "Working" until a reload. So the send asks for the readiness wait
 * (session-events `awaitReady`), which holds until the pane draws Claude's own
 * `❯` and holds still. `respawn-pane` clears the visible screen, so the frozen
 * scrollback's old prompt cannot satisfy that check.
 *
 * WHY NOT HOLD THE TEXT UNTIL SOMEONE RESUMES. The composer used to keep the
 * message in module memory until the sidebar row was clicked. Opening a session
 * by URL, hash or notification never clicked the row, so nothing woke the
 * session, the field was already empty, and a reload lost the words. Here the
 * composer clears optimistically as for any send and gets the text back if the
 * wake or the send fails.
 */
export interface WakeSendOptions {
  /** True while the session has no claude to talk to. */
  suspended: () => boolean;
  /** Ask tmux-api to bring the session back; false when it would not. */
  resume: () => Promise<boolean>;
  /** The session store's send, POST /prompt. */
  send: (text: string, opts?: { awaitReady?: boolean }) => Promise<boolean>;
  notify?: (msg: string, kind: "info") => void;
  /**
   * Show the message as sending while the session wakes, and hand back what
   * takes it down again. Before this the field emptied and nothing showed it for
   * about 2 s (deployed review round 5, 2026-09-29).
   */
  hold?: (text: string) => () => void;
}

/** The composer's send for one session, waking it first when it is suspended. */
export function sendWaking(o: WakeSendOptions): (text: string) => Promise<boolean> {
  return async (text) => {
    if (!o.suspended()) return o.send(text);
    o.notify?.("Waking the session. Your message goes in once Claude is ready.", "info");
    const release = o.hold?.(text);
    try {
      if (!(await o.resume())) return false;
    } finally {
      // Before the send, which puts up its own before its first await, so no
      // frame is drawn with neither or with both.
      release?.();
    }
    return o.send(text, { awaitReady: true });
  };
}
