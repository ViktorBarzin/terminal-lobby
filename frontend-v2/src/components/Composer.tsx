import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  onMount,
  type Component,
} from "solid-js";
import type { PermissionDecision } from "../types/events";
import { MAX_QUEUED_SHOWN, type PendingPermission } from "./timeline.logic";
import { PermissionPanel } from "./PermissionPanel";
import {
  composeMessage,
  completionFor,
  mergeCommands,
  modeLabel,
  BUILTIN_COMMANDS,
  type Completion,
  type CompletionItem,
  type SlashCommand,
} from "./compose.logic";
import { clearDraft, loadDraft, saveDraft, type DraftAttachment } from "../store/drafts";
import { contentUrlFor, storedDisplayName } from "../lib/attachments";
import { FileTextIcon, PaperclipIcon } from "./Icons";

/**
 * Prompt composer with the permission panel docked above it. Send↔Stop morphs
 * on `working` (design: Stop = inject ESC/Ctrl-C into the pty). Enter sends,
 * Shift+Enter inserts a newline. When a permission is pending and the input is
 * empty, 1 approves / 2 denies (T3 number-key affordance).
 *
 * Sending goes through ONE route on every device: `onSend` (the session control
 * channel, session-events /prompt). See submit() for why the coarse-pointer
 * fork through the terminal iframe was removed.
 * The mobile input attributes (autocapitalize off, autocorrect/spellcheck on,
 * enterkeyhint send) restore QuickType / swipe typing and are harmless on
 * desktop.
 */
/** What a caller outside the composer may put into the message being written. */
export interface ComposerSinks {
  /** Add attachments to the tray (a window drop, a gallery tile). */
  add: (items: DraftAttachment[]) => void;
  /** Insert text at the caret (a clipboard paste that is not an image). */
  insertText: (text: string) => void;
}

