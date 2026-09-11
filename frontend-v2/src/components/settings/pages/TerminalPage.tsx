import type { Component } from "solid-js";
import {
  BOLD_WEIGHTS,
  CURSOR_STYLES,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LETTER_SPACING_MAX,
  LETTER_SPACING_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  WHEEL_SPEEDS,
  type BoldWeight,
  type CursorStyle,
  type PrefsStore,
  type WheelSpeed,
} from "../../../store/prefs";
import { Group, Row, Segmented, Stepper, Toggle } from "../controls";
import type { StepSpec } from "../stepper";

const FONT: StepSpec = { min: FONT_SIZE_MIN, max: FONT_SIZE_MAX, step: 1 };
const LINE: StepSpec = { min: LINE_HEIGHT_MIN, max: LINE_HEIGHT_MAX, step: 0.05 };
const LETTER: StepSpec = { min: LETTER_SPACING_MIN, max: LETTER_SPACING_MAX, step: 0.1 };

/**
 * Everything that changes how the terminal looks and behaves: Text, Cursor and
 * "Scrolling & links".
 *
 * TWO ROWS HAVE LEFT THIS PAGE, and they left for the same reason. An Engine
 * row chose which of the two terminals rendered, from the flip (2026-09-04)
 * until the deletion (2026-09-05); there is one terminal now, and a segmented
 * control over a single option pretends to offer a choice. A Flow control
 * toggle sat in a group of its own called "Output" until 2026-09-06; the
 * accounting that would have read its key never came across from term.html
 * (SessionView.tsx lists it among what went with that page), so the toggle
 * moved `tl-flow-control` and changed nothing a person could see. Viktor chose
 * removal over a disabled row, on the grounds that a control which does
 * nothing is worse than no control. Removing the row emptied "Output", so the
 * group went too.
 *
 * Neither stored key is migrated or deleted. Both are `tl-` keys, so Clear
 * local data sweeps them, and until then they sit unread: anyone who had
 * picked Classic gets the built-in terminal, and anyone who had turned flow
 * control off gets what they already had, since nothing was reading the answer.
 *
 * EVERY ROW LEFT HERE IS ROAMED, which is why no row on this page wears the
 * "this device" chip any more, and why a change reaches the live terminal
 * without a reload. Font size gets there through the `__tlPrefsLive` receiver
 * TerminalNative installs, which the store calls after it persists
 * (store/prefs.ts). The input-bar posture is the row that still waits for the
 * terminal's next mount, and the reason is on the read.
 */
export const TerminalPage: Component<{ prefs: PrefsStore }> = (props) => {
  const p = () => props.prefs.prefs();

  return (
    <>
      <Group title="Text">
        <Row label="Font size">
          <Stepper
            label="Font size"
            value={p().fontSize}
            spec={FONT}
            unit="px"
            onChange={(v) => props.prefs.setFontSize(v)}
          />
        </Row>
        <Row label="Line height">
          <Stepper
            label="Line height"
            value={p().lineHeight}
            spec={LINE}
            onChange={(v) => props.prefs.setPref({ lineHeight: v })}
          />
        </Row>
        <Row label="Letter spacing">
          <Stepper
            label="Letter spacing"
            value={p().letterSpacing}
            spec={LETTER}
            unit="px"
            onChange={(v) => props.prefs.setPref({ letterSpacing: v })}
          />
        </Row>
        <Row
          label="Bold weight"
          hint="How heavy bold text renders. 600 is easier on a low-resolution screen; 700 is the usual bold."
        >
          <Segmented
            label="Bold weight"
            options={BOLD_WEIGHTS}
            value={p().fontWeightBold}
            onChange={(w) => props.prefs.setPref({ fontWeightBold: w as BoldWeight })}
          />
        </Row>
      </Group>

      <Group title="Cursor">
        <Row label="Shape">
          <Segmented
            label="Cursor shape"
            options={CURSOR_STYLES}
            value={p().cursorStyle}
            onChange={(c) => props.prefs.setPref({ cursorStyle: c as CursorStyle })}
          />
        </Row>
        <Row label="Blink">
          <Toggle
            label="Blink"
            checked={p().cursorBlink}
            onChange={(on) => props.prefs.setPref({ cursorBlink: on })}
          />
        </Row>
      </Group>

      <Group title="Scrolling & links">
        <Row label="Smooth mouse-wheel scrolling">
          <Toggle
            label="Smooth mouse-wheel scrolling"
            checked={p().gestures.wheelSmooth}
            onChange={(on) => props.prefs.setPref({ gestures: { wheelSmooth: on } })}
          />
        </Row>
        <Row
          label="Scroll speed"
          hint="Applies to the smooth scroller, so it does nothing while that is off."
        >
          <Segmented
            label="Scroll speed"
            options={WHEEL_SPEEDS}
            value={p().gestures.wheelSpeed}
            disabled={!p().gestures.wheelSmooth}
            format={(s) => `${s}×`}
            onChange={(s) => props.prefs.setPref({ gestures: { wheelSpeed: s as WheelSpeed } })}
          />
        </Row>
        <Row label="Copy button on terminal links">
          <Toggle
            label="Copy button on terminal links"
            checked={p().links.copyChip}
            onChange={(on) => props.prefs.setPref({ links: { copyChip: on } })}
          />
        </Row>
      </Group>
    </>
  );
};
