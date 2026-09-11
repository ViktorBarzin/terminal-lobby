import { For, Show, createEffect, createMemo, type Component } from "solid-js";

/**
 * A dialog screen the parser could not read, shown as itself.
 *
 * ADR-0010's original consequence was "treat a failure to parse as an unknown
 * prompt: show the honest fallback to the terminal". That sent the reader to a
 * view they had deliberately left, for 22.4% of the 1,045 AskUserQuestion
 * calls in this box's corpus. The design agreed 2026-09-10 replaces it with
 * this: draw the capture, and make the lines that look like numbered rows
 * tappable so there is still a way to answer.
 *
 * DETECTING ROWS IS A GUESS, and it is worth saying so plainly. This component
 * only ever runs on screens sessionio.ParseDialog refused, so by construction
 * nothing here is a screen we understand. A CLI restyle — a different bullet,
 * a letter instead of a digit, a two-column layout — makes the guess wrong,
 * and a wrong guess presses a key on somebody's live session. That trade-off
 * was weighed on 2026-09-10 against the alternative of a plain key row
 * (↑ ↓ ← → ⏎ ⎋) and the rows won: the key row makes every unknown screen a
 * blind arrow walk, while a wrong digit on a select widget is one visible,
 * recoverable press. When no rows are found the card shows the capture and no
 * controls at all, which is the one case where reaching for the Terminal is
 * the honest answer.
 *
 * The patterns and the region below are ports of sessionio's, not new
 * inventions: reOption, reFooter, reBorder, reTabBar, reHeader and reRule in
 * dialog.go, and dialogTop in answerplan.go. They can drift from the Go, so
 * both sides are tested against the same captures under sessionio/testdata.
 */

/** "❯ 1. Label" / "  2. [ ] Label" / "  3. [✔] Label" — dialog.go reOption. */
const RE_OPTION = /^\s*[❯>]?\s*(\d+)\.\s+(?:\[[^\]]*\]\s+)?(.*\S)\s*$/;
/** The footer the select widget draws under every dialog — dialog.go reFooter. */
const RE_FOOTER = /Enter to select .* Esc to cancel/;
/** The box-drawing the dialog paints down the left of every line it owns. */
const RE_BORDER = /[│┃|┆┊╎╏║]/g;
/** "←  ☒ Fruit  ☐ Drink  ✔ Submit  →" — dialog.go reTabBar. */
const RE_TAB_BAR = /^\s*←.*[☐☒].*→\s*$/;
/** " ☐ Font", the header a single-question dialog draws — dialog.go reHeader,
 *  without the capture, since only whether it matched is wanted here. */
const RE_HEADER = /^\s*[☐☒]\s*\S/;
/** The horizontal rule the CLI and tmux both draw — dialog.go reRule. */
const RE_RULE = /^[\s─━-]+$/;

/**
 * How far above the footer to read when the capture gives nothing else to
 * anchor on.
 *
 * This is sessionio/answerplan.go's maxRegionLines and it is the LAST RESORT
 * there too, not the bound. Taking it as the bound is what this file did until
 * a numbered list in the conversation above a dialog was measured shifting
 * every row: three plan steps in the scrollback consumed the 1, 2, 3 the
 * widget's own rows needed, so the card offered the plan steps as answers and
 * dropped Sans, Serif and Type something. Tapping the row labelled with a plan
 * step sent digit 1, which the dialog read as Sans — an answer to a question
 * whose options the reader never saw.
 *
 * It also decides what the reader SEES. A capture carries the whole scroll
 * buffer and the dialog is always at the bottom, so showing the head of the
 * file would open the card on conversation the reader has already read.
 */
const MAX_REGION_LINES = 48;

/**
 * How many lines of question can sit above the option list — dialog.go
 * maxQuestionLines.
 */
const MAX_QUESTION_LINES = 12;

/**
 * How many lines a wrapped footer can occupy — dialog.go footerAt.
 *
 * The footer runs to 60 characters, so any pane narrower than that breaks it.
 * Measured 2026-09-04 on a live 58x16 pane: "Esc to cancel" lands on the line
 * below, and matching one line at a time missed the dialog entirely.
 */
const FOOTER_WRAP = 3;

/**
 * The most rows worth offering.
 *
 * sessionio.answerKeys allows the digits 1-9 and nothing else, and that
 * allowlist is the whole security boundary of the keys route. A tenth row
 * cannot be pressed, so it is not drawn as something pressable.
 */
const MAX_ROWS = 9;

/** One numbered row as the screen drew it. */
export interface PaneRow {
  digit: number;
  label: string;
}

/** Put a line into the form the patterns are matched against. */
function strip(line: string): string {
  return line.replace(RE_BORDER, " ");
}

