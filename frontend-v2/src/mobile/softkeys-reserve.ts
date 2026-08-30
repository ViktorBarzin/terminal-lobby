import { createEffect, onCleanup, type Accessor } from "solid-js";

/**
 * Publish `body.has-soft-keys`, which app.css reads to reserve a real height so
 * both views sit above the soft-key toolbar and the keyboard.
 *
 * INSTALL ONCE PER APP, not per session. This lived in SessionView until
 * 2026-08-30, and the shell keeps every opened session mounted — so N sessions
 * meant N effects writing one shared class, and the first session to close ran
 * its cleanup and removed it for all the others. Nothing put it back: the
 * effect only re-runs when the pointer type changes, which it does not. Closing
 * one session on a phone therefore dropped the reservation for the rest and put
 * their composer under the keyboard. Same shape as the installViewportSync bug
 * fixed a day earlier, and the same fix — the writer belongs to the app.
 *
 * The class stays on in text mode, where no toolbar is mounted: it then
 * reserves 0 for the toolbar and keeps the keyboard offset, which is what lifts
 * the composer clear.
 */
export function installSoftKeysReserve(coarse: Accessor<boolean>): void {
  if (typeof document === "undefined") return;
  createEffect(() => {
    document.body.classList.toggle("has-soft-keys", coarse());
  });
  onCleanup(() => document.body.classList.remove("has-soft-keys"));
}
