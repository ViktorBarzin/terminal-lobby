import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
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
import { takeLeftBehind } from "../lib/leaving";
import { closeOnBack } from "../lib/back-closes";
import {
  anchorRestored,
  attachToken,
  cutSpan,
  tokenizeStorePaths,
  previewContentUrl,
  readableTokens,
  storedDisplayName,
} from "../lib/attachments";
import { EyeIcon, PlusIcon, SendArrowIcon, StopSquareIcon } from "./Icons";
import { createCoarsePointer, createMobileFlip } from "../mobile/pointer";
import { dismissFloat, dismissOnPress } from "./overlay";
import { PlusMenu } from "./PlusMenu";
import { ColumnGrip } from "./ColumnGrip";

/**
 * The field a prompt is written in: the pill, with `+` before it and Send
 * after it.
 *
 * Shared by the two composers, which want the same writing surface and nothing
 * else in common: `Composer` writes to a LIVE session and puts the +, the
 * model button and the round button in a row beside this; the new-session
 * composer writes the prompt a session will be CREATED with and puts a
 * project, a command and a model above it. Everything about the act of
 * writing lives here — multi-line with Enter to send and Shift+Enter for a
 * newline on a desktop (a phone's return key adds a line and the round button
 * sends), `/` and `@` completion, attachments, the unsent draft, ↑ history,
 * and the mobile input attributes (autocapitalize off, autocorrect and
 * spellcheck on) that restore QuickType and swipe typing.
 *
 * An attached file lives IN the message, as a token the mirror layer draws a
 * chip behind — see `mirror` below and lib/attachments.ts for the token
 * vocabulary. It used to be a chip in a tray above the field whose path was
 * spliced in at the front on send, which is what Viktor asked to change on
 * 2026-09-13: a screenshot pasted mid-sentence belongs mid-sentence.
 *
 * ONE SURFACE, TWO SHAPES (the T3 pass, chosen 2026-09-27;
 * docs/plans/2026-09-27-text-view-t3-pass.md). On a phone at rest it is a 50px
 * pill: `+`, one line of the field, and the round button. Focused on the
 * phone, and always on a desktop, it is a box: the text across the top, and
 * beneath it `+`, the caller's tools (the model button's slot) and the round
 * button. It replaced the Quiet line's pill (2026-09-24), which had a thin
 * status line above it on both devices. The surface stays one element in
 * both shapes and only its `data-shape` changes, so the field, its draft and
 * its attachments never remount.
 *
 * "Phone" is the coarse-pointer flip (mobile/pointer.ts FLIP_QUERY), not width
 * alone, and only for a caller that asks for the fold (`fold`). The pill opens
 * when the field takes focus and folds again when the conversation is pressed,
 * which also puts the keyboard away. It does not fold on blur: a press on `+`
 * or the round button blurs the field on iOS, and folding under that finger
 * would move the button before the click lands.
 *
 * Send stays the surface's last control, never greys out on a live session,
 * and never says "Queue".
 */
export interface PromptFieldSinks {
  /** Put attachments into the message (a window drop, a gallery tile). */
  add: (items: DraftAttachment[]) => void;
  /** Insert text at the caret (a clipboard paste that is not an image), and
   *  put the focus in the field unless `focus` is false: on a phone that
   *  raises the keyboard. */
  insertText: (text: string, opts?: { focus?: boolean }) => void;
  /** Put text at the START of the message, a blank line before whatever the
   *  field already holds: the queued prompts a Stop hands back. */
  prependText: (text: string) => void;
  /** What the field holds now, as written. */
  text: () => string;
  /** Put the caret in the field. */
  focus: () => void;
}

/** The least a phone keyboard shrinks the visual viewport by: 150px, where
 *  the URL bar folding away moves it by about 56px. */
const KEYBOARD_MIN_PX = 150;

/**
 * The words the watching pill shows: who is being watched, from the session
 * view's one sentence ("Watching alice: take control to type in their
 * session", "Watching: this device does not type into the session"). The whole
 * sentence is the pill's title.
 */