export const Composer: Component<{
  working: boolean;
  pending: PendingPermission[];
  /** resolves false when the session refused the prompt (409 mid-turn, 5xx,
   *  unreachable), which puts the typed text back in the field. */
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onResolve: (reqId: string, decision: PermissionDecision) => void;
  /** Forward raw pty bytes to the live terminal iframe. No longer used for
   *  SENDING (see submit) — kept for callers that hand bytes to the pty for
   *  other reasons, e.g. answering a prompt the transcript cannot express. */
  sendToTerminal?: (bytes: string) => void;
  /** Prompts already sent in this session, oldest first (↑ recalls them). */
  history?: string[];
  /** Prompts Claude has queued but not yet started. */
  queued?: string[];
  /** The permission mode in force, shown as a chip. */
  mode?: string;
  /** Cycle the permission mode (Shift+Tab in the CLI). */
  onCycleMode?: () => void;
  /** Directory listing for `@` path completion. */
  onListDir?: (dir: string) => Promise<string[]>;
  /** The session's own skills / custom commands / plugin commands, offered by
   *  `/` beside the built-ins this page ships. */
  commands?: SlashCommand[];
  /**
   * The session this composer belongs to — the key its unsent draft is stored
   * under (store/drafts.ts). Attachments and text both persist, so a reload or an
   * evicted phone tab does not lose a half-written message with a photo on it.
   */
  session?: string;
  /** Effective OS user, so a tray thumbnail knows it may fetch its own store. */
  me?: string;
  /**
   * Upload these files and return what became attachable. The uploader decides:
   * a document over the store cap stays an ephemeral /tmp transfer and comes back
   * absent from the result, which is why this returns a list rather than one item
   * per input file.
   */
  onAttach?: (files: File[]) => Promise<DraftAttachment[]>;
  /** Open one attachment in the file preview overlay. */
  onOpenPreview?: (path: string) => void;
  /** Watching: the controls that type are inert, and so is attaching. */
  inertReason?: string;
  /**
   * Hand the caller the two sinks a message can be filled from OUTSIDE this
   * component.
   *
   * The draft's state belongs here, with the persistence that backs it — but the
   * gestures do not: a drag-and-drop lands on the WINDOW, and the Paste button,
   * the ⌘V chord and the command palette all run in the session view
   * (clipboard/attach.ts, clipboard/paste-into-terminal.ts). Rather than hoisting
   * the state up past the thing that owns it, the view is handed these on mount.
   */
  register?: (api: ComposerSinks) => void;
}> = (props) => {
  let ta: HTMLTextAreaElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  const [draft, setDraft] = createSignal("");
  const [tray, setTray] = createSignal<DraftAttachment[]>([]);
  const [attaching, setAttaching] = createSignal(false);
  const [caret, setCaret] = createSignal(0);
  const [paths, setPaths] = createSignal<string[]>([]);
  const [picked, setPicked] = createSignal(0);
  /** Where ↑ has walked to in history; -1 is "not browsing". */
  const [histAt, setHistAt] = createSignal(-1);

  const autosize = () => {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  };

  const sync = () => {
    if (!ta) return;
    setDraft(ta.value);
    setCaret(ta.selectionStart ?? ta.value.length);
    autosize();
  };

  const clear = () => {
    if (!ta) return;
    ta.value = "";
    setDraft("");
    setTray([]);
    setHistAt(-1);
    autosize();
    if (props.session) clearDraft(props.session);
  };

  // ---- the unsent draft: restored on mount, saved on every change ----------
  // Restored on MOUNT rather than in an effect keyed on the session: this
  // component is remounted per session (SessionView is), so a reactive restore
  // would only ever fire once anyway, and doing it here keeps it from racing the
  // first keystroke.
  onMount(() => {
    const key = props.session;
    if (!key) return;
    const saved = loadDraft(key);
    if (!saved) return;
    setTray(saved.attachments);
    if (saved.text && ta) {
      ta.value = saved.text;
      setDraft(saved.text);
      autosize();
    }
  });

  createEffect(() => {
    const key = props.session;
    if (!key) return;
    // Both halves are read reactively so either one changing persists the pair.
    const text = draft();
    const attachments = tray();
    saveDraft(key, { text, attachments, at: Date.now() });
  });

  // ---- attaching -----------------------------------------------------------
  const attach = async (files: File[]): Promise<void> => {
    if (!files.length || !props.onAttach) return;
    setAttaching(true);
    try {
      // De-duplicated by path in addToTray: attaching the same file twice would
      // ask Claude to read it twice and give the tray two identical chips.
      addToTray(await props.onAttach(files));
    } finally {
      setAttaching(false);
    }
  };

  const addToTray = (items: DraftAttachment[]): void => {
    if (!items.length) return;
    setTray((current) => {
      const have = new Set(current.map((a) => a.path));
      return [...current, ...items.filter((a) => !have.has(a.path))];
    });
  };
  /**
   * Insert text at the caret — what a paste read OUTSIDE this component does to
   * the message being written. Same splice the completion menu performs, so a
   * paste behaves like typing: the caret lands after the inserted text and the
   * rest of the message survives.
   */
  const insertText = (text: string): void => {
    if (!ta || !text) return;
    const at = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? at;
    ta.value = ta.value.slice(0, at) + text + ta.value.slice(end);
    const pos = at + text.length;
    ta.setSelectionRange(pos, pos);
    sync();
    ta.focus();
  };

  onMount(() => props.register?.({ add: addToTray, insertText }));

  const removeAt = (path: string): void => {
    setTray((current) => current.filter((a) => a.path !== path));
  };

  /** What `/` or `@` at the caret is currently offering. */
  // Built-ins plus what this session actually has. Merged in a memo so a
  // catalogue that arrives after the first keystroke shows up in the menu the
  // reader is already looking at.
  const catalogue = createMemo<SlashCommand[]>(() =>
    mergeCommands(BUILTIN_COMMANDS, props.commands ?? []),
  );
  const completion = createMemo<Completion | null>(() =>
    completionFor(draft(), caret(), paths(), catalogue()),
  );

  // `@` completes against the real filesystem, so the listing is fetched for
  // whichever directory the token names.
  // A sentinel no directory can equal, so the first refresh always fetches.
  // Escaped, NOT a literal NUL byte: a raw one makes this whole file read as
  // binary, and every grep over the tree silently skips it.
  let lastDir = "\0";
  const refreshPaths = async () => {
    const c = completion();
    if (!c || c.trigger !== "@" || !props.onListDir) return;
    if (c.dir === lastDir) return;
    lastDir = c.dir;
    setPaths(await props.onListDir(c.dir));
  };

  const applyCompletion = (item: CompletionItem) => {
    const c = completion();
    if (!ta || !c) return;
    const value = item.value;
    const before = draft().slice(0, c.start);
    const after = draft().slice(caret());
    // A directory keeps the menu open so the next segment can be picked.
    const suffix = value.endsWith("/") ? "" : " ";
    ta.value = before + value + suffix + after;
    const pos = before.length + value.length + suffix.length;
    ta.setSelectionRange(pos, pos);
    setPicked(0);
    sync();
    void refreshPaths();
    ta.focus();
  };

  /**
   * Send the composed message.
   *
   * ONE route: the session's control channel (`onSend` → session-events
   * /prompt), which drives tmux server-side. It used to fork on
   * `sendToTerminal` for a coarse pointer and post the bytes into the terminal
   * IFRAME instead — and in Text mode that iframe has not attached yet, because
   * the attach is deliberately lazy. sendBytesToFrame returns false with no
   * contentWindow and nothing upstream looked at the result, so the field was
   * cleared and the message went nowhere: typing on a phone, pressing send, and
   * watching the text vanish. The control channel needs no attached iframe, is
   * the same path the desktop has always used, and reports whether it landed.
   *
   * The field is cleared optimistically because it has to feel instant, and the
   * text is put BACK if the send did not land — so a refusal (a 409, a 5xx, an
   * unreachable box) can never destroy what was typed. Only a field the user has
   * not since typed into is restored.
   */
  const submit = () => {
    const raw = ta?.value ?? "";
    const held = tray();
    // The TRAY counts too: attachments with no prose is a valid message, so the
    // old `if (!t) return` would have swallowed a photo sent on its own.
    const message = composeMessage(raw, held.map((a) => a.path));
    if (!message) return;
    clear();
    void props.onSend(message).then((ok) => {
      if (ok || !ta || ta.value !== "") return;
      // A refusal restores BOTH halves. The text already had this guarantee; an
      // attachment needs it more, because re-attaching means finding the file
      // again.
      ta.value = raw;
      setDraft(raw);
      setTray(held);
      autosize();
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const empty = (ta?.value ?? "") === "";
    const c = completion();

    // The completion menu owns the arrows and Enter while it is open.
    if (c && c.items.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = c.items.length;
        setPicked((p) => (e.key === "ArrowDown" ? (p + 1) % n : (p - 1 + n) % n));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyCompletion(c.items[picked()] ?? c.items[0]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPaths([]);
        setCaret(-1); // closes the menu until the next keystroke
        return;
      }
    }

    // Number-key permission affordance (only when not mid-typing).
    if (empty && props.pending.length > 0 && (e.key === "1" || e.key === "2")) {
      const p = props.pending[0];
      if (p) {
        e.preventDefault();
        props.onResolve(p.reqId, e.key === "1" ? "allow" : "deny");
        return;
      }
    }

    // ↑ from an empty field walks back through this session's prompts.
    const hist = props.history ?? [];
    if (e.key === "ArrowUp" && hist.length > 0 && (empty || histAt() >= 0)) {
      e.preventDefault();
      const next = histAt() < 0 ? hist.length - 1 : Math.max(0, histAt() - 1);
      setHistAt(next);
      if (ta) {
        ta.value = hist[next] ?? "";
        sync();
      }
      return;
    }
    if (e.key === "ArrowDown" && histAt() >= 0) {
      e.preventDefault();
      const next = histAt() + 1;
      if (next >= hist.length) {
        setHistAt(-1);
        clear();
      } else {
        setHistAt(next);
        if (ta) {
          ta.value = hist[next] ?? "";
          sync();
        }
      }
      return;
    }

    // Shift+Tab cycles the permission mode, as it does in the CLI.
    if (e.key === "Tab" && e.shiftKey && props.onCycleMode) {
      e.preventDefault();
      props.onCycleMode();
      return;
    }

    // `isComposing` excludes the Enter an IME sends to COMMIT a candidate
    // (Japanese/Chinese/Korean, and WebKit/iOS autocomplete): that keystroke
    // belongs to the input method, not to us, and submitting on it sends a
    // half-composed message and wipes the field.
    if (e.key === "Enter" && e.shiftKey) {
      // A deliberate soft newline: let the resulting insertLineBreak through.
      allowLineBreak = true;
      return;
    }
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  /**
   * The phone keyboard's blue send/return key.
   *
   * Enter on a textarea is a line break, and which events a mobile keyboard
   * fires for that key varies — with an IME or autocorrect committing a
   * candidate, the keydown can arrive as a composition keystroke and be skipped
   * (correctly) by the Enter handler below, leaving the message unsent. The
   * `beforeinput` event is unambiguous: inputType "insertLineBreak" IS that key,
   * it arrives before anything is inserted, and cancelling it keeps the newline
   * out of the field. Shift+Enter still reaches the field as a soft newline,
   * because that produces the same inputType only when the handler lets it
   * through — hence the shift check kept in onKeyDown, and the flag below.
   */
  let allowLineBreak = false;
  const onBeforeInput = (e: InputEvent) => {
    if (e.inputType !== "insertLineBreak") return;
    if (allowLineBreak) {
      allowLineBreak = false;
      return;
    }
    e.preventDefault();
    submit();
  };

  /**
   * iOS: take focus during the GESTURE, not on the click.
   *
   * `body.has-soft-keys .tl-views` grows its bottom margin by the keyboard
   * height the moment visualViewport reports it, and the composer is the bottom
   * child of that column — so between touchstart and the click, the field moves
   * up by roughly the keyboard's height. The click then lands on whatever is now
   * under the finger (the timeline), iOS reads that as a tap outside the input,
   * and the keyboard that had just started opening closes again. Tapping a
   * keyboard-height ABOVE the field was the only way to hit it.
   *
   * Focusing here — inside the user gesture, before any layout change — means
   * the field already holds focus when that stray click arrives, so there is
   * nothing left to steal. preventDefault stops the browser's own
   * focus-on-click, which is what would otherwise blur it.
   *
   * Only when the field is NOT already focused: taking the gesture over on every
   * touch would break placing the caret inside existing text.
   */
  const onPointerDown = (e: PointerEvent) => {
    // Only a finger or a pen. Naming the types to ACT on rather than the one to
    // skip means an event with no pointerType at all (an older browser, a
    // synthetic event) leaves the mouse path untouched instead of hijacking it.
    if (!ta || (e.pointerType !== "touch" && e.pointerType !== "pen")) return;
    if (document.activeElement === ta) return;
    e.preventDefault();
    ta.focus();
  };

  return (
    <div class="tl-composer">
      <Show when={props.pending.length > 0}>
        <PermissionPanel pending={props.pending} onResolve={props.onResolve} />
      </Show>
      <Show when={(props.queued?.length ?? 0) > 0}>
        <div class="tl-queued">
          <For each={(props.queued ?? []).slice(0, MAX_QUEUED_SHOWN)}>
            {(q) => (
              <div class="tl-queued-item" title={q}>
                <span class="tl-queued-chip">queued</span>
                <span class="tl-queued-text">{q}</span>
              </div>
            )}
          </For>
          <Show when={(props.queued?.length ?? 0) > MAX_QUEUED_SHOWN}>
            <div class="tl-queued-item tl-queued-more">
              +{(props.queued?.length ?? 0) - MAX_QUEUED_SHOWN} more waiting
            </div>
          </Show>
        </div>
      </Show>
      {/* The attachment tray (decision 1). Above the input so the field stays
          prose; each chip opens the file preview, and × removes it. Nothing here
          is destructive — the file is already in the store and listed in the 🖼
          gallery, so removing a chip drops a reference, never an upload. */}
      <Show when={tray().length > 0}>
        <div class="tl-tray" aria-label="Attachments">
          <For each={tray()}>
            {(item) => (
              <div class="tl-tray-item" data-kind={item.kind}>
                <button
                  type="button"
                  class="tl-tray-open"
                  title={item.path}
                  aria-label={`Open ${storedDisplayName(item.name)}`}
                  onClick={() => props.onOpenPreview?.(item.path)}
                >
                  <Show
                    when={item.kind === "image" && contentUrlFor(item.path, props.me ?? "")}
                    fallback={
                      <>
                        <FileTextIcon />
                        <span class="tl-tray-name">{storedDisplayName(item.name)}</span>
                      </>
                    }
                  >
                    <img
                      src={contentUrlFor(item.path, props.me ?? "")!}
                      alt={storedDisplayName(item.name)}
                      loading="lazy"
                    />
                  </Show>
                </button>
                <button
                  type="button"
                  class="tl-tray-remove"
                  aria-label={`Remove ${storedDisplayName(item.name)}`}
                  onClick={() => removeAt(item.path)}
                >
                  ×
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={completion() && completion()!.items.length > 0}>
        <div class="tl-complete" role="listbox">
          <For each={completion()!.items}>
            {(item, i) => (
              <button
                type="button"
                class="tl-complete-item"
                role="option"
                aria-selected={i() === picked()}
                data-picked={i() === picked() ? "true" : undefined}
                onClick={() => applyCompletion(item)}
                title={item.description}
              >
                <span class="tl-complete-name">{item.value}</span>
                <Show when={item.description}>
                  <span class="tl-complete-desc">{item.description}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class="tl-composer-row">
        <textarea
          ref={ta}
          class="tl-composer-input"
          rows={1}
          placeholder="Message…"
          title="Enter to send · Shift+Enter for a newline"
          autocapitalize="off"
          autocorrect="on"
          spellcheck={true}
          enterkeyhint="send"
          aria-label="Message to send to the session"
          onInput={() => {
            sync();
            setPicked(0);
            void refreshPaths();
          }}
          onKeyDown={onKeyDown}
          onBeforeInput={onBeforeInput}
          onPointerDown={onPointerDown}
          onClick={sync}
        />
        <Show when={props.onAttach}>
          {/* Present on EVERY device, which is the point: the soft-key row
              carries Copy and Paste only, so a phone had no file picker in either
              view — and the text view is the default view on a coarse pointer.
              `capture` is deliberately absent so iOS offers Photo Library / Take
              Photo / Choose File rather than jumping straight to the camera. */}
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            aria-hidden="true"
            onChange={(e) => {
              const el = e.currentTarget;
              const files = [...(el.files ?? [])];
              el.value = ""; // let the same file be picked again
              void attach(files);
            }}
          />
          <button
            type="button"
            class="tl-attach-btn"
            aria-label="Attach a file"
            title={props.inertReason || "Attach a file"}
            disabled={!!props.inertReason || attaching()}
            onClick={() => fileInput?.click()}
          >
            <PaperclipIcon />
          </button>
        </Show>
        <Show when={props.mode && props.onCycleMode}>
          <button
            type="button"
            class="tl-mode-chip"
            title="Permission mode (Shift+Tab)"
            onClick={() => props.onCycleMode?.()}
          >
            {modeLabel(props.mode ?? "")}
          </button>
        </Show>
        <Show
          when={props.working}
          fallback={
            <button type="button" class="tl-send" onClick={submit}>
              Send
            </button>
          }
        >
          <button type="button" class="tl-stop" onClick={() => props.onStop()}>
            Stop
          </button>
        </Show>
      </div>
    </div>
  );
};
