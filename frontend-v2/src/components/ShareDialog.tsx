import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type Component,
} from "solid-js";
import { Portal } from "solid-js/web";
import {
  sessionLabel,
  type LinkMode,
  type LinkTTL,
  type LinkView,
  type Session,
} from "../types/lobby";
import {
  LINK_TTLS,
  MODE_CHOICES,
  TTL_LABELS,
  clampTtl,
  countVisitors,
  expiryLabel,
  linkUrl,
  linksForSession,
  modeBadge,
  ttlAllowed,
  visitorCountLabel,
  visitorLabel,
} from "./links.logic";
import { createLink, listLinks, revokeLink } from "../lib/links-api";
import type { ShareTarget } from "../store/share-dialog";
import { installDialogFocus, wrapTab } from "../lib/focus-trap";
import { dismissOnPress } from "./overlay";
import { Group, Row } from "./settings/controls";

/**
 * How often an open list re-reads its links. Visitors come and go while the
 * dialog is up, and "guest 1 (driving)" appearing is the reason to look at it.
 * The session poll's own cadence, so the dialog is never staler than the bar.
 */
const LINKS_POLL_MS = 5000;

/** The minute clock that moves "expires in 23 h" along under an open list. */
const CLOCK_TICK_MS = 30_000;

/**
 * Re-read the caller's links every LINKS_POLL_MS while mounted, and keep a
 * wall clock for the expiry wording. Shared by the dialog and the Settings
 * page, which show the same rows.
 */
export function createLinksPoll(): {
  links: Accessor<LinkView[] | null>;
  error: Accessor<string>;
  now: Accessor<number>;
  reload: () => Promise<void>;
} {
  const [links, setLinks] = createSignal<LinkView[] | null>(null);
  const [error, setError] = createSignal("");
  const [now, setNow] = createSignal(Date.now());
  // Only the newest read may land: a revoke reloads while a poll is in flight,
  // and the older answer arriving second would put the revoked row back.
  let seq = 0;
  const reload = async (): Promise<void> => {
    const mine = ++seq;
    try {
      const got = await listLinks();
      if (mine !== seq) return;
      setLinks(got);
      setError("");
    } catch (e) {
      if (mine !== seq) return;
      setError(`Could not load links: ${(e as Error).message}`);
    }
    setNow(Date.now());
  };
  void reload();
  const poll = setInterval(() => void reload(), LINKS_POLL_MS);
  const clock = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
  onCleanup(() => {
    clearInterval(poll);
    clearInterval(clock);
  });
  return { links, error, now, reload };
}

/**
 * One link in a list: its mode, how long it has left, the private note and who
 * is on it, with a Revoke button. The dialog names the visitors; Settings,
 * which lists every session's links, counts them and names the session.
 */
export const LinkRow: Component<{
  link: LinkView;
  now: number;
  /** Settings: name the session and count visitors rather than list them. */
  overview?: boolean;
  onRevoke: (id: string) => void;
}> = (props) => {
  const visitors = (): string =>
    props.overview
      ? visitorCountLabel(countVisitors(props.link.visitors))
      : props.link.visitors.map(visitorLabel).join(", ");
  return (
    <div class="tl-link-row">
      <div class="tl-link-meta">
        <div class="tl-link-line">
          <span class="tl-link-badge" data-mode={props.link.mode}>
            {modeBadge(props.link.mode)}
          </span>
          <Show when={props.overview}>
            <span class="tl-link-session" title={props.link.session}>
              {props.link.title || props.link.session}
            </span>
          </Show>
          <span class="tl-link-expiry">{expiryLabel(props.link.expiresAt, props.now)}</span>
        </div>
        <Show when={props.link.note}>
          <div class="tl-link-note">{props.link.note}</div>
        </Show>
        <Show when={visitors()}>
          <div class="tl-link-visitors">{visitors()}</div>
        </Show>
      </div>
      <button
        type="button"
        class="tl-set-btn tl-set-btn-danger"
        aria-label={`Revoke ${modeBadge(props.link.mode).toLowerCase()} link`}
        onClick={() => props.onRevoke(props.link.id)}
      >
        Revoke
      </button>
    </div>
  );
};

/**
 * Copy text, falling back to selecting it in its field: the async clipboard is
 * missing on a plain-http origin and can be refused, and `execCommand` still
 * works in both cases. When neither does, the text is left selected so a
 * keyboard copy is one keystroke away.
 */
async function copyText(text: string, field: HTMLInputElement | undefined): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!field) return false;
    field.focus();
    field.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    }
  }
}

/**
 * The Share dialog (docs/plans/2026-10-06-public-links-design.md, "What the
 * owner sees"): the session's public links and a form for a new one.
 *
 * Opened from the ⋯ menu of a session you own. The URL is shown once, when the
 * link is made, because the server keeps only a hash of its token.
 */
