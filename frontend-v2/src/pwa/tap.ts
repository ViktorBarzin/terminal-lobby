/**
 * Which notification did the user tap, and why do we say so?
 *
 * ONE pure function answers both. It replaces three overlapping ones
 * (pickTappedSession decided, stashIsActionable decided what got REPORTED,
 * stashExpired decided what got deleted), which could disagree: the journal then
 * said `stale` about a tap that had actually been refused for a different
 * reason, and every fix after that was a guess.
 *
 * What the platform gives us to work with:
 *   - An installed iOS PWA gets NO notificationclick. Tapping a banner
 *     foregrounds the app with no argument and, when it was killed, cold-launches
 *     it with no argument. Measured on Viktor's phone 2026-09-02.
 *   - iOS DOES clear the banner it opened and leaves the others alone. So a
 *     record whose banner has gone from the shade was tapped or dismissed, and
 *     that is the only signal there is.
 *   - Where a click IS delivered (Chrome, and the warm-window branch of sw.js),
 *     the worker writes `tapped: true`. That is evidence, not inference.
 *
 * The numbers this is built against. Seven days of notify.stash_read after the
 * per-session records landed: acted 51, already 11, untapped 156, stale 201,
 * absent 376. Only 51 of 795 reads routed anywhere, and the largest single bucket
 * was records thrown away for age.
 *
 * Everything here is synchronous, total and side-effect free. The caller reads
 * the shade ONCE (`reg.getNotifications()` with no argument) and passes the
 * tags in. Do not put that call in here: getNotifications({tag}) only began
 * honouring its filter in WebKit main on 2024-08-29, no release note says which
 * iOS shipped it, and same-tag banners do not coalesce on iOS anyway
 * (WebKit bug 258922), so a per-tag count is not something to build on.
 */
import { NAME_RE } from "../types/lobby";

/**
 * The record sw.js writes into db 'tl-notif', store 'pending', one per session
 * keyed by the session NAME (an opaque 12-character id since ADR-0019; what the
 * banner SAYS is the title, which is not an address). `last` is a legacy mirror
 * of one of them.
 */
export interface PendingNotif {
  session: string;
  ts: number;
  /** true when the worker saw a real notificationclick, not a push receipt. */
  tapped?: boolean;
}

/**
 * What IndexedDB actually hands back: rows written by older builds of the
 * worker, or half-written ones. Validated here rather than trusted, so a
 * `PendingNotif` fits without a cast and junk fits without an `any`.
 */
export interface StoredRecord {
  session?: unknown;
  ts?: unknown;
  tapped?: unknown;
}

/**
 * The vocabulary of notify.stash_read's tl.reason. The five words are the same
 * five, but two of them changed populations in this rewrite, so a `stale` count
 * from before it and one from after it are NOT the same measurement:
 *
 *   absent   nothing usable was waiting (no rows, or only unreadable ones)
 *   stale    rows were waiting, all of them past their window
 *   untapped live rows, none of them a tap: the app was opened by its icon
 *   acted    this session was tapped, go there
 *
 * The old build called a read `stale` whenever no record passed its actionable
 * test, which swept up aged receipts whose banner was still on screen. Those
 * now read `untapped`, which is what they always were. So `stale` here means
 * the age gate alone, and comparing the 201 `stale` reads measured over the
 * seven days to 2026-09-06 against a `stale` count from this build understates
 * how far the widened window moved things. `untapped` widened by the same rows.
 *
 * The caller still owns `already`, and only that one: whether the app is
 * ALREADY showing the session we picked depends on what is on screen, which
 * this function cannot see. It downgrades `acted` to `already` in that case.
 */
export type TapReason = "acted" | "already" | "untapped" | "stale" | "absent";

export interface TapPick {
  /** The session to switch to, or null. Null is always safe. */
  session: string | null;
  /** Exactly what the caller reports as tl.reason. One decision, one story. */
  reason: TapReason;
}

/**
 * How long a push RECEIPT counts on its own, with no evidence the banner was
 * touched. A receipt is a guess that the user is about to act, so it stays
 * tight: 2 min is wide enough for a tap and a cold launch, tight enough that an
 * icon launch rarely lands inside one.
 */
export const RECEIPT_FRESH_MS = 120 * 1000;

/**
 * The outer window for a receipt. Past it the row is finished with, banner or
 * no banner: a shade someone cleared this morning is not intent.
 *
 * It was 15 min for receipts AND clicks alike. Pushes for one session are a
 * median of 956 s apart, so 15 min sits below the interval at which the next
 * push arrives, and `stale` swallowed 201 of 795 reads in a week. An hour
 * covers a tap answered after a meeting. The exact hour is a judgement call,
 * not a measurement; what the numbers say is only that 15 min was too short.
 *
 * Read those 201 as an upper bound, not as 201 age-gate rejections: the build
 * that produced them also said `stale` when a live record's banner was still on
 * screen (see TapReason). How many of the 201 the age gate alone accounts for is
 * not recoverable from that week, and the next week of journal, measured against
 * this build, is what would settle the hour.
 */
