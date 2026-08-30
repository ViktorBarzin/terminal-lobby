import { createSignal, type Component } from "solid-js";
import { toasts } from "../../../store/toast";
import { clearLocalData } from "../../../store/device-prefs";
import { diagnosticsWanted, setDiagnosticsEnabled } from "../../../telemetry/diag";
import { ActionRow, Group, Row, Toggle } from "../controls";

/**
 * The two rows where what happens next matters more than what the control is.
 *
 * Both keep their text in the page rather than behind the ⓘ: one states the
 * boundary of what leaves this browser, the other says what is about to be
 * removed. An explanation one click away is one some people will not read, and
 * these are the two where not reading it has a cost.
 */
export const PrivacyPage: Component<{
  /** confirm seam for Clear local data (tests inject it). */
  confirm?: (message: string) => boolean;
  /** reload seam for Clear local data (tests inject it). */
  onCleared?: () => void;
}> = (props) => {
  const [diagOn, setDiagOn] = createSignal(diagnosticsWanted());
  const [alsoRoamed, setAlsoRoamed] = createSignal(false);
  const [clearing, setClearing] = createSignal(false);

  const confirmFn = () => props.confirm ?? ((m: string) => window.confirm(m));

  const doClear = async (): Promise<void> => {
    const ok = confirmFn()(
      "Clear this browser's terminal-lobby data (theme, font size, sidebar " +
        "layout, gestures, notification opt-in)" +
        (alsoRoamed() ? " AND reset the settings that roam to your other devices" : "") +
        ", then reload?\n\nYour tmux sessions are not affected.",
    );
    if (!ok) return;
    setClearing(true);
    await clearLocalData({
      alsoRoamed: alsoRoamed(),
      onError: (m) => toasts.push({ kind: "error", message: m }),
      ...(props.onCleared ? { reload: props.onCleared } : {}),
    });
  };

  return (
    <>
      <Group title="Diagnostics">
        <Row
          label="Send diagnostics"
          deviceOnly
          note="Lobby timings, failures and device info. Never terminal contents, keystrokes or session names."
        >
          <Toggle
            label="Send diagnostics"
            checked={diagOn()}
            onChange={(on) => {
              setDiagnosticsEnabled(on);
              setDiagOn(on);
            }}
          />
        </Row>
      </Group>

      <Group title="Reset">
        <Row label="Also reset settings that roam to your other devices">
          <Toggle
            label="Also reset settings that roam to your other devices"
            checked={alsoRoamed()}
            onChange={setAlsoRoamed}
          />
        </Row>
        <ActionRow
          label="Clear local data"
          deviceOnly
          note="Removes this browser's saved theme, font size, sidebar layout, gestures and notification opt-in, then reloads. Your tmux sessions are not affected."
        >
          <button
            type="button"
            class="tl-set-btn tl-set-btn-danger"
            disabled={clearing()}
            onClick={() => void doClear()}
          >
            Clear local data
          </button>
        </ActionRow>
      </Group>
    </>
  );
};
