import { For, Show, createMemo, createSignal, onMount, type Component } from "solid-js";
import { listUsers } from "../lib/lobby-api";
import {
  createShare,
  inviteUrl,
  listShares,
  removeShare,
  type ShareMode,
  type ShareView,
} from "../lib/shares-api";
import { copyText } from "./copy-text";
import { Group, Row } from "./settings/controls";

/** What the dialog calls each mode. */
const MODE_LABELS: Record<ShareMode, string> = { rw: "Drive", ro: "Watch" };

/** What each mode lets the other person do, said where they choose it. */
const MODE_NOTES: Record<ShareMode, string> = {
  rw: "Drive: they see the session and type into it, terminal and composer, as you, with your files, credentials and spend.",
  ro: "Watch: they see the session live and cannot type into it.",
};

/**
 * The People half of the Share dialog (ADR-0043): who else on this box may
 * open this session, and how far. Each person can be moved between Watch and
 * Drive or removed, which detaches them at once; an invite reaches the other
 * person as a push and under Shared with me in their sidebar.
 */
export const SharePeople: Component<{
  /** The session's tmux name now. */
  name: string;
  /** You: the session's owner. */
  me: string;
}> = (props) => {
  const [shares, setShares] = createSignal<ShareView[] | null>(null);
  const [users, setUsers] = createSignal<string[]>([]);
  const [guest, setGuest] = createSignal("");
  const [mode, setMode] = createSignal<ShareMode>("rw");
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal("");
  const [copied, setCopied] = createSignal("");
  let urlEl: HTMLInputElement | undefined;

  const reload = async (): Promise<void> => {
    try {
      setShares(await listShares());
    } catch (e) {
      setShares([]);
      setStatus(`Could not load who has access: ${(e as Error).message}`);
    }
  };
  onMount(() => {
    void reload();
    void listUsers().then(setUsers);
  });

  const mine = createMemo(() =>
    (shares() ?? [])
      .filter((s) => s.owner === props.me && s.name === props.name)
      .sort((a, b) => a.guest.localeCompare(b.guest)),
  );
  /** Everyone who could still be invited: not you, not already in. */
  const candidates = createMemo(() => {
    const taken = new Set(mine().map((s) => s.guest));
    return users().filter((u) => u !== props.me && !taken.has(u));
  });

  const invite = async (who: string, m: ShareMode): Promise<void> => {
    if (!who || busy()) return;
    setBusy(true);
    setStatus("");
    try {
      await createShare({ name: props.name, guest: who, mode: m });
      setGuest("");
      await reload();
    } catch (e) {
      setStatus(`Could not share with ${who}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (who: string): Promise<void> => {
    setStatus("");
    try {
      await removeShare(props.me, props.name, who);
    } catch (e) {
      setStatus(`Could not remove ${who}: ${(e as Error).message}`);
    }
    await reload();
  };

  const url = () => inviteUrl(window.location.origin, props.me, props.name);
  const copy = async (): Promise<void> => {
    setCopied((await copyText(url(), urlEl)) ? "Copied" : "Selected. Press Ctrl+C to copy");
  };

  return (
    <Group title="People">
      <Show
        when={shares() !== null}
        fallback={<div class="tl-set-hint tl-set-hint-static">Loading…</div>}
      >
        <Show
          when={mine().length > 0}
          fallback={
            <div class="tl-set-hint tl-set-hint-static">Only you can open this session.</div>
          }
        >
          <For each={mine()}>
            {(s) => (
              <div class="tl-share-person">
                <span class="tl-share-person-name">{s.guest}</span>
                <div class="tl-set-seg" role="radiogroup" aria-label={`What ${s.guest} may do`}>
                  <For each={["rw", "ro"] as const}>
                    {(m) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={s.mode === m}
                        classList={{ active: s.mode === m }}
                        disabled={busy()}
                        onClick={() => s.mode !== m && void invite(s.guest, m)}
                      >
                        {MODE_LABELS[m]}
                      </button>
                    )}
                  </For>
                </div>
                <button
                  type="button"
                  class="tl-set-btn"
                  aria-label={`Remove ${s.guest}`}
                  onClick={() => void remove(s.guest)}
                >
                  Remove
                </button>
              </div>
            )}
          </For>
        </Show>
      </Show>

      <Show when={candidates().length > 0}>
        <Row label="Invite" labelFor="tl-share-guest">
          <select
            id="tl-share-guest"
            class="tl-share-guest-field"
            value={guest()}
            onChange={(e) => setGuest(e.currentTarget.value)}
          >
            <option value="">Choose someone…</option>
            <For each={candidates()}>{(u) => <option value={u}>{u}</option>}</For>
          </select>
        </Row>
        <Row label="They may">
          <div class="tl-set-seg" role="radiogroup" aria-label="What they may do">
            <For each={["rw", "ro"] as const}>
              {(m) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode() === m}
                  classList={{ active: mode() === m }}
                  onClick={() => setMode(m)}
                >
                  {MODE_LABELS[m]}
                </button>
              )}
            </For>
          </div>
        </Row>
        <div class="tl-set-note">{MODE_NOTES[mode()]}</div>
        <div class="tl-share-actions">
          <button
            type="button"
            class="tl-set-btn tl-set-btn-go"
            disabled={busy() || !guest()}
            onClick={() => void invite(guest(), mode())}
          >
            Invite
          </button>
        </div>
      </Show>

      <Show when={mine().length > 0}>
        <div class="tl-share-url">
          <input
            ref={urlEl}
            class="tl-share-url-field"
            type="text"
            readOnly
            value={url()}
            aria-label="Session link for the people above"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button type="button" class="tl-set-btn" onClick={() => void copy()}>
            Copy
          </button>
        </div>
        <div class="tl-set-note">
          Opens this session for the people above, and for nobody else.
          <Show when={copied()}> {copied()}.</Show>
        </div>
      </Show>
      <Show when={status()}>
        <div class="tl-set-hint tl-set-hint-static">{status()}</div>
      </Show>
    </Group>
  );
};
