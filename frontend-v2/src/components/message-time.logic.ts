/**
 * When a message in the Text view was sent, in the words a chat app uses: the
 * time for today, "Yesterday" and a weekday within the week, a date before
 * that, and the year once it is not this one. A session can run for weeks, so
 * a bare time would read as today for a message from last Tuesday.
 *
 * Local time and the browser's locale throughout, as the skill rows' clock
 * (rows.tsx `clockTime`) is.
 */
export function messageTime(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = daysBetween(at, now);
  if (days === 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const date = d.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${date} ${time}`;
}

/** The whole moment, for the hover title: "Tuesday 3 November 2026 at 14:05". */
export function messageTimeFull(at: number): string {
  return new Date(at).toLocaleString([], { dateStyle: "full", timeStyle: "short" });
}

/**
 * How long until the next local midnight, which is when "14:05" has to become
 * "Yesterday 14:05" on a tab left open overnight.
 */
export function msUntilMidnight(now: number): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next.getTime() - now;
}

/** Calendar days from `a` to `b`, by local midnights, so DST cannot shift it. */
function daysBetween(a: number, b: number): number {
  const midnight = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  return Math.round((midnight(b) - midnight(a)) / 86_400_000);
}
