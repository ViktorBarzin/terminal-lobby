/**
 * Pageviews and session replay through Rybbit
 * (docs/adr/0048-usage-events-reach-the-event-pipeline.md, infra ADR-0041).
 *
 * The script is served same-origin from the Ingest path `/_t/r/`, and it runs
 * on the production host only: terminal-lobby is open source, and a lobby on
 * any other box should load nothing. Replay masks password fields and leaves
 * other inputs visible, as the standard sets. index.html carries
 * `<meta name="analytics" content="sdk">`, which tells the edge injection
 * plugin that this page loads the script itself.
 *
 * Once /whoami names the caller's Person id (the Authentik hashed user id the
 * proxy sends), identifyPerson hands it to Rybbit, so a visit joins the same
 * Person the services' Product events name. The lobby has no sign-out of its
 * own (Authentik's session ends it), so there is no clear on sign-out; a
 * different id on the same tab clears the previous one first. Custom browser
 * events are not sent from here: the page's usage events already reach the
 * pipeline through tmux-api's intake.
 */

/** Hosts whose visits count. */
export const PRODUCTION_HOSTS: readonly string[] = Object.freeze(["terminal.viktorbarzin.me"]);

/** The Analytics site every instrumented app shares (`apps`). */
const SITE_ID = "1";

export const SCRIPT_SRC = "/_t/r/script.js";

interface Rybbit {
  identify(id: string): void;
  clearUserId(): void;
}

export interface AnalyticsWindow {
  rybbit?: Rybbit;
}

let loaded = false;
/** The Person id Rybbit was last told, or is waiting to be told. */
let named: string | null = null;
/** An identify waiting for the script to load. */
let pending: string | null = null;

/** Add the Rybbit script on the production host. True when added. */
export function loadAnalytics(doc: Document, hostname: string, win: AnalyticsWindow): boolean {
  if (loaded || !PRODUCTION_HOSTS.includes(hostname)) return false;
  loaded = true;
  const script = doc.createElement("script");
  script.src = SCRIPT_SRC;
  script.defer = true;
  script.setAttribute("data-site-id", SITE_ID);
  script.setAttribute("data-replay-mask-all-inputs", "false");
  script.setAttribute("data-replay-mask-input-options", '{"password":true}');
  script.addEventListener("load", () => {
    if (pending && win.rybbit) {
      win.rybbit.identify(pending);
      pending = null;
    }
  });
  doc.head.appendChild(script);
  return true;
}

/** Name the caller's Person, now or once the script has loaded. */
export function identifyPerson(id: string | undefined, win: AnalyticsWindow): void {
  if (!id || id === named) return;
  const previous = named;
  named = id;
  try {
    if (!win.rybbit) {
      pending = id;
      return;
    }
    if (previous) win.rybbit.clearUserId();
    win.rybbit.identify(id);
  } catch {
    /* analytics never breaks the page */
  }
}

/** Forget what this module has done. For tests. */
export function resetAnalytics(): void {
  loaded = false;
  named = null;
  pending = null;
}
