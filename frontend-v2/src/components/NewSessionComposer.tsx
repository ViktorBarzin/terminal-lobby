import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  type Accessor,
  type Component,
  type JSX,
} from "solid-js";
import type { LobbyStore } from "../store/lobby";
import type { NewCommand, PrefsStore } from "../store/prefs";
import { MAX_TITLE_RUNES } from "../lib/title";
import {
  canRun,
  COMMAND_LABELS,
  effectiveCommand,
  NEW_SESSION_COMMANDS as COMMANDS,
  type CommandAvailability,
} from "../lib/new-commands";
import { MODEL_LABELS, NEW_SESSION_MODELS, type NewModel } from "../lib/models";
import { PromptField } from "./PromptField";
import { isCoarsePointer } from "../mobile/pointer";

/** Where the composer's unsent draft lives (store/drafts.ts).
 *
 *  `:` is the one character a session name cannot contain, so this key can
 *  never collide with a real session's draft however many sessions exist. */
export const NEW_SESSION_DRAFT_KEY = ":new";

/**
 * The new-session composer: you say what you want to do, and the session is
 * created to do it.
 *
 * It replaced a name box that refused to be empty, so a name had to be chosen
 * before the session existed — before there was any work to name it after
 * (docs/plans/2026-09-04-prompt-first-sessions-design.md). Nothing here asks
 * for a name: `store.create` mints an opaque id (ADR-0019) and the title comes
 * from Claude's own summary of the conversation a few seconds later. Until it
 * does, the card reads the first line of what was typed here.
 *
 * Three controls sit under the field. The PROJECT is where the session lands,
 * defaulting to the last one created in and overridable for one create by the
 * `+` on a sidebar group. The COMMAND is which tool runs, the same roamed
 * `session.newCommand` the terminal attach reads, so what is picked here is
 * what starts. The MODEL is applied as `/model <name>` ahead of the first
 * prompt (lib/models.ts) rather than as a launch flag, which is what keeps the
 * pre-warm pool usable for every model.
 *
 * Choosing `shell` turns the box back into a NAME box: a shell has no
 * conversation to prompt or to summarise, and it is the case where someone most
 * likely wanted to name the thing.
 */