export const RECEIPT_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * The outer window for a recorded CLICK. A click is not a guess, so it lives
 * until it is consumed rather than expiring on the receipt clock. The only
 * thing it waits for is the launch that follows it, which can be seconds
 * (foregrounding) or minutes (a cold launch on a phone that has to wake, unlock
 * and re-download the app shell). 6 h is far longer than any of that, and short
 * enough that a row still sitting there the next morning is dropped rather than
 * yanking the reader into yesterday's conversation.
 */
export const TAP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** The notification tag sw.js gives a session's banner. */
export function tagFor(session: string): string {
  return "tl-" + session;
}

/** The window this row gets, which depends on whether it is a click or a guess. */
function maxAgeFor(rec: PendingNotif): number {
  return rec.tapped ? TAP_MAX_AGE_MS : RECEIPT_MAX_AGE_MS;
}

/**
 * A row we can read, or null. A name that is not a name, a ts that is not a
 * finite number, and a ts in the future are all rows no launch should act on:
 * we cannot tell what they mean, and guessing is what the reason vocabulary
 * exists to stop. A row written ahead of `now` means the device clock moved
 * between the push and the launch; the next push rewrites it.
 */
function wellFormed(rec: StoredRecord | null | undefined, now: number): PendingNotif | null {
  if (!rec) return null;
  const { session, ts } = rec;
  if (typeof session !== "string" || !NAME_RE.test(session)) return null;
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts > now) return null;
  return { session, ts, tapped: rec.tapped === true };
}

/**
 * Newest first, ties broken by name so the answer never depends on the order
 * IndexedDB happened to hand the rows over in.
 */
function newestFirst(a: PendingNotif, b: PendingNotif): number {
  if (a.ts !== b.ts) return b.ts - a.ts;
  return a.session < b.session ? -1 : a.session > b.session ? 1 : 0;
}

/**
 * One row per session. The legacy `last` slot mirrors one of the per-session
 * rows, so the same push can arrive twice; a click beats a receipt for the same
 * session, and otherwise the newer copy wins.
 */
function bySession(
  records: readonly (StoredRecord | null | undefined)[],
  now: number,
): PendingNotif[] {
  const best = new Map<string, PendingNotif>();
  for (const raw of records) {
    const rec = wellFormed(raw, now);
    if (!rec) continue;
    const prev = best.get(rec.session);
    if (!prev) {
      best.set(rec.session, rec);
      continue;
    }
    if (rec.tapped !== prev.tapped) {
      if (rec.tapped) best.set(rec.session, rec);
      continue;
    }
    if (rec.ts > prev.ts) best.set(rec.session, rec);
  }
  return [...best.values()];
}

/**
 * The shade as a set, or null when the caller could not read it at all.
 *
 * The distinction carries weight, so the caller has to make it: `[]` means
 * getNotifications answered and nothing is on screen, which is exactly the
 * state a tap leaves behind. `null` means no registration, no getNotifications,
 * or a throw, and nothing may be inferred from silence.
 */
function shadeSet(
  displayedTags: readonly string[] | ReadonlySet<string> | null | undefined,
): ReadonlySet<string> | null {
  if (displayedTags === null || displayedTags === undefined) return null;
  return new Set<string>(displayedTags);
}

/**
 * How good the evidence behind this row is. Lower is stronger, null means the
 * row is not a candidate at all.
 *
 *   0 CLICKED  the worker saw a real notificationclick. Not an inference.
 *   1 GONE     the shade answered and this banner is no longer in it, which on
 *              iOS means it was tapped or dismissed.
 *   2 FRESH    a push receipt inside its own window, with the banner still on
 *              screen or the shade unreadable. A guess that the user is about
 *              to act, and the only thing there is when the shade says nothing.
 *
 * The tiers exist because a launch with GONE evidence for one session and a
 * FRESH receipt for another must land on the gone one. Ranking every candidate
 * by timestamp instead is the 2026-09-02 bug: pushes for `issues` and `ux`
 * arrive 60 s apart, the reader taps `issues`, iOS clears its banner and leaves
 * `ux` on screen, and newest-first opens `ux`. The shade said which one, and
 * the clock overruled it.
 */
type Tier = 0 | 1 | 2;
const TIER_CLICKED: Tier = 0;
const TIER_GONE: Tier = 1;
const TIER_FRESH: Tier = 2;

