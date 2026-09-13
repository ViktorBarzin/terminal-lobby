import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  onCleanup,
  onMount,
  type Component,
  type JSX,
} from "solid-js";
import {
  composeMessage,
  completionFor,
  mergeCommands,
  scrollTopFor,
  BUILTIN_COMMANDS,
  type Completion,
  type CompletionItem,
  type SlashCommand,
} from "../logic/compose.logic";
import {
  clearDraft,
  DRAFT_PARKED_EVENT,
  loadDraft,
  saveDraft,
  type DraftAttachment,
} from "../store/drafts";
import { anchorRestored, attachToken, cutSpan } from "../lib/attachments";
import { PaperclipIcon } from "./Icons";

/**
 * The field a prompt is written in, and the bar under it.
 *
 * Shared by the two composers, which want the same writing surface and nothing
 * else in common: `Composer` writes to a LIVE session and docks a permission
 * panel, a context meter, Stop and queued-prompt chips above this; the
 * new-session composer writes the prompt a session will be CREATED with and
 * puts a project, a command and a model beside it. Everything about the act of
 * writing lives here — multi-line with Enter to send and Shift+Enter for a
 * newline, `/` and `@` completion, attachments, the unsent draft, ↑ history,
 * and the mobile input attributes (autocapitalize off, autocorrect and
 * spellcheck on, enterkeyhint send) that restore QuickType and swipe typing.
 *
 * An attached file lives IN the message, as a token the mirror layer draws a
 * chip behind — see `mirror` below and lib/attachments.ts for the token
 * vocabulary. It used to be a chip in a tray above the field whose path was
 * spliced in at the front on send, which is what Viktor asked to change on
 * 2026-09-13: a screenshot pasted mid-sentence belongs mid-sentence.
 *
 * Each composer contributes its own controls through `leftExtra` and
 * `rightExtra`, which land inside the two bar groups: the left one may scroll
 * and give up width, the right one never shrinks, and Send is permanently its
 * last child so it does not move when something is inserted beside it.
 */
export interface PromptFieldSinks {
  /** Put attachments into the message (a window drop, a gallery tile). */
  add: (items: DraftAttachment[]) => void;
  /** Insert text at the caret (a clipboard paste that is not an image). */
  insertText: (text: string) => void;
  /** Put the caret in the field. */
  focus: () => void;
}

