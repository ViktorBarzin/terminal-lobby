import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type Accessor,
  type Component,
} from "solid-js";
import type { PrefsStore } from "../store/prefs";
import type { NotificationSystem } from "../notify/notifications";
import type { SkillsStore } from "../store/skills";
import { railFor, resolvePage, type PageId, type RailEntry } from "./settings/rail";
import { AppearancePage } from "./settings/pages/AppearancePage";
import { TerminalPage } from "./settings/pages/TerminalPage";
import { SessionsPage } from "./settings/pages/SessionsPage";
import { KeyboardPage, type KeybindingsControl } from "./settings/pages/KeyboardPage";
import { NotificationsPage } from "./settings/pages/NotificationsPage";
import { NetworkPage } from "./settings/pages/NetworkPage";
import { PrivacyPage } from "./settings/pages/PrivacyPage";
import { ActAsPage, type ActAsControl } from "./settings/pages/ActAsPage";
import { SkillsPage } from "./settings/pages/SkillsPage";

export type { ActAsControl } from "./settings/pages/ActAsPage";
export type { PageId } from "./settings/rail";

/** Which page the panel reopens on. Per device, and deliberately not roamed:
 *  where you were last in Settings is about this screen, not about you. */
const LAST_PAGE_KEY = "tl:settings:page";

const readLastPage = (): string | null => {
  try {
    return localStorage.getItem(LAST_PAGE_KEY);
  } catch {
    return null;
  }
};

const writeLastPage = (id: PageId): void => {
  try {
    localStorage.setItem(LAST_PAGE_KEY, id);
  } catch {
    /* a private window refuses; the panel just opens on the first page */
  }
};

/**
 * The Settings overlay: a category rail and one page at a time.
 *
 * It was thirteen groups down a single 420px column, roughly 2,400px of scroll,
 * where a nine-theme grid, a byte-usage dashboard and a destructive button all
 * carried the same visual weight. Each group was sound; the stack was the
 * problem. The rail is the hierarchy now, and this file holds only what is
 * shared: the chrome, the focus contract, and which page is showing. Every page
 * is its own file under settings/pages/.
 *
 * The contract the dialog keeps, unchanged and now covering Skills too:
 * role="dialog" with aria-modal, a Tab trap that wraps at both ends, Escape to
 * close, and focus returned to whatever opened it.
 */