function tierOf(
  rec: PendingNotif,
  now: number,
  displayed: ReadonlySet<string> | null,
): Tier | null {
  // A recorded click beats every inference, including the shade: iOS does not
  // always clear the banner (WebKit bug 258922 keeps duplicate-tag banners on
  // screen), and the click already told us what the shade is being asked to.
  if (rec.tapped) return TIER_CLICKED;
  if (displayed !== null) {
    // The shade answered. A banner that has gone was tapped or dismissed; a
    // banner still sitting there is positive evidence the reader has NOT
    // touched it, however recent the push was, so nothing promotes it.
    //
    // Freshness used to promote it anyway, and that is a wrong jump rather
    // than a missed one: on a desktop, returning to the window within
    // RECEIPT_FRESH_MS of a push nobody tapped moved the reader off the
    // session they were reading. Nothing is lost by refusing it. Where a click
    // is delivered at all (Chrome, Android, and the warm branch of sw.js) the
    // row is already CLICKED, and on iOS 18.4+ the declarative navigate URL
    // says which banner the OS opened before this function has to guess.
    return displayed.has(tagFor(rec.session)) ? null : TIER_GONE;
  }
  // The shade could not be read: no registration, no getNotifications, or a
  // throw. Nothing can be proven gone, so a recent receipt is the only signal
  // left and it carries the launch on its own window.
  if (now - rec.ts < RECEIPT_FRESH_MS) return TIER_FRESH;
  // An aged receipt with no shade to corroborate it is not evidence of
  // anything: a launch the reader did not ask to be redirected must not be.
  return null;
}

/**
 * Decide which pending notification the launch belongs to.
 *
 * @param records       every row read from the 'pending' store, in any order.
 * @param displayedTags tags of the notifications still in the shade, from ONE
 *                      `reg.getNotifications()` with no argument; null when it
 *                      could not be read.
 * @param now           injected clock, so the whole decision is reproducible.
 * @param navigated     the session the OS itself opened this launch on, from
 *                      the `?session=` of a Declarative Web Push navigate URL
 *                      (pwa/register.ts navigatedSession). Null on every other
 *                      path.
 */
export function pickTap(
  records: readonly (StoredRecord | null | undefined)[],
  displayedTags: readonly string[] | ReadonlySet<string> | null | undefined,
  now: number,
  navigated: string | null = null,
): TapPick {
  const rows = bySession(records, now);
  if (rows.length === 0) return { session: null, reason: "absent" };

  const live = rows.filter((r) => now - r.ts <= maxAgeFor(r));
  if (live.length === 0) return { session: null, reason: "stale" };

  // The OS said which banner it opened, and nothing inferred here outranks
  // that. iOS 18.4+ never dispatches notificationclick for a declarative
  // notification (Notifications spec 2.7 steps 5 and 6); it navigates to the
  // `navigate` URL instead, and that URL names the session.
  //
  // Trusted ONLY when a live record backs it, which is the interlock that keeps
  // a STALE url out. The query survives the navigation (nothing rewrites it),
  // and an installed PWA is restored at the URL it was last showing, so
  // `?session=` on an icon launch may be yesterday's tap. A record for it that
  // is still live is the second witness; without one the URL is ignored and the
  // stash decides as usual.
  if (navigated !== null && NAME_RE.test(navigated)) {
    const row = live.find((r) => r.session === navigated);
    if (row) return { session: row.session, reason: "acted" };
  }

  const displayed = shadeSet(displayedTags);
  const ranked: { rec: PendingNotif; tier: Tier }[] = [];
  for (const r of live) {
    const tier = tierOf(r, now, displayed);
    if (tier !== null) ranked.push({ rec: r, tier });
  }
  if (ranked.length === 0) return { session: null, reason: "untapped" };

  // Evidence first, inference second, then newest WITHIN the tier. Sorting the
  // whole pool by time instead lets a fresh receipt outrank a banner the reader
  // demonstrably cleared.
  const best = ranked.reduce((a, b) =>
    b.tier < a.tier || (b.tier === a.tier && newestFirst(b.rec, a.rec) < 0) ? b : a,
  );
  return { session: best.rec.session, reason: "acted" };
}

/**
 * Which rows are finished with and safe to delete?
 *
 * Deliberately much narrower than "pickTap did not choose it". A receipt whose
 * banner is still on screen was not chosen and is NOT spent: the reader has not
 * tapped it yet, and will. An earlier version deleted everything the actionable
 * test refused, so opening the app by its icon erased the record behind every
 * notification still in the shade and the tap minutes later found nothing. Over
 * 72 hours on that build 44 of 237 reads came back `absent`, 16 of them with a
 * record written inside the window.
 *
 * Spent means one of three things: past its own window, unreadable (it can
 * never route anything), or acted on by this launch.
 *
 * @param acted the session the caller is switching to, if any. Passed in so the
 *              consume and the prune are one write.
 */
export function spentSessions(
  records: readonly (StoredRecord | null | undefined)[],
  now: number,
  acted: string | null = null,
): string[] {
  const spent = new Set<string>();
  const live = new Set<string>();
  for (const raw of records) {
    // The store is keyed BY the session name, so a row whose name is not a
    // usable string cannot be named for deletion. It is left where it is; it
    // costs one ignored row per read and nothing else.
    const name =
      raw && typeof raw.session === "string" && raw.session.length > 0 ? raw.session : null;
    if (!name) continue;
    const rec = wellFormed(raw, now);
    if (!rec) {
      spent.add(name);
      continue;
    }
    if (now - rec.ts <= maxAgeFor(rec)) live.add(name);
    else spent.add(name);
  }
  // A duplicated session with one live copy stays: deleting by name would take
  // the live copy with it.
  for (const name of live) spent.delete(name);
  if (acted) spent.add(acted);
  return [...spent];
}