export const PromptField: Component<{
  /** The text view's pinch size. Read only to re-measure the field when it
   *  changes — the height is written in px, so the text would otherwise outgrow
   *  a box that stays where it was. */
  textSize?: number;
  /**
   * Send what was written. Resolves false when the send was refused, which puts
   * the typed text AND its attachments back in the field.
   *
   * `text` is the whole message with each token already swapped for the path it
   * stands for, unless `pendingAttachments` says those paths do not exist yet —
   * then it is the text as written, tokens and all, and the attachments arrive
   * beside it for the caller to finish once the upload has given it real paths.
   */
  onSend: (text: string, attachments: readonly DraftAttachment[]) => Promise<boolean>;
  placeholder?: string;
  /** aria-label for the field; what a screen reader announces it as. */
  label: string;
  /** The field's tooltip, which is also where the Enter/Shift+Enter contract is
   *  written down for a mouse user. */
  hint?: string;
  /** Send's tooltip, when there is a caveat worth stating. */
  sendTitle?: string;
  /** Prompts already sent here, oldest first (↑ recalls them). */
  history?: string[];
  /** Directory listing for `@` path completion. */
  onListDir?: (dir: string) => Promise<string[]>;
  /** Slash commands offered by `/` beside the built-ins this page ships. */
  commands?: SlashCommand[];
  /**
   * False when that catalogue could not be read. An empty `commands` is
   * ambiguous on its own — a user with no skills reads the same as a route the
   * ingress does not carry — so the menu shows a footer row rather than looking
   * complete (store/catalogue.ts carries the measurement).
   */
  commandsOk?: boolean;
  /**
   * The key this field's unsent draft is stored under (store/drafts.ts). A live
   * composer passes its session; the new-session composer passes a key of its
   * own, because the session it is writing for does not exist yet. Absent means
   * nothing persists.
   */
  draftKey?: string;
  /**
   * Upload these files and return what became attachable. The uploader decides:
   * a document over the store cap stays an ephemeral /tmp transfer and comes back
   * absent from the result, which is why this returns a list rather than one item
   * per input file.
   */
  onAttach?: (files: File[]) => Promise<DraftAttachment[]>;
  /** Watching: the controls that type are inert, and so is attaching. */
  inertReason?: string;
  /** Cycle the permission mode (Shift+Tab in the CLI). */
  onCycleMode?: () => void;
  /**
   * A digit typed into an EMPTY field. Return true when it was consumed — the
   * live composer's number-key permission affordance (1 approves, 2 denies) is
   * the only caller, and returning false leaves the digit to be typed.
   */
  onEmptyDigit?: (digit: string) => boolean;
  /** Controls for the bar's left group, after Attach. */
  leftExtra?: JSX.Element;
  /** Controls for the bar's right group, before Send. */
  rightExtra?: JSX.Element;
  /**
   * Draw Send as unavailable while there is nothing to send.
   *
   * An empty send is refused either way — the guard in `submit` is the same for
   * both composers. What differs is whether the refusal has to be VISIBLE. A
   * live session is already there, so a keystroke that sends nothing to it
   * costs nothing and saying so would be noise. On the new-session composer
   * that keystroke is what CREATES the session, so a silent refusal reads as
   * the app being broken. Turned on there, and nowhere else.
   *
   * "Input" rather than "text" because a held file counts: a screenshot on its
   * own is a prompt, and it leaves as the path it uploaded to.
   */
  sendNeedsInput?: boolean;
  /**
   * The attachments are files that have not been uploaded yet.
   *
   * True only for the new-session composer, where there is nothing to upload
   * INTO until Enter is pressed: the session is created by that keypress
   * (ADR-0019), and writing into a bucket for a session that may never exist
   * would leave litter behind every abandoned draft.
   *
   * Two things follow, and they are the same fact twice. `onSend` is handed the
   * prose and the attachments separately rather than one composed message,
   * because the paths it would swap in are placeholders — the caller finishes
   * the job once the upload has given it real ones. And the attachments are
   * left OUT of the saved draft: a `File` does not survive JSON, so a reloaded
   * tab would restore chips pointing at nothing. The typed text still persists,
   * which is the half that can, and its orphaned tokens are cut out of it on
   * the way back in (`anchorRestored`).
   */
  pendingAttachments?: boolean;
  /** Take focus on mount. The new-session composer does this on a desktop; a
   *  coarse pointer deliberately does not, because focusing raises a keyboard
   *  over the screen the person just opened. */
  autofocus?: boolean;
  /**
   * Hand the caller the sinks a message can be filled from OUTSIDE this
   * component.
   *
   * The draft's state belongs here, with the persistence that backs it — but the
   * gestures do not: a drag-and-drop lands on the WINDOW, and the Paste button,
   * the ⌘V chord and the command palette all run in the session view
   * (clipboard/attach.ts, clipboard/paste-into-terminal.ts). Rather than hoisting
   * the state up past the thing that owns it, the view is handed these on mount.
   */
  register?: (api: PromptFieldSinks) => void;
}> = (props) => {
  let ta: HTMLTextAreaElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  /** The chip layer behind the field — see `mirror` and the JSX below. */
  let mirrorEl: HTMLDivElement | undefined;
  const [draft, setDraft] = createSignal("");
  /** The files this message carries, each anchored to its token in the text. */
  const [attached, setAttached] = createSignal<DraftAttachment[]>([]);
  const [attaching, setAttaching] = createSignal(false);
  const [caret, setCaret] = createSignal(0);
  const [paths, setPaths] = createSignal<string[]>([]);
  const [picked, setPicked] = createSignal(0);
  let menuEl: HTMLDivElement | undefined;

  /**
   * Follow the selection with the scroller.
   *
   * The menu shows about four rows of a catalogue that runs to 148, so arrowing
   * down without this picked rows nobody could see after the fourth press.
   * Measured against the CONTAINER rather than with scrollIntoView, which also
   * scrolls ancestors — this app is laid out against a mobile viewport the
   * platform already drags around on its own.
   *
   * Re-runs on the completion as well as on the index: typing re-filters the
   * list and resets the selection to the first row, which has to bring the
   * scroller back to the top with it.
   */
  createEffect(() => {
    completion();
    const i = picked();
    const menu = menuEl;
    if (!menu) return;
    const item = menu.children[i] as HTMLElement | undefined;
    if (!item) return;
    const top =
      item.getBoundingClientRect().top - menu.getBoundingClientRect().top + menu.scrollTop;
    menu.scrollTop = scrollTopFor(top, item.offsetHeight, menu.scrollTop, menu.clientHeight);
  });
  /** Where ↑ has walked to in history; -1 is "not browsing". */
  const [histAt, setHistAt] = createSignal(-1);

  /**
   * Make the field as tall as its text.
   *
   * `scrollHeight` covers content and padding but NOT the border, and
   * everything here is border-box (app.css:5) — so writing it straight back as
   * a height leaves the content box short by exactly the borders, and a single
   * line is sliced along its middle. Measured before this: a 24px line in a
   * 42px field with 40px of client height.
   *
   * Re-measured whenever the pinch size changes as well as on input: the height
   * is written in px at the moment of typing, so without that the text grows
   * inside a box that stays where it was.
   */
  const autosize = () => {
    if (!ta) return;
    ta.style.height = "auto";
    const chrome = ta.offsetHeight - ta.clientHeight; // borders, under border-box
    ta.style.height = Math.min(ta.scrollHeight + chrome, 200) + "px";
  };

  /**
   * Whether the caret is a real place the writer put it.
   *
   * An untouched textarea reports `selectionStart === 0`, which is
   * indistinguishable from a caret parked at the start — so inserting "at the
   * caret" put a dropped file at the FRONT of a message nobody had clicked
   * into. Until something says otherwise, an insertion goes to the end.
   */
  let caretKnown = false;

  const sync = () => {
    if (!ta) return;
    caretKnown = true;
    setDraft(ta.value);
    setCaret(ta.selectionStart ?? ta.value.length);
    // A chip the writer has deleted takes its file with it — see `attached`.
    reconcile(ta.value);
    autosize();
  };

  const clear = () => {
    if (!ta) return;
    ta.value = "";
    setDraft("");
    setAttached([]);
    setHistAt(-1);
    caretKnown = false;
    autosize();
    if (props.draftKey) clearDraft(props.draftKey);
  };

  // ---- the unsent draft: restored on mount, saved on every change ----------
  // Restored on MOUNT rather than in an effect keyed on the key: this component
  // is remounted per session (SessionView is), so a reactive restore would only
  // ever fire once anyway, and doing it here keeps it from racing the first
  // keystroke.
  onMount(() => {
    const key = props.draftKey;
    if (!key) return;
    const saved = loadDraft(key);
    if (!saved) return;
    // Held files cannot be persisted, so the pending composer restores none and
    // `anchorRestored` cuts the tokens they left behind out of the text.
    const restored = anchorRestored(saved.text, props.pendingAttachments ? [] : saved.attachments);
    setAttached(restored.items);
    if (restored.text && ta) {
      ta.value = restored.text;
      setDraft(restored.text);
      autosize();
    }
  });

  /**
   * Take a draft that was parked from outside while this field was mounted.
   *
   * The restore above runs in onMount and nowhere else, which is right for the
   * drafts this field writes itself. A first prompt that could not be delivered
   * is written by nothing on screen: the composer that sent it was unmounted by
   * the create, and this field — the LIVE session's — mounted seconds before
   * the delivery gave up (store/drafts.ts, parkDraft). Without this it would
   * never be read, and the persist effect below would overwrite it on the next
   * keystroke.
   *
   * What was typed in the meantime is never thrown away: a parked message joins
   * it on a new line rather than replacing it.
   *
   * A parked first prompt carries its paths in the TEXT — the send composed it
   * before the delivery failed — so it arrives with no attachments of its own
   * and nothing here has to anchor anything.
   */
  const onParked = (e: Event) => {
    const key = props.draftKey;
    if (!key) return;
    const detail = (e as CustomEvent<{ session?: string }>).detail;
    if (!detail || detail.session !== key) return;
    const parked = loadDraft(key);
    if (!parked || !ta) return;
    const current = ta.value;
    ta.value = current ? current + "\n" + parked.text : parked.text;
    setDraft(ta.value);
    if (!props.pendingAttachments && parked.attachments.length > 0) {
      addAttachments(parked.attachments);
    }
    autosize();
  };
  window.addEventListener(DRAFT_PARKED_EVENT, onParked);
  onCleanup(() => window.removeEventListener(DRAFT_PARKED_EVENT, onParked));

  /**
   * Keep the field's height derived, not pinned.
   *
   * autosize writes a px height, and it used to run only on input, on clear,
   * and on mount when a draft was restored — so an untouched field kept
   * whatever the single measurement at mount produced. Clicking it called
   * sync(), which called autosize, which is why touching it "resized it
   * correctly": the click was the second measurement.
   *
   * Three things that decide a line's height can arrive after that first
   * measurement, so all three re-derive it:
   *   - the pinch scale, which reaches this field through a custom property on
   *     an ancestor;
   *   - the webfont, whose metrics differ from the fallback it replaces;
   *   - the field's own WIDTH, which decides how many lines the text wraps to,
   *     and changes when the sidebar collapses or the phone rotates.
   *
   * Width only from the observer: autosize writes the height, so watching the
   * height would chase itself.
   */
  createEffect(() => {
    props.textSize;
    autosize();
  });

  onMount(() => {
    autosize();
    if (props.autofocus) ta?.focus();
    // The font swap changes the metrics under a height already written in px.
    void (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready
      ?.then(() => autosize())
      .catch(() => {});
    if (!ta || typeof ResizeObserver === "undefined") return;
    let lastWidth = -1;
    const ro = new ResizeObserver(() => {
      const w = ta ? ta.clientWidth : 0;
      if (w === lastWidth) return; // our own height write, not a real change
      lastWidth = w;
      autosize();
    });
    ro.observe(ta);
    onCleanup(() => ro.disconnect());
  });

  createEffect(() => {
    const key = props.draftKey;
    if (!key) return;
    // Both halves are read reactively so either one changing persists the pair.
    const text = draft();
    const attachments = props.pendingAttachments ? [] : attached();
    saveDraft(key, { text, attachments, at: Date.now() });
  });

  // ---- attaching -----------------------------------------------------------
  const attach = async (files: File[]): Promise<void> => {
    if (!files.length || !props.onAttach) return;
    setAttaching(true);
    try {
      // De-duplicated by path in addAttachments: attaching the same file twice
      // would ask Claude to read it twice and write two chips for one file.
      addAttachments(await props.onAttach(files));
    } finally {
      setAttaching(false);
    }
  };

  /**
   * Put files into the message where the writer is.
   *
   * Each one is written as a token at the caret and remembered against it, so
   * the send can swap in its path there and the mirror can draw a chip over it.
   * Every intake arrives here — the paste, the window drop, the picker, a
   * gallery tile — because all four mean the same thing: this file belongs in
   * what I am writing.
   */
  const addAttachments = (items: DraftAttachment[]): void => {
    if (!items.length) return;
    const current = attached();
    const have = new Set(current.map((a) => a.path));
    const taken = new Set(current.map((a) => a.token).filter((t): t is string => !!t));
    const fresh: DraftAttachment[] = [];
    for (const item of items) {
      if (have.has(item.path)) continue;
      have.add(item.path);
      const token = attachToken(item.name, item.kind, taken);
      taken.add(token);
      fresh.push({ ...item, token });
    }
    if (!fresh.length) return;
    splice(fresh.map((a) => a.token).join(" "), true);
    setAttached([...current, ...fresh]);
  };

  /**
   * Write text into the message at the caret, or at the END when nothing has
   * put a caret in the field yet (see `caretKnown`).
   *
   * `pad` keeps a chip from fusing with the words on either side of it. Plain
   * text never pads: a paste has to land exactly as typed.
   */
  const splice = (text: string, pad: boolean): void => {
    if (!ta || !text) return;
    const at = caretKnown ? (ta.selectionStart ?? ta.value.length) : ta.value.length;
    const end = caretKnown ? (ta.selectionEnd ?? at) : at;
    const before = ta.value.slice(0, at);
    const after = ta.value.slice(end);
    const body =
      (pad && before && !/\s$/.test(before) ? " " : "") +
      text +
      (pad && after && !/^\s/.test(after) ? " " : "");
    ta.value = before + body + after;
    const pos = at + body.length;
    ta.setSelectionRange(pos, pos);
    sync();
    ta.focus();
  };

  /**
   * Insert text at the caret — what a paste read OUTSIDE this component does to
   * the message being written. Same splice the completion menu performs, so a
   * paste behaves like typing: the caret lands after the inserted text and the
   * rest of the message survives.
   */
  const insertText = (text: string): void => splice(text, false);

  /**
   * Drop the files whose chips are no longer in the message.
   *
   * Deleting a chip IS how an attachment is removed now, so this runs on every
   * change to the text: select-all-and-retype, a history recall, an edit that
   * ate the token. The keystroke that removes a whole chip in one press is in
   * `onKeyDown`; this is the backstop that keeps the two halves honest however
   * the text got that way.
   */
  const reconcile = (text: string): void => {
    setAttached((current) => {
      const live = current.filter((a) => !a.token || text.includes(a.token));
      return live.length === current.length ? current : live;
    });
  };

  onMount(() => props.register?.({ add: addAttachments, insertText, focus: () => ta?.focus() }));

  /** The message split into runs of prose and the tokens standing in it, which
   *  is what the mirror layer paints chips from. */
  const mirror = createMemo<{ text: string; kind?: DraftAttachment["kind"] }[]>(() => {
    const text = draft();
    const items = attached().filter((a) => !!a.token);
    const parts: { text: string; kind?: DraftAttachment["kind"] }[] = [];
    let at = 0;
    for (;;) {
      let next = -1;
      let hit: DraftAttachment | undefined;
      for (const a of items) {
        const i = text.indexOf(a.token!, at);
        if (i >= 0 && (next < 0 || i < next)) {
          next = i;
          hit = a;
        }
      }
      if (next < 0 || !hit) break;
      if (next > at) parts.push({ text: text.slice(at, next) });
      parts.push({ text: hit.token!, kind: hit.kind });
      at = next + hit.token!.length;
    }
    if (at < text.length) parts.push({ text: text.slice(at) });
    // A block drops its last line break, so without this the mirror is one line
    // shorter than the field and every chip below a trailing newline is off.
    if (text.endsWith("\n")) parts.push({ text: " " });
    return parts;
  });

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
  /** The `/` menu is open and the session's own commands are not in it. */
  const slashUnreadable = createMemo(
    () => props.commandsOk === false && completion()?.trigger === "/",
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
   * Whether a send would land at all, by the same rule `submit` refuses on:
   * prose (whitespace is not prose), a held file, or both.
   *
   * Off the `draft` signal rather than the textarea, because an element's
   * `value` is not reactive and the bar has to redraw as you type.
   */
  const sendable = createMemo(() => draft().trim() !== "" || attached().length > 0);

  /**
   * Send the composed message.
   *
   * The field is cleared optimistically because it has to feel instant, and the
   * text is put BACK if the send did not land — so a failure (a 5xx, an
   * unreachable box) can never destroy what was typed. Only a field the user has
   * not since typed into is restored.
   */
  const submit = () => {
    const raw = ta?.value ?? "";
    const held = attached();
    // The FILES count too: attachments with no prose is a valid message, so the
    // old `if (!t) return` would have swallowed a photo sent on its own.
    const message = props.pendingAttachments ? raw.trim() : composeMessage(raw, held);
    if (!message && held.length === 0) return;
    clear();
    void props.onSend(message, held).then((ok) => {
      if (ok || !ta || ta.value !== "") return;
      // A refusal restores BOTH halves. The text already had this guarantee; an
      // attachment needs it more, because re-attaching means finding the file
      // again — and the tokens are still in the text that comes back, so the
      // chips land where they were.
      ta.value = raw;
      setDraft(raw);
      setAttached(held);
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

    // Backspace or Delete against a chip takes the WHOLE chip. A token eaten
    // one character at a time stops being an attachment at the first keystroke
    // (`reconcile` drops the file) and leaves the rest of its text sitting in
    // the message as prose, which is the worst of both.
    if (ta && (e.key === "Backspace" || e.key === "Delete") && !e.altKey && !e.metaKey) {
      const at = ta.selectionStart ?? 0;
      if (at === (ta.selectionEnd ?? at)) {
        const back = e.key === "Backspace";
        const hit = attached().find((a) =>
          a.token
            ? back
              ? ta!.value.slice(0, at).endsWith(a.token)
              : ta!.value.slice(at).startsWith(a.token)
            : false,
        );
        if (hit?.token) {
          e.preventDefault();
          const start = back ? at - hit.token.length : at;
          const cut = cutSpan(ta.value, start, start + hit.token.length);
          ta.value = cut.text;
          ta.setSelectionRange(cut.at, cut.at);
          sync();
          return;
        }
      }
    }

    // A digit on an empty field, offered to the caller (the live composer's
    // 1-approves / 2-denies affordance) before it is treated as typing.
    if (empty && (e.key === "1" || e.key === "2") && props.onEmptyDigit?.(e.key)) {
      e.preventDefault();
      return;
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
    <>
      <Show when={completion() && (completion()!.items.length > 0 || slashUnreadable())}>
        <div class="tl-complete" role="listbox" ref={menuEl}>
          <For each={completion()!.items}>
            {(item, i) => (
              <button
                type="button"
                class="tl-complete-item"
                role="option"
                aria-selected={i() === picked()}
                data-picked={i() === picked() ? "true" : undefined}
                data-source={item.source}
                data-weak={item.weak ? "true" : undefined}
                onClick={() => applyCompletion(item)}
                title={item.description}
              >
                <span class="tl-complete-row">
                  <span class="tl-complete-name">{item.value}</span>
                  {/* Which of the four lists this row came from. 95 of the 130
                      entries are built-ins, so without this the reader cannot
                      tell their own skill from a command the CLI ships. */}
                  <Show when={item.source && item.source !== "builtin"}>
                    <span class="tl-complete-source">{item.source}</span>
                  </Show>
                </span>
                <Show when={item.description}>
                  <span class="tl-complete-desc">{item.description}</span>
                </Show>
              </button>
            )}
          </For>
          {/* The per-user half of the catalogue is missing. Not an error state —
              the built-ins above are real and usable — but it must not look
              complete: every route the ingress does not carry answers with the
              SPA's own index.html, on which `res.json()` throws, and the menu
              then silently held 95 rows instead of 130. */}
          <Show when={slashUnreadable()}>
            <div class="tl-complete-note" role="note">
              Your own skills could not be loaded
            </div>
          </Show>
        </div>
      </Show>
      {/* Field and controls in ONE surface. They were two: a bordered field
          with an unbordered bar loose underneath it, which read as an input
          that had lost its buttons. The border and the fill live here now and
          the field goes transparent, so the whole thing is one control. */}
      <div class="tl-composer-box">
        <div class="tl-composer-row">
          {/* The chip layer.

              A textarea holds characters and nothing else, so an attachment
              inside the message can only BE text — the token. This element is
              the same string laid out in the same box behind the field, with a
              pill painted behind each token and every glyph transparent, so
              what the reader sees is the field's own text sitting on a chip.
              It owns no state and takes no clicks; if it were ever wrong the
              message would still read correctly, which is why the token says
              `[img: chart.png]` rather than relying on the paint. */}
          <div class="tl-field">
            <div class="tl-composer-mirror" aria-hidden="true" ref={mirrorEl}>
              <For each={mirror()}>
                {(part) => (
                  <Show when={part.kind} fallback={part.text}>
                    <span class="tl-inline-chip" data-kind={part.kind}>
                      {part.text}
                    </span>
                  </Show>
                )}
              </For>
            </div>
            <textarea
              ref={ta}
              class="tl-composer-input"
              rows={1}
              placeholder={props.placeholder ?? "Message…"}
              title={props.hint ?? "Enter to send · Shift+Enter for a newline"}
              autocapitalize="off"
              autocorrect="on"
              spellcheck={true}
              enterkeyhint="send"
              aria-label={props.label}
              onInput={() => {
                sync();
                setPicked(0);
                void refreshPaths();
              }}
              onKeyDown={onKeyDown}
              onBeforeInput={onBeforeInput}
              onPointerDown={onPointerDown}
              onClick={sync}
              // The field scrolls past 200px; the layer behind it has to go
              // with it or the chips stay where the text no longer is.
              onScroll={() => {
                if (mirrorEl && ta) mirrorEl.scrollTop = ta.scrollTop;
              }}
            />
          </div>
        </div>
        {/* The controls, on their own bar. They used to share the row with the
            field, which left the field 92.8px of a 343.2px row once a turn
            started and Stop appeared — 27%, for the thing the composer is for.
            With the context meter present it fell to 26px and the row overflowed
            its own width by 20px.

            Two groups. The left one may scroll and give up width; the right one
            never shrinks, so the controls that must stay reachable always are.
            Send is the last child of it, permanently: today it jumps 71px left
            the moment a turn starts, because Stop is inserted after it. */}
        <div class="tl-composer-bar">
          <div class="tl-bar-left">
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
                aria-label="Attach an image or file"
                // What it TAKES and where it goes. A paperclip on its own was the
                // only wordless control on this bar, and its purpose lived in a
                // title, which a phone has no way to show.
                title={
                  props.inertReason ||
                  "Attach an image or file — images join this session's gallery"
                }
                disabled={!!props.inertReason || attaching()}
                onClick={() => fileInput?.click()}
              >
                <PaperclipIcon />
                <span class="tl-attach-label">{attaching() ? "Attaching…" : "Attach"}</span>
              </button>
            </Show>
            {props.leftExtra}
          </div>
          <div class="tl-bar-right">
            {props.rightExtra}
            {/* Send is always here; Stop JOINS it while there is a turn to stop.
                Stop used to REPLACE it, which is the browser half of a turn gate
                the server gave up on 2026-08-15 — mid-turn sends queue in Claude,
                and Enter has been doing exactly that all along. What the swap cost
                was the phone, where there is no Enter key to fall back on.

                Rendering Send unconditionally also fixes a second, worse case.
                `working` comes from the transcript, which lags the pane: measured
                live, a session whose real state was `done` showed Stop in 98 of 100
                samples over 300s (and kept doing so after a reload), and 17-22% of
                sessions disagreed with their state at any moment. A finished
                session could therefore offer no way to send at all. */}
            <button
              type="button"
              class="tl-send"
              onClick={submit}
              disabled={props.sendNeedsInput && !sendable()}
              title={props.sendTitle}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
