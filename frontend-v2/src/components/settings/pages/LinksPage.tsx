import { For, Show, createSignal, type Component } from "solid-js";
import { revokeLink } from "../../../lib/links-api";
import { LinkRow, createLinksPoll } from "../../ShareDialog";
import { Group } from "../controls";

/**
 * Every public link you own, across sessions, including links whose session
 * has ended and now show its conversation
 * (docs/plans/2026-10-06-public-links-design.md, decision 12). Links are made
 * from a session's ⋯ menu → Share…; this page is where you find and revoke
 * them all in one place. The rows are the dialog's, naming the session and
 * counting visitors rather than listing them.
 */
export const LinksPage: Component = () => {
  const { links, error, now, reload } = createLinksPoll();
  const [status, setStatus] = createSignal("");

  const revoke = async (id: string): Promise<void> => {
    setStatus("");
    try {
      await revokeLink(id);
    } catch (e) {
      setStatus(`Could not revoke: ${(e as Error).message}`);
    }
    await reload();
  };

  return (
    <Group>
      <Show
        when={links() !== null}
        fallback={<div class="tl-set-hint tl-set-hint-static">Loading…</div>}
      >
        <Show
          when={(links() ?? []).length > 0}
          fallback={
            <div class="tl-set-hint tl-set-hint-static">
              No public links. Make one from a session's ⋯ menu with Share….
            </div>
          }
        >
          <For each={links() ?? []}>
            {(l) => <LinkRow link={l} now={now()} overview onRevoke={(id) => void revoke(id)} />}
          </For>
        </Show>
      </Show>
      <Show when={error() || status()}>
        <div class="tl-set-hint tl-set-hint-static">{status() || error()}</div>
      </Show>
      <div class="tl-set-note">
        When its session ends, a link shows the conversation read-only until it expires or you
        revoke it. A plain shell's link ends with the session. Revoking one disconnects everyone
        using it.
      </div>
    </Group>
  );
};
