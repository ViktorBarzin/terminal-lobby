import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type Accessor,
  type Component,
  type JSX,
} from "solid-js";
import { setSessionModel } from "../lib/model-api";
import { readCatalogue } from "../store/catalogue";
import { newSessionCommandsUrl } from "../lib/config";
import type { SlashCommand } from "../logic/compose.logic";
import type { Catalogue } from "../store/catalogue";
import type { LobbyStore } from "../store/lobby";
import type { SessionTool } from "../types/lobby";
import type { NewCommand, PrefsStore } from "../store/prefs";
import { MAX_TITLE_RUNES } from "../lib/title";
import {
  canRun,
  COMMAND_LABELS,
  effectiveCommand,
  NEW_SESSION_COMMANDS as COMMANDS,
  type CommandAvailability,
} from "../lib/new-commands";
import {
  chipName,
  DEFAULT_CHOICE,
  isOneSessionEffort,
  labelFor,
  modelHarness,
  modelName,
  type ModelHarness,
} from "../lib/models";
import { modelChoiceFor, modelChoicePatch } from "../store/prefs";
import { PromptField, type PromptFieldSinks } from "./PromptField";
import { DialBar, type DialSpec } from "./Dial";
import { ModelPanel } from "./ModelPanel";
import { CheckIcon, SendArrowIcon } from "./Icons";
import { installImageClipboard } from "../clipboard/attach";
import { isCoarsePointer } from "../mobile/pointer";
import { deliverFirstPrompt, firstPromptDelivery } from "../lib/first-prompt";
import { piModels, refreshPiModels } from "../lib/pi-models";
import { uploadAttachments } from "../clipboard/attach-files";
import { composeMessage } from "../logic/compose.logic";
import { attachmentKind, dropToken } from "../lib/attachments";
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
 * An attachment is keyed by path — it is what de-duplicates one, and what the
 * send looks up — so a file waiting for a session still needs one. It
 * deliberately cannot be mistaken for a real path: every path the store or a
 * /tmp transfer produces is absolute, so nothing that resolves one will
 * resolve this.
 */
const HELD_PATH_PREFIX = "held:";

/**
 * A URL the chip can draw a held file from, or undefined where the platform
 * will not make one (jsdom has no `createObjectURL`; a browser refuses on a
 * revoked or detached blob). Absent simply means the chip stays the pill it
 * was, which is what this screen showed before there were thumbnails at all.
 */
function objectUrl(f: File): string | undefined {
  try {
    return typeof URL.createObjectURL === "function" ? URL.createObjectURL(f) : undefined;
  } catch {
    return undefined;
  }
}

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
 * Three dials sit on a line above the field, right-aligned the way the live
 * composer's are, and built from the same component (Dial.tsx): "project code
 * · command Claude · model Opus 5.5 · High". The PROJECT is where the session
 * lands, defaulting to the last one created in and overridable for one create
 * by the `+` on a sidebar group. The COMMAND is which tool runs, the same
 * roamed `session.newCommand` the terminal attach reads, so what is picked here
 * is what starts. The MODEL and the EFFORT share one dial, as they do on the
 * live composer. Both belong to whichever CLI the command names (no two share
 * a vocabulary) and leave as launch arguments on the process the attach starts
 * (lib/terminal-url.ts). Pi's models are the one list not written down: they
 * are pi's own, read from GET /pi-models each time this opens with pi chosen
 * (ADR-0032), and its effort is pi's thinking level.
 *
 * On a phone the dials open one sheet with a tab each, and a pick leaves it
 * open, so the project and the model take one visit rather than two. A
 * popover on a desktop closes on a pick, as the live composer's does.
 *
 * Choosing `shell` turns the box back into a NAME box: a shell has no
 * conversation to prompt or to summarise, and it is the case where someone most
 * likely wanted to name the thing. It holds the same line either way — nothing
 * typed, nothing created.
 */
