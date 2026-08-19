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
import type { PeerSkill, Skill } from "../lib/skills-api";
import { rowKey, type SkillsStore } from "../store/skills";
import {
  fileSummary,
  peerAction,
  peerLabel,
  pluginStatus,
  restartTargets,
  skillStatus,
  type RowStatus,
} from "../store/skills.logic";
import {
  emptyReason,
  mineRows,
  peerRows,
  pluginRows,
  resolveTab,
  tabsFor,
  type TabId,
} from "../store/skills.tabs";

/**
 * The Skills panel: its own overlay off the shell bar, beside Settings.
 *
 * It began as a group inside the Settings overlay and outgrew it — 38 own
 * skills, 7 plugins, 21 of a peer's and every live session do not read as one
 * 420px column. So the surface is its own dialog, wider, with a tab per list and
 * a filter, and Settings is back to being settings.
 *
 * What a row means and what it offers is unchanged, and still decided in
 * skills.logic.ts: every user's skills are visible to every other one (which
 * grants nothing new — the file modes already allow it), the person who takes on
 * a skill is the one who installs it, and the file count says how many of those
 * files are executable, because installing a peer's skill puts their scripts in
 * your sessions.
 */
export const SkillsPanel: Component<{
  skills: SkillsStore;
  onClose: () => void;
  /** The caller's live sessions, for the Sessions tab. */
  sessions?: Accessor<ReadonlyArray<{ name: string; state?: string }>>;
  confirm?: (message: string) => boolean;
}> = (props) => {
  const s = props.skills;
  let dialogEl: HTMLDivElement | undefined;
  const [tab, setTab] = createSignal<TabId | "">("");
  const [query, setQuery] = createSignal("");

  onMount(() => {
    if (!s.inventory() && !s.loading()) void s.load();
  });

  const confirm = (m: string) => (props.confirm ? props.confirm(m) : window.confirm(m));

  const inv = () => s.inventory();
  const sessionRows = createMemo(() => restartTargets(props.sessions?.() ?? []));
  const tabs = createMemo(() => tabsFor(inv(), sessionRows()));
  // The selected tab is derived, not stored: a peer who leaves the roster, or
  // plugins all uninstalled, must not leave the panel on a tab nobody can see.
  const active = createMemo(() => resolveTab(tabs(), tab()));
  const activePeer = () => {
    const id = active();
    return id.startsWith("peer:") ? id.slice(5) : "";
  };
  const isBusy = (key: string) => s.busy() === key;
  const anyBusy = () => s.busy() !== "";

  // --- the dialog contract, the same one SettingsPanel keeps ------------------
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
      return;
    }
    if (e.key === "Tab" && dialogEl) {
      const items = [
        ...dialogEl.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      const outside = !dialogEl.contains(at);
      if (!first || !last) {
        e.preventDefault();
        dialogEl.focus();
      } else if (e.shiftKey && (outside || at === first || at === dialogEl)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || at === last)) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  let opener: HTMLElement | null = null;
  onMount(() => {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => dialogEl?.focus());
  });
  onCleanup(() => {
    if (opener && opener !== document.body && opener.isConnected) opener.focus();
  });

  const meta = (st: RowStatus) => (
    <span class={`tl-skill-meta tl-skill-${st.tone}`}>{st.label}</span>
  );

  return (
    <div
      class="tl-settings-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        class="tl-settings tl-skills-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Skills"
        tabindex="-1"
        ref={dialogEl}
      >
        <div class="tl-settings-head">
          <span class="tl-settings-title">Skills</span>
          <div class="tl-skills-head-right">
            <button
              type="button"
              class="tl-icon-btn"
              onClick={() => void s.load()}
              disabled={s.loading()}
              aria-label="Re-read every account's skills"
              title="Re-read every account's skills"
            >
              {s.loading() ? "…" : "⟳"}
            </button>
            <button
              type="button"
              class="tl-icon-btn"
              onClick={() => props.onClose()}
              aria-label="Close skills"
            >
              ✕
            </button>
          </div>
        </div>

        <Show when={s.error()}>
          <div class="tl-settings-hint tl-skill-warn">{s.error()}</div>
        </Show>

        <Show when={inv()}>
          <div class="tl-skills-tabs" role="tablist" aria-label="Skill lists">
            <For each={tabs()}>
              {(t) => (
                <button
                  type="button"
                  role="tab"
                  class="tl-skills-tab"
                  classList={{ active: active() === t.id }}
                  aria-selected={active() === t.id}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                  <Show when={t.count > 0}>
                    <span class="tl-skills-tab-count">{t.count}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>

          <Show when={active() !== "sessions"}>
            <input
              class="tl-skills-filter"
              type="search"
              placeholder="Filter by name or description"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              aria-label="Filter skills"
            />
          </Show>

          <div class="tl-skills-body">
            {/* --- the caller's own ------------------------------------------ */}
            <Show when={active() === "mine"}>
              <For each={mineRows(inv(), query())}>
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
                        {meta(st())}
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
                              class="tl-settings-btn"
                              disabled={anyBusy()}
                              onClick={() => {
                                if (confirm(`Remove ${skill.name}? A backup is kept.`)) {
                                  void s.remove(skill.name);
                                }
                              }}
                              title="Keeps a copy under .backup/"
                            >
                              {isBusy(skill.name) ? "Removing…" : "Remove"}
                            </button>
                            {/* The permanent one. Remove is recoverable, so it
                                keeps the plain button; this asks a harder
                                question and names what cannot come back. */}
                            <button
                              type="button"
                              class="tl-settings-btn tl-settings-btn-danger"
                              disabled={anyBusy()}
                              onClick={() => {
                                if (confirm(deleteWarning(skill))) {
                                  void s.deleteForever(skill.name);
                                }
                              }}
                              title="Permanent: the skill and every backup of it"
                            >
                              {isBusy(skill.name) ? "Deleting…" : "Delete"}
                            </button>
                          </div>
                        </div>
                      </Show>
                    </>
                  );
                }}
              </For>
              <Empty
                text={emptyReason("mine", (inv()?.skills ?? []).length > 0, query())}
                shown={mineRows(inv(), query()).length === 0}
              />
            </Show>

            {/* --- one other account ---------------------------------------- */}
            <Show when={activePeer()}>
              {(() => {
                const rows = () => peerRows(inv(), activePeer(), query());
                return (
                  <>
                    <For each={rows().skills}>
                      {(skill) => (
                        <PeerRow peer={activePeer()} skill={skill} store={s} />
                      )}
                    </For>
                    <Empty
                      text={emptyReason(
                        "peer",
                        (rows().block?.skills ?? []).length > 0,
                        query(),
                        !!rows().block?.unreachable,
                      )}
                      shown={rows().skills.length === 0}
                    />
                  </>
                );
              })()}
            </Show>

            {/* --- marketplace plugins -------------------------------------- */}
            <Show when={active() === "plugins"}>
              <For each={pluginRows(inv(), query())}>
                {(plugin) => (
                  <div class="tl-skill-row">
                    <input
                      type="checkbox"
                      checked={plugin.enabled}
                      disabled={anyBusy()}
                      aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
                      onChange={(e) => void s.setEnabled(plugin.id, e.currentTarget.checked)}
                    />
                    <span class="tl-skill-name tl-skill-plain">{plugin.name}</span>
                    {meta(pluginStatus(plugin))}
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
                    <button
                      type="button"
                      class="tl-settings-btn tl-settings-btn-danger"
                      disabled={anyBusy()}
                      onClick={() => {
                        if (
                          confirm(
                            `Uninstall ${plugin.name}? Its files are removed. You can install it again from its marketplace.`,
                          )
                        ) {
                          void s.uninstall(plugin.id);
                        }
                      }}
                      title="Removes the plugin and reclaims its files"
                    >
                      {isBusy(plugin.id) ? "Working…" : "Uninstall"}
                    </button>
                  </div>
                )}
              </For>
              <Empty
                text={emptyReason("plugins", (inv()?.plugins ?? []).length > 0, query())}
                shown={pluginRows(inv(), query()).length === 0}
              />
            </Show>

            {/* --- what can pick a change up -------------------------------- */}
            <Show when={active() === "sessions"}>
              <div class="tl-settings-hint">
                A skill is read when a session starts, so a change reaches new ones.
              </div>
              <For each={sessionRows()}>
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
          </div>

          <div class="tl-settings-hint">
            Everyone here can see everyone's skills. Installing copies it into your
            account; the owner's copy is untouched.
          </div>
        </Show>
      </div>
    </div>
  );
};

/**
 * deleteWarning says what is actually at stake, which differs per row.
 *
 * A skill installed from someone else is one click from coming back, so its
 * warning is mild. One this account authored has no other copy anywhere once the
 * backups go, and a link's target is not ours to delete — saying so is the
 * difference between an informed click and a regretted one.
 */
function deleteWarning(skill: Skill): string {
  if (skill.symlink) {
    return `Delete ${skill.name}? The link goes; whatever it points at is left alone.`;
  }
  if (skill.from) {
    return `Delete ${skill.name} permanently, including any backups? You can install it again from ${skill.from}.`;
  }
  return `Delete ${skill.name} permanently, including any backups? Nothing else has a copy of this one.`;
}

/** Empty renders the reason a list is empty, and nothing when it is not. */
const Empty: Component<{ text: string; shown: boolean }> = (props) => (
  <Show when={props.shown && props.text}>
    <div class="tl-settings-hint">{props.text}</div>
  </Show>
);

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