/**
 * Where the select widget's footer starts, or -1.
 *
 * Scans upwards so the LAST footer wins: a session discussing dialogs has the
 * words further up its own scrollback, and the live one is at the bottom.
 */
function footerAt(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    for (let n = 1; n <= FOOTER_WRAP && i + n <= lines.length; n++) {
      const joined = lines
        .slice(i, i + n)
        .map((l) => l.trim())
        .join(" ");
      if (RE_FOOTER.test(joined)) return i;
    }
  }
  return -1;
}

/** A line carrying nothing but the dialog's border — dialog.go blankDialogLine. */
function blankLine(line: string): boolean {
  return strip(line).trim() === "";
}

/** The tab bar or the ☐ header: the dialog's top edge where one is on screen. */
function anchor(line: string): boolean {
  return RE_TAB_BAR.test(line) || RE_HEADER.test(strip(line));
}

/**
 * The first numbered row of the list above the footer, or -1 — sessionio's
 * optionListTop.
 *
 * It walks UP from the footer and stops at the first line that is neither a
 * numbered row nor an indented description belonging to the row above it. That
 * line is the question, and everything above it is somebody's conversation.
 */
function optionListTop(lines: string[], end: number): number {
  let first = -1;
  let rows = 0;
  for (let i = end - 1; i >= 0; i--) {
    const line = strip(lines[i]!);
    if (line.trim() === "" || RE_RULE.test(lines[i]!)) continue;
    if (RE_OPTION.test(line)) {
      first = i;
      rows++;
      continue;
    }
    if (rows === 0) continue; // still between the footer and the list
    if (i > 0 && !RE_TAB_BAR.test(lines[i]!) && lines[i]!.startsWith("  ")) {
      continue; // a description under the row above it — dialog.go numbered
    }
    break;
  }
  return rows === 0 ? -1 : first;
}

/**
 * The last top edge at or above the footer, bounded — sessionio's anchorTop.
 * Only for a screen with no option list under it.
 */
function anchorTop(lines: string[], end: number): number {
  let top = -1;
  for (let i = 0; i <= end && i < lines.length; i++) {
    if (anchor(lines[i]!)) top = i;
  }
  const floor = Math.max(0, end - MAX_REGION_LINES + 1);
  return top >= floor ? top : floor;
}

/**
 * The lines the dialog owns, ending at the footer where there is one.
 *
 * This is sessionio's dialogTop, and the top comes from THE DIALOG'S OWN
 * SHAPE: the option list, the question wrapped above it, and the tab bar or ☐
 * header immediately above that.
 *
 * WHY NOT JUST THE TOP LANDMARK, which was the first cut here. Two panes break
 * it, and the Go hit both. On a phone-sized pane a long question and its
 * options push the tab bar off the top, leaving no landmark and sending the
 * region back to "the 48 lines above the footer" — which on a short pane is
 * the whole capture, conversation included, and that is what puts a numbered
 * list from the conversation in front of the reader as the answers. And a
 * session that QUOTES a tab bar, as this feature's own design doc does, hands
 * the pane a landmark belonging to no dialog.
 *
 * The option list is the better anchor because the dialog cannot exist
 * without it. Only an ADJACENT landmark is taken above the question: one
 * further up, with conversation in between, belongs to something else.
 *
 * TWO DIVERGENCES FROM THE GO, both deliberate.
 *
 * answerRegion returns nothing when a capture has no dialog shape at all,
 * because for the driver that means there is nothing to answer. Screens the
 * parser refused are this component's whole population, so it keeps the
 * bounded tail instead: picker-claude-model.txt has no ☐ anywhere and a footer
 * reading "Enter to set as default", and dropping it would leave the reader a
 * blank card instead of a menu they can press.
 *
 * dialogTop also climbs past the review screen's two title lines so that
 * reviewOnScreen can see the tab bar above them. That check is the server's,
 * and a reply carrying a review screen carries a parsed Dialog rather than a
 * capture, so it never arrives here.
 */
function paneRegion(pane: string): string[] {
  const lines = pane.replace(/\s+$/, "").split("\n");
  const foot = footerAt(lines);
  const end = foot >= 0 ? foot : lines.length - 1;
  if (end < 0) return [];
  const first = optionListTop(lines, end);
  if (first < 0) return lines.slice(anchorTop(lines, end), end + 1);

  let top = first;
  let i = first - 1;
  while (i >= 0 && blankLine(lines[i]!)) i--;
  for (let n = 0; i >= 0 && n < MAX_QUESTION_LINES; i--, n++) {
    if (blankLine(lines[i]!) || RE_RULE.test(lines[i]!) || anchor(lines[i]!)) break;
    top = i;
  }
  while (i >= 0 && (blankLine(lines[i]!) || RE_RULE.test(lines[i]!))) i--;
  if (i >= 0 && anchor(lines[i]!)) top = i;
  return lines.slice(top, end + 1);
}