/** The real catalogue read: what a session started in `dir` would offer. */
function fetchCatalogue(dir: string): Promise<Catalogue> {
  return readCatalogue(() => fetch(newSessionCommandsUrl(dir)));
}

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
  /** How the `/` menu's catalogue is read, for the directory a session would
   *  start in. Injected by tests; the default is the real endpoint. */
  catalogue?: (dir: string) => Promise<Catalogue>;
  setModel?: typeof setSessionModel;
}> = (props) => {
  const avail = (): CommandAvailability => props.available?.() ?? {};
  const cmd = (): NewCommand =>
    effectiveCommand(props.prefs.prefs().session.newCommand, avail(), COMMANDS);
  /** Which CLI is starting, or null for a shell, which has none. */
  const harness = (): ModelHarness | null => modelHarness(cmd() as SessionTool);
  const choice = (h: ModelHarness) => modelChoiceFor(props.prefs.prefs(), h);

  // ---- pi's models ---------------------------------------------------------
  // Read again whenever this opens with pi chosen, and whenever pi becomes the
  // choice: that is the moment somebody is about to pick, and a provider
  // signed into since the page loaded should be there. A memo, so the read
  // follows the command and nothing else — picking a model writes a
  // preference, and that is no reason to run pi on the server again.
  const choosingPi = createMemo(() => harness() === "pi");
  createEffect(() => {
    if (choosingPi()) void refreshPiModels();
  });
  /**
   * The model rows pi offers: its own list, and the stored pick when that list
   * does not carry it. The attach launches on the stored pick whatever the
   * menu shows, so a menu that dropped it would disagree with what starts —
   * before the list arrives, and after pi stops listing a model somebody
   * chose. Pi applies a launch model it no longer lists as best it can, which
   * is why it is sent as an environment variable rather than a flag that
   * would end the session on the spot (design doc, "terminal-lobby").
   */
  const piModelRows = (): string[] => [
    ...(piModels()?.models ?? []).map((m) => m.ref),
    choice("pi").model,
  ];
  /** Why pi's model list could not be read, or undefined. */
  const piListError = (): string | undefined => {
    const err = choosingPi() ? piModels()?.error : undefined;
    return err ? `Pi's model list could not be read: ${err}` : undefined;
  };
  /** Nothing listed, nothing failed, nobody signed in: pi needs a `/login`. */
  const piSignedOut = (): boolean => {
    const a = piModels();
    return choosingPi() && !!a && !a.signedIn && !a.error && a.models.length === 0;
  };
  /** A shell has no prompt to receive, so the box asks for a name instead. */
  const naming = (): boolean => cmd() === "shell";
  const projects = () => props.store.layout().projects;
  const dirFor = (name: string): string | undefined =>
    projects().find((p) => p.name === name)?.dir || undefined;

  // ---- the `/` menu --------------------------------------------------------
  // The live composer gets its catalogue from the SESSION (/commands/{session}).
  // This one has no session, so without this it fell back to the built-ins
  // alone and typing `/` offered none of your skills — which is what a person
  // reaching for `/publish-page` in a brand-new session actually wants.
  //
  // Keyed on the selected project, because half the answer is that directory:
  // its .claude/skills and .claude/commands are what the session would see.
  // Re-fetched when the project changes for the same reason. Once per change
  // rather than polled, matching the live composer — these are files on disk.
  const [commands, setCommands] = createSignal<SlashCommand[]>([]);
  const [commandsOk, setCommandsOk] = createSignal(true);
  createEffect(() => {
    const dir = dirFor(props.project()) ?? "";
    const read = props.catalogue ?? fetchCatalogue;
    void read(dir).then((c) => {
      setCommands(c.commands);
      setCommandsOk(c.ok);
    });
  });

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
  // And only while the command is Claude. The pool claims a slot for the
  // `claude` key alone (devvm/tmux-user-attach), so a slot warmed for pi,
  // codex or a shell is a Claude nobody will adopt, held until the server's
  // TTL collects it. Moving the command off Claude hands it back.
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
    const dir = cmd() === "claude" ? dirFor(props.project()) : undefined;
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
  onCleanup(() => window.removeEventListener("tl:focus-new-session", onFocusReq));

  // ---- files with nowhere to go yet ---------------------------------------
  // Held, not uploaded. There is no session to upload INTO until Enter is
  // pressed, and writing into a bucket for a session that may never be created
  // would leave a file behind every abandoned draft. They are memory-only: the
  // typed text persists through the draft store, a File cannot, so a reloaded
  // tab keeps the prose and loses the chips — `anchorRestored` cuts the tokens
  // they left behind out of the restored text.
  const held = new Map<string, File>();
  // The chip's picture, for files that exist nowhere a server can serve them
  // from. Kept beside the files rather than in the chip alone, so every one can
  // be handed back when this screen goes away.
  const previews = new Map<string, string>();
  let heldSeq = 0;
  const holdFiles = (files: File[]): Promise<DraftAttachment[]> => {
    const chips: DraftAttachment[] = [];
    for (const f of files) {
      heldSeq += 1;
      const path = `${HELD_PATH_PREFIX}${heldSeq}/${f.name}`;
      held.set(path, f);
      const kind = attachmentKind(f.name);
      const preview = kind === "image" ? objectUrl(f) : undefined;
      if (preview) previews.set(path, preview);
      chips.push({ path, name: f.name, kind, preview });
    }
    return Promise.resolve(chips);
  };
  // Leaving without creating takes the files with it — nothing was uploaded, so
  // there is nothing to clean up anywhere else. The object URLs are the one
  // thing that outlives the map on its own, so they are handed back by name.
  onCleanup(() => {
    for (const url of previews.values()) URL.revokeObjectURL(url);
    previews.clear();
    held.clear();
  });

  // ---- paste and drop, with no session to upload into ---------------------
  //
  // The Attach button was the only way to get a file onto this screen. The
  // image clipboard is installed by SessionView and gated on that session being
  // ON SCREEN (clipboard/attach.ts `active`), and while this composer is up
  // none is — so a pasted screenshot was handled by nobody and the gesture did
  // nothing at all. Viktor, 2026-09-06: "uploading image (via paste) on new
  // session screen doesn't work".
  //
  // Installing it HERE is what keeps a paste from being handled twice. App
  // renders this composer only while nothing is selected, which is the same
  // moment every kept SessionView's `active` reads false, so exactly one set of
  // document listeners ever wants the gesture.
  //
  // `composerOwns` is unconditionally true: there is no pty on this screen and
  // no session bucket to upload into, so both intakes route to `holdFiles` —
  // the memory-only hold the Attach button fills. `session` and `sendToPty`
  // satisfy the interface and are never reached.
  let sinks: PromptFieldSinks | undefined;
  const image = installImageClipboard({
    session: () => "",
    sendToPty: () => false,
    // A shell is named, not prompted, so the box has no message to put a file
    // in. Declining leaves the paste to the browser, which is what a name box
    // wants; swallowing it would make the gesture look handled and lose it.
    active: () => !naming(),
    composerOwns: () => true,
    onComposerFiles: async (files) => {
      const chips = await holdFiles(files);
      if (chips.length) sinks?.add(chips);
    },
  });
  onCleanup(image.dispose);

  /**
   * Create the session and give it what was typed.
   *
   * Something has to be typed first. An empty box used to create a bare session
   * and send it nothing, on the reading that "just give me a session" is a real
   * instruction — but it is also what a stray Enter looks like, and what it
   * left behind was a session with no prompt to summarise, so it sat in the
   * sidebar as `New session` with nothing in it (Viktor, 2026-09-12). The field
   * refuses that send and draws Send unavailable while it would (PromptField's
   * round button), so by the time this runs there is prose or a held file
   * behind it. The slot warmed above is deliberately
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
  const submit = async (text: string, attached: readonly DraftAttachment[]): Promise<boolean> => {
    handedOff = true; // and never warmed again: the create's own layout write re-runs the effect
    warmedDir = null; // claimed by the attach; not ours to hand back
    const shell = naming();
    const store = props.store;
    // Whether the server should wait for the pane, and for which harness —
    // decided now, while the command is still on screen to read.
    const delivery = firstPromptDelivery(harness());
    // Nothing about the model or the effort happens here any more. Both are
    // FLAGS on the process the attach starts (lib/terminal-url.ts), read out of
    // the same preference this row writes — so by the time the create selects
    // and this component is gone, the answer is already where the attach will
    // look for it. What that replaced was a POST that drove the CLI's own
    // picker after the session was up, which cost about four seconds and put a
    // `/model` line in a conversation that had not started.
    // Paired, not two independent lists: the token is how the send knows where
    // in the text this file's path goes, and a chip whose File has gone missing
    // must not shift the rest of them onto the wrong tokens.
    const picked = attached
      .map((a) => ({ file: held.get(a.path), token: a.token }))
      .filter((p): p is { file: File; token: string | undefined } => p.file !== undefined);
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
      files: picked.map((p) => p.file),
      tokens: picked.map((p) => p.token),
      ...delivery,
      deliver,
      upload,
    });
    return true;
  };

  /** A shell is created from its NAME, so an unnamed one is not created. Its
   *  Send is drawn unavailable for the same reason the prompt box's is. */
  const namable = (): boolean => name().trim() !== "";
  const submitName = (): void => {
    const n = name().trim();
    if (!n) return;
    setName("");
    void submit(n, []);
  };

  // ---- the dials ------------------------------------------------------------
  // Built once each and handed to the bar by reference, every value read
  // through an accessor, so a pick updates a dial in place rather than
  // rebuilding it under the reader's finger.

  /** What a pick does to the float: a popover goes away, the phone's sheet
   *  stays, so a second choice needs no second visit. */
  const afterPick = (ctx: { close: () => void; sheet: boolean }): (() => void) | undefined =>
    ctx.sheet ? undefined : ctx.close;

  const projectName = (): string => props.project() || "Ungrouped";
  const projectDial: DialSpec = {
    id: "project",
    label: "project",
    tab: "Project",
    title: "Project for new session",
    value: () => <span class="tl-dial-value">{projectName()}</span>,
    ariaLabel: () => `Project for new session: ${projectName()}`,
    hint: () => `Project for the new session: ${projectName()}. ${whereItStarts(props.project())}`,
    panel: (ctx) => (
      <div role="radiogroup" aria-label="Project for new session">
        <ChoiceRow
          value=""
          name="Ungrouped"
          sub={whereItStarts("")}
          checked={props.project() === ""}
          onPick={() => pickProject("", ctx)}
        />
        <For each={projects()}>
          {(p) => (
            <ChoiceRow
              value={p.name}
              name={p.name}
              sub={whereItStarts(p.name)}
              checked={props.project() === p.name}
              onPick={() => pickProject(p.name, ctx)}
            />
          )}
        </For>
      </div>
    ),
  };
  /** A project's row says where its session would start. */
  function whereItStarts(name: string): string {
    const dir = dirFor(name);
    return dir ? `Starts in ${dir}` : "Starts in your home directory";
  }
  function pickProject(name: string, ctx: { close: () => void; sheet: boolean }): void {
    if (name !== props.project()) props.onProject(name);
    afterPick(ctx)?.();
  }

  const commandDial: DialSpec = {
    id: "command",
    label: "command",
    tab: "Command",
    title: "Command for new session",
    value: () => <span class="tl-dial-value">{COMMAND_LABELS[cmd()]}</span>,
    ariaLabel: () => `Command for new session: ${COMMAND_LABELS[cmd()]}`,
    hint: () => `What the new session runs: ${COMMAND_LABELS[cmd()]}`,
    panel: (ctx) => (
      <div role="radiogroup" aria-label="Command for new session">
        <For each={COMMANDS}>
          {(c) => (
            <ChoiceRow
              value={c}
              name={COMMAND_LABELS[c]}
              // Greyed out and saying why: a command with nothing behind it
              // starts a session that closes the moment it opens.
              sub={canRun(c, avail()) ? undefined : "Not installed on this box"}
              disabled={!canRun(c, avail())}
              checked={cmd() === c}
              onPick={() => {
                if (c !== cmd()) props.prefs.setPref({ session: { newCommand: c } });
                afterPick(ctx)?.();
              }}
            />
          )}
        </For>
      </div>
    ),
  };

  /** The model by name and the effort by label, as the live dial words them.
   *  An untouched effort is left out rather than read as "Default". */
  const modelWords = (h: ModelHarness): string => {
    const c = choice(h);
    const m = c.model === DEFAULT_CHOICE ? "Default" : modelName(h, c.model);
    const e = c.effort === DEFAULT_CHOICE ? "" : labelFor(h, "effort", c.effort);
    return [m, e].filter((w) => w !== "").join(" · ");
  };
  /** Under the lists: what the choice does, and when it lasts one session. */
  const modelNote = (h: ModelHarness): string => {
    const effort = choice(h).effort;
    return isOneSessionEffort(h, effort)
      ? `${labelFor(h, "effort", effort)} lasts this one session. The next one starts on the default again.`
      : "The new session starts on these.";
  };
  const modelDial: DialSpec = {
    id: "model",
    label: "model",
    tab: "Model",
    get title() {
      return `${chipName(harness() ?? "claude")} for new session`;
    },
    value: () => <span class="tl-dial-value">{modelWords(harness() ?? "claude")}</span>,
    ariaLabel: () => `Model for new session: ${modelWords(harness() ?? "claude")}`,
    // The exact slug, which the name on the dial shortens.
    hint: () => {
      const c = choice(harness() ?? "claude");
      return `Model and effort for the new session: ${c.model} · ${c.effort}`;
    },
    panel: (ctx) => (
      <Show when={harness()}>
        {(h) => (
          <ModelPanel
            harness={h()}
            state={choice(h())}
            busy={false}
            offerDefault
            names={{
              model: "Model for new session",
              effort: "Effort for new session",
            }}
            note={modelNote(h())}
            // Pi's rows are pi's own list plus the stored pick, which the
            // attach launches on whatever the list says (piModelRows).
            {...(h() === "pi" ? { offer: { models: piModelRows() } } : {})}
            // Said on the list it explains, not as a banner: the list could
            // not be read, and the default is what pi will start on.
            {...(piListError() ? { modelTitle: piListError() } : {})}
            onPick={(field, id) => props.prefs.setPref(modelChoicePatch(h(), field, id))}
            onDone={afterPick(ctx)}
          />
        )}
      </Show>
    ),
  };

  /** A shell has no model and no effort, so it gets no model dial. */
  const hasModel = createMemo(() => harness() !== null);
  const dials = createMemo<DialSpec[]>(() =>
    hasModel() ? [projectDial, commandDial, modelDial] : [projectDial, commandDial],
  );

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
        {/* The choices sit on a line above the box, where the live composer
            keeps its dials (the Quiet line, 2026-09-24). */}
        <div class="tl-new-line">
          <DialBar dials={dials()} sheetTitle="New session" />
        </div>
        <Show
          when={!naming()}
          fallback={
            <div class="tl-pill tl-pill-name">
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
              <div class="tl-pill-end">
                <button
                  type="button"
                  class="tl-send"
                  aria-label="Send"
                  title="Start the shell (Enter)"
                  disabled={!namable()}
                  onClick={submitName}
                >
                  <span class="tl-disc">
                    <SendArrowIcon />
                  </span>
                </button>
              </div>
            </div>
          }
        >
          <PromptField
            onSend={submit}
            onAttach={holdFiles}
            pendingAttachments
            label="Prompt for a new session"
            placeholder="What do you want to do?"
            hint="Enter to start the session · Shift+Enter for a newline"
            draftKey={NEW_SESSION_DRAFT_KEY}
            commands={commands()}
            commandsOk={commandsOk()}
            // A desktop lands here ready to type. A coarse pointer deliberately
            // does not: this is the phone's LANDING view, and focusing it would
            // throw a keyboard over the screen before anyone asked for one.
            autofocus={!isCoarsePointer()}
            register={(api) => {
              registerFocus(api.focus);
              // Where a paste or a drop puts its chips: both land outside this
              // component, so the message has to be handed over rather than
              // reached into.
              sinks = api;
            }}
            trayNote="Files upload when the session starts"
          />
        </Show>
        {/* Under the box rather than in its row of controls, which has no
            room for a sentence on a phone. Only when the answer really is
            "nobody signed in": a list that could not be read says so on the
            model menu's own title instead. */}
        <Show when={piSignedOut()}>
          <p class="tl-new-hint">
            Pi is not signed in yet. Run <code>/login</code> in a pi session, and its models appear
            here.
          </p>
        </Show>
      </div>

      {/* The same overlay the session view raises, saying what a drop here
          does differently: nothing is uploaded until the session exists.
          Not raised while naming a shell, where the drop is declined. */}
      <Show when={image.dropActive() && !naming()}>
        <div class="tl-drop-overlay" aria-hidden="true">
          Drop files — they attach to the session you are about to start
        </div>
      </Show>
    </div>
  );
};

