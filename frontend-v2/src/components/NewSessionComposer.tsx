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
  COMMAND_PHRASES,
  effectiveCommand,
  NEW_SESSION_COMMANDS as COMMANDS,
  type CommandAvailability,
} from "../lib/new-commands";
import {
  MODEL_PHRASES,
  modelCommandFor,
  NEW_SESSION_MODELS,
  type NewModel,
} from "../lib/models";
import { PromptField } from "./PromptField";
import { isCoarsePointer } from "../mobile/pointer";
import { deliverFirstPrompt } from "../lib/first-prompt";
import { uploadAttachments } from "../clipboard/attach-files";
import { composeMessage } from "./compose.logic";
import { attachmentKind } from "../lib/attachments";
import { parkDraft, type DraftAttachment } from "../store/drafts";
import { showToast } from "../store/toast";

/** Where the composer's unsent draft lives (store/drafts.ts).
 *
 *  `:` is the one character a session name cannot contain, so this key can
 *  never collide with a real session's draft however many sessions exist. */
export const NEW_SESSION_DRAFT_KEY = ":new";

/**
 * The stand-in path a held file wears until it has been uploaded.
 *
 * The tray is keyed by path — it is what de-duplicates a chip, what the × on a
 * chip removes, and what a thumbnail is fetched from — so a file waiting for a
 * session still needs one. It deliberately cannot be mistaken for a real path:
 * every path the store or a /tmp transfer produces is absolute, so nothing that
 * resolves one will resolve this, and `contentUrlFor` answers null for it,
 * which is what draws the chip as an icon and a name rather than a broken
 * image.
 */
const HELD_PATH_PREFIX = "held:";

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
  /** Where the next session should go, by the caller's reckoning: fired when
   *  somebody picks in the selector AND after a create lands, since both are
   *  what make a project "the last one". The caller decides what to persist. */
  onProject: (name: string) => void;
  /** A control for the header — on a phone, the route to the session list. */
  leading?: JSX.Element;
  /** Seams for tests, defaulting to the real thing: how a created session is
   *  given its first prompt, and how held files reach its store. */
  deliver?: typeof deliverFirstPrompt;
  upload?: typeof uploadAttachments;
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
  // Set once submit has handed the warm slot to the attach. From then on this
  // composer neither warms nor releases: creating WRITES THE LAYOUT, which sets
  // the layout signal synchronously (store.saveLayout → applyLocalLayout) while
  // we are still mounted, so the effect below re-runs, finds warmedDir back at
  // null and re-arms it — and the unmount that follows `select()` would then
  // hand back, over DELETE /sessions/prewarm, the very slot ttyd is a few
  // hundred milliseconds away from claiming. Every create into a named project
  // would boot cold.
  let handedOff = false;
  const releaseWarm = (): void => {
    if (warmedDir === null) return;
    void props.store.releasePrewarm(warmedDir);
    warmedDir = null;
  };
  createEffect(() => {
    const dir = dirFor(props.project());
    if (handedOff) return;
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
  onCleanup(() =>
    window.removeEventListener("tl:focus-new-session", onFocusReq),
  );

  // ---- files with nowhere to go yet ---------------------------------------
  // Held, not uploaded. There is no session to upload INTO until Enter is
  // pressed, and writing into a bucket for a session that may never be created
  // would leave a file behind every abandoned draft. They are memory-only: the
  // typed text persists through the draft store, a File cannot, so a reloaded
  // tab shows an empty tray with the prose still in it.
  const held = new Map<string, File>();
  let heldSeq = 0;
  const holdFiles = (files: File[]): Promise<DraftAttachment[]> => {
    const chips: DraftAttachment[] = [];
    for (const f of files) {
      heldSeq += 1;
      const path = `${HELD_PATH_PREFIX}${heldSeq}/${f.name}`;
      held.set(path, f);
      chips.push({ path, name: f.name, kind: attachmentKind(f.name) });
    }
    return Promise.resolve(chips);
  };
  // Leaving without creating takes the files with it — nothing was uploaded, so
  // there is nothing to clean up anywhere else.
  onCleanup(() => held.clear());

  /**
   * Create the session and give it what was typed.
   *
   * Nothing is refused, including an empty box: `store.create` mints the id and
   * the attach brings the session into being, so there is no name to collide
   * and no reason left to say no. An empty box makes a bare session and sends
   * nothing, which is a real instruction. The slot warmed above is deliberately
   * NOT released — create only STARTS the attach, and handing it back now would
   * reliably win that race and cost the create its head start. `handedOff` is
   * what makes that stick: without it the create's own layout write re-arms the
   * warm before the unmount, and the unmount releases it.
   *
   * Resolves as soon as the session exists, not when the prompt lands. Creating
   * SELECTS, which unmounts this composer, so the delivery deliberately outlives
   * it: everything it needs is read out of props first, and it reports through
   * the toaster rather than back into a field that is no longer on screen.
   */
  const submit = async (
    text: string,
    tray: readonly DraftAttachment[],
  ): Promise<boolean> => {
    handedOff = true; // and never warmed again: the create's own layout write re-runs the effect
    warmedDir = null; // claimed by the attach; not ours to hand back
    const shell = naming();
    const store = props.store;
    const key = cmd();
    // `/model` is Claude's. Codex and a plain shell would take it as literal
    // text and put it in the conversation (lib/models.ts).
    const modelLine = key === "claude" ? modelCommandFor(model()) : null;
    const files = tray
      .map((a) => held.get(a.path))
      .filter((f): f is File => f !== undefined);
    held.clear();
    // Everything the delivery needs, read while this component is still on
    // screen. It runs after the create has selected the session and unmounted
    // us, so nothing below may reach back into props.
    const deliver = props.deliver ?? deliverFirstPrompt;
    const upload = props.upload ?? uploadAttachments;

    const project = props.project();
    const id = await store.create(text, project, shell ? "name" : "prompt");
    // Creating into a project is what MAKES it the last one, so it is recorded
    // here rather than only when somebody opens the dropdown. Without this the
    // preference is written on one path only — a deliberate pick — and the
    // composer exists to remove that step, so the common route never wrote it
    // and every session landed in Ungrouped however many had gone elsewhere.
    props.onProject(project);
    // A shell has no conversation to prompt: the text was its NAME.
    if (shell) return true;
    void sendFirstPrompt({
      session: id,
      text,
      files,
      modelLine,
      claude: key === "claude",
      deliver,
      upload,
    });
    return true;
  };

  const submitName = (): void => {
    const n = name();
    setName("");
    void submit(n, []);
  };

  return (
    <div class="tl-new-view">
      {/* The SAME bar the session view carries, not a lookalike: same class,
          so it keeps the same height, border, background and every phone rule
          already written for it — the label exemption on the back control, the
          overflow guard, the flex-none children. A header that reads
          differently on the two screens makes the row jump when you move
          between them, and this is the one screen you arrive on. */}
      <div class="tl-session-bar">
        {props.leading}
        <span class="tl-session">New session</span>
      </div>
      <div class="tl-new-composer">
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
            onAttach={holdFiles}
            pendingAttachments
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
          {/* "in <project>" rather than the bare name, so the row reads as
              one sentence and the name cannot be mistaken for the command or
              the model beside it. Ungrouped is already a noun and needs no
              preposition. */}
          <option value="">Ungrouped</option>
          <For each={projects()}>
            {(p) => <option value={p.name}>in {p.name}</option>}
          </For>
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
                {COMMAND_PHRASES[c]}
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
              props.prefs.setPref({
                session: { newModel: e.currentTarget.value as NewModel },
              })
            }
          >
            <For each={NEW_SESSION_MODELS}>
              {(k) => <option value={k}>{MODEL_PHRASES[k]}</option>}
            </For>
          </select>
        </Show>
      </>
    );
  }
};