export const NewSessionComposer: Component<{
  store: LobbyStore;
  prefs: PrefsStore;
  /** Which new-session commands this box can actually run. Absent means no
   *  opinion, and everything is offered — which is what a failed probe must
   *  leave behind. */
  available?: () => CommandAvailability;
  /** The project a create lands in, "" for Ungrouped. Resolved by the caller,
   *  which is what lets the sidebar's `+` override the roamed preference for a
   *  single create without overwriting it. */
  project: Accessor<string>;
  /** The user picked a project. */
  onProject: (name: string) => void;
  /** A control for the header — on a phone, the route to the session list. */
  leading?: JSX.Element;
}> = (props) => {
  const avail = (): CommandAvailability => props.available?.() ?? {};
  const cmd = (): NewCommand =>
    effectiveCommand(props.prefs.prefs().session.newCommand, avail(), COMMANDS);
  const model = (): NewModel => props.prefs.prefs().session.newModel;
  /** A shell has no prompt to receive, so the box asks for a name instead. */
  const naming = (): boolean => cmd() === "shell";
  const projects = () => props.store.layout().projects;
  const dirFor = (name: string): string | undefined =>
    projects().find((p) => p.name === name)?.dir || undefined;

  let nameEl: HTMLInputElement | undefined;
  const [name, setName] = createSignal("");

  // ---- speculative pre-warm ------------------------------------------------
  // Being on screen is the earliest moment a session's DIRECTORY is known, and
  // it is seconds before anything is typed. Claude takes ~2.4s to boot, so
  // starting one now means the attach can adopt a ready session with a ~9ms
  // rename instead of waiting for it.
  //
  // Only when the project actually has a dir: without one the session would
  // start in $HOME, and warming $HOME would spend a slot on the one directory
  // that is never specific to a project.
  //
  // Held separately from the project name because a project's dir can change
  // under us, and releasing a different directory would leave the warmed slot
  // behind and collect one nobody asked about.
  let warmedDir: string | null = null;
  const releaseWarm = (): void => {
    if (warmedDir === null) return;
    void props.store.releasePrewarm(warmedDir);
    warmedDir = null;
  };
  createEffect(() => {
    const dir = dirFor(props.project());
    if (dir === warmedDir || (dir === undefined && warmedDir === null)) return;
    // Changing project hands the old guess back rather than leaving ~530MB for
    // the server's TTL to notice.
    releaseWarm();
    if (!dir) return;
    warmedDir = dir;
    void props.store.prewarm(dir);
  });
  // Leaving the composer without creating means the guess was wrong.
  onCleanup(releaseWarm);

  // The session.new command (Alt+Shift+N / the palette's "New session")
  // focuses this box; App reveals the composer first, then dispatches.
  const onFocusReq = () => queueMicrotask(() => focusField());
  const registerFocus = (fn: () => void): void => void (focusField = fn);
  let focusField: () => void = () => nameEl?.focus();
  window.addEventListener("tl:focus-new-session", onFocusReq);
  onCleanup(() => window.removeEventListener("tl:focus-new-session", onFocusReq));

  /**
   * Create the session.
   *
   * Nothing is refused, including an empty box: `store.create` mints the id and
   * the attach brings the session into being, so there is no name to collide
   * and no reason left to say no. The slot warmed above is deliberately NOT
   * released — create only STARTS the attach, and handing it back now would
   * reliably win that race and cost the create its head start.
   */
  const submit = async (text: string): Promise<boolean> => {
    warmedDir = null; // claimed by the attach; not ours to hand back
    await props.store.create(text, props.project(), naming() ? "name" : "prompt");
    return true;
  };

  const submitName = (): void => {
    const n = name();
    setName("");
    void submit(n);
  };

  return (
    <div class="tl-new-composer">
      <div class="tl-new-head">
        {props.leading}
        <h2 class="tl-new-title">New session</h2>
      </div>
      <Show
        when={!naming()}
        fallback={
          <div class="tl-composer-box">
            <div class="tl-composer-row">
              <input
                ref={nameEl}
                class="tl-composer-input tl-new-name"
                placeholder="Name this shell…"
                aria-label="Name for the new session"
                maxlength={MAX_TITLE_RUNES}
                value={name()}
                autofocus={!isCoarsePointer()}
                onInput={(e) => setName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitName();
                }}
              />
            </div>
            <div class="tl-composer-bar">
              <div class="tl-bar-left">{controls()}</div>
              <div class="tl-bar-right">
                <button type="button" class="tl-send" onClick={submitName}>
                  Send
                </button>
              </div>
            </div>
          </div>
        }
      >
        <PromptField
          onSend={submit}
          label="Prompt for a new session"
          allowEmpty
          placeholder="What do you want to do?"
          hint="Enter to start the session · Shift+Enter for a newline"
          draftKey={NEW_SESSION_DRAFT_KEY}
          // A desktop lands here ready to type. A coarse pointer deliberately
          // does not: this is the phone's LANDING view, and focusing it would
          // throw a keyboard over the screen before anyone asked for one.
          autofocus={!isCoarsePointer()}
          register={(api) => registerFocus(api.focus)}
          leftExtra={controls()}
        />
      </Show>
    </div>
  );

  /** The three choices, shared by both shapes of the box. */
  function controls(): JSX.Element {
    return (
      <>
        <select
          class="tl-new-cmd"
          aria-label="Project for new session"
          value={props.project()}
          onChange={(e) => props.onProject(e.currentTarget.value)}
        >
          <option value="">Ungrouped</option>
          <For each={projects()}>{(p) => <option value={p.name}>{p.name}</option>}</For>
        </select>
        <select
          class="tl-new-cmd"
          aria-label="Command for new session"
          value={cmd()}
          onChange={(e) =>
            props.prefs.setPref({
              session: { newCommand: e.currentTarget.value as NewCommand },
            })
          }
        >
          <For each={COMMANDS}>
            {(c) => (
              <option value={c} disabled={!canRun(c, avail())}>
                {COMMAND_LABELS[c]}
                {canRun(c, avail()) ? "" : " (not installed)"}
              </option>
            )}
          </For>
        </select>
        {/* Nothing summarises a shell and nothing reads `/model` in one, so the
            picker is only offered where it means something. */}
        <Show when={!naming()}>
          <select
            class="tl-new-cmd"
            aria-label="Model for new session"
            value={model()}
            onChange={(e) =>
              props.prefs.setPref({ session: { newModel: e.currentTarget.value as NewModel } })
            }
          >
            <For each={NEW_SESSION_MODELS}>
              {(k) => <option value={k}>{MODEL_LABELS[k]}</option>}
            </For>
          </select>
        </Show>
      </>
    );
  }
};
