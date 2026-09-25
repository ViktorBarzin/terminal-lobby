import { createSignal, type Accessor } from "solid-js";
import { apiUrl } from "./config";
import { fetchWithDeadline } from "./http";
import { isPiModelRef } from "./models";

/**
 * The models a pi session can start on, for the caller's OS user.
 *
 * Claude's and codex's rows are written down in lib/models.ts, because neither
 * CLI prints what an account can run before a session exists. Pi does:
 * `pi --list-models` answers from the user's own sign-in without starting
 * anything, and pi is where people on the box sign into different providers.
 * So tmux-api runs it as the user (`tmux-user-attach --pi-models`, the way
 * `--probe` answers GET /new-commands), keeps the rows that match the user's
 * `enabledModels`, and serves them as GET /pi-models (ADR-0031).
 *
 * The list is pi's catalogue for the providers a user signed into, not an
 * entitlement check: a model the account cannot use still appears, and
 * choosing it shows the provider's error in the session.
 *
 * One copy per page. The new-session composer refreshes it each time it opens
 * with pi chosen, and a pi session's model chip reads whatever the page has,
 * asking only if nothing has been read yet. Each read costs the server a login
 * shell running pi, which is why two callers asking at once share one.
 */

/** One row, as tmux-api serves it. */
export interface PiModel {
  /** `provider/id`: what pi's `--model` and `/model` take, and what is sent. */
  ref: string;
  provider: string;
  id: string;
  /** Whether the model reasons at all. One that does not supports only `off`. */
  thinking: boolean;
}

export interface PiModels {
  /** Whether pi has a provider signed in for this user. */
  signedIn: boolean;
  models: PiModel[];
  /** Why the list could not be read, when it could not. */
  error?: string;
}

/**
 * Validate-or-drop a GET /pi-models body. Null for something that is not an
 * answer at all. A row whose reference the attach would refuse is dropped
 * rather than offered, because the reference goes onto a launch command line.
 */
export function parsePiModels(raw: unknown): PiModels | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const models: PiModel[] = [];
  for (const row of Array.isArray(o.models) ? o.models : []) {
    if (!row || typeof row !== "object") continue;
    const m = row as Record<string, unknown>;
    if (!isPiModelRef(m.ref)) continue;
    models.push({
      ref: m.ref,
      provider: typeof m.provider === "string" ? m.provider : "",
      id: typeof m.id === "string" ? m.id : "",
      thinking: m.thinking === true,
    });
  }
  const out: PiModels = { signedIn: o.signedIn === true, models };
  if (typeof o.error === "string" && o.error !== "") out.error = o.error;
  return out;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const [answer, setAnswer] = createSignal<PiModels | undefined>(undefined);
let inFlight: Promise<PiModels | undefined> | null = null;

/** What this page last heard; undefined until the first answer lands. */
export const piModels: Accessor<PiModels | undefined> = answer;

async function read(fetchImpl: FetchLike): Promise<PiModels | undefined> {
  try {
    const res = await fetchImpl(apiUrl("/pi-models"), { cache: "no-store" });
    if (!res.ok) return answer();
    const parsed = parsePiModels(await res.json());
    if (parsed) setAnswer(parsed);
  } catch {
    // A blip, or a body that was not JSON. The picker keeps what it had.
  }
  return answer();
}

/**
 * Ask again. A caller arriving while a read is in flight gets that read. A
 * read that fails leaves the previous answer in place: a blip must not empty a
 * picker that was working a moment ago.
 */
export function refreshPiModels(
  fetchImpl: FetchLike = fetchWithDeadline,
): Promise<PiModels | undefined> {
  if (inFlight) return inFlight;
  // Cleared in a `finally` chained on the outside, so it runs after this
  // assignment even when the fetch throws before it returns a promise.
  const pending: Promise<PiModels | undefined> = read(fetchImpl).finally(() => {
    if (inFlight === pending) inFlight = null;
  });
  inFlight = pending;
  return pending;
}

/** Ask only if this page has no answer yet. */
export function ensurePiModels(
  fetchImpl: FetchLike = fetchWithDeadline,
): Promise<PiModels | undefined> {
  const have = answer();
  return have ? Promise.resolve(have) : refreshPiModels(fetchImpl);
}

/** Forget the page's copy. Tests share one module per file, so they need it. */
export function resetPiModels(): void {
  setAnswer(undefined);
  inFlight = null;
}
