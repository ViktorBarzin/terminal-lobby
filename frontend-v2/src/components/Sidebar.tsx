import {
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js";
import type { LobbyStore } from "../store/lobby";
import { SHARED_KEY } from "../store/collapse";
import { ProjectGroup } from "./ProjectGroup";
import { SessionCard } from "./SessionCard";
import { CreateSessionRow } from "./CreateSessionRow";

/**
 * The lobby sidebar (inventory Cat.2/3): identity + new-session row, the ordered
 * project/Ungrouped groups, a read-only Shared-with-me section for foreign
 * sessions, and the New-project / Restore footer. It is a pure view over the
 * store's derived model; all mutation goes back through the store.
 */
export const Sidebar: Component<{ store: LobbyStore }> = (props) => {
  const store = props.store;

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
  // render so they can be seen and dropped into.
  const visibleGroups = () =>
    store.model().groups.filter((g) => g.kind === "project" || g.sessions.length > 0);

  const isEmpty = () =>
    !store.loading() &&
    store.model().groups.every((g) => g.sessions.length === 0) &&
    store.model().foreign.length === 0 &&
    store.layout().projects.length === 0;

  const sharedCollapsed = () => store.collapse.isCollapsed(SHARED_KEY);

  return (
    <div class="tl-sidebar">
      <div class="tl-sidebar-head">
        <span class="tl-sidebar-title">Sessions</span>
        <Show when={store.whoami()}>
          <span class="tl-sidebar-user" title="signed in as">
            {store.whoami()!.osUser}
          </span>
        </Show>
      </div>

      <CreateSessionRow store={store} />

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
          {(g) => <ProjectGroup store={store} group={g} tick={tick} />}
        </For>

        <Show when={store.model().foreign.length > 0}>
          <div class="tl-group">
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
                  {(s) => <SessionCard store={store} session={s} groupName="" tick={tick} />}
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
          <button class="tl-foot-btn" onClick={() => void store.restore()} title="Recreate saved-but-dead sessions">
            Restore
          </button>
        </Show>
      </div>
    </div>
  );
};
