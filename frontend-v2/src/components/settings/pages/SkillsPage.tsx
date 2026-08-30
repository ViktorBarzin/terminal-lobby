import {
  For,
  Show,
  createMemo,
  createSignal,
  onMount,
  type Accessor,
  type Component,
} from "solid-js";
import type { PeerSkill, Skill, SourceInfo } from "../../../lib/skills-api";
import { CodeEditor } from "../../CodeEditor";
import { rowKey, type SkillsStore } from "../../../store/skills";
import {
  fileSummary,
  peerAction,
  peerLabel,
  pluginStatus,
  restartTargets,
  skillStatus,
  type RowStatus,
} from "../../../store/skills.logic";
import {
  emptyReason,
  matches,
  mineRows,
  peerRows,
  pluginRows,
  resolveTab,
  tabsFor,
  type TabId,
} from "../../../store/skills.tabs";

/**
 * The Skills page: one entry on the Settings rail, below the preferences.
 *
 * It was a group inside the old 420px Settings column, outgrew it in August
 * 2026 — 38 own skills, 7 plugins, 21 of a peer's and every live session do not
 * read as one narrow column — and became its own overlay. The rail gives it the
 * room that overlay was for, at the full width and height of the dialog, so the
 * surface comes back into Settings while keeping the shape that fixed it: a tab
 * per list with its count, a filter over name and description, and the list
 * scrolling under a fixed strip.
 *
 * Navigation nests, rail → Skills → tabs, and that is deliberate. These tabs are
 * filters with live counts over one collection, and one of them appears per peer
 * on the roster; a rail entry each would churn as people come and go.
 *
 * What a row means and what it offers is unchanged, and still decided in
 * skills.logic.ts: every user's skills are visible to every other one (which
 * grants nothing new — the file modes already allow it), the person who takes on
 * a skill is the one who installs it, and the file count says how many of those
 * files are executable, because installing a peer's skill puts their scripts in
 * your sessions.
 */
/**
 * One skill's file, under its row.
 *
 * Your own is editable in place: the shortest path from "that wording is wrong"
 * to a fixed skill, on the same file a session reads. A peer's is read-only —
 * their home is theirs, and taking a copy is what makes a skill yours to change.
 *
 * The store holds one file at a time, the expanded row's, so this renders only
 * for that row: a peer row can also be open on a diff, and it must not show the
 * text of whichever skill was expanded.
 */
