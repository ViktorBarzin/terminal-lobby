import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Accessor,
  type Component,
  type JSX,
} from "solid-js";
import type { LobbyStore } from "../store/lobby";
import type { PrefsStore } from "../store/prefs";
import { SHARED_KEY } from "../store/collapse";
import {
  callerGroupTitle,
  groupSeqTokens,
  groupToken,
  isGroupVisible,
  isOriginGroup,
  sessionsByName,
  type RenderGroup,
} from "./lobby.logic";
import {
  attachGroupList,
  attachSessionList,
  GROUP_ATTR,
  liveGroupOrder,
  liveOrder,
} from "../dnd/sidebar";
import { OrderMenu } from "./OrderMenu";
import { ProjectGroup } from "./ProjectGroup";
import { SessionsByIdentity } from "./SessionsByIdentity";
import {
  SessionCard,
  SidebarPhoneContext,
  SidebarWorkspacesContext,
  type SidebarWorkspaces,
} from "./SessionCard";
import { createDismissableMenu, stopMenuActivationKey, stopMenuClick } from "./menu";
import { SESSION_ORDER_TEXT, SESSION_ORDERS, type SessionOrder } from "../logic/order.logic";
import { matchesSearch } from "./phone-row.logic";
import { createMobileFlip } from "../mobile/pointer";
import { badgeLabel, flatSessionOrder } from "../keybindings/navigation.logic";
import { RestorePicker } from "./RestorePicker";
import { SkillsIcon } from "./Icons";
import { BellIcon } from "./BellIcon";
import type { NotificationSystem } from "../notify/notifications";
import { StatusDot } from "./StatusDot";
import { SpendFigure } from "./SpendFigure";
import type { Session, SessionTool } from "../types/lobby";
import { LOBBY_CHANNELS, type Channel } from "../diagnostics/status";

/**
 * The lobby sidebar (inventory Cat.2/3): identity + a route to the new-session
 * composer, the ordered
 * project/Ungrouped groups, a read-only Shared-with-me section for foreign
 * sessions, and the New-project / Restore footer. It is a pure view over the
 * store's derived model; all mutation goes back through the store.
 */
