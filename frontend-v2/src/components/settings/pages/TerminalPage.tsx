import { createSignal, type Component } from "solid-js";
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
import {
  DEFAULT_TERMINAL_RENDERER,
  flowControlWanted,
  setFlowControlEnabled,
  setTerminalRenderer,
  terminalRenderer,
  type TerminalRenderer,
} from "../../../store/device-prefs";
import { Group, Row, Segmented, Stepper, Toggle } from "../controls";
import type { StepSpec } from "../stepper";

const FONT: StepSpec = { min: FONT_SIZE_MIN, max: FONT_SIZE_MAX, step: 1 };
const LINE: StepSpec = { min: LINE_HEIGHT_MIN, max: LINE_HEIGHT_MAX, step: 0.05 };
const LETTER: StepSpec = { min: LETTER_SPACING_MIN, max: LETTER_SPACING_MAX, step: 0.1 };

/** The two terminals, and what to call them on screen. "Native" and "iframe"
 *  name an implementation; these name the choice a person is making. */
const RENDERERS: readonly TerminalRenderer[] = ["native", "iframe"];
const RENDERER_LABELS: Record<TerminalRenderer, string> = {
  native: "Built in",
  iframe: "Classic",
};

/**
 * Everything that changes how the terminal looks and behaves.
 *
 * Four of the old groups, plus flow control, which used to sit under "This
 * browser" beside diagnostics. Those two were together because both happen to
 * be per-browser rather than because they are related: flow control is a
 * terminal behaviour, so it belongs here, wearing the chip that says where it
 * is stored.
 *
 * Engine joined them at the flip (2026-09-04), and it is the one row on this
 * page that is not cosmetic. It chooses WHICH terminal renders, so it is also
 * the only way back to the iframe on an installed app, where a `?native=0` in
 * the URL never survives the home-screen launch. Per-device for the same reason
 * flow control is: it answers a question about this device.
 *
 * Every row except those two is roamed and read by the terminal page out of the
 * shared-origin prefs doc, so a change reaches the live terminal without a
 * reload. Engine is the exception in the other direction as well: it is read
 * once when a session mounts, so it applies to the next session opened rather
 * than to the one on screen.
 */
export const TerminalPage: Component<{ prefs: PrefsStore }> = (props) => {
  const p = () => props.prefs.prefs();
  const [flowOn, setFlowOn] = createSignal(flowControlWanted());
  // Nothing stored reads as the default rather than as an empty strip: the
  // control has to show which terminal you are getting, and with no choice
  // recorded that is whatever the app defaults to.
  const [renderer, setRenderer] = createSignal<TerminalRenderer>(
    terminalRenderer() ?? DEFAULT_TERMINAL_RENDERER,
  );

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

      <Group title="Engine">
        <Row
          label="Engine"
          deviceOnly
          hint={
            <>
              <b>Built in</b> is the terminal the lobby draws itself, in this
              page. <b>Classic</b> is the older one: its own page inside a
              frame, kept for one release as the way back. Classic still has a
              few things the built-in terminal has not picked up yet: clickable
              links, and A− / A+ resizing without a reload.
            </>
          }
          note="Applies to the next session you open in this tab. Sessions already open keep the terminal they started with until you reload."
        >
          <Segmented
            label="Terminal engine"
            options={RENDERERS}
            value={renderer()}
            format={(r) => RENDERER_LABELS[r]}
            onChange={(r) => {
              setTerminalRenderer(r);
              setRenderer(r);
            }}
          />
        </Row>
      </Group>

      <Group title="Output">
        <Row
          label="Flow control"
          deviceOnly
          hint="Back-pressure that pauses a session flooding output. Turning it off releases a stream that is stuck paused — the terminal picks the change up immediately, no reload."
        >
          <Toggle
            label="Flow control"
            checked={flowOn()}
            onChange={(on) => {
              setFlowControlEnabled(on);
              setFlowOn(on);
            }}
          />
        </Row>
      </Group>
    </>
  );
};
