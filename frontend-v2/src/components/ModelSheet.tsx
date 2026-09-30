import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
  type Component,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import { isCoarsePointer } from "../mobile/pointer";
import { installDialogFocus, wrapTab } from "../lib/focus-trap";
import { isDangerMode, MODES, modeHangsOnModel, modeId, modeTitle, type ModeId } from "../logic/modes";
import {
  chipName,
  DEFAULT_CHOICE,
  START_MODEL,
  effortsForModel,
  fieldHeading,
  isCurrentModel,
  isEffortFor,
  labelFor,
  modelName,
  modelNote,
  optionsFor,
  startEfforts,
  summarise,
  type ModelField,
  type ModelHarness,
  type ModelOption,
  type ModelState,
  type PiOffer,
} from "../lib/models";
import { contextSummary, contextTone, percentFull, type ContextState } from "./context.logic";
import { CheckIcon, ChevronDownIcon, ShieldIcon, SparkleIcon } from "./Icons";
import { closeOnBack } from "../lib/back-closes";
import { dismissFloat, focusChosen, walkNav, type RowNav } from "./overlay";

/**
 * The model button in the composer's box, and the one sheet it opens.
 *
 * THE T3 PASS (Viktor, 2026-09-27; docs/plans/2026-09-27-text-view-t3-pass.md).
 * The Quiet line put three dials on a line above the field: mode, model with
 * effort, and context. Viktor asked for "something closer to t3 code", so they
 * became one button in the box's bottom row, "✳ Opus 5.5 ⌄", and one sheet
 * behind it with four parts: the Model list, an Effort segmented control, the
 * Mode list, and a quiet "Context N% used" line. With a fine pointer the sheet
 * is a 440px popover above the box; with a coarse one it is a bottom sheet
 * over a scrim, drawn at phone sizes (48px rows, 16px text).
 *
 * WHAT THE BUTTON SAYS. The model's name, which keeps the version and drops
 * the rest of the slug (lib/models.ts `modelName`); the exact slug and the
 * effort go in its title. "Model" until the session has reported one, and
 * "Switching…" while a model change or a mode walk is being driven. Bypass and
 * No ask add a small red shield in front of the sparkle; the box's border
 * turning the danger colour is the other half of that signal (PromptField).
 *
 * WHAT A PICK DOES. A model or an effort goes to `onPickModel`, which drives
 * the CLI's own picker (POST /model); a mode goes to `onPickMode`, which asks
 * the server to walk Shift+Tab to it (POST /model with a mode). Both type into
 * somebody's live pane, so a pick of what is already in force sends nothing,
 * and every pick closes the sheet, the way the dials did on a live session.
 *
 * WHEN IT CANNOT ACT. A dialog on the pane holds the button: the picker and
 * the walk both type keys, and a dialog would take them (on the plan
 * approval's feedback row Shift+Tab approves the plan, memory #13896). A
 * dialog that lands while the phone's sheet is open holds every row instead,
 * and closes the desktop popover, whose box the card moves. So does
 * watching another device drive, and a change already in flight holds the rows
 * it would race.
 *
 * WHICH EFFORTS. The levels the session's model offers (lib/models.ts
 * `effortsForModel`, read from the CLI's own catalogue): five rungs on every
 * Claude row but Haiku 4.5, which has one level and so no control. Codex keeps
 * its catalogue and pi the levels its session stamped, under pi's own word,
 * "Thinking". The level the session reports always shows, so a session on
 * ultracode, which the row leaves out, still sees it ticked.
 *
 * THE NEW-SESSION VARIANT (`offerDefault`). The new-session screen's box
 * carries the same button, and its sheet holds Model and Effort only: a
 * session that does not exist has no mode to walk and no context used. Both
 * lists lead with Default ("whatever the CLI starts on"), Claude keeps
 * ultracode on every model with xhigh (lib/models.ts `startEfforts`), and a
 * pick writes a preference rather than typing into a pane, so the phone's
 * sheet stays up for the second choice (`keepSheetOpen`) and `note` says when
 * an effort lasts one session.
 */

