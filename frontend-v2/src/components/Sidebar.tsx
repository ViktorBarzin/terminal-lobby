import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Accessor,
  type Component,
} from "solid-js";
import type { LobbyStore } from "../store/lobby";
import type { PrefsStore } from "../store/prefs";
import { SHARED_KEY } from "../store/collapse";
import { isGroupVisible } from "./lobby.logic";
import { ProjectGroup } from "./ProjectGroup";
import { SessionCard } from "./SessionCard";
import { CreateSessionRow } from "./CreateSessionRow";
import { badgeLabel, flatSessionOrder } from "../keybindings/navigation.logic";
import { RestorePicker } from "./RestorePicker";
import { BellIcon } from "./BellIcon";
import type { NotificationSystem } from "../notify/notifications";

/**
 * The lobby sidebar (inventory Cat.2/3): identity + new-session row, the ordered
 * project/Ungrouped groups, a read-only Shared-with-me section for foreign
 * sessions, and the New-project / Restore footer. It is a pure view over the
 * store's derived model; all mutation goes back through the store.
 */
export const Sidebar: Component<{
  store: LobbyStore;
  /** roamed prefs — the create row's command dropdown is one of its knobs. */
  prefs: PrefsStore;
  /** true while Alt is held (engine): overlays numbered chips on the first 10 cards. */
  altActive?: Accessor<boolean>;
  /** confirm seam for the destructive card actions (tests inject it). */
  confirm?: (message: string) => boolean;
  /** the notification system, for the bell in the header. The shell owns it;
   *  the header is just where it is presented (as on the vanilla page).
   *  Optional so a test can mount the sidebar without one. */
  notifications?: NotificationSystem;
  /** reload seam — the header's ↻ button. Defaults to a real page reload;
   *  tests pass their own rather than navigating jsdom. */
  onReload?: () => void;
}> = (props) => {
  const store = props.store;

  // Restore picker overlay (2026-08-14). The footer button opens it rather than
  // restoring immediately: after a partial loss the newest snapshot is the
  // already-pruned one, so which version to restore from is a choice.
  const [restoreOpen, setRestoreOpen] = createSignal(false);
  const home = (): string => {
    const u = store.whoami()?.osUser;
    return u ? `/home/${u}` : "";
  };

  // Alt-hold numbered chips: name -> "1".."9","0" for the first ten sidebar
  // cards, in the same flat paint order Alt+1..0 attaches. Empty while Alt is
  // not held (or the layer is disabled), so cards render no chip.
  const badgeMap = createMemo<Map<string, string>>(() => {
    const m = new Map<string, string>();
    if (!props.altActive?.()) return m;
    flatSessionOrder(store.model())
      .slice(0, 10)
      .forEach((s, i) => m.set(s.name, badgeLabel(i)));
    return m;
  });
  const badge = (name: string): string | null => badgeMap().get(name) ?? null;

  // One shared 1Hz tick drives every running session's working timer (the
  // vanilla app updates only .working-timer textContent; here running cards
  // re-read `tick` each second).
  const [tick, setTick] = createSignal(0);
  let timer: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    timer = setInterval(() => setTick((t) => t + 1), 1000);
  });
  onCleanup(() => timer && clearInterval(timer));

  const [addingProject, setAddingProject] = createSignal(false);
  let projInput: HTMLInputElement | undefined;
  const beginProject = () => {
    setAddingProject(true);
    queueMicrotask(() => projInput?.focus());
  };
  const commitProject = async () => {
    const name = projInput?.value.trim() ?? "";
    if (!name) {
      setAddingProject(false);
      return;
    }
    const ok = await store.createProject(name);
    if (ok) setAddingProject(false);
  };

  // Ungrouped hides while empty (keeps its slot in the layout); projects always
  // render so they can be seen and dropped into. Shared with the move-up/down
  // bounds — the two reading different predicates is what let a group's Move
  // item offer a step onto a slot that renders nothing.
  const visibleGroups = () => store.model().groups.filter(isGroupVisible);

  // "No sessions yet." is a claim about fetched data, so a load error disowns
  // it: refresh() can bail before /sessions is ever called (denied whoami), and
  // an empty model then means "nothing known", not "nothing there".
  const isEmpty = () =>
    !store.loading() &&
    !store.loadError() &&
    store.model().groups.every((g) => g.sessions.length === 0) &&
    store.model().foreign.length === 0 &&
    store.layout().projects.length === 0;

  const sharedCollapsed = () => store.collapse.isCollapsed(SHARED_KEY);

  return (
    <div class="tl-sidebar">
      {/* The lobby header, as on the vanilla page: the title carries the app,
          the actions sit on its row, and the line beneath answers "who am I
          here, and whose sessions are these?" — the isolation model is the
          first thing worth knowing about a shared box. The bare "Sessions"
          label this replaces said none of that. */}
      <div class="tl-sidebar-head">
        <div class="tl-sidebar-head-row">
          <h1 class="tl-sidebar-title">tmux sessions</h1>
          <button
            class="tl-icon-btn tl-head-btn"
            type="button"
            aria-label="Reload the app"
            title="Reload the app"
            onClick={() =>
              props.onReload ? props.onReload() : window.location.reload()
            }
          >
            ↻
          </button>
          <Show when={props.notifications && props.notifications.bellMode !== "hidden"}>
            <button
              class="tl-icon-btn tl-head-btn tl-notify-btn"
              type="button"
              classList={{ on: props.notifications!.bellOn() }}
              aria-label="Notifications"
              aria-pressed={props.notifications!.bellOn()}
              title={
                props.notifications!.bellMode === "install-hint"
                  ? "Install to Home Screen for notifications"
                  : props.notifications!.bellTitle()
              }
              onClick={() =>
                props.notifications!.bellMode === "install-hint"
                  ? props.notifications!.showInstallHint()
                  : void props.notifications!.toggleBell()
              }
            >
              <BellIcon ringing={props.notifications!.bellOn()} />
            </button>
          </Show>
        </div>
        <Show when={store.whoami()}>
          <p class="tl-sidebar-sub">
            Logged in as {store.whoami()!.osUser} ({store.whoami()!.authentik}).
            Sessions are kernel-isolated per Unix user; you only see your own.
          </p>
        </Show>
      </div>

      <CreateSessionRow store={store} prefs={props.prefs} />

      <div class="tl-sidebar-scroll">
        <Show when={store.loadError()}>
          <div class="tl-sidebar-msg tl-sidebar-error">{store.loadError()}</div>
        </Show>

        <Show when={store.loading() && store.model().groups.length === 0}>
          <div class="tl-skeleton" />
          <div class="tl-skeleton" />
          <div class="tl-skeleton" />
        </Show>

        <Show when={isEmpty()}>
          <div class="tl-sidebar-msg tl-muted">No sessions yet.</div>
        </Show>

        <For each={visibleGroups()}>
          {(g) => (
            <ProjectGroup store={store} group={g} tick={tick} badge={badge} confirm={props.confirm} />
          )}
        </For>

        <Show when={store.model().foreign.length > 0}>
          {/* hand-rolled rather than a <ProjectGroup> (it is read-only and has
              no actions), so it has to carry the collapsed class itself — the
              chevron rotation hangs off it. */}
          <div class="tl-group" classList={{ "tl-group-collapsed": sharedCollapsed() }}>
            <div
              class="tl-group-header"
              role="button"
              tabindex={0}
              aria-expanded={!sharedCollapsed()}
              onClick={() => store.collapse.toggle(SHARED_KEY)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  store.collapse.toggle(SHARED_KEY);
                }
              }}
            >
              <span class="tl-chev">▾</span>
              <span class="tl-group-title">Shared with me</span>
              <span class="tl-group-badges">
                <span class="tl-group-count">{store.model().foreign.length}</span>
              </span>
            </div>
            <Show when={!sharedCollapsed()}>
              <div class="tl-group-body">
                <For each={store.model().foreign}>
                  {(s) => <SessionCard store={store} session={s} groupName="" tick={tick} badge={badge} />}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>

      <div class="tl-sidebar-foot">
        <Show
          when={!addingProject()}
          fallback={
            <input
              ref={projInput}
              class="tl-add-input"
              placeholder="new project name…"
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitProject();
                else if (e.key === "Escape") setAddingProject(false);
              }}
              onBlur={() => setAddingProject(false)}
            />
          }
        >
          <button class="tl-foot-btn" onClick={beginProject}>
            + Project
          </button>
          <button
            class="tl-foot-btn"
            onClick={() => setRestoreOpen(true)}
            title="Pick a saved snapshot and choose which sessions to bring back"
          >
            Restore
          </button>
        </Show>
      </div>

      <Show when={restoreOpen()}>
        <RestorePicker
          api={{
            listSnapshots: () => store.listSnapshots(),
            getSnapshot: (ts) => store.getSnapshot(ts),
            restoreSessions: (sel) => store.restore(sel),
          }}
          home={home()}
          onClose={() => setRestoreOpen(false)}
        />
      </Show>
    </div>
  );
};
