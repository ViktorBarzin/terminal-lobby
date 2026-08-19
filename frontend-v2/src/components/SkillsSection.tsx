import { For, Show, createMemo, onMount, type Accessor, type Component } from "solid-js";
import type { PeerBlock, PeerSkill, Plugin, Skill } from "../lib/skills-api";
import { rowKey, type SkillsStore } from "../store/skills";
import {
  fileSummary,
  installableCount,
  peerAction,
  peerLabel,
  peersWorthShowing,
  pluginStatus,
  restartTargets,
  skillStatus,
  type RowStatus,
} from "../store/skills.logic";

/**
 * The Skills group of the Settings overlay (docs/adr/0011): what this account
 * loads, what the other people on this box have, and the actions that move a
 * skill between them.
 *
 * Every user's skills are visible to every other one, which grants nothing new —
 * the file modes already allow it — and the person who takes on a skill is the
 * one who installs it, because a skill can carry scripts that then run in their
 * sessions. That is why a row can be read before it is taken, and why the file
 * count says how many of those files are executable.
 */
export const SkillsSection: Component<{
  skills: SkillsStore;
  /** The caller's live sessions, for the "what can pick this up" list. Optional:
   *  without it the group still works and simply says nothing about sessions. */
  sessions?: Accessor<ReadonlyArray<{ name: string; state?: string }>>;
  confirm?: (message: string) => boolean;
}> = (props) => {
  const s = props.skills;
  // Lazily: the group is what asks for the inventory, so opening Settings for a
  // theme costs nothing.
  onMount(() => {
    if (!s.inventory() && !s.loading()) void s.load();
  });

  const confirm = (m: string) =>
    props.confirm ? props.confirm(m) : window.confirm(m);

  const inv = () => s.inventory();
  const mine = createMemo<Skill[]>(() => inv()?.skills ?? []);
  const plugins = createMemo<Plugin[]>(() => inv()?.plugins ?? []);
  const peers = createMemo<PeerBlock[]>(() => peersWorthShowing(inv()?.peers ?? []));
  const sessions = createMemo(() => restartTargets(props.sessions?.() ?? []));
  const isBusy = (key: string) => s.busy() === key;
  const anyBusy = () => s.busy() !== "";

  const label = (st: RowStatus) => (
    <span class={`tl-skill-meta tl-skill-${st.tone}`}>{st.label}</span>
  );

  return (
    <section class="tl-settings-group">
      <div class="tl-settings-label">
        Skills
        <button
          type="button"
          class="tl-skill-refresh"
          onClick={() => void s.load()}
          disabled={s.loading()}
          title="Re-read every account's skills"
        >
          {s.loading() ? "…" : "⟳"}
        </button>
      </div>

      <Show when={s.error()}>
        <div class="tl-settings-hint tl-skill-warn">{s.error()}</div>
      </Show>

      {/* --- the caller's own skills ----------------------------------------- */}
      <Show when={inv()}>
        <div class="tl-skill-head">Mine ({mine().length})</div>
        <For each={mine()}>
          {(skill) => {
            const st = () => skillStatus(skill);
            const open = () => s.expanded() === rowKey("", skill.name);
            const id = `${skill.name}@skills-dir`;
            return (
              <>
                <div class="tl-skill-row">
                  <input
                    type="checkbox"
                    checked={skill.enabled}
                    disabled={anyBusy()}
                    aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
                    onChange={(e) => void s.setEnabled(id, e.currentTarget.checked)}
                  />
                  <button
                    type="button"
                    class="tl-skill-name"
                    aria-expanded={open()}
                    onClick={() => s.toggleExpanded("", skill.name)}
                  >
                    {skill.name}
                  </button>
                  {label(st())}
                </div>
                <Show when={open()}>
                  <div class="tl-skill-detail">
                    <Show when={skill.description}>
                      <div class="tl-skill-desc">{skill.description}</div>
                    </Show>
                    <div class="tl-skill-facts">{fileSummary(skill)}</div>
                    <Show when={st().detail}>
                      <div class="tl-skill-facts">{st().detail}</div>
                    </Show>
                    <div class="tl-settings-btnrow">
                      <Show when={skill.updateAvailable && skill.from}>
                        <button
                          type="button"
                          class="tl-settings-btn"
                          disabled={anyBusy()}
                          onClick={() => {
                            if (
                              !skill.locallyModified ||
                              confirm(
                                `${skill.name} has local edits. Updating backs your copy up first. Continue?`,
                              )
                            ) {
                              void s.install(skill.from!, skill.name, true);
                            }
                          }}
                        >
                          {isBusy(rowKey(skill.from!, skill.name)) ? "Updating…" : "Update"}
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="tl-settings-btn tl-settings-btn-danger"
                        disabled={anyBusy()}
                        onClick={() => {
                          if (confirm(`Remove ${skill.name}? A backup is kept.`)) {
                            void s.remove(skill.name);
                          }
                        }}
                      >
                        {isBusy(skill.name) ? "Removing…" : "Remove"}
                      </button>
                    </div>
                  </div>
                </Show>
              </>
            );
          }}
        </For>

        {/* --- marketplace plugins ------------------------------------------ */}
        <Show when={plugins().length > 0}>
          <div class="tl-skill-head">Plugins ({plugins().length})</div>
          <For each={plugins()}>
            {(plugin) => {
              const st = () => pluginStatus(plugin);
              return (
                <div class="tl-skill-row">
                  <input
                    type="checkbox"
                    checked={plugin.enabled}
                    disabled={anyBusy()}
                    aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
                    onChange={(e) => void s.setEnabled(plugin.id, e.currentTarget.checked)}
                  />
                  <span class="tl-skill-name tl-skill-plain">{plugin.name}</span>
                  {label(st())}
                  <Show when={plugin.stale}>
                    <button
                      type="button"
                      class="tl-settings-btn"
                      disabled={anyBusy()}
                      onClick={() => void s.update(plugin.id)}
                    >
                      {isBusy(plugin.id) ? "Updating…" : "Update"}
                    </button>
                  </Show>
                </div>
              );
            }}
          </For>
        </Show>

        {/* --- the other accounts on this box ------------------------------- */}
        <For each={peers()}>
          {(peer) => (
            <>
              <div class="tl-skill-head">
                From {peer.user}
                <Show when={!peer.unreachable}>
                  {" "}— {installableCount(peer)} to take
                </Show>
              </div>
              <Show when={peer.unreachable}>
                <div class="tl-settings-hint">
                  Could not read {peer.user}'s skills just now.
                </div>
              </Show>
              <For each={peer.skills ?? []}>
                {(skill) => <PeerRow peer={peer.user} skill={skill} store={s} />}
              </For>
            </>
          )}
        </For>

        {/* --- what can pick a change up ------------------------------------ */}
        <Show when={sessions().length > 0}>
          <div class="tl-skill-head">Your sessions</div>
          <div class="tl-settings-hint">
            A skill is read when a session starts, so a change reaches new ones.
          </div>
          <For each={sessions()}>
            {(row) => (
              <div class="tl-skill-row">
                <span class={`tl-skill-dot tl-skill-dot-${row.state}`} aria-hidden="true" />
                <span class="tl-skill-name tl-skill-plain">{row.name}</span>
                <Show
                  when={row.restartable}
                  fallback={<span class="tl-skill-meta tl-skill-muted">mid-turn</span>}
                >
                  <button
                    type="button"
                    class="tl-settings-btn"
                    disabled={anyBusy()}
                    onClick={() => void s.restart(row.name)}
                    title="Respawn with claude --continue: the conversation survives"
                  >
                    {isBusy(`session:${row.name}`) ? "Restarting…" : "Restart"}
                  </button>
                </Show>
              </div>
            )}
          </For>
        </Show>

        <div class="tl-settings-hint">
          Everyone here can see everyone's skills. Installing copies it into your
          account; the owner's copy is untouched.
        </div>
      </Show>
    </section>
  );
};