/** The float's accessible name, on the popover and the bottom sheet alike. */
const SHEET_NAME = "Model, effort and mode";

/** Why No ask cannot be picked by a session not already in it. */
const NO_ASK_WHY = "Set when the session starts. Shift+Tab cannot reach it";

/** What the arrow keys walk in the sheet. */
const NAV: RowNav = { row: ".tl-ms-row", seg: ".tl-ms-seg" };

/**
 * The tallest the popover gets. The prototype drew 620px for three models;
 * the box offers six, and the rows are drawn tighter than the prototype's so
 * the whole sheet fits above the box in an 800px window (app.css .tl-ms-model).
 */
const POP_MAX = 720;
/** The least room under the pane's header the popover settles for before it
 *  takes the window's room instead: enough for Effort and the Mode list. */
const POP_MIN_UNDER_HEADER = 400;
/** The popover's width: wide enough for each model's note under its name and
 *  each mode's line beside its name (app.css .tl-ms-pop). The prototype drew
 *  360px for three models. */
const POP_W = 440;
/** How far past the box's left edge the popover starts: just past the +. */
const POP_INSET = 36;
/** The gap between the popover and the box, and its least distance from the
 *  window's edges. */
const POP_GAP = 8;

/** Where the popover sits over the page, in the window's pixels. */
interface PopPlace {
  left: number;
  bottom: number;
  width: number;
  maxHeight: number;
}