export const SettingsPanel: Component<{
  prefs: PrefsStore;
  onClose: () => void;
  /** Which page to show, overriding the remembered one. The header's Skills
   *  button passes "skills" so its one-click path survives the move, and it may
   *  change while the panel is open — pressing Skills over an open Settings
   *  switches to that page rather than closing it. */
  initialPage?: PageId;
  /** Which page is actually showing. The openers need this to say whether the
   *  surface behind their button is on screen; without it they would have to
   *  keep a copy of this component's state, which goes stale the moment
   *  someone uses the rail. */
  onPageChange?: (id: PageId) => void;
  /** the keybinding layer's opt-in toggle (per-device, not roamed). */
  keybindings?: KeybindingsControl;
  /** the PWA notification system (per-device readouts + test actions). */
  notifications?: NotificationSystem;
  /** the admin act-as picker. Supplied only when the CALLER administers this
   *  box; absent for everyone else, so the page does not render at all. */
  actAs?: ActAsControl;
  /** the skills inventory behind the Skills page. */
  skills?: SkillsStore;
  /** the caller's live sessions, for the Skills page's Sessions tab. */
  skillSessions?: Accessor<ReadonlyArray<{ name: string; state?: string }>>;
  /** confirm seam for Clear local data and the skills actions (tests inject). */
  confirm?: (message: string) => boolean;
  /** reload seam for Clear local data (tests inject it). */
  onCleared?: () => void;
}> = (props) => {
  let dialogEl: HTMLDivElement | undefined;
  let railEl: HTMLDivElement | undefined;
  let pageEl: HTMLDivElement | undefined;

  const rail = createMemo<RailEntry[]>(() => railFor({ admin: !!props.actAs }));
  const [page, setPage] = createSignal<PageId>(
    resolvePage(railFor({ admin: !!props.actAs }), props.initialPage ?? readLastPage()),
  );
  // The rail can lose an entry under a live panel — an act-as switch drops the
  // admin control — so the shown page is filtered through the rail rather than
  // trusted from the signal alone.
  const current = (): PageId => resolvePage(rail(), page());

  const show = (id: PageId): void => {
    setPage(id);
    writeLastPage(id);
  };

  // An opener may ask for a different page while the panel is already open.
  // Deferred, so the signal's own seed owns the first render, and it does not
  // write the remembered page: being sent to a page is not the same as
  // navigating to one.
  createEffect(
    on(
      () => props.initialPage,
      (id) => {
        if (id && id !== page()) setPage(id);
      },
      { defer: true },
    ),
  );

  // Report the page that is SHOWING, which is not always the one asked for:
  // the rail moves it, and the rail can drop an entry under a live panel.
  createEffect(on(current, (id) => props.onPageChange?.(id)));

  /** Tabbable descendants in DOM order — a disabled −/+ drops out on its own. */
  const tabbable = (): HTMLElement[] =>
    dialogEl
      ? [
          ...dialogEl.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ]
      : [];

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
      return;
    }
    // aria-modal="true" tells assistive tech Tab cannot leave this dialog, so
    // it must not: wrap at both ends instead of landing on the app behind.
    if (e.key === "Tab" && dialogEl) {
      const items = tabbable();
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const outside = !dialogEl.contains(active);
      if (!first || !last) {
        e.preventDefault();
        dialogEl.focus();
      } else if (e.shiftKey && (outside || active === first || active === dialogEl)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  /**
   * ↑↓ walk the rail, Home/End jump to its ends, Enter steps into the page —
   * what a vertical tablist is expected to do, and the reason the rail rather
   * than a text box takes focus when the panel opens.
   */
  const onRailKey = (e: KeyboardEvent): void => {
    // Enter on a tab that is already selected would otherwise re-select it and
    // leave you where you were, which is a dead end for a keyboard.
    if (e.key === "Enter") {
      const first = pageEl?.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!first) return; // a page with nothing to focus keeps the rail
      e.preventDefault();
      first.focus();
      return;
    }
    const order = rail();
    const at = order.findIndex((r) => r.id === current());
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(order.length - 1, at + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, at - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = order.length - 1;
    else return;
    e.preventDefault();
    const id = order[next]?.id;
    if (!id) return;
    show(id);
    railEl?.querySelector<HTMLElement>(`[data-page="${id}"]`)?.focus();
  };

  // Opening moves focus to the rail rather than to the ✕, so Enter doesn't
  // immediately close the panel and ↑↓ work from the first keystroke; every
  // close path unmounts, so the restore belongs in onCleanup and covers the ✕,
  // the backdrop and Escape alike.
  let opener: HTMLElement | null = null;
  onMount(() => {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Deferred like the command palette's: the node is in the document by the
    // time the microtask runs.
    queueMicrotask(() =>
      (railEl?.querySelector<HTMLElement>('[aria-selected="true"]') ?? dialogEl)?.focus(),
    );
  });
  onCleanup(() => {
    if (opener && opener !== document.body && opener.isConnected) opener.focus();
  });

  const heading = () => rail().find((r) => r.id === current())?.label ?? "";

  return (
    <div
      class="tl-settings-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        ref={dialogEl}
        class="tl-settings tl-settings-wide"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabindex="-1"
      >
        <div class="tl-settings-head">
          <span class="tl-settings-title">Settings</span>
          <button
            type="button"
            class="tl-icon-btn"
            aria-label="Close settings"
            title="Close"
            onClick={() => props.onClose()}
          >
            ✕
          </button>
        </div>

        <div class="tl-set-body">
          <div
            ref={railEl}
            class="tl-set-rail"
            role="tablist"
            aria-orientation="vertical"
            aria-label="Settings categories"
            onKeyDown={onRailKey}
          >
            <For each={rail()}>
              {(entry) => (
                <button
                  type="button"
                  role="tab"
                  class="tl-set-rail-item"
                  classList={{
                    "is-on": current() === entry.id,
                    "starts-group": entry.startsGroup,
                  }}
                  data-page={entry.id}
                  aria-selected={current() === entry.id}
                  // Roving tabindex: Tab reaches the rail once and lands on the
                  // selected entry, then ↑↓ move within it.
                  tabindex={current() === entry.id ? 0 : -1}
                  onClick={() => show(entry.id)}
                >
                  {entry.label}
                </button>
              )}
            </For>
          </div>

          <div
            ref={pageEl}
            class="tl-set-page"
            classList={{ "is-skills": current() === "skills" }}
            role="tabpanel"
            aria-label={heading()}
          >
            <h2 class="tl-set-page-title">{heading()}</h2>
            <Switch>
              <Match when={current() === "appearance"}>
                <AppearancePage />
              </Match>
              <Match when={current() === "terminal"}>
                <TerminalPage prefs={props.prefs} />
              </Match>
              <Match when={current() === "sessions"}>
                <SessionsPage prefs={props.prefs} />
              </Match>
              <Match when={current() === "keyboard"}>
                <Show
                  when={props.keybindings}
                  fallback={
                    <div class="tl-set-hint tl-set-hint-static">
                      The shortcut layer is not running in this tab.
                    </div>
                  }
                >
                  {(kb) => <KeyboardPage keybindings={kb()} />}
                </Show>
              </Match>
              <Match when={current() === "notifications"}>
                <NotificationsPage prefs={props.prefs} notifications={props.notifications} />
              </Match>
              <Match when={current() === "network"}>
                <NetworkPage />
              </Match>
              <Match when={current() === "privacy"}>
                <PrivacyPage confirm={props.confirm} onCleared={props.onCleared} />
              </Match>
              <Match when={current() === "skills"}>
                <Show
                  when={props.skills}
                  fallback={
                    <div class="tl-set-hint tl-set-hint-static">
                      Skills are not available in this tab.
                    </div>
                  }
                >
                  {(store) => (
                    <SkillsPage
                      skills={store()}
                      sessions={props.skillSessions}
                      confirm={props.confirm}
                    />
                  )}
                </Show>
              </Match>
              <Match when={current() === "actas"}>
                <Show when={props.actAs}>{(ctl) => <ActAsPage actAs={ctl()} />}</Show>
              </Match>
            </Switch>
          </div>
        </div>
      </div>
    </div>
  );
};