export const Sidebar: Component<{
  store: LobbyStore;
  /** roamed prefs — the session-list order and the last-active line. */
  prefs: PrefsStore;
  /** Show the new-session composer, optionally preset to a project ("" is
   *  Ungrouped). The sidebar has no create box of its own any more: its button
   *  and every group's `+` route here. Optional so a test can mount without it. */
  onNewSession?: (group?: string) => void;
  /** true while Alt is held (engine): overlays numbered chips on the first 10 cards. */
  altActive?: Accessor<boolean>;
  /** the notification system, for the bell in the header. The shell owns it;
   *  the header is just where it is presented (as on the vanilla page).
   *  Optional so a test can mount the sidebar without one. */
  notifications?: NotificationSystem;
  /** reload seam — the header's ↻ button. Defaults to a real page reload;
   *  tests pass their own rather than navigating jsdom. */
  onReload?: () => void;
  /** Supplied only by the phone layout, which folds the shell bar (and its
   *  Settings gear) into the session bar. That bar only exists once a session
   *  is open, so the sidebar's own screen carries the gear instead. */
  onOpenSettings?: () => void;
  /** Supplied only by the phone layout, for the same reason as onOpenSettings:
   *  the shell bar that carries the Skills button is folded away there, and the
   *  session bar that replaces it only exists once a session is open. */
  onOpenSkills?: () => void;
  /** The act-as chip, for the same reason as onOpenSettings: the phone folds
   *  away the shell bar that carries it on a desktop, so the sidebar's own
   *  screen needs a route back to your own lobby. */
  actAsChip?: JSX.Element;
  /** The connection badge in the header (ADR-0016), scoped to the channels a
   *  list screen can honestly report. Optional so a test can mount without it. */
  status?: { channels: () => readonly Channel[]; onOpen: () => void };
  /** Open the Agent spend page. Supplying it is what puts the footer figure on
   *  screen; a test that does not care about spend mounts without it, and the
   *  sidebar then reads nothing from the server. */
  onOpenSpend?: () => void;
  /**
   * The workspace half of the list: which sessions are tiles on the screen
   * right now, which workspace any given session belongs to, and where a click
   * on one should land. The shell owns both halves of a Workspace (membership
   * in tmux-api, the arrangement in `store/workspaces.ts`) and answers from
   * them; the sidebar only asks.
   *
   * Optional, and absent means there are no workspaces: every card is marked as
   * it was before tiles existed and a click opens that session alone. That is
   * what a test mounting the sidebar on its own gets, and what the app itself
   * gets before the first split.
   */
  workspaces?: SidebarWorkspaces;
}> = (props) => {
  const store = props.store;

  /**
   * A phone has no workspaces, so the sidebar it draws has no marks and its
   * cards ask the shell for nothing.
   *
   * ADR-0027: a tree of tiles describes a screen, and the one the flip query
   * claims shows a single session at a time. A mark there would point at a
   * group this screen cannot draw, and a click that entered one would hand the
   * shell a tree with nowhere to put it.
   *
   * Gated HERE rather than in App, and in TypeScript rather than as a `@media`
   * rule neutralising the class. In the sidebar because this is the one place
   * that can read the query once for a whole list instead of once per card, and
   * in TypeScript because the CLICK has to be gated too — a stylesheet can hide
   * a mark, and cannot stop a tap entering a workspace.
   *
   * The value is a stable object whose methods read `flip()` when they are
   * called, so it is safe to hand to a context that reads it once: the media
   * query is live inside the answers rather than around them, and a 2-in-1
   * crossing the query needs no remount.
   */
  const flip = createMobileFlip();
  const workspaces: SidebarWorkspaces = {
    current: () => (flip() ? null : (props.workspaces?.current() ?? null)),
    workspaceOf: (sel) => (flip() ? null : (props.workspaces?.workspaceOf(sel) ?? null)),
    onOpen: (sel, workspace) => {
      if (flip()) return;
      props.workspaces?.onOpen(sel, workspace);
    },
  };

  // Which tool the attached session runs, which is the whole of what the footer
  // figure follows. `tool` comes off the same /sessions payload the cards read
  // (tmux-api derives it from the pane's process tree), so the figure and the
  // card's tool mark cannot disagree.
  const attachedTool = createMemo<SessionTool | undefined>(() => {
    const sel = store.selected();
    if (!sel) return undefined;
    return store.sessions.find((s) => s.name === sel.name)?.tool;
  });

  // The roamed session-list pref, read once here and threaded to every card
  // (through ProjectGroup for projects and Ungrouped, directly for the
  // shared-with-me section).
  const showLastActive = () => props.prefs.prefs().sidebar.showLastActive;

  // The list's ordering — roamed beside it, and read by the STORE (which is
  // what orders the model); the header only picks it.
  const order = () => props.prefs.prefs().sidebar.order;

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
  /**
   * Which sessions finished since you last looked. This is the set the app-icon
   * badge counts, so the list must be able to point at its members — before
   * this the card hardcoded `state === "done"`, every finished session drew the
   * unread treatment, and the number named a set nothing could show.
   */
  const unseenOf = (sn: { name: string; state?: string }): boolean =>
    props.notifications?.isUnseen(sn) ?? false;

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

  // ---- the phone's header and search (T3 pass on the list, 2026-11-23) ----
  /**
   * The ⋯ menu that replaces the phone's footer row and header icons: the
   * order, New project, Restore, Skills, notifications, spend, reload and
   * Settings, in one place, the way T3 Code's home screen keeps its bar to a
   * title and two round buttons.
   */
  const more = createDismissableMenu(() => store.hold());
  const fromMore = (run: () => void) => () => {
    more.close();
    run();
  };
  const pickOrder = (next: SessionOrder) => {
    more.close();
    if (next !== order()) void store.setSessionOrderMode(next);
  };
  /** What the phone's search box holds. Matching is titles, tmux names and
   *  projects only (phone-row.logic.ts matchesSearch). */
  const [query, setQuery] = createSignal("");
  const searching = () => flip() && query().trim() !== "";
  /** Every session this list shows, with the project its group names: the
   *  groups in order, System and the Callers included, then Shared with me. */
  const everySession = (): { key: string; s: Session; group: string; project: string }[] => {
    const out: { key: string; s: Session; group: string; project: string }[] = [];
    for (const g of store.model().groups) {
      const project =
        g.kind === "caller"
          ? callerGroupTitle(g.caller ?? "")
          : isOriginGroup(g)
            ? "System"
            : g.name;
      for (const s of g.sessions) out.push({ key: s.name, s, group: g.name, project });
    }
    for (const s of store.model().foreign) {
      out.push({ key: `${s.owner ?? ""}/${s.name}`, s, group: "", project: "" });
    }
    return out;
  };
  const results = createMemo(() =>
    searching() ? everySession().filter((r) => matchesSearch(r.s, r.project, query())) : [],
  );
  const countLabel = (n: number) => (n === 1 ? "1 session" : `${n} sessions`);

  const [addingProject, setAddingProject] = createSignal(false);
  let projInput: HTMLInputElement | undefined;
  const beginProject = () => {
    setAddingProject(true);
    queueMicrotask(() => projInput?.focus());
  };
  const projectBox = () => (
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
  );
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
  //
  // System and the Caller groups are drawn by hand at the foot instead, so they
  // are filtered out here for the same reason `visibleGroupSeqTokens` drops
  // them: this list is also the token space the group sortable measures, and a
  // slot the layout cannot store is a slot no drag may land on.
  const onScreen = () => store.model().groups.filter((g) => !isOriginGroup(g) && isGroupVisible(g));
  /** The groups to draw: the model's sequence, or the one a header being
   *  dragged has now (dnd/sidebar.ts holds it for the length of the drag). */
  const visibleGroups = (): RenderGroup[] => {
    const order = liveGroupOrder();
    const groups = onScreen();
    if (!order) return groups;
    const byToken = new Map(groups.map((g) => [groupToken(g), g]));
    return order.flatMap((t) => {
      const g = byToken.get(t);
      return g ? [g] : [];
    });
  };

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

  // The Caller groups and System, each only while something has landed in it,
  // in the model's order (Callers by name, then System). Hand-rolled below
  // rather than drawn by <ProjectGroup>, for the same reason "Shared with me"
  // is: what they share with a project is a header, a chevron and a count. They
  // cannot be renamed, deleted, added to, dragged, or moved in the sequence,
  // and every one of those controls would have needed a branch of its own.
  const originGroups = (): RenderGroup[] =>
    store.model().groups.filter((g) => isOriginGroup(g) && isGroupVisible(g));
  /** The cards to draw: the model's order, or the one the pointer has now —
   *  the same swap ProjectGroup makes, so a card dragged OUT of the group
   *  leaves the list under the finger instead of snapping back until the drop
   *  lands. */
  const originCards = (g: RenderGroup): Session[] => {
    const order = liveOrder(g.name);
    if (!order) return g.sessions;
    const all = sessionsByName(store.model());
    return order.flatMap((n) => {
      const s = all.get(n);
      return s ? [s] : [];
    });
  };

  /** One origin group: System, or a Caller's. The group's name is also its
   *  collapse key, the way a project's is. */
  const OriginGroup: Component<{ group: RenderGroup }> = (p) => {
    const key = () => p.group.name;
    const collapsed = () => store.collapse.isCollapsed(key());
    const toggle = () => store.collapse.toggle(key());
    const title = () =>
      p.group.kind === "caller" ? callerGroupTitle(p.group.caller ?? "") : "System";
    const hint = () =>
      p.group.kind === "caller"
        ? `Sessions ${title()} started. They attach and kill like any other. They do not notify.`
        : "Sessions the lobby did not create. They attach and kill like any other. They do not notify.";
    return (
      <div class="tl-group" classList={{ "tl-group-collapsed": collapsed() }}>
        <div
          class="tl-group-header"
          role="button"
          tabindex={0}
          aria-expanded={!collapsed()}
          aria-label={`${title()} group`}
          title={hint()}
          onClick={toggle}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle();
            }
          }}
        >
          <span class="tl-chev">▾</span>
          <span class="tl-group-title">{title()}</span>
          <span class="tl-group-badges">
            <span class="tl-group-count">{p.group.sessions.length}</span>
          </span>
        </div>
        <Show when={!collapsed()}>
          <div
            class="tl-group-body"
            // A sortable like any other group's, so a card can be dragged
            // OUT — which is the rescue (store.move stamps the session
            // `user` on the server before it writes the layout). A drop
            // back IN reads this name, and the store refuses it: the
            // layout has no slot to write.
            {...{ [GROUP_ATTR]: key() }}
            ref={(el) =>
              attachSessionList(el, {
                group: key,
                names: () => p.group.sessions.map((s) => s.name),
                move: (name, group, anchor) => store.move(name, group, anchor),
                hold: () => store.hold(),
              })
            }
          >
            <SessionsByIdentity each={originCards(p.group)} me={store.me()}>
              {(s) => (
                <SessionCard
                  isUnseen={unseenOf}
                  store={store}
                  session={s()}
                  groupName={key()}
                  tick={tick}
                  badge={badge}
                  showLastActive={showLastActive}
                />
              )}
            </SessionsByIdentity>
          </div>
        </Show>
      </div>
    );
  };

  return (
    // Every card in the list reads the workspace answers, and they arrive by
    // three different routes — a project's rows through <ProjectGroup>, the
    // Shared-with-me rows and System's straight from here. One provider covers
    // all three, and carries the phone gate with it (see `workspaces` above).
    <SidebarWorkspacesContext.Provider value={workspaces}>
      <SidebarPhoneContext.Provider value={flip}>
        <div class="tl-sidebar">
          {/* The phone's header, T3 Code's shape: a title, a ⋯ menu and a round
          compose button, then a line of how the lobby is connected, then the
          search box. The desktop header, the New session bar and the footer
          are not drawn on the phone; everything they offered is in the menu. */}
          <Show when={flip()}>
            <div class="tl-phone-head">
              <div class="tl-phone-head-row">
                <h1 class="tl-phone-title">Sessions</h1>
                <span class="tl-phone-more" ref={more.anchor}>
                  <button
                    class="tl-phone-round"
                    type="button"
                    aria-label="More"
                    aria-haspopup="menu"
                    aria-expanded={more.open()}
                    onClick={() => more.toggle()}
                  >
                    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                      <circle cx="6" cy="12" r="1.6" fill="currentColor" />
                      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
                      <circle cx="18" cy="12" r="1.6" fill="currentColor" />
                    </svg>
                  </button>
                  <Show when={more.open()}>
                    <div
                      class="tl-menu tl-phone-more-menu"
                      role="menu"
                      onClick={stopMenuClick}
                      onKeyDown={stopMenuActivationKey}
                    >
                      <div class="tl-menu-label">Order sessions</div>
                      <For each={SESSION_ORDERS}>
                        {(o) => (
                          <button
                            class="tl-menu-item tl-order-item"
                            role="menuitemradio"
                            aria-checked={order() === o}
                            onClick={() => pickOrder(o)}
                          >
                            <span class="tl-order-tick" aria-hidden="true">
                              {order() === o ? "✓" : ""}
                            </span>{" "}
                            {SESSION_ORDER_TEXT[o].label}{" "}
                            <span class="tl-order-hint">{SESSION_ORDER_TEXT[o].hint}</span>
                          </button>
                        )}
                      </For>
                      <div class="tl-menu-sep" role="separator" />
                      <button class="tl-menu-item" role="menuitem" onClick={fromMore(beginProject)}>
                        New project
                      </button>
                      <button
                        class="tl-menu-item"
                        role="menuitem"
                        onClick={fromMore(() => setRestoreOpen(true))}
                      >
                        Restore closed
                      </button>
                      <Show when={props.onOpenSkills}>
                        {(open) => (
                          <button class="tl-menu-item" role="menuitem" onClick={fromMore(open())}>
                            Skills
                          </button>
                        )}
                      </Show>
                      <Show when={props.notifications && props.notifications.bellMode !== "hidden"}>
                        <button
                          class="tl-menu-item"
                          role="menuitem"
                          onClick={fromMore(() =>
                            props.notifications!.bellMode === "install-hint"
                              ? props.notifications!.showInstallHint()
                              : void props.notifications!.toggleBell(),
                          )}
                        >
                          {props.notifications!.bellOn()
                            ? "Turn notifications off"
                            : "Turn notifications on"}
                        </button>
                      </Show>
                      <Show when={props.onOpenSpend}>
                        {(open) => (
                          <button class="tl-menu-item" role="menuitem" onClick={fromMore(open())}>
                            Agent spend
                          </button>
                        )}
                      </Show>
                      <button
                        class="tl-menu-item"
                        role="menuitem"
                        onClick={fromMore(() =>
                          props.onReload ? props.onReload() : window.location.reload(),
                        )}
                      >
                        Reload the app
                      </button>
                      <Show when={props.onOpenSettings}>
                        {(open) => (
                          <button class="tl-menu-item" role="menuitem" onClick={fromMore(open())}>
                            Settings
                          </button>
                        )}
                      </Show>
                    </div>
                  </Show>
                </span>
                <button
                  class="tl-phone-round tl-phone-compose"
                  type="button"
                  aria-label="New session"
                  onClick={() => props.onNewSession?.()}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path
                      d="M4 20h4L20 8l-4-4L4 16zM14 6l4 4"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </button>
              </div>
              <div class="tl-phone-sub">
                <Show when={props.status}>
                  {(st) => (
                    <StatusDot
                      class="tl-sidebar-status"
                      channels={st().channels}
                      only={LOBBY_CHANNELS}
                      onOpen={st().onOpen}
                    />
                  )}
                </Show>
                <span>{countLabel(everySession().length)}</span>
                {props.actAsChip}
              </div>
              <div class="tl-phone-search">
                <input
                  class="tl-phone-search-input"
                  type="search"
                  aria-label="Search sessions"
                  placeholder="Search sessions"
                  autocomplete="off"
                  enterkeyhint="search"
                  value={query()}
                  onInput={(e) => setQuery(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setQuery("");
                  }}
                />
                <Show when={query() !== ""}>
                  <button class="tl-phone-search-cancel" type="button" onClick={() => setQuery("")}>
                    Cancel
                  </button>
                </Show>
              </div>
            </div>
          </Show>
          {/* The lobby header, as on the vanilla page: the title carries the app,
          the actions sit on its row, and the line beneath answers "who am I
          here, and whose sessions are these?" — the isolation model is the
          first thing worth knowing about a shared box. The bare "Sessions"
          label this replaces said none of that. */}
          <Show when={!flip()}>
            <div class="tl-sidebar-head">
              <div class="tl-sidebar-head-row">
                <h1 class="tl-sidebar-title">tmux sessions</h1>
                <Show when={props.status}>
                  {(s) => (
                    <StatusDot
                      class="tl-sidebar-status"
                      channels={s().channels}
                      only={LOBBY_CHANNELS}
                      onOpen={s().onOpen}
                    />
                  )}
                </Show>
                {/* Through the store rather than straight at the pref: a switch into
              manual freezes the visible arrangement into the layout first, and
              the switch itself is undoable. The store still writes the choice
              through this same pref (App wires `setSessionOrder` to it), so it
              roams exactly as it did. */}
                <OrderMenu
                  order={order}
                  onPick={(next) => void store.setSessionOrderMode(next)}
                  hold={() => store.hold()}
                />
                <button
                  class="tl-icon-btn tl-head-btn"
                  type="button"
                  aria-label="Reload the app"
                  title="Reload the app"
                  onClick={() => (props.onReload ? props.onReload() : window.location.reload())}
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
                  Logged in as {store.whoami()!.osUser} ({store.whoami()!.authentik}). Sessions are
                  kernel-isolated per Unix user; you only see your own.
                </p>
              </Show>
            </div>
          </Show>

          {/* The create box moved out of the sidebar and became the composer, which
          needs the room: it takes a prompt, not a name. This is the route to
          it, and the `+` on each group is the same route with that project
          preselected. */}
          <Show when={!flip()}>
            <div class="tl-new-row">
              <button
                class="tl-new-btn tl-new-full"
                aria-label="New session"
                onClick={() => props.onNewSession?.()}
              >
                + New session
              </button>
            </div>
          </Show>

          <div
            class="tl-sidebar-scroll"
            // The groups are a sortable of their own, dragged by their headers.
            // Each group's cards are a sortable NESTED in one of these nodes, and
            // the inner list claims a press on a card first, so the two never
            // answer the same gesture.
            ref={(el) =>
              attachGroupList(el, {
                // None while the phone's search results stand in for the groups:
                // no header is on screen to drag.
                visible: () => (searching() ? [] : visibleGroups().map(groupToken)),
                sequence: () => groupSeqTokens(store.layout()),
                reorder: (from, to) => store.reorderGroupsTo(from, to),
                hold: () => store.hold(),
              })
            }
          >
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

            {/* The phone's search results: one flat list, each row naming its
            own project since no group header sits over it. Keyed by name so
            a poll does not remount a row. */}
            <Show when={searching()}>
              <div class="tl-search-count" classList={{ "tl-muted": results().length === 0 }}>
                {results().length === 0
                  ? `No sessions match “${query().trim()}”`
                  : countLabel(results().length)}
              </div>
              <For each={results().map((r) => r.key)}>
                {(key) => (
                  <Show when={results().find((r) => r.key === key)}>
                    {(r) => (
                      <SessionCard
                        isUnseen={unseenOf}
                        store={store}
                        session={r().s}
                        groupName={r().group}
                        tick={tick}
                        badge={badge}
                        showLastActive={showLastActive}
                        searchProject={r().project}
                      />
                    )}
                  </Show>
                )}
              </For>
            </Show>

            <Show when={!searching()}>
              {/* Keyed by group token, for the reason the origin groups below are
            keyed by name: a group whose cards change is a new object (a new
            session listed, a session renamed), and keyed by object the whole
            group and every card in it was rebuilt, seconds into every create. */}
              <For each={visibleGroups().map(groupToken)}>
                {(token) => (
                  <Show when={visibleGroups().find((g) => groupToken(g) === token)}>
                    {(g) => (
                      <ProjectGroup
                        isUnseen={unseenOf}
                        store={store}
                        group={g()}
                        tick={tick}
                        badge={badge}
                        showLastActive={showLastActive}
                        onNewSession={props.onNewSession}
                      />
                    )}
                  </Show>
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
                        {(s) => (
                          <SessionCard
                            isUnseen={unseenOf}
                            store={store}
                            session={s}
                            groupName=""
                            tick={tick}
                            badge={badge}
                            showLastActive={showLastActive}
                          />
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>

              {/* The Caller groups, then System, at the very foot. A Caller's group
            holds what that program started through agent-api; System holds
            the sessions the lobby's own create path did not make — harness
            fleets, and whatever else reached the tmux server without saying
            who it was. All collapsed by default, which is the point of them,
            so the COUNT is the whole of the evidence that something landed
            here and has to be readable without opening the group. Keyed by
            name so a poll does not remount an open group. */}
              <For each={originGroups().map((g) => g.name)}>
                {(name) => (
                  <Show when={originGroups().find((g) => g.name === name)}>
                    {(g) => <OriginGroup group={g()} />}
                  </Show>
                )}
              </For>
            </Show>
          </div>

          {/* The phone has no footer row: its buttons are in the header's ⋯
          menu. The new-project box still opens here, at the foot, where the
          keyboard reveal (mobile/reveal.ts) already knows to bring it up. */}
          <Show when={flip() && addingProject()}>
            <div class="tl-sidebar-foot">{projectBox()}</div>
          </Show>
          <Show when={!flip()}>
            <div class="tl-sidebar-foot">
              <Show when={!addingProject()} fallback={projectBox()}>
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
              {props.actAsChip}
              {/* Beside the gear, because it is the short answer to the question the
            gear opens: attach a Claude or pi session and it reads that tool's
            spend today, attach a Codex one and it reads the tighter of its two
            limits. */}
              <Show when={props.onOpenSpend}>
                {(open) => (
                  <SpendFigure tool={attachedTool} polls={store.polls} onOpen={() => open()()} />
                )}
              </Show>
              <Show when={props.onOpenSkills}>
                {(open) => (
                  <button
                    class="tl-icon-btn tl-foot-skills"
                    aria-label="Skills"
                    title="Skills"
                    onClick={() => open()()}
                  >
                    <SkillsIcon />
                  </button>
                )}
              </Show>
              <Show when={props.onOpenSettings}>
                {(open) => (
                  <button
                    class="tl-icon-btn tl-settings-btn tl-foot-settings"
                    aria-label="Settings"
                    title="Settings"
                    onClick={() => open()()}
                  >
                    ⚙
                  </button>
                )}
              </Show>
            </div>
          </Show>

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
      </SidebarPhoneContext.Provider>
    </SidebarWorkspacesContext.Provider>
  );
};