const SkillFile: Component<{
  s: SkillsStore;
  owner: string;
  name: string;
  /** Left out for a peer's skill: read it, do not write it. */
  editable?: boolean;
  confirm?: (message: string) => boolean;
}> = (props) => {
  const s = props.s;
  const mine = () => s.expanded() === rowKey(props.owner, props.name);
  const dirty = () => s.draft() !== s.saved();
  const saving = () => s.busy() === `edit:${props.name}`;
  const ask = props.confirm ?? ((m: string) => window.confirm(m));

  return (
    <Show when={mine()}>
      <Show when={s.viewing()}>
        <div class="tl-skill-facts">Reading {props.name}…</div>
      </Show>
      <Show when={s.viewError()}>
        <div class="tl-skill-facts tl-skill-warn">{s.viewError()}</div>
      </Show>
      {/* keyed: a fetch replaces this object, which is what rebuilds the editor
          around the file it just read. A save does not fetch, so it does not
          disturb the cursor. */}
      <Show when={s.view()} keyed>
        {(v) => (
          <div class="tl-skill-file">
            <Show
              when={props.editable}
              fallback={<pre class="tl-skill-md">{v.skillmd}</pre>}
            >
              {/* Seeded from the draft, not the file: switching tabs unmounts
                  this and an edit in progress has to survive coming back. */}
              <CodeEditor
                initialText={s.draft()}
                language="markdown"
                onChange={(text) => s.setDraft(text)}
                onSave={() => {
                  if (dirty() && !saving()) void s.save(props.name);
                }}
              />
              <div class="tl-skill-file-foot">
                <span class="tl-skill-meta" title={v.path ?? ""}>
                  {v.path ?? `${v.owner}/${v.name}`}
                </span>
                <span class="tl-skill-file-btns">
                  <button
                    type="button"
                    class="tl-set-btn"
                    disabled={!dirty() || saving()}
                    onClick={() => {
                      if (ask(`Throw away your changes to ${props.name}?`)) void s.reread();
                    }}
                    title="Read the file again, losing what you typed"
                  >
                    Revert
                  </button>
                  <button
                    type="button"
                    class="tl-set-btn tl-set-btn-go"
                    disabled={!dirty() || saving()}
                    onClick={() => void s.save(props.name)}
                    title="Save (Ctrl/Cmd-S)"
                  >
                    {saving() ? "Saving…" : dirty() ? "Save" : "Saved"}
                  </button>
                </span>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </Show>
  );
};

export const SkillsPage: Component<{
  skills: SkillsStore;
  /** The caller's live sessions, for the Sessions tab. */
  sessions?: Accessor<ReadonlyArray<{ name: string; state?: string }>>;
  confirm?: (message: string) => boolean;
}> = (props) => {
  const s = props.skills;
  const [tab, setTab] = createSignal<TabId | "">("");
  const [query, setQuery] = createSignal("");
  const [draft, setDraft] = createSignal("");

  onMount(() => {
    if (!s.inventory() && !s.loading()) void s.load();
  });

  const confirm = (m: string) =>
    props.confirm ? props.confirm(m) : window.confirm(m);

  const inv = () => s.inventory();
  const sessionRows = createMemo(() =>
    restartTargets(props.sessions?.() ?? []),
  );
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

  const meta = (st: RowStatus) => (
    <span class={`tl-skill-meta tl-skill-${st.tone}`}>{st.label}</span>
  );

  return (
    <div class="tl-skills-page">
        <Show when={s.error()}>
          <div class="tl-set-hint tl-set-hint-static tl-skill-warn">{s.error()}</div>
        </Show>

        <Show when={inv()}>
          <div class="tl-skills-tabbar">
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

          {/* Install from a repo. One field for both kinds: a look at the repo
              decides whether it offers skills, a plugin marketplace, or both
              (docs/adr/0012). The look installs nothing. */}
          <Show when={active() === "mine" || active() === "plugins"}>
            <form
              class="tl-skills-source"
              onSubmit={(e) => {
                e.preventDefault();
                const v = draft().trim();
                if (v) void s.inspect(v);
              }}
            >
              <input
                class="tl-skills-filter tl-skills-source-input"
                type="text"
                placeholder="Install from a repo — owner/repo"
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                aria-label="Install from a repo"
                spellcheck={false}
                autocapitalize="off"
              />
              <button
                type="submit"
                class="tl-set-btn"
                disabled={s.inspecting() || !draft().trim()}
              >
                {s.inspecting() ? "Looking…" : "Look"}
              </button>
            </form>
          </Show>

          <Show when={s.source()}>
            {(info) => <SourceResult info={info()} store={s} confirm={confirm} />}
          </Show>

          <div class="tl-skills-body">
            {/* --- the caller's own ------------------------------------------ */}
            <Show when={active() === "mine"}>
              <table class="tl-skill-table">
                <thead>
                  <tr>
                    <th class="tl-col-check">
                      <span class="tl-sr-only">Enabled</span>
                    </th>
                    <th>Skill</th>
                    <th class="tl-col-source">Source</th>
                    <th class="tl-col-actions">
                      <span class="tl-sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <For each={mineRows(inv(), query())}>
                    {(skill) => {
                      const st = () => skillStatus(skill);
                      const open = () => s.expanded() === rowKey("", skill.name);
                      const id = `${skill.name}@skills-dir`;
                      return (
                        <>
                          <tr classList={{ open: open() }}>
                            <td class="tl-col-check">
                              <input
                                type="checkbox"
                                checked={skill.enabled}
                                disabled={anyBusy()}
                                aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
                                onChange={(e) => void s.setEnabled(id, e.currentTarget.checked)}
                              />
                            </td>
                            <td>
                              <button
                                type="button"
                                class="tl-skill-name"
                                aria-expanded={open()}
                                onClick={() => s.toggleExpanded("", skill.name)}
                              >
                                {skill.name}
                              </button>
                            </td>
                            <td class="tl-col-source">{meta(st())}</td>
                            <td class="tl-col-actions">
                              <span class="tl-skill-actions">
                                <Show when={skill.updateAvailable && skill.from}>
                                  <button
                                    type="button"
                                    class="tl-set-btn"
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
                                    title={`Take ${skill.from}'s newer copy`}
                                  >
                                    {isBusy(rowKey(skill.from!, skill.name)) ? "Updating…" : "Update"}
                                  </button>
                                </Show>
                                <button
                                  type="button"
                                  class="tl-set-btn"
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
                                  class="tl-set-btn tl-set-btn-danger"
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
                              </span>
                            </td>
                          </tr>
                          <Show when={open()}>
                            <tr class="tl-detail-row">
                              <td />
                              <td colspan="3">
                                <div class="tl-skill-detail">
                                  <Show when={skill.description}>
                                    <div class="tl-skill-desc">{skill.description}</div>
                                  </Show>
                                  <div class="tl-skill-facts">{fileSummary(skill)}</div>
                                  <Show when={st().detail}>
                                    <div class="tl-skill-facts">{st().detail}</div>
                                  </Show>
                                  <SkillFile
                                    s={s}
                                    owner=""
                                    name={skill.name}
                                    editable
                                    confirm={props.confirm}
                                  />
                                </div>
                              </td>
                            </tr>
                          </Show>
                        </>
                      );
                    }}
                  </For>
                </tbody>
              </table>
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
                    <table class="tl-skill-table">
                      <thead>
                        <tr>
                          <th>Skill</th>
                          <th class="tl-col-source">Against yours</th>
                          <th class="tl-col-actions">
                            <span class="tl-sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={rows().skills}>
                          {(skill) => (
                            <PeerRow
                              peer={activePeer()}
                              skill={skill}
                              store={s}
                              confirm={confirm}
                            />
                          )}
                        </For>
                      </tbody>
                    </table>
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
              <table class="tl-skill-table">
                <thead>
                  <tr>
                    <th class="tl-col-check">
                      <span class="tl-sr-only">Enabled</span>
                    </th>
                    <th>Plugin</th>
                    <th class="tl-col-source">Version</th>
                    <th class="tl-col-actions">
                      <span class="tl-sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <For each={pluginRows(inv(), query())}>
                    {(plugin) => (
                      <tr>
                        <td class="tl-col-check">
                          <input
                            type="checkbox"
                            checked={plugin.enabled}
                            disabled={anyBusy()}
                            aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
                            onChange={(e) => void s.setEnabled(plugin.id, e.currentTarget.checked)}
                          />
                        </td>
                        <td>
                          <span class="tl-skill-name tl-skill-plain">{plugin.name}</span>
                        </td>
                        <td class="tl-col-source">{meta(pluginStatus(plugin))}</td>
                        <td class="tl-col-actions">
                          <span class="tl-skill-actions">
                            <Show when={plugin.stale}>
                              <button
                                type="button"
                                class="tl-set-btn"
                                disabled={anyBusy()}
                                onClick={() => void s.update(plugin.id)}
                              >
                                {isBusy(plugin.id) ? "Updating…" : "Update"}
                              </button>
                            </Show>
                            <button
                              type="button"
                              class="tl-set-btn tl-set-btn-danger"
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
                          </span>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              <Empty
                text={emptyReason("plugins", (inv()?.plugins ?? []).length > 0, query())}
                shown={pluginRows(inv(), query()).length === 0}
              />
            </Show>

            {/* --- what can pick a change up -------------------------------- */}
            <Show when={active() === "sessions"}>
              <div class="tl-set-hint tl-set-hint-static">
                A skill is read when a session starts, so a change reaches new ones.
              </div>
              <table class="tl-skill-table">
                <thead>
                  <tr>
                    <th class="tl-col-check">
                      <span class="tl-sr-only">State</span>
                    </th>
                    <th>Session</th>
                    <th class="tl-col-source">Claude</th>
                    <th class="tl-col-actions">
                      <span class="tl-sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <For each={sessionRows()}>
                    {(row) => (
                      <tr>
                        <td class="tl-col-check">
                          <span
                            class={`tl-skill-dot tl-skill-dot-${row.state}`}
                            aria-hidden="true"
                          />
                        </td>
                        <td>
                          <span class="tl-skill-name tl-skill-plain">{row.name}</span>
                        </td>
                        <td class="tl-col-source">
                          <span class="tl-skill-meta tl-skill-muted">{row.state}</span>
                        </td>
                        <td class="tl-col-actions">
                          <span class="tl-skill-actions">
                            <Show
                              when={row.restartable}
                              fallback={
                                <span class="tl-skill-meta tl-skill-muted">let it finish</span>
                              }
                            >
                              <button
                                type="button"
                                class="tl-set-btn"
                                disabled={anyBusy()}
                                onClick={() => void s.restart(row.name)}
                                title="Respawn with claude --continue: the conversation survives"
                              >
                                {isBusy(`session:${row.name}`) ? "Restarting…" : "Restart"}
                              </button>
                            </Show>
                          </span>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>

          <div class="tl-set-hint tl-set-hint-static">
            Everyone here can see everyone's skills. Installing copies it into
            your account; the owner's copy is untouched.
          </div>
        </Show>
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

/**
 * What a look at a repo found, and the choice it presents.
 *
 * A repo can be a skills repo, a plugin marketplace, or both — `mattpocock/skills`
 * is 35 skills AND a marketplace — so both are offered rather than one being
 * picked by a precedence rule nobody can see. Installing runs the ecosystem's own
 * installer as you, which is why the confirmation says so plainly.
 */
const SourceResult: Component<{
  info: SourceInfo;
  store: SkillsStore;
  confirm: (message: string) => boolean;
}> = (props) => {
  const s = props.store;
  const [chosen, setChosen] = createSignal<Record<string, "skills" | "plugins">>({});
  // A marketplace can offer hundreds — the official one has 286 plugins — so the
  // result gets its own filter once either list is long enough to need one.
  const [narrow, setNarrow] = createSignal("");
  const shown = <T extends { name: string; description?: string }>(rows: T[] | undefined) =>
    (rows ?? []).filter((r) => matches(r, narrow()));
  const many = () =>
    (props.info.skills ?? []).length + (props.info.plugins ?? []).length > 25;
  const pick = (name: string, kind: "skills" | "plugins", on: boolean) =>
    setChosen((c) => {
      const next = { ...c };
      if (on) next[`${kind}:${name}`] = kind;
      else delete next[`${kind}:${name}`];
      return next;
    });
  const namesFor = (kind: "skills" | "plugins") =>
    Object.entries(chosen())
      .filter(([, k]) => k === kind)
      .map(([key]) => key.slice(kind.length + 1));
  const total = () => Object.keys(chosen()).length;
  const busy = () => s.busy().startsWith("source:");

  const install = () => {
    const skills = namesFor("skills");
    const plugins = namesFor("plugins");
    const what = [
      skills.length ? `${skills.length} skill${skills.length === 1 ? "" : "s"}` : "",
      plugins.length ? `${plugins.length} plugin${plugins.length === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(" and ");
    if (
      !props.confirm(
        `Install ${what} from ${props.info.owner}/${props.info.repo}? This runs that project's own installer as you.`,
      )
    ) {
      return;
    }
    if (skills.length) void s.installSource("skills", skills);
    if (plugins.length) void s.installSource("plugins", plugins);
  };

  return (
    <div class="tl-skill-detail tl-source-result">
      <div class="tl-skill-desc">
        {props.info.owner}/{props.info.repo}
        <Show when={!props.info.knownOwner}>
          <span class="tl-skill-meta tl-skill-warn">
            {" "}
            · not an owner you have installed from before
          </span>
        </Show>
      </div>

      <Show when={many()}>
        <input
          class="tl-skills-filter"
          type="search"
          placeholder="Narrow this list"
          value={narrow()}
          onInput={(e) => setNarrow(e.currentTarget.value)}
          aria-label="Narrow what this repo offers"
        />
      </Show>

      <Show when={(props.info.skills ?? []).length > 0}>
        <div class="tl-skill-head">
          Skills ({(props.info.skills ?? []).length}
          <Show when={props.info.skillsCut}>{` of ${(props.info.skills ?? []).length + (props.info.skillsCut ?? 0)}`}</Show>
          )
        </div>
        <For each={shown(props.info.skills)}>
          {(sk) => (
            <label class="tl-source-row">
              <input
                type="checkbox"
                checked={!!chosen()[`skills:${sk.name}`]}
                onChange={(e) => pick(sk.name, "skills", e.currentTarget.checked)}
              />
              <span class="tl-skill-name tl-skill-plain">{sk.name}</span>
              <Show when={sk.description}>
                <span class="tl-skill-facts">{sk.description}</span>
              </Show>
            </label>
          )}
        </For>
      </Show>

      <Show when={(props.info.plugins ?? []).length > 0}>
        <div class="tl-skill-head">
          Plugins in {props.info.marketplace} ({(props.info.plugins ?? []).length}
          <Show when={props.info.pluginsCut}>{` of ${(props.info.plugins ?? []).length + (props.info.pluginsCut ?? 0)}`}</Show>
          )
        </div>
        <For each={shown(props.info.plugins)}>
          {(pl) => (
            <label class="tl-source-row">
              <input
                type="checkbox"
                checked={!!chosen()[`plugins:${pl.name}`]}
                onChange={(e) => pick(pl.name, "plugins", e.currentTarget.checked)}
              />
              <span class="tl-skill-name tl-skill-plain">{pl.name}</span>
              <Show when={pl.description}>
                <span class="tl-skill-facts">{pl.description}</span>
              </Show>
            </label>
          )}
        </For>
      </Show>

      <div class="tl-set-actions">
        <button
          type="button"
          class="tl-set-btn"
          disabled={total() === 0 || busy()}
          onClick={install}
        >
          {busy() ? "Installing…" : `Install ${total() || ""}`.trim()}
        </button>
        <button type="button" class="tl-set-btn" onClick={() => s.clearSource()}>
          Cancel
        </button>
      </div>
      <div class="tl-skill-facts">
        Installing runs that project's own installer as you. Nothing here reads a
        skill for intent — check what lands.
      </div>
    </div>
  );
};

/** Empty renders the reason a list is empty, and nothing when it is not. */
const Empty: Component<{ text: string; shown: boolean }> = (props) => (
  <Show when={props.shown && props.text}>
    <div class="tl-set-hint tl-set-hint-static">{props.text}</div>
  </Show>
);

/** One of another user's skills: read it, take it, or see how it differs. */
const PeerRow: Component<{
  peer: string;
  skill: PeerSkill;
  store: SkillsStore;
  confirm: (message: string) => boolean;
}> = (props) => {
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
      <tr classList={{ open: open() }}>
        <td>
          <button
            type="button"
            class="tl-skill-name"
            aria-expanded={open()}
            onClick={() => s.toggleExpanded(props.peer, skill.name)}
          >
            {skill.name}
          </button>
        </td>
        <td class="tl-col-source">
          <Show when={st().label}>
            <span class={`tl-skill-meta tl-skill-${st().tone}`}>{st().label}</span>
          </Show>
        </td>
        <td class="tl-col-actions">
          <span class="tl-skill-actions">
            <Show when={action() === "install"}>
              <button
                type="button"
                class="tl-set-btn"
                disabled={anyBusy()}
                onClick={() => void s.install(props.peer, skill.name)}
              >
                {s.busy() === key ? "Installing…" : "Install"}
              </button>
            </Show>
            <Show when={action() === "replace"}>
              <button
                type="button"
                class="tl-set-btn"
                disabled={anyBusy()}
                onClick={() => void s.showDiff(props.peer, skill.name)}
                title="See how their copy differs from yours"
              >
                View diff
              </button>
              <button
                type="button"
                class="tl-set-btn"
                disabled={anyBusy()}
                onClick={() => {
                  if (
                    props.confirm(
                      `Replace your ${skill.name} with ${props.peer}'s? Yours is backed up first.`,
                    )
                  ) {
                    void s.install(props.peer, skill.name, true);
                  }
                }}
                title="Backs your copy up first"
              >
                {s.busy() === key ? "Replacing…" : "Replace"}
              </button>
            </Show>
          </span>
        </td>
      </tr>
      <Show when={open() || !!diff()}>
        <tr class="tl-detail-row">
          <td colspan="3">
            <div class="tl-skill-detail">
              <Show when={skill.description}>
                <div class="tl-skill-desc">{skill.description}</div>
              </Show>
              <div class="tl-skill-facts">{fileSummary(skill)}</div>
              <SkillFile s={s} owner={props.peer} name={skill.name} />
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
          </td>
        </tr>
      </Show>
    </>
  );
};