export const ModelSheet: Component<{
  /** Which CLI the session runs. Absent: no Model or Effort section. */
  harness?: ModelHarness;
  /** What the session reports being on; undefined until it has answered. */
  model?: ModelState;
  /** A model or effort change is being driven. */
  modelBusy?: boolean;
  /** Pi's rows: the models pi lists and the levels the session supports. */
  modelOffer?: PiOffer;
  onPickModel?: (field: ModelField, id: string) => void;
  /** The permission mode in force. Empty or absent: no Mode section. */
  mode?: string;
  /** A mode walk is being driven. */
  modeBusy?: boolean;
  /** Modes the server has said this session does not offer. */
  modesUnavailable?: ReadonlySet<string>;
  onPickMode?: (mode: ModeId) => void;
  /** Why the mode cannot change right now: a dialog is on the pane. */
  modeHeld?: string;
  /** Why the model cannot change right now, for the same dialogs. */
  modelHeld?: string;
  /** How full the context is, for the context line (context.logic.ts). */
  context?: ContextState;
  /** Watching: the sheet reads, and every row is inert. */
  inertReason?: string;
  /** A session not started yet: Default leads both lists, and the efforts
   *  are the ones a launch can ask for (`startEfforts`). */
  offerDefault?: boolean;
  /** The two lists' accessible names, "Model" and the effort heading unless
   *  given. */
  names?: { model: string; effort: string };
  /** The button's accessible name, followed by the model and the effort. The
   *  live composer's names the harness and the mode instead. */
  buttonName?: string;
  /** A line under the efforts, in place of codex's live-session note. */
  note?: string;
  /** Said on the model list itself, such as why pi's list could not be read. */
  modelTitle?: string;
  /** A pick leaves the phone's sheet up, for a second choice in one visit. */
  keepSheetOpen?: boolean;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [sheet, setSheet] = createSignal(false);
  const [place, setPlace] = createSignal<PopPlace | null>(null);
  const [more, setMore] = createSignal(false);
  /**
   * The popover is shorter than its rows, and draws them tighter (app.css,
   * `.tl-ms-pop[data-tight]`) before it asks for a scroll. Deployed review
   * round 2 of the T3 pass (2026-09-29): in a workspace tile at 1280x800 the
   * tile's name strip left the popover 20px short and cut the context line in
   * half at its edge, and a 1024x700 window hid Bypass, No ask and the line.
   */
  const [tight, setTight] = createSignal(false);
  let root: HTMLSpanElement | undefined;
  let btn: HTMLButtonElement | undefined;
  let popEl: HTMLDivElement | undefined;
  let layerEl: HTMLDivElement | undefined;

  // ---- the button ------------------------------------------------------------
  const danger = (): boolean => isDangerMode(props.mode ?? "");
  const busy = (): boolean => props.modelBusy === true || props.modeBusy === true;
  /** Why the button opens nothing: a dialog is on the pane. */
  const held = (): string => props.modelHeld || props.modeHeld || "";
  /** The model's name, or "" while the session has not said. */
  const name = (): string => {
    const m = props.model?.model;
    if (!props.harness || !m) return "";
    if (m !== DEFAULT_CHOICE) return modelName(props.harness, m);
    // The new-session button names what a default start boots on, where the
    // box decides it (START_MODEL); the sheet's row still reads Default.
    const start = props.offerDefault ? START_MODEL[props.harness] : undefined;
    return start ? modelName(props.harness, start) : "Default";
  };
  const label = (): string => {
    if (busy()) return "Switching…";
    if (props.harness) return name() || "Model";
    return modeTitle(props.mode ?? "") || "Model";
  };
  /**
   * The effort the session runs at, or undefined when its model has none: a
   * leftover level from the model before Haiku 4.5 is not one Haiku uses
   * (deployed review round 4, 2026-09-28).
   */
  const shownEffort = (): string | undefined => {
    const h = props.harness;
    const m = props.model?.model;
    if (h && m && m !== DEFAULT_CHOICE && effortsForModel(h, m, props.modelOffer).length === 0) {
      return undefined;
    }
    return props.model?.effort;
  };
  /** The model and the effort by name, for the button's accessible name. */
  const spoken = (): string => {
    const h = props.harness;
    if (!h) return "";
    const effort = shownEffort();
    const e = effort && effort !== DEFAULT_CHOICE ? labelFor(h, "effort", effort) : "";
    return [name(), e].filter((s) => s !== "").join(" · ");
  };
  const title = (): string => {
    if (held()) return held();
    const h = props.harness;
    if (!h) return `Permission mode: ${modeTitle(props.mode ?? "")}`;
    // The exact slug and effort, which the name on the button shortens.
    if (props.buttonName) {
      return `Model and effort for the new session: ${props.model?.model ?? DEFAULT_CHOICE} · ${props.model?.effort ?? DEFAULT_CHOICE}`;
    }
    const exact = summarise({ model: props.model?.model, effort: shownEffort() });
    return exact ? `${chipName(h)}: ${exact}` : `${chipName(h)}. The session has not answered yet`;
  };
  const ariaLabel = (): string => {
    if (props.buttonName) return `${props.buttonName}: ${spoken() || "Default"}`;
    const parts: string[] = [];
    if (props.harness) parts.push(`${chipName(props.harness)}: ${spoken() || "not reported yet"}.`);
    if (props.mode) parts.push(`Permission mode: ${modeTitle(props.mode)}.`);
    parts.push(held() || "Change them");
    return parts.join(" ");
  };

  // ---- opening and closing ---------------------------------------------------
  const close = (refocus: boolean): void => {
    if (!open()) return;
    setOpen(false);
    if (refocus) btn?.focus();
  };

  // A watch hides the model button, so a sheet it had open closes with it.
  createEffect(() => {
    if (props.inertReason) untrack(() => close(false));
  });
  // A dialog landing docks its card under the box and moves it, and the
  // popover, placed against the box when it opened, was left floating over
  // the card (deployed review rounds 3 to 5, 2026-09-28). It closes. The
  // phone's sheet is anchored to the screen, and holds its rows instead.
  createEffect(() => {
    if (held()) untrack(() => !sheet() && close(false));
  });

  dismissFloat({
    open,
    inside: (t) => !!(root?.contains(t) || popEl?.contains(t) || layerEl?.contains(t)),
    close: (why) => close(why === "escape"),
  });
  // The phone's Back closes it rather than leaving the page (lib/back-closes).
  closeOnBack(open, () => close(false));

  /**
   * Place the popover over the page, above the box, capped at the WINDOW's
   * room above it. It used to sit inside the pane, capped at the pane's room:
   * found live on 2026-09-27, a 700px or 450px window stacks the sidebar above
   * the pane, and the popover was 227px tall with Effort and Mode out of view.
   * It is drawn in the document's body for the reason BottomSheet is: the
   * box's surface blurs what is behind it, which pins a fixed child to the box.
   *
   * Answers whether it fits under the pane's header. When it does not, the
   * button opens the bottom sheet instead (`press`).
   */
  const placePop = (): boolean => {
    const pill = root?.closest(".tl-pill") ?? root;
    if (!pill) return true;
    const r = pill.getBoundingClientRect();
    const vw = window.innerWidth;
    const width = Math.min(POP_W, vw - 2 * POP_GAP);
    const left = r.left + Math.min(POP_INSET, Math.max(0, r.width - width));
    // The pane's own header stays in view: found live on 2026-09-28 at
    // 1280x800, six models tall, the popover rose over the session's title and
    // the lobby's bar. The Text view's top edge is the header's foot. When the
    // pane leaves too little room under it (a short window), the window's room
    // is used instead, as above.
    const pane = pill.closest(".tl-textview");
    const paneTop = pane?.getBoundingClientRect().top ?? 0;
    const underHeader = r.top - paneTop - 2 * POP_GAP;
    const fits = underHeader >= POP_MIN_UNDER_HEADER;
    const room = fits ? underHeader : r.top - 2 * POP_GAP;
    setPlace({
      left: Math.max(POP_GAP, Math.min(left, vw - POP_GAP - width)),
      bottom: window.innerHeight - r.top + POP_GAP,
      width,
      maxHeight: Math.min(POP_MAX, Math.max(160, room)),
    });
    // Only a Text view's pane can be too short: the new-session box has none.
    return fits || !pane;
  };
  /** Whether part of the sheet is below the popover's edge, for the fade that
   *  says so. */
  const checkMore = (): void => {
    const el = popEl;
    setMore(!!el && el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  };
  /** Draw the rows tighter when they overflow the popover, then say whether
   *  more is still below. Measured a frame after the rows change. */
  const fit = (): void => {
    const el = popEl;
    if (el && !untrack(tight) && el.scrollHeight > el.clientHeight + 1) {
      setTight(true);
      requestAnimationFrame(checkMore);
      return;
    }
    checkMore();
  };
  // A window that changes size moves the box; the popover follows it.
  createEffect(() => {
    if (!open() || sheet()) {
      setTight(false);
      return;
    }
    const follow = (): void => {
      placePop();
      setTight(false);
      requestAnimationFrame(fit);
    };
    window.addEventListener("resize", follow);
    requestAnimationFrame(fit);
    onCleanup(() => window.removeEventListener("resize", follow));
  });

  const press = (e: MouseEvent): void => {
    if (held() || busy()) return;
    if (open()) {
      close(false);
      return;
    }
    // A pane too short for the popover under its header (a narrow window
    // stacks the sidebar above it) gets the phone's bottom sheet: drawn over
    // the window's room instead, the popover covered the sidebar and the
    // session's header (found live on 2026-09-28).
    const phone = isCoarsePointer();
    setSheet(phone || !placePop());
    setOpen(true);
    // A keyboard activation is a click with no pointer detail. The list takes
    // the focus then, or the arrows would have nothing to walk. A pointer
    // leaves the focus where it was, as a menu does. The phone's sheet takes
    // the focus itself (lib/focus-trap), which is what puts the keyboard away.
    if (!phone && e.detail === 0) focusChosen(popEl, NAV);
  };

  // ---- the Model and Effort sections ------------------------------------------
  const h = (): ModelHarness | undefined => props.harness;
  /** Why no model or effort can be picked, or "" when one can. */
  const modelLocked = (): boolean =>
    !!props.inertReason || !!props.modelHeld || props.modelBusy === true;
  const chosen = (field: ModelField, id: string): boolean => {
    const hh = h();
    if (!hh) return false;
    if (field === "model" && id === DEFAULT_CHOICE) return props.model?.model === DEFAULT_CHOICE;
    return field === "model"
      ? isCurrentModel(hh, id, props.model?.model)
      : props.model?.effort === id;
  };
  const modelRows = (): readonly ModelOption[] => {
    const hh = h();
    if (!hh) return [];
    const rows = optionsFor(hh, "model", props.modelOffer).filter((o) => o.id !== DEFAULT_CHOICE);
    return props.offerDefault ? [{ id: DEFAULT_CHOICE, label: "Default" }, ...rows] : rows;
  };
  /** This model's levels, and the one the session is on if the row left it out. */
  const effortRows = (): readonly ModelOption[] => {
    const hh = h();
    if (!hh) return [];
    const rows = props.offerDefault
      ? startEfforts(hh, props.model?.model ?? DEFAULT_CHOICE, props.modelOffer)
      : effortsForModel(hh, props.model?.model, props.modelOffer);
    const cur = props.model?.effort;
    if (rows.length === 0 || !cur || rows.some((o) => o.id === cur)) return rows;
    return isEffortFor(hh, cur) && cur !== DEFAULT_CHOICE
      ? [...rows, { id: cur, label: labelFor(hh, "effort", cur) }]
      : rows;
  };
  /** A model row's name: Default, or the model's own. */
  const rowName = (id: string): string => (id === DEFAULT_CHOICE ? "Default" : modelName(h()!, id));
  const pickModel = (field: ModelField, id: string): void => {
    if (modelLocked()) return;
    if (!chosen(field, id)) props.onPickModel?.(field, id);
    if (!(props.keepSheetOpen && sheet())) close(true);
  };

  // ---- the Mode section --------------------------------------------------------
  const current = (): ModeId | undefined => modeId(props.mode ?? "");
  /** Why no mode can be picked right now, said once under the list. */
  const modeHold = (): string =>
    props.inertReason ||
    props.modeHeld ||
    (props.modeBusy ? "A mode change is on its way to the session" : "");
  /** Why this row cannot be picked, or "" when it can. */
  const why = (id: ModeId): string => {
    const hold = modeHold();
    if (hold) return hold;
    if (props.modesUnavailable?.has(id)) {
      const on = modeHangsOnModel(id) ? name() : "";
      return on ? `Not offered on ${on}` : "Not offered in this session";
    }
    // No ask is not a stop on Shift+Tab: a session can start in it, and the
    // first press leaves it for good (CLI 2.1.281, memory #13911).
    if (id === "dontAsk" && current() !== "dontAsk") return NO_ASK_WHY;
    return "";
  };
  const pickMode = (id: ModeId): void => {
    if (why(id)) return;
    // The walk would press no key; the tick already says so.
    if (id !== current()) props.onPickMode?.(id);
    close(true);
  };

  /** Named for what it holds: a new session's sheet has no Mode section. */
  const sheetName = (): string => (props.mode ? SHEET_NAME : "Model and effort");

  /** The one line under the lists that says why nothing can be picked. */
  const holdNote = (): string => props.inertReason || props.modelHeld || props.modeHeld || "";

  const body = (): JSX.Element => (
    <>
      <Show when={h() && modelRows().length > 0}>
        <div class="tl-ms-h" aria-hidden="true">
          {fieldHeading(h()!, "model")}
        </div>
        {/* Six models at a finger's 48px pushed Bypass, No ask and the
            context line below a phone's sheet (412x783, 2026-09-27), and
            six one-line rows put No ask and the context line under the
            desktop popover's scroll at 1280x800 (round 7, 2026-09-28). So
            more than three go in two columns on both. The prototype's one
            column held three. */}
        <div
          role="radiogroup"
          class="tl-ms-models"
          data-cols={modelRows().length > 3 ? "2" : undefined}
          aria-label={props.names?.model ?? "Model"}
          title={props.modelTitle}
        >
          <For each={modelRows()}>
            {(o) => (
              <button
                type="button"
                role="radio"
                class="tl-ms-row tl-ms-model"
                data-value={o.id}
                aria-checked={chosen("model", o.id)}
                aria-disabled={modelLocked() ? "true" : undefined}
                title={
                  props.inertReason ||
                  (modelNote(h()!, o.id) ? `${modelNote(h()!, o.id)} · ${o.id}` : o.id)
                }
                onClick={() => pickModel("model", o.id)}
              >
                <span class="tl-ms-lab">
                  {/* Claude's mark, on Claude's rows only. */}
                  <Show when={h() === "claude"}>
                    <SparkleIcon size={14} class="tl-ms-spark" />
                  </Show>
                  <span class="tl-ms-name">{rowName(o.id)}</span>
                  {/* A short note beside the name, as the prototype's rows
                      have. The exact slug, which Viktor asked to see
                      (2026-09-06), is the row's title; codex and pi name their
                      rows by it. */}
                  <Show when={modelNote(h()!, o.id)}>
                    {(note) => <small class="tl-ms-sub">{note()}</small>}
                  </Show>
                </span>
                <Show when={o.id === DEFAULT_CHOICE}>
                  <span class="tl-ms-desc">Whatever the CLI starts on</span>
                </Show>
                <span class="tl-ms-tick" aria-hidden="true">
                  <Show when={chosen("model", o.id)}>
                    <CheckIcon />
                  </Show>
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={h()}>
        {(hh) => (
          <>
            <div class="tl-ms-h" aria-hidden="true">
              {fieldHeading(hh(), "effort")}
              <Show when={effortRows().length > 0}>
                <span class="tl-ms-aside">how hard it thinks</span>
              </Show>
            </div>
            <Show
              when={effortRows().length > 0}
              fallback={
                <p class="tl-ms-none">
                  {`${props.model?.model ? modelName(hh(), props.model.model) : "This model"} has one effort level.`}
                </p>
              }
            >
              <div
                class="tl-ms-seg"
                role="radiogroup"
                aria-label={props.names?.effort ?? fieldHeading(hh(), "effort")}
              >
                <For each={effortRows()}>
                  {(o) => (
                    <button
                      type="button"
                      role="radio"
                      data-value={o.id}
                      aria-checked={chosen("effort", o.id)}
                      aria-disabled={modelLocked() ? "true" : undefined}
                      title={labelFor(hh(), "effort", o.id)}
                      onClick={() => pickModel("effort", o.id)}
                    >
                      {o.id}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            {/* Codex's picker writes ~/.codex/config.toml and has no "this
                session only" key, where Claude's does, so a change there also
                moves what the next codex session starts on. */}
            <Show
              when={props.note}
              fallback={
                <Show when={hh() === "codex"}>
                  <p class="tl-ms-note">Also becomes codex's default for new sessions.</p>
                </Show>
              }
            >
              <p class="tl-ms-note">{props.note}</p>
            </Show>
          </>
        )}
      </Show>
      <Show when={props.mode}>
        <div class="tl-ms-h" aria-hidden="true">
          Mode
          <span class="tl-ms-aside">{modeTitle(props.mode ?? "")}</span>
        </div>
        <div role="radiogroup" aria-label="Permission mode">
          <For each={MODES}>
            {(m, i) => (
              <>
                <Show when={m.tone === "danger" && MODES[i() - 1]?.tone !== "danger"}>
                  <div class="tl-ms-rule" aria-hidden="true" />
                </Show>
                <button
                  type="button"
                  role="radio"
                  class="tl-ms-row tl-ms-mode"
                  data-mode={m.id}
                  data-danger={m.tone === "danger" ? "" : undefined}
                  aria-checked={current() === m.id}
                  aria-disabled={why(m.id) ? "true" : undefined}
                  title={why(m.id) || (tight() ? m.line : undefined)}
                  onClick={() => pickMode(m.id)}
                >
                  <span class="tl-ms-lab">
                    <Show when={m.tone === "danger"}>
                      <ShieldIcon size={14} class="tl-ms-shield" />
                    </Show>
                    <span class="tl-ms-name">{m.label}</span>
                  </span>
                  {/* A row held for its own reason says it here, where a
                      phone can read it; the hold on every row is said once,
                      under the list. No ask's standing reason is the row's
                      title, and its settled line stays, as the prototype
                      draws it. */}
                  <span class="tl-ms-desc">
                    {why(m.id) && why(m.id) !== modeHold() && why(m.id) !== NO_ASK_WHY
                      ? why(m.id)
                      : m.line}
                  </span>
                  <span class="tl-ms-tick" aria-hidden="true">
                    <Show when={current() === m.id}>
                      <CheckIcon />
                    </Show>
                  </span>
                </button>
              </>
            )}
          </For>
        </div>
      </Show>
      <Show when={holdNote()}>
        <p class="tl-ms-note" data-kind="held">
          {holdNote()}
        </p>
      </Show>
      <Show when={props.context}>
        {(c) => (
          <div class="tl-ms-ctx" data-tone={contextTone(c().reading)} title={contextSummary(c())}>
            <i style={{ "--p": `${percentFull(c().reading)}%` }} aria-hidden="true" />
            Context {percentFull(c().reading)}% used
          </div>
        )}
      </Show>
    </>
  );

  return (
    <span class="tl-ms" ref={root}>
      <button
        ref={btn}
        type="button"
        class="tl-model-btn"
        data-mode={props.mode || undefined}
        data-danger={danger() ? "" : undefined}
        data-busy={busy() ? "" : undefined}
        data-unknown={!busy() && !!props.harness && name() === "" ? "" : undefined}
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-disabled={held() ? "true" : undefined}
        aria-label={ariaLabel()}
        title={title()}
        onClick={press}
      >
        <Show when={danger()}>
          <ShieldIcon size={14} class="tl-model-shield" />
        </Show>
        {/* Claude's mark, so only on Claude's button (a Codex session's read
            "✳ Model", deployed review round 1, 2026-09-28). */}
        <Show when={!props.harness || props.harness === "claude"}>
          <SparkleIcon class="tl-model-spark" />
        </Show>
        <span class="tl-model-name">{label()}</span>
        <ChevronDownIcon class="tl-model-chev" />
      </button>
      <Show when={open() && !sheet()}>
        <Portal>
          <div
            ref={popEl}
            class="tl-ms-pop"
            role="dialog"
            aria-label={sheetName()}
            data-more={more() ? "" : undefined}
            data-tight={tight() ? "" : undefined}
            style={(() => {
              const p = place();
              return p
                ? {
                    left: `${p.left}px`,
                    bottom: `${p.bottom}px`,
                    width: `${p.width}px`,
                    "max-height": `${p.maxHeight}px`,
                  }
                : { "max-height": `${POP_MAX}px` };
            })()}
            onScroll={checkMore}
            onKeyDown={(e) => walkNav(e, NAV)}
          >
            {body()}
          </div>
        </Portal>
      </Show>
      <Show when={open() && sheet()}>
        <Portal>
          <BottomSheet
            ref={(el) => (layerEl = el)}
            label={sheetName()}
            onClose={() => close(false)}
          >
            {body()}
          </BottomSheet>
        </Portal>
      </Show>
    </span>
  );
};

/**
 * The phone's sheet: a scrim and a sheet rising from the bottom edge. The
 * model sheet's, and the new-session strip's project and command lists.
 *
 * Rendered into the document's body. The composer's surface blurs what is
 * behind it (`backdrop-filter`), which makes it the containing block of any
 * fixed descendant, so a sheet drawn inside it would be pinned to the box
 * rather than to the screen.
 *
 * Modal while it is up. It takes the focus, which also puts the phone's
 * keyboard away when the message field had it; Tab cannot walk out behind the
 * scrim; closing hands the focus back to whatever held it (lib/focus-trap).
 */
export const BottomSheet: Component<{
  ref: (el: HTMLDivElement) => void;
  /** The sheet's accessible name. */
  label: string;
  onClose: () => void;
  children: JSX.Element;
}> = (props) => {
  let sheetEl: HTMLDivElement | undefined;
  installDialogFocus(() => sheetEl);
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Tab" && sheetEl) wrapTab(e, sheetEl);
    else walkNav(e, NAV);
  };
  return (
    <div class="tl-ms-layer" ref={props.ref}>
      <button
        type="button"
        class="tl-ms-scrim"
        aria-label="Close"
        tabindex={-1}
        onClick={() => props.onClose()}
      />
      <div
        class="tl-ms-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        tabindex={-1}
        ref={sheetEl}
        onKeyDown={onKeyDown}
      >
        <div class="tl-ms-grab" aria-hidden="true" />
        {props.children}
      </div>
    </div>
  );
};