/** One of another user's skills: read it, take it, or see how it differs. */
const PeerRow: Component<{ peer: string; skill: PeerSkill; store: SkillsStore }> = (props) => {
  const s = props.store;
  const skill = props.skill;
  const action = () => peerAction(skill);
  const st = () => peerLabel(skill);
  const key = rowKey(props.peer, skill.name);
  const open = () => s.expanded() === key;
  const anyBusy = () => s.busy() !== "";
  const diff = () => (s.diff()?.name === skill.name ? s.diff() : null);

  return (
    <>
      <div class="tl-skill-row">
        <button
          type="button"
          class="tl-skill-name tl-skill-peer"
          aria-expanded={open()}
          onClick={() => s.toggleExpanded(props.peer, skill.name)}
        >
          {skill.name}
        </button>
        <Show when={st().label}>
          <span class={`tl-skill-meta tl-skill-${st().tone}`}>{st().label}</span>
        </Show>
        <Show when={action() === "install"}>
          <button
            type="button"
            class="tl-settings-btn"
            disabled={anyBusy()}
            onClick={() => void s.install(props.peer, skill.name)}
          >
            {s.busy() === key ? "Installing…" : "Install"}
          </button>
        </Show>
      </div>
      <Show when={open()}>
        <div class="tl-skill-detail">
          <Show when={skill.description}>
            <div class="tl-skill-desc">{skill.description}</div>
          </Show>
          <div class="tl-skill-facts">{fileSummary(skill)}</div>
          <Show when={action() === "replace"}>
            <div class="tl-settings-btnrow">
              <button
                type="button"
                class="tl-settings-btn"
                onClick={() => void s.showDiff(props.peer, skill.name)}
              >
                View diff
              </button>
              <button
                type="button"
                class="tl-settings-btn"
                disabled={anyBusy()}
                onClick={() => void s.install(props.peer, skill.name, true)}
              >
                {s.busy() === key ? "Replacing…" : "Replace (backs up mine)"}
              </button>
            </div>
          </Show>
          <Show when={diff()}>
            <pre class="tl-skill-diff">
              <For each={(diff()!.diff || "").split("\n")}>
                {(line) => (
                  <div
                    class={
                      line.startsWith("+")
                        ? "tl-skill-add"
                        : line.startsWith("-")
                          ? "tl-skill-del"
                          : ""
                    }
                  >
                    {line}
                  </div>
                )}
              </For>
            </pre>
          </Show>
        </div>
      </Show>
    </>
  );
};