/**
 * The numbered rows in a region.
 *
 * The numbering has to be the widget's own — 1, 2, 3 in order — which is the
 * check sessionio.answerRows makes for the same reason: a line of prose that
 * happens to start with a digit is not an option, and counting it would shift
 * every digit after it. Two decorations are the CLI's rather than the label's
 * and come off: the trailing period it draws on "Type something." and the
 * trailing tick a revisited question draws on the pick it already has.
 */
function paneRows(region: string[]): PaneRow[] {
  const rows: PaneRow[] = [];
  for (const line of region) {
    if (rows.length >= MAX_ROWS) break;
    const m = RE_OPTION.exec(strip(line));
    if (!m || Number(m[1]) !== rows.length + 1) continue;
    rows.push({ digit: Number(m[1]), label: m[2]!.trim().replace(/[.✔✓\s]+$/, "") });
  }
  return rows;
}

export const PaneKeypad: Component<{
  /** The raw capture, as sessionio.AnswerResponse.Pane sent it. */
  pane: string;
  /** True while a request is in flight. */
  busy: boolean;
  /** Send raw keys. The same allowlist and cap as POST /keys apply server-side. */
  onKeys: (keys: string[]) => Promise<void>;
}> = (props) => {
  const region = createMemo(() => paneRegion(props.pane));
  const rows = createMemo(() => paneRows(region()));

  // Open on the BOTTOM of the capture, which is where the dialog is. A
  // terminal writes downwards, so the top of any window into it is the oldest
  // thing on screen — picker-claude-model.txt puts its banner and eighteen
  // blank lines there, and a card opening on those looks empty while the menu
  // it is showing sits just out of sight.
  let view: HTMLPreElement | undefined;
  createEffect(() => {
    region();
    if (view) view.scrollTop = view.scrollHeight;
  });

  const send = (keys: string[]) => {
    if (props.busy) return;
    void props.onKeys(keys);
  };

  return (
    // A column, so the percentage cap below has a definite height to resolve
    // against and the rows keep their own room whatever the capture's length.
    <div
      class="tl-qcard-body"
      style={{ display: "flex", "flex-direction": "column", "min-height": "0" }}
    >
      {/* The capture takes at most HALF the body, so the rows under it stay
          reachable. Measured at 400x1500 against picker-claude-model.txt:
          uncapped, a 40-line capture filled every pixel `.tl-qcard`'s
          `max-height: min(52%, 420px)` allows, and pushed all four rows and
          both keys out of the card.

          A percentage rather than a pixel cap, and deliberately not a `vh`:
          app.css already carries the measurement that `vh` is wrong for this
          card — on iOS Safari a keyboard shrinks the visual viewport only, so
          `52vh` went on resolving against the whole 844px screen while the
          pane holding the card was 465px. 45% of the body scales with whatever
          the card actually got. */}
      <pre
        class="tl-code"
        ref={view}
        style={{ flex: "0 0 auto", "max-height": "45%", "overflow-y": "auto" }}
      >
        {region().join("\n")}
      </pre>
      <Show when={rows().length > 0}>
        <div class="tl-qcard-options">
          <For each={rows()}>
            {(row) => (
              <button
                type="button"
                class="tl-qcard-option"
                disabled={props.busy}
                onClick={() => send([String(row.digit)])}
              >
                <span class="tl-qcard-key" aria-hidden="true">
                  {row.digit}
                </span>
                <span class="tl-qcard-label">{row.label}</span>
              </button>
            )}
          </For>
        </div>
        {/* Enter and Esc, in the same grammar as the rows above rather than a
            row of their own: `.tl-qcard-options` is a column, so on a phone
            these read as two more things to tap instead of a pair of small
            targets squeezed side by side. */}
        <div class="tl-qcard-options">
          <button
            type="button"
            class="tl-qcard-option"
            disabled={props.busy}
            onClick={() => send(["Enter"])}
          >
            <span class="tl-qcard-key" aria-hidden="true">
              ⏎
            </span>
            <span class="tl-qcard-label">Enter</span>
          </button>
          <button
            type="button"
            class="tl-qcard-option"
            disabled={props.busy}
            onClick={() => send(["Escape"])}
          >
            <span class="tl-qcard-key" aria-hidden="true">
              ⎋
            </span>
            <span class="tl-qcard-label">Esc</span>
          </button>
        </div>
      </Show>
    </div>
  );
};