/**
 * One row in the project or the command list: a name, a line under it where
 * there is something to say, and a tick on the chosen one. The model list is
 * ModelPanel's own.
 */
const ChoiceRow: Component<{
  value: string;
  name: string;
  sub?: string;
  checked: boolean;
  disabled?: boolean;
  onPick: () => void;
}> = (props) => (
  <button
    type="button"
    role="radio"
    class="tl-pick-row tl-pick-model"
    data-value={props.value}
    aria-checked={props.checked}
    aria-disabled={props.disabled ? "true" : undefined}
    onClick={() => {
      if (!props.disabled) props.onPick();
    }}
  >
    <span class="tl-pick-name">{props.name}</span>
    <span class="tl-pick-tick" aria-hidden="true">
      <Show when={props.checked}>
        <CheckIcon />
      </Show>
    </span>
    <Show when={props.sub}>
      <span class="tl-pick-sub">{props.sub}</span>
    </Show>
  </button>
);

/**
 * Give a just-created session its first prompt.
 *
 * Runs after the composer is gone — creating selects, and selecting unmounts —
 * so it holds no props and reports through the toaster.
 *
 * Order matters and is the whole of it. The files go up FIRST, because the
 * prompt has to carry their paths and those paths do not exist until they are
 * in the session's own bucket. The prompt goes second, and there is no third
 * step: the model and the effort are flags on the process the attach started,
 * so by the time anything is sent the session is already answering as it was
 * asked to.
 *
 * The wait is the server's: a session tmux has created accepts input seconds
 * before the CLI in it is ready to read any, and text sent into that gap is
 * silently dropped, so `session-events` holds each attempt until the pane can
 * take it and answers 503 when it cannot (lib/first-prompt.ts).
 */