function watchWord(reason: string): string {
  const m = /^(.+?)\s*(?:—|:)\s+/.exec(reason.trim());
  return m ? m[1]! : "Watching";
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
  /** aria-label for the field; what a screen reader announces it as. Also
   *  drawn, out of sight, as the element aria-labelledby names: with a label
   *  of its own, Safari's AutoFill matches the field on its words alone and
   *  stops reading the text around it (see the textarea below). */
  label: string;
  /** Called for each word autocorrect replaces, so a caller can report
   *  whether autocorrect ran; no page can see the QuickType bar itself. */
  onAutocorrect?: () => void;
  /** The field's tooltip, which is also where the Enter/Shift+Enter contract is
   *  written down for a mouse user. */
  hint?: string;
  /** Send's tooltip, when there is a caveat worth stating. */
  sendTitle?: string;
  /** Prompts already sent here, oldest first (↑ recalls them). */
  history?: string[];
  /**
   * Prompts are queued behind the turn: ↑ on an empty field asks for them back
   * to edit, as Claude Code's own box does, and the caller puts them in the
   * field. Resolves false when nothing came back, and the same ↑ then recalls
   * history. Absent while nothing is queued.
   */
  onEditQueued?: () => Promise<boolean>;
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
  /** The field is out of sight behind a card but keeps the focus (Composer
   *  `offstage`): a refused send's words come back ending on a new line. */
  offstage?: boolean;
  /** Cycle the permission mode (Shift+Tab in the CLI). */
  onCycleMode?: () => void;
  /**
   * A digit 1-9 typed into an EMPTY field. Return true when it was consumed —
   * the composer's number-key permission affordance is the only caller, and
   * returning false leaves the digit to be typed.
   */
  onEmptyDigit?: (digit: string) => boolean;
  /**
   * Claude is working, so a send now QUEUES. While this is true and the field
   * holds something, Send is named "Send, queues after this turn". The caller
   * decides it on the same two readings as `canStop` (Composer.queue.test.tsx).
   */
  queues?: boolean;
  /** Where an attached file ends up, said in the `+`'s title (the + menu
   *  has no footer). */
  attachNote?: string;
  /** No `+` at all: a field that takes no files and offers no triggers. */
  noPlus?: boolean;
  /**
   * Rest as the 50px pill on a phone, opening into the box on focus. The live
   * composer asks for it; the new-session screen is the box at full size.
   */
  fold?: boolean;
  /** Draw a grip on each edge of the box that drags the Text view's column
   *  wider or narrower (ColumnGrip). The live composer asks for it. */
  resizable?: boolean;
  /** The mode lets every tool through (Bypass, No ask): the surface's border
   *  turns the danger colour, and nothing else changes. */
  danger?: boolean;
  /** What sits between `+` and the round button in the box: the model
   *  button's slot. Hidden in the pill. */
  tools?: JSX.Element;
  /**
   * Something is running that Stop would interrupt, and how to stop it. While
   * this is true and the field is empty with nothing attached, the round
   * button IS Stop; typing turns it back into Send.
   */
  canStop?: boolean;
  onStop?: () => void;
  /** Stop was pressed and the turn has not settled: Stop shows greyed as
   *  "Stopping…" and takes no press. The caller decides when it settles
   *  (Composer `STOP_SETTLE_MS`). */
  stopping?: boolean;
  /** Hand the session back to this device, from the watching pill. */
  onTakeControl?: () => void;
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
  /** The surface holding `+`, the field and Send (autosize holds its height). */
  let pillEl: HTMLDivElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  let photoInput: HTMLInputElement | undefined;
  let cameraInput: HTMLInputElement | undefined;
  let plusEl: HTMLButtonElement | undefined;
  let menuPlusEl: HTMLDivElement | undefined;
  /** The chip layer behind the field — see `mirror` and the JSX below. */
  let mirrorEl: HTMLDivElement | undefined;
  /** The field's label element, which aria-labelledby names. */
  const labelId = createUniqueId();
  const [draft, setDraft] = createSignal("");

  // ---- the shape ----------------------------------------------------------
  const phone = createMobileFlip();
  /** The phone's pill has been opened into the box by focusing the field. */
  const [opened, setOpened] = createSignal(false);
  /** Another device drives: the surface is the watching pill, on every device. */
  const watching = (): boolean => !!props.inertReason;
  const shape = (): "pill" | "box" =>
    watching() || (props.fold === true && phone() && !opened()) ? "pill" : "box";
  /**
   * What a folded pill shows of an unsent draft: its first line with words on
   * it. The field's own text is hidden in the pill (a textarea cannot cut a
   * line with an ellipsis everywhere this is served), so this is drawn over it.
   */
  const foldedLine = (): string => {
    if (shape() !== "pill" || watching()) return "";
    const line = draft()
      .split("\n")
      .find((l) => l.trim() !== "");
    return line ? line.trimStart() : "";
  };
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
  /** A touch keyboard, whose return key adds a line rather than sending. */
  const coarse = createCoarsePointer();
  /**
   * Where ↑ has walked to in history; -1 is "not browsing".
   *
   * Only an untouched recall is browsing. Any edit makes the text the writer's
   * own, and from then the arrows move the caret as they would in any text
   * (deployed review round 5, 2026-09-29: an arrow after an edit swapped the
   * writer's words for another entry, and nothing brought them back).
   */
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
    // The pill is one line at a fixed height, which the stylesheet sets. A px
    // height left over from the box would hold it open.
    if (shape() === "pill") {
      ta.style.height = "";
      ta.scrollTop = 0;
      ta.scrollLeft = 0;
      return;
    }
    // Measuring drops the field to height:auto, one row, and the reads below
    // force a real layout at that height. The pill is held at its height
    // meanwhile, so the page never sees the composer shrink: a transcript
    // parked at its bottom had its scrollTop clamped to the momentarily
    // taller box, and nothing moved it back when the field grew again. On the
    // emulator (2026-09-26) three typed lines left the reader 90px above the
    // latest message with "Latest" up.
    // The pill and not the field's own row: that row is a flex row that
    // stretches the field, so holding it made height:auto read back the held
    // height and a grown field never shrank. The pill aligns its children to
    // an edge, so the field inside it is free to drop to one row.
    const box = pillEl;
    const heldWas = box?.style.minHeight ?? "";
    if (box) box.style.minHeight = `${box.offsetHeight}px`;
    ta.style.height = "auto";
    const chrome = ta.offsetHeight - ta.clientHeight; // borders, under border-box
    const need = ta.scrollHeight;
    // The cap is the stylesheet's (220px in the desktop box, 148px in the
    // phone's), read rather than repeated here so the two cannot disagree.
    // Unmeasurable (jsdom) leaves it uncapped.
    const cap = parseFloat(getComputedStyle(ta).maxHeight);
    const want = need + chrome;
    ta.style.height = (Number.isFinite(cap) && cap > 0 ? Math.min(want, cap) : want) + "px";
    if (box) box.style.minHeight = heldWas;
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

  /**
   * Put a history entry in the field, its store paths back as the chips they
   * were sent from (deployed review round 3, 2026-09-28: a picture came back
   * as text, and a file as its raw path). The pending composer holds files it
   * has not uploaded, so a path there stays text.
   */
  const recall = (text: string) => {
    if (!ta) return;
    const back = props.pendingAttachments ? { text, items: [] } : tokenizeStorePaths(text);
    setAttached(back.items);
    ta.value = back.text;
    sync();
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
    shape();
    autosize();
  });

  /**
   * Fold the phone's box back into the pill when the conversation is pressed,
   * and put the keyboard away with it (the prototype's `blurPhone`). Only a
   * press on the conversation: the header, a sheet or a card is not a sign
   * the reader is done writing.
   */
  createEffect(() => {
    if (props.fold !== true || !phone() || !opened()) return;
    const onPress = (e: Event) => {
      const t = e.target;
      if (!(t instanceof Element) || !t.closest(".tl-timeline")) return;
      setOpened(false);
      ta?.blur();
    };
    document.addEventListener("pointerdown", onPress, true);
    onCleanup(() => document.removeEventListener("pointerdown", onPress, true));
  });

  /**
   * Fold back into the pill when the phone's keyboard goes away with the field
   * still focused. Android Chrome keeps the focus when the keyboard is put
   * away with the back gesture, so the box stayed open with no keyboard under
   * it (found on the emulator, 2026-09-27). The keyboard's leaving is read off
   * the visual viewport: it grows back by at least a keyboard's height from
   * the smallest it was while the box was open. The URL bar folding away moves
   * it by about 56px, so that is not mistaken for it.
   */
  createEffect(() => {
    const vv = window.visualViewport;
    if (props.fold !== true || !phone() || !opened() || !vv) return;
    let least = vv.height;
    const onResize = (): void => {
      least = Math.min(least, vv.height);
      if (vv.height - least < KEYBOARD_MIN_PX) return;
      setOpened(false);
      ta?.blur();
    };
    vv.addEventListener("resize", onResize);
    onCleanup(() => vv.removeEventListener("resize", onResize));
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
   * text never pads: a paste has to land exactly as typed. A chip at the END
   * of the message still gets its space after, so the caret sits clear of it
   * and the word typed next is a word of its own: attach-then-type is how a
   * phone writes a message about a picture.
   */
  const splice = (
    text: string,
    pad: boolean,
    padAfter: boolean = pad,
    focus: boolean = true,
  ): void => {
    if (!ta || !text) return;
    const at = caretKnown ? (ta.selectionStart ?? ta.value.length) : ta.value.length;
    const end = caretKnown ? (ta.selectionEnd ?? at) : at;
    const before = ta.value.slice(0, at);
    const after = ta.value.slice(end);
    const body =
      (pad && before && !/\s$/.test(before) ? " " : "") +
      text +
      (padAfter && !/^\s/.test(after) ? " " : "");
    ta.value = before + body + after;
    const pos = at + body.length;
    ta.setSelectionRange(pos, pos);
    sync();
    if (focus) ta.focus();
  };

  /**
   * Insert text at the caret — what a paste read OUTSIDE this component does to
   * the message being written. Same splice the completion menu performs, so a
   * paste behaves like typing: the caret lands after the inserted text and the
   * rest of the message survives.
   */
  const insertText = (text: string, opts?: { focus?: boolean }): void =>
    splice(text, false, false, opts?.focus !== false);

  /**
   * Put text in front of the message, with a blank line between it and what
   * was already written. For a Stop that hands queued prompts back: they were
   * written first, so they read first, and a line typed while the Stop was in
   * flight stays after them. The caret goes to the end and the field is not
   * focused, which on a phone would raise the keyboard under the reader.
   *
   * A store path in it comes back as the chip it was sent from, as a history
   * recall does (deployed review round 1 of the T3 pass, 2026-09-29: a queued
   * picture came back as its raw path). The pending composer holds files it
   * has not uploaded, so a path there stays text.
   */
  const prependText = (text: string): void => {
    if (!ta || !text) return;
    let body = text;
    if (!props.pendingAttachments) {
      const current = attached();
      const back = tokenizeStorePaths(text, current);
      body = back.text;
      if (back.items.length > 0) setAttached([...current, ...back.items]);
    }
    ta.value = ta.value ? `${body}\n\n${ta.value}` : body;
    ta.setSelectionRange(ta.value.length, ta.value.length);
    sync();
  };

  /**
   * Put a `/` at the caret and open the command menu: the + menu's Commands
   * row. (`@` has no row; it is typed.)
   *
   * A space goes before it when the word before would otherwise swallow it,
   * and none after, since the caret has to sit right behind the trigger for
   * the menu to read the token it starts. At the start of an empty message a
   * `/` is a command the CLI will run; anywhere else it mentions one, which is
   * the distinction `completionFor` already draws.
   */
  const insertSlash = (): void => {
    splice("/", true, false);
    setPicked(0);
  };

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

  onMount(() =>
    props.register?.({
      add: addAttachments,
      insertText,
      prependText,
      text: () => ta?.value ?? "",
      focus: () => ta?.focus(),
    }),
  );

  /** The message split into runs of prose and the tokens standing in it, which
   *  is what the mirror layer paints chips from. */
  const mirror = createMemo<{ text: string; item?: DraftAttachment }[]>(() => {
    const text = draft();
    const items = attached().filter((a) => !!a.token);
    const parts: { text: string; item?: DraftAttachment }[] = [];
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
      parts.push({ text: hit.token!, item: hit });
      at = next + hit.token!.length;
    }
    if (at < text.length) parts.push({ text: text.slice(at) });
    // A block drops its last line break, so without this the mirror is one line
    // shorter than the field and every chip below a trailing newline is off.
    if (text.endsWith("\n")) parts.push({ text: " " });
    return parts;
  });

  /**
   * The files whose picture could not be read back.
   *
   * A thumbnail is a second request for something already attached, so it can
   * fail on its own: a store path the read-back route cannot resolve, or a
   * format Chromium does not decode (HEIF, which clipboard-upload accepts). The
   * chip falls back to the pill and its token text, which still says what is
   * attached, and the field stops making room for a picture nobody can see.
   */
  const [broken, setBroken] = createSignal<ReadonlySet<string>>(new Set());

  /** Where a chip's picture is read from, or null when it has none to draw. */
  const thumbFor = (a: DraftAttachment): string | null => {
    if (a.kind !== "image" || broken().has(a.path)) return null;
    return a.preview ?? previewContentUrl(a.path);
  };

  /**
   * The pictures in the message, in the order they were attached, each with
   * where it is read from. They are drawn in a row at the top of the field,
   * above the text, and the token stays in the text as a chip.
   *
   * NOT OVER THE TOKEN. Until 2026-09-27 each picture was painted over its own
   * token, which needed a line tall enough for a picture, and a textarea has
   * one line height for all of its lines: on the phone every wrapped line of a
   * message took 52px, and four of them scrolled the 200px field until the
   * picture was cut off at the top (measured on the Android emulator).
   */
  const pictures = createMemo(() =>
    attached().flatMap((a) => {
      const src = a.token ? thumbFor(a) : null;
      return src ? [{ item: a, src }] : [];
    }),
  );
  /** A picture is in the message, so the field makes room above the text. */
  const hasThumb = createMemo(() => pictures().length > 0);

  /**
   * The attached picture being looked at full size, or null.
   *
   * The chip is a way IN to the image rather than a view of it: 80x44 says
   * which screenshot is attached and cannot say what is in it. It opens the
   * same `.tl-lightbox` the gallery uses, on the URL the chip is already drawn
   * from — which is what lets a held file open at all, since nothing has
   * uploaded it yet and no path of its own would resolve.
   */
  const [zoom, setZoom] = createSignal<{ src: string; name: string } | null>(null);
  /** Whether closing the picture owes the field its focus back. */
  let refocusAfterZoom = false;

  /**
   * Open the picture, and put the keyboard away.
   *
   * On a phone the field's keyboard covers half the screen, which is half of
   * the picture the press just asked to see — measured on the emulator on
   * 2026-09-16, where the tap opened the image behind a keyboard that stayed
   * up. Blurring drops it, and the caret survives a blur, so handing focus
   * back on close puts the writer exactly where they were. A field nobody was
   * typing in gets nothing back, or closing a picture would raise a keyboard
   * over the screen the person is trying to read.
   */
  const openZoom = (src: string, name: string): void => {
    refocusAfterZoom = !!ta && document.activeElement === ta;
    ta?.blur();
    setZoom({ src, name });
  };

  const closeZoom = (): void => {
    setZoom(null);
    if (refocusAfterZoom) ta?.focus();
    refocusAfterZoom = false;
  };

  // Escape closes it, and does not reach the field underneath: without the
  // capture the same keystroke would also close the completion menu or
  // whatever else the composer does with Escape.
  const onZoomKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !zoom()) return;
    e.preventDefault();
    e.stopPropagation();
    closeZoom();
  };
  window.addEventListener("keydown", onZoomKey, true);
  onCleanup(() => window.removeEventListener("keydown", onZoomKey, true));

  // The room above the text goes with it, and the field's own height is written
  // in px at the moment of typing, so without this the field keeps the height
  // it had without the row and clips the picture it just made room for.
  createEffect(() => {
    hasThumb();
    autosize();
  });

  /** What `/` or `@` at the caret is currently offering. */
  // Built-ins plus what this session actually has. Merged in a memo so a
  // catalogue that arrives after the first keystroke shows up in the menu the
  // reader is already looking at.
  const catalogue = createMemo<SlashCommand[]>(() =>
    mergeCommands(BUILTIN_COMMANDS, props.commands ?? []),
  );
  // A recalled entry opens no menu: `/model` coming back from history would
  // otherwise raise the `/` list, which takes every further ↑ and leaves older
  // entries out of reach (deployed review round 5, 2026-09-29). Typing leaves
  // history (see the field's onInput), so the menu is back on the next key.
  const completion = createMemo<Completion | null>(() =>
    histAt() >= 0 ? null : completionFor(draft(), caret(), paths(), catalogue()),
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
   * Send the composed message through `send`.
   *
   * The field is cleared optimistically because it has to feel instant, and the
   * text is put BACK if the send did not land — so a failure (a 5xx, an
   * unreachable box) can never destroy what was typed. Only a field the user has
   * not since typed into is restored. A sender that throws has not delivered
   * anything either, so it restores the same way.
   *
   * `send` is `onSend`, which Send and Enter both reach.
   */
  const submitWith = (
    send: (text: string, held: readonly DraftAttachment[]) => Promise<boolean>,
  ): Promise<boolean> => {
    const raw = ta?.value ?? "";
    const held = attached();
    // The FILES count too: attachments with no prose is a valid message, so the
    // old `if (!t) return` would have swallowed a photo sent on its own.
    const message = props.pendingAttachments ? raw.trim() : composeMessage(raw, held);
    if (!message && held.length === 0) return Promise.resolve(false);
    // A watching device's send is refused (TextView refuseWatching), so the
    // field is left as it is rather than emptied and put back.
    const watching = !!props.inertReason;
    if (!watching) clear();
    // Called in THIS tick, so a caller sees its sender run the moment Send is
    // pressed; a sender that throws before it returns a promise counts as a
    // refusal like one that rejects.
    let sending: Promise<boolean>;
    try {
      sending = send(message, held);
    } catch {
      sending = Promise.resolve(false);
    }
    return sending
      .catch(() => false)
      .then((ok) => {
        if (watching) {
          if (ok) clear();
          return ok;
        }
        if (ok || !ta || ta.value !== "") return ok;
        // The page is going and the prompt's request was already out: the
        // server most likely has it, so the words stay out of the field and
        // the draft (lib/leaving.ts).
        if (takeLeftBehind()) return ok;
        // A refusal restores BOTH halves. The text already had this guarantee;
        // an attachment needs it more, because re-attaching means finding the
        // file again — and the tokens are still in the text that comes back,
        // so the chips land where they were.
        // Out of sight behind a card, the reader goes on typing the next
        // message without seeing this one, which ran the two together
        // (deployed review round 5, 2026-09-29). It ends on a new line.
        const back = props.offstage && raw !== "" && !raw.endsWith("\n") ? `${raw}\n` : raw;
        ta.value = back;
        setDraft(back);
        setAttached(held);
        autosize();
        return ok;
      });
  };
  const submit = (): void => {
    void submitWith(props.onSend);
  };

  /** A ↑ that asked for the queue is waiting on the answer. */
  let askingQueue = false;
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
        // Forget which folder the emptied listing was for as well, or the
        // next @ in that folder never fetches it again and the menu stays
        // shut for the rest of the session (deployed review round 2).
        setPaths([]);
        lastDir = "\0";
        setCaret(-1); // closes the menu until the next keystroke
        return;
      }
    }

    // Escape stops the turn, as it does in the Terminal: the round button's
    // Stop, words in the field or not, and they stay. Not at an idle prompt,
    // where a second Esc opens Claude's rewind menu, which this view cannot
    // draw, and the next message's Enter would pick a rewind point from it.
    if (e.key === "Escape" && !e.isComposing) {
      if (!watching() && props.canStop === true && props.onStop && !stopping()) {
        e.preventDefault();
        props.onStop();
      }
      return;
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

    // A digit on an empty field, offered to the caller (the composer's
    // permission affordance) before it is treated as typing.
    if (empty && /^[1-9]$/.test(e.key) && props.onEmptyDigit?.(e.key)) {
      e.preventDefault();
      return;
    }

    // ↑ from an empty field with prompts queued takes them back to edit.
    const editQueued = props.onEditQueued;
    if (e.key === "ArrowUp" && empty && histAt() < 0 && editQueued) {
      e.preventDefault();
      if (askingQueue) return;
      askingQueue = true;
      void editQueued()
        .catch(() => false)
        .then((ok) => {
          askingQueue = false;
          // The turn ended and sent them a moment ago: the key does what it
          // would have done, unless the writer has typed since.
          const hist = props.history ?? [];
          if (ok || (ta?.value ?? "") !== "" || histAt() >= 0 || hist.length === 0) return;
          setHistAt(hist.length - 1);
          recall(hist[hist.length - 1] ?? "");
        });
      return;
    }

    // ↑ from an empty field walks back through this session's prompts.
    const hist = props.history ?? [];
    if (e.key === "ArrowUp" && hist.length > 0 && (empty || histAt() >= 0)) {
      e.preventDefault();
      const next = histAt() < 0 ? hist.length - 1 : Math.max(0, histAt() - 1);
      setHistAt(next);
      recall(hist[next] ?? "");
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
        recall(hist[next] ?? "");
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
    // A phone's return key adds a line and the round button sends (Viktor,
    // 2026-09-28, as in T3 Code, ChatGPT and Claude on an iPhone). Ctrl or
    // Cmd+Enter from a hardware keyboard on the same device still sends.
    if (e.key === "Enter" && coarse() && !e.metaKey && !e.ctrlKey) return;
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  /**
   * The keyboard's Enter as `beforeinput` sees it, on a desktop. A phone's
   * return key adds a line instead (see onKeyDown).
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
    if (e.inputType === "insertReplacementText") props.onAutocorrect?.();
    if (e.inputType !== "insertLineBreak") return;
    // On a phone the key is return: the line goes in (see onKeyDown).
    if (coarse()) return;
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
   * the field already holds focus when that stray click arrives. It is not
   * enough on its own on WebKit, whose compat mousedown still follows touchend
   * and still blurs the field when it lands off it (`holdTap`).
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
    const opening = shape() === "pill";
    e.preventDefault();
    ta.focus();
    holdTap(opening);
  };

  /**
   * Keep the keyboard up across a finger's press on Send.
   *
   * A press on a button blurs the field, and on a phone that puts the keyboard
   * away. Measured on the Android emulator on 2026-09-27: after Send the box
   * stayed open with no keyboard under it and nothing to type into. A chat app
   * keeps the keyboard up across a send, so the press's default (moving focus)
   * is cancelled while the field holds it; the click still sends.
   */
  const keepFocusOnSend = (e: PointerEvent): void => {
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
    if (ta && document.activeElement === ta) e.preventDefault();
  };

  /**
   * The rest of the tap that focused the field is the field's, wherever it
   * lands.
   *
   * WebKit sends a tap's compat mousedown and click after touchend, hit-tested
   * at the finger against the layout as it is by then, and the keyboard has
   * already moved it. A mousedown on a non-focusable element blurs the field,
   * the same mechanism the terminal guards against (terminal/keepfocus.ts).
   * Seen on an iPhone on 2026-09-30, new-session screen: the field focused,
   * the keyboard started up, and the focus was on <body> 5 to 32ms later, on
   * three taps in a row. So a mousedown off the field has its default (moving
   * the focus) cancelled, and a click off it is eaten, so whatever slid under
   * the finger does not fire either.
   *
   * On the field itself both go through, to place the caret, except the click
   * of the tap that opened the pill: the box grows upward from where the pill
   * sat, and measured in Chromium's phone emulation on 2026-09-27 that click
   * landed on the model button and opened its sheet. One tap's worth, within
   * the time a tap takes, and nothing after it.
   */
  const holdTap = (opening: boolean): void => {
    const offField = (ev: Event): boolean =>
      !(ev.target instanceof Node && ta?.contains(ev.target));
    const onDown = (ev: Event): void => {
      if (offField(ev)) ev.preventDefault();
    };
    const onClick = (ev: Event): void => {
      if (opening || offField(ev)) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      done();
    };
    const done = (): void => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("click", onClick, true);
    };
    const timer = setTimeout(done, 700);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("click", onClick, true);
  };

  // ---- the + menu ----------------------------------------------------------
  // One float at a time: a press outside the menu and the `+` closes it, and so
  // does Escape, which hands the focus back to the `+`. Typing closes it too
  // (the input handler), since a reader who types has chosen the field.
  const [plusOpen, setPlusOpen] = createSignal(false);
  dismissFloat({
    open: plusOpen,
    inside: (t) => !!menuPlusEl?.contains(t) || !!plusEl?.contains(t),
    close: (why) => {
      setPlusOpen(false);
      if (why === "escape") plusEl?.focus();
    },
  });
  // The phone's Back closes it, as it does the model sheet (deployed review
  // round 1 of the T3 pass, 2026-09-29: Back went past the open menu).
  closeOnBack(plusOpen, () => setPlusOpen(false));
  // The watch hides the `+`, so a menu it had open goes with it.
  createEffect(() => {
    if (watching()) setPlusOpen(false);
  });
  const togglePlus = (e: MouseEvent): void => {
    // Watching: the `+` explains itself in its title and opens nothing, the
    // way the Attach button it replaced was disabled with the same reason.
    if (props.inertReason) return;
    const opening = !plusOpen();
    setPlusOpen(opening);
    // From the keyboard the first row takes the focus, so the arrows work.
    if (opening && e.detail === 0)
      menuPlusEl?.querySelector<HTMLButtonElement>(".tl-plus-item")?.focus();
  };
  /** A picker delivered files: attach them, and clear it so the same file
   *  can be picked again. */
  const onPicked = (e: Event & { currentTarget: HTMLInputElement }): void => {
    const el = e.currentTarget;
    const files = [...(el.files ?? [])];
    el.value = "";
    void attach(files);
  };
  /** Close the menu, then act. */
  const fromMenu = (act: () => void): void => {
    setPlusOpen(false);
    act();
  };

  // ---- the round button ------------------------------------------------
  // Send, Stop, or the Send that queues: one 32px disc, the surface's last
  // control. See `canStop` and Composer.queue.test.tsx.

  /** A send now queues behind the running turn. */
  const queueing = (): boolean => props.queues === true && sendable();
  /**
   * What Send's tooltip says. A caller's caveat wins (a question it would
   * dismiss, a plan it would answer); otherwise the queue.
   */
  const sendTitle = (): string =>
    props.sendTitle ??
    (queueing()
      ? "Send (Enter). Claude is working, so this queues until the turn ends"
      : "Send (Enter)");
  const stopping = (): boolean => props.stopping === true;

  /**
   * Which the button is. Stop only with an empty field and nothing attached:
   * anything to send wins, so a stale reading can never stand between the
   * reader and a send. A watching device gets neither.
   */
  const kind = (): "send" | "stop" =>
    !watching() && props.canStop === true && !!props.onStop && !sendable() ? "stop" : "send";
  /**
   * Greyed while the press would do nothing: an empty Send, a Stop already
   * pressed this turn, or any press from a watching device.
   */
  const buttonDisabled = (): boolean =>
    watching() || (kind() === "stop" ? stopping() : !sendable());
  const buttonLabel = (): string => {
    if (kind() === "stop") return stopping() ? "Stopping…" : "Stop Claude";
    return queueing() ? "Send, queues after this turn" : "Send";
  };
  const buttonTitle = (): string => {
    if (kind() === "stop")
      return stopping() ? "Stopping: waiting for the turn to end" : "Stop: interrupts this turn";
    return sendTitle();
  };
  /**
   * The press. Enter never reaches here with an empty field: it goes straight
   * to `submit`, which refuses an empty send, so Enter never stops Claude.
   */
  const press = (): void => {
    if (buttonDisabled()) return;
    if (kind() === "stop") {
      // The caller gives the field the focus back once whatever the Stop
      // hands back has landed in it (TextView stopHandingBack).
      props.onStop?.();
      return;
    }
    submit();
    // A mouse press took the focus from the field, and the next message is
    // typed there (deployed review rounds 3 to 5, 2026-09-28). A finger's
    // press keeps it already when the field had it (keepFocusOnSend); raising
    // a phone's keyboard it did not have would cover the conversation.
    if (!coarse() && !watching()) ta?.focus({ preventScroll: true });
  };

  return (
    <>
      <div class="tl-pillwrap">
        <Show when={props.resizable}>
          <ColumnGrip side="left" />
          <ColumnGrip side="right" />
        </Show>
        <Show when={plusOpen()}>
          <PlusMenu
            ref={(el) => (menuPlusEl = el)}
            canAttach={!!props.onAttach}
            attaching={attaching()}
            onPhoto={() => fromMenu(() => photoInput?.click())}
            onCamera={() => fromMenu(() => cameraInput?.click())}
            onFile={() => fromMenu(() => fileInput?.click())}
            onSlash={() => fromMenu(insertSlash)}
          />
        </Show>
        {/* Above the pill rather than below it, and floating: the menu is a
            question about the token under the caret, and in flow it pushed
            the whole composer up by its own height every time it opened. */}
        <Show
          when={
            !plusOpen() && completion() && (completion()!.items.length > 0 || slashUnreadable())
          }
        >
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
        {/* One surface for `+`, the field and Send, as the phone's pill or as
            the box. The field goes transparent inside it, so the surface
            carries the border, the fill and the focus edge, and reads as one
            control rather than an input with buttons parked beside it. */}
        <div
          ref={pillEl}
          class="tl-pill"
          data-shape={shape()}
          data-danger={props.danger ? "" : undefined}
          data-watch={watching() ? "" : undefined}
        >
          <Show when={!props.noPlus}>
            <button
              ref={plusEl}
              type="button"
              class="tl-plus"
              aria-haspopup="menu"
              aria-expanded={plusOpen()}
              aria-label="Add a photo, a file or a command"
              aria-disabled={props.inertReason ? "true" : undefined}
              aria-busy={attaching() ? "true" : undefined}
              hidden={watching()}
              // What it opens, and where a file goes. A title is all a mouse
              // gets before pressing; the menu's rows carry the words for a
              // phone, which shows no titles at all.
              title={
                props.inertReason ||
                ["Add a photo or a file, or insert a / command", props.attachNote]
                  .filter(Boolean)
                  .join(". ")
              }
              onClick={togglePlus}
            >
              <span class="tl-disc">
                <PlusIcon />
              </span>
            </button>
          </Show>
          {/* The chip layer.

              A textarea holds characters and nothing else, so an attachment
              inside the message can only BE text — the token. This element is
              the same string laid out in the same box behind the field, with a
              pill painted behind each token and every glyph transparent, so
              what the reader sees is the field's own text sitting on a chip.
              It owns no state and takes no clicks; if it were ever wrong the
              message would still read correctly, which is why the token says
              `[img: chart.png]` rather than relying on the paint. */}
          <div
            class="tl-field"
            data-thumbs={hasThumb() ? "on" : undefined}
            // Hidden, not unmounted, while another device drives: the draft
            // and its attachments survive the watch. `hidden` takes it out of
            // the accessibility tree as well as the paint.
            hidden={watching()}
          >
            {/* A folded draft's first line, drawn over the field whose own
                text the pill hides. Takes no presses: they belong to the
                field under it, which opens the box. */}
            <Show when={foldedLine()}>
              {(line) => (
                <span class="tl-pill-draft" aria-hidden="true">
                  {/* No chip layer sits behind this line, so a token is
                      drawn as a chip naming its file here instead. */}
                  <For each={readableTokens(line())}>
                    {(piece) =>
                      "chip" in piece ? (
                        <span class="tl-inline-chip" data-kind={piece.kind}>
                          {piece.chip}
                        </span>
                      ) : (
                        piece.text
                      )
                    }
                  </For>
                </span>
              )}
            </Show>
            <div class="tl-composer-mirror" aria-hidden="true" ref={mirrorEl}>
              {/* The pictures, in a row in the room the field leaves above
                  its text. The one thing in this layer that sits ABOVE the
                  field rather than behind it, and out of flow, so the copy of
                  the text stays a character-for-character match of the
                  field's. It scrolls with the text, as the first thing in the
                  message. */}
              <Show when={hasThumb()}>
                <div class="tl-thumb-strip">
                  <For each={pictures()}>
                    {(p) => (
                      <button
                        type="button"
                        class="tl-inline-zoom"
                        // Pointer-only, deliberately. This layer is
                        // `aria-hidden` (it is a copy of text the field
                        // already carries), so a control inside it must not be
                        // in the tab order, and a screen reader is not told
                        // about a picture twice. The token in the text still
                        // says what is attached.
                        tabindex={-1}
                        title={`Open ${p.item.token} full size`}
                        // The button sits ON TOP of the field, so the default
                        // press would move the caret into the text under it.
                        // Opening a picture is not an edit.
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => openZoom(p.src, p.item.name)}
                      >
                        <img
                          class="tl-inline-thumb"
                          src={p.src}
                          alt=""
                          // The store keeps the original (a 4100px screen grab
                          // is a normal paste here) and this box is 44px tall.
                          // Decoding off the main thread keeps that from
                          // landing on the keystroke that attached it.
                          decoding="async"
                          draggable={false}
                          onError={() => setBroken((was) => new Set(was).add(p.item.path))}
                        />
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <For each={mirror()}>
                {(part) => (
                  // The prose in a hidden span: transparent text still counts
                  // as visible to Safari's AutoFill, which scans the text
                  // before a lone field for "verification code" and the like.
                  <Show when={part.item} fallback={<span class="tl-mirror-text">{part.text}</span>}>
                    {(item) => (
                      <span class="tl-inline-chip" data-kind={item().kind}>
                        {part.text}
                      </span>
                    )}
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
              enterkeyhint={coarse() ? "enter" : "send"}
              // Safari's AutoFill decides what a field is from its words: the
              // placeholder, title and labels, and when it has no label, the
              // text before it. A "code" there made this box a one-time-code
              // field, with Bitwarden's codes over the keyboard and no
              // autocorrect (2026-10-09). The label below stops the reading of
              // the text around it. No autocomplete attribute: "off" changes no
              // AutoFill in WebKit and turns inline predictions off.
              aria-label={props.label}
              aria-labelledby={labelId}
              onInput={() => {
                setPlusOpen(false);
                setHistAt(-1);
                sync();
                setPicked(0);
                void refreshPaths();
              }}
              onKeyDown={onKeyDown}
              onBeforeInput={onBeforeInput}
              onPointerDown={onPointerDown}
              onFocus={() => setOpened(true)}
              onClick={sync}
              // The field scrolls past 200px; the layer behind it has to go
              // with it or the chips stay where the text no longer is.
              onScroll={() => {
                if (mirrorEl && ta) mirrorEl.scrollTop = ta.scrollTop;
              }}
            />
            <span id={labelId} class="tl-sr-only">
              {props.label}
            </span>
          </div>
          {/* The round button is the surface's last control, always, in one
              of three states (Composer.queue.test.tsx).

              Why Stop is gated so hard. Send was once REPLACED by Stop while a
              turn ran, on the transcript's reading alone, and that reading lags
              the pane: measured live, a session whose real state was `done`
              showed Stop in 98 of 100 samples over 300s, so a finished session
              could offer no way to send at all. Now the caller needs the hook
              state to agree before `canStop` is true, and typing anything
              turns the button back into Send. */}
          <Show when={props.tools}>
            <div class="tl-box-tools" hidden={watching()}>
              {props.tools}
            </div>
          </Show>
          {/* Watching: another device drives. The pill says so and offers the
              session back, and that button is its only control: no field, no
              +, no model button, no round button. Those are hidden but stay
              mounted, so a draft and its attachments survive the watch. The
              refusal in TextView (refuseWatching) stays the authority on
              sending; this is what the reader sees. */}
          <Show when={watching()}>
            <div class="tl-watch" title={props.inertReason}>
              <span class="tl-watch-eye" aria-hidden="true">
                <EyeIcon size={17} />
              </span>
              <span class="tl-watch-word">{watchWord(props.inertReason ?? "")}</span>
              <Show when={props.onTakeControl}>
                <button
                  type="button"
                  class="tl-take"
                  title="Stop watching, and type into this session from here"
                  onClick={() => props.onTakeControl?.()}
                >
                  Take control
                </button>
              </Show>
            </div>
          </Show>
          <div class="tl-pill-end" hidden={watching()}>
            <button
              type="button"
              class="tl-send"
              data-kind={kind()}
              aria-label={buttonLabel()}
              onPointerDown={keepFocusOnSend}
              onClick={press}
              disabled={buttonDisabled()}
              title={buttonTitle()}
            >
              <span class="tl-disc">
                <Show when={kind() === "stop"} fallback={<SendArrowIcon />}>
                  <StopSquareIcon size={11} />
                </Show>
              </span>
            </button>
          </div>
        </div>
        <Show when={props.onAttach}>
          {/* The three pickers stay mounted while the + menu comes and goes: a
              picker opened from a row that has since unmounted still has to
              deliver its files somewhere. The any-file input comes first,
              which is the one a bare `input[type=file]` finds.

              Present on EVERY device, which is the point: the soft-key row
              carries Copy and Paste only, so a phone had no file picker in
              either view, and the text view is the default view on a coarse
              pointer. Photo library's input has no `capture`, so iOS still
              offers its own sheet (Photo Library, Take Photo, Choose File);
              Camera's has `capture=environment`, which opens the back camera
              directly. Each clears its value after a pick, so the same file
              can be picked again. */}
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            aria-hidden="true"
            onChange={onPicked}
          />
          <input
            ref={photoInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            aria-hidden="true"
            onChange={onPicked}
          />
          <input
            ref={cameraInput}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            aria-hidden="true"
            onChange={onPicked}
          />
        </Show>
      </div>
      {/* The attached picture, full size. Same class as the gallery's, so the
          two look and behave alike, and pressing anywhere on it closes it —
          the surface is not a control, which is why the gesture goes on
          through `dismissOnPress` rather than an onClick (components/overlay). */}
      <Show when={zoom()}>
        {(shot) => (
          <div class="tl-lightbox" ref={dismissOnPress(closeZoom, { keepFocus: true })}>
            <img src={shot().src} alt={storedDisplayName(shot().name)} />
          </div>
        )}
      </Show>
    </>
  );
};
