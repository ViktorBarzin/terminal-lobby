import { createEffect, onCleanup, untrack, type Accessor } from "solid-js";

/**
 * The phone's Back closes the overlay on top, the way a native sheet does.
 *
 * Found in the deployed reviews (2026-09-28): Android's Back with the picture
 * lightbox or the model sheet up left the overlay on screen and moved the
 * browser's history instead, which on the lobby means leaving the page. An
 * open overlay now pushes one history entry of its own, and the `popstate`
 * that Back fires closes it. iOS's edge swipe back fires the same event.
 *
 * Overlays stack: Back closes the newest one only. One that closes some other
 * way (Escape, a pick, a press outside) takes its entry back off, and the
 * `popstate` that causes closes nothing else: each entry's state says how deep
 * it is, so a `popstate` closes exactly the overlays above where it landed.
 */

interface Entry {
  /** Its place in the stack, written into its history entry's state. */
  depth: number;
  close: () => void;
}

const stack: Entry[] = [];
let listening = false;

/** How many overlay entries the history entry now current says are under it. */
function depthOf(state: unknown): number {
  const d = (state as { tlOverlay?: unknown } | null)?.tlOverlay;
  return typeof d === "number" ? d : 0;
}

/**
 * Every overlay whose entry is no longer in the history closes. A Back from
 * an overlay's own entry lands one below it; the Back an overlay takes when
 * it closes some other way lands below an entry already off the stack, so
 * nothing else closes.
 */
function onPop(e: PopStateEvent): void {
  const d = depthOf(e.state);
  while (stack.length > 0 && stack[stack.length - 1]!.depth > d) stack.pop()!.close();
}

function listen(): void {
  if (listening || typeof window === "undefined") return;
  window.addEventListener("popstate", onPop);
  listening = true;
}

/** Take `e` off the stack and its history entry with it. */
function release(e: Entry): void {
  const i = stack.indexOf(e);
  if (i < 0) return;
  stack.splice(i, 1);
  try {
    window.history.back();
  } catch {
    /* no history */
  }
}

/**
 * While `open()` is true, Back calls `close`, which must make `open()` false.
 * Registers on the current owner and gives its entry back on cleanup.
 */
export function closeOnBack(open: Accessor<boolean>, close: () => void): void {
  listen();
  let entry: Entry | null = null;
  createEffect(() => {
    const isOpen = open();
    untrack(() => {
      if (isOpen && !entry) {
        const e: Entry = {
          depth: stack.length + 1,
          close: () => {
            entry = null;
            close();
          },
        };
        try {
          window.history.pushState({ tlOverlay: e.depth }, "", window.location.href);
        } catch {
          return;
        }
        entry = e;
        stack.push(e);
      } else if (!isOpen && entry) {
        const e = entry;
        entry = null;
        release(e);
      }
    });
  });
  onCleanup(() => {
    if (!entry) return;
    const e = entry;
    entry = null;
    release(e);
  });
}