async function sendFirstPrompt(o: {
  session: string;
  text: string;
  files: readonly File[];
  /** Each file's token in `text`, by the same index — see `tokenFor`. */
  tokens: readonly (string | undefined)[];
  /** How the server should deliver it (lib/first-prompt.ts, firstPromptDelivery). */
  awaitReady: boolean;
  tool?: "pi";
  deliver: typeof deliverFirstPrompt;
  upload: typeof uploadAttachments;
}): Promise<void> {
  const attached = await o.upload(o.files, o.session, {
    notify: (message, kind) => void showToast(message, kind, 8000),
    tokenFor: (_file, i) => o.tokens[i],
  });
  // A file that did not make it leaves its token behind, and a token that no
  // path replaced would go to Claude as the literal `[img]`. The upload has
  // already said what failed and why; the message simply loses the chip.
  const landed = new Set(attached.map((a) => a.token));
  let written = o.text;
  for (const token of o.tokens) {
    if (token && !landed.has(token)) written = dropToken(written, token);
  }
  const prompt = composeMessage(written, attached);
  const lines = [prompt].filter((l): l is string => !!l);
  const ok = await o.deliver({
    session: o.session,
    lines,
    awaitReady: o.awaitReady,
    ...(o.tool ? { tool: o.tool } : {}),
  });
  if (ok || lines.length === 0) return;
  // The session exists and is what the person is now looking at, so the text
  // goes into ITS composer — the field in front of them — rather than back into
  // one that has been unmounted since they pressed Enter.
  // parkDraft, not saveDraft: that composer is already mounted and has already
  // read storage, so it has to be TOLD (store/drafts.ts).
  //
  // No attachments beside it: `prompt` already carries every path, spliced in
  // where its token stood. Parking them too would hand the live composer files
  // it would splice in a SECOND time on the retry.
  parkDraft(o.session, { text: prompt, attachments: [], at: Date.now() });
  showToast("Couldn't send the first prompt — it is waiting in the composer", "error", 8000);
}