/**
 * Give a just-created session its first prompt.
 *
 * Runs after the composer is gone — creating selects, and selecting unmounts —
 * so it holds no props and reports through the toaster.
 *
 * Order matters and is the whole of it. The files go up FIRST, because the
 * prompt has to carry their paths and those paths do not exist until they are
 * in the session's own bucket. The model line goes ahead of the prompt, because
 * it decides which model answers it. Both ride `deliverFirstPrompt`, which is
 * where the waiting lives: a session tmux has created accepts input seconds
 * before the Claude in it is ready to read any, and text sent into that gap is
 * silently dropped (lib/first-prompt.ts).
 *
 * The waiting is asked for rather than done here: `session-events` holds each
 * attempt until the pane can take the text and answers 503 when it cannot
 * (lib/first-prompt.ts). Only for Claude, whose `❯` is what that check watches
 * for — asking where nothing draws one would spend every rung waiting and give
 * up with the text unsent, so codex takes the ladder alone.
 */
async function sendFirstPrompt(o: {
  session: string;
  text: string;
  files: readonly File[];
  modelLine: string | null;
  claude: boolean;
  deliver: typeof deliverFirstPrompt;
  upload: typeof uploadAttachments;
}): Promise<void> {
  const attached = await o.upload(o.files, o.session, {
    notify: (message, kind) => void showToast(message, kind, 8000),
  });
  const prompt = composeMessage(
    o.text,
    attached.map((a) => a.path),
  );
  const lines = [o.modelLine, prompt].filter((l): l is string => !!l);
  const ok = await o.deliver({
    session: o.session,
    lines,
    awaitReady: o.claude,
  });
  if (ok || lines.length === 0) return;
  // The session exists and is what the person is now looking at, so the text
  // goes into ITS composer — the field in front of them — rather than back into
  // one that has been unmounted since they pressed Enter.
  // parkDraft, not saveDraft: that composer is already mounted and has already
  // read storage, so it has to be TOLD (store/drafts.ts).
  parkDraft(o.session, { text: prompt, attachments: attached, at: Date.now() });
  showToast(
    "Couldn't send the first prompt — it is waiting in the composer",
    "error",
    8000,
  );
}