export const ShareDialog: Component<{
  target: ShareTarget;
  /** The live session list, so the title follows a rename and a kill shows. */
  sessions: Accessor<readonly Session[]>;
  onClose: () => void;
}> = (props) => {
  let dialogEl: HTMLDivElement | undefined;
  let urlEl: HTMLInputElement | undefined;

  const session = createMemo(() =>
    props
      .sessions()
      .find((s) => (props.target.id ? s.id === props.target.id : s.name === props.target.name)),
  );
  const label = (): string => {
    const s = session();
    return s ? sessionLabel(s) : props.target.name;
  };

  const { links, error, now, reload } = createLinksPoll();
  const mine = (): LinkView[] =>
    linksForSession(links() ?? [], {
      id: props.target.id,
      name: session()?.name ?? props.target.name,
    });

  const [mode, setMode] = createSignal<LinkMode>("ro");
  const [ttl, setTtl] = createSignal<LinkTTL>("24h");
  const [note, setNote] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal("");
  const [created, setCreated] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal("");

  const pickMode = (m: LinkMode): void => {
    setMode(m);
    setTtl((t) => clampTtl(m, t));
  };

  const create = async (): Promise<void> => {
    const s = session();
    if (!s || busy()) return;
    setBusy(true);
    setStatus("");
    setCopied("");
    try {
      const got = await createLink({
        name: s.name,
        mode: mode(),
        ttl: ttl(),
        ...(note().trim() ? { note: note().trim() } : {}),
      });
      setCreated(linkUrl(window.location.origin, got.token));
      setNote("");
      await reload();
    } catch (e) {
      setStatus(`Could not create the link: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string): Promise<void> => {
    try {
      await revokeLink(id);
    } catch (e) {
      setStatus(`Could not revoke: ${(e as Error).message}`);
    }
    await reload();
  };

  const copy = async (): Promise<void> => {
    const url = created();
    if (!url) return;
    setCopied((await copyText(url, urlEl)) ? "Copied" : "Selected. Press Ctrl+C to copy");
  };

  // Escape closes and Tab stays inside, as on Settings. Capture, so the key
  // lands here rather than in the terminal that held focus before.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
      return;
    }
    if (e.key === "Tab" && dialogEl) wrapTab(e, dialogEl);
  };
  onMount(() => document.addEventListener("keydown", onKey, true));
  onCleanup(() => document.removeEventListener("keydown", onKey, true));
  installDialogFocus(() => dialogEl);

  return (
    <Portal>
      <div
        class="tl-cmdpalette-backdrop"
        ref={dismissOnPress(() => props.onClose(), { surfaceOnly: true })}
      >
        <div
          ref={dialogEl}
          class="tl-schelp tl-share"
          role="dialog"
          aria-modal="true"
          aria-label={`Share ${label()}`}
          tabindex="-1"
        >
          <h2 class="tl-schelp-title">Share {label()}</h2>
          <div class="tl-schelp-scroll">
            <Group title="Public links">
              <Show
                when={links() !== null}
                fallback={<div class="tl-set-hint tl-set-hint-static">Loading…</div>}
              >
                <Show
                  when={mine().length > 0}
                  fallback={
                    <div class="tl-set-hint tl-set-hint-static">
                      No public links to this session.
                    </div>
                  }
                >
                  <For each={mine()}>
                    {(l) => <LinkRow link={l} now={now()} onRevoke={(id) => void revoke(id)} />}
                  </For>
                </Show>
              </Show>
              <Show when={error()}>
                <div class="tl-set-hint tl-set-hint-static">{error()}</div>
              </Show>
            </Group>

            <Show when={created()}>
              {(url) => (
                <Group title="Your new link">
                  <div class="tl-share-url">
                    <input
                      ref={urlEl}
                      class="tl-share-url-field"
                      type="text"
                      readOnly
                      value={url()}
                      aria-label="Link URL"
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <button
                      type="button"
                      class="tl-set-btn tl-set-btn-go"
                      onClick={() => void copy()}
                    >
                      Copy
                    </button>
                  </div>
                  <div class="tl-set-note">
                    Copy it now; it can't be shown again.
                    <Show when={copied()}> {copied()}.</Show>
                  </div>
                </Group>
              )}
            </Show>

            <Group title="New link">
              <Show
                when={session()}
                fallback={<div class="tl-set-hint tl-set-hint-static">This session has ended.</div>}
              >
                <Row label="Access">
                  <div class="tl-set-seg" role="radiogroup" aria-label="Access">
                    <For each={["ro", "rw"] as const}>
                      {(m) => (
                        <button
                          type="button"
                          role="radio"
                          aria-checked={mode() === m}
                          classList={{ active: mode() === m }}
                          onClick={() => pickMode(m)}
                        >
                          {MODE_CHOICES[m]}
                        </button>
                      )}
                    </For>
                  </div>
                </Row>
                <Show when={mode() === "rw"}>
                  <div class="tl-share-warn" role="note">
                    Anyone with this link gets a shell as you, until it expires or you revoke it.
                  </div>
                </Show>
                <Row label="Lifetime">
                  <div class="tl-set-seg" role="radiogroup" aria-label="Lifetime">
                    <For each={LINK_TTLS}>
                      {(t) => (
                        <button
                          type="button"
                          role="radio"
                          aria-checked={ttl() === t}
                          classList={{ active: ttl() === t }}
                          disabled={!ttlAllowed(mode(), t)}
                          title={
                            ttlAllowed(mode(), t)
                              ? undefined
                              : "A link that can type lasts at most 24 hours"
                          }
                          onClick={() => setTtl(t)}
                        >
                          {TTL_LABELS[t]}
                        </button>
                      )}
                    </For>
                  </div>
                </Row>
                <Row label="Note" labelFor="tl-share-note">
                  <input
                    id="tl-share-note"
                    class="tl-share-note-field"
                    type="text"
                    maxLength={80}
                    placeholder="Only you see this"
                    value={note()}
                    onInput={(e) => setNote(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void create();
                    }}
                  />
                </Row>
                <div class="tl-share-actions">
                  <button
                    type="button"
                    class="tl-set-btn tl-set-btn-go"
                    disabled={busy()}
                    onClick={() => void create()}
                  >
                    Create link
                  </button>
                </div>
              </Show>
              <Show when={status()}>
                <div class="tl-set-hint tl-set-hint-static">{status()}</div>
              </Show>
            </Group>
          </div>
          <div class="tl-restore-footer">
            <button type="button" class="tl-foot-btn" onClick={() => props.onClose()}>
              Close
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
};
