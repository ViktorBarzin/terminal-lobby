import { Show, onMount, type Component } from "solid-js";
import type { PrefsStore } from "../../../store/prefs";
import type { NotificationSystem } from "../../../notify/notifications";
import { ActionRow, Group, Readout, Row, Toggle } from "../controls";

const PERMISSION_LABEL: Record<string, string> = {
  granted: "granted",
  denied: "denied",
  unsupported: "unsupported",
};

/**
 * What gets sent, plus what this particular device is actually set up to
 * receive.
 *
 * The two toggles roam; everything under them is about the browser you are
 * looking at, because push registration is per device and per browser. Keeping
 * the readouts on the same page as the toggles is deliberate: "I turned it on
 * and got nothing" is answered by the three lines under them.
 */
export const NotificationsPage: Component<{
  prefs: PrefsStore;
  notifications?: NotificationSystem;
}> = (props) => {
  const notify = () => props.prefs.prefs().notify;

  // Async: it compares this browser's live push endpoint against the server's
  // stored list, so it cannot be read synchronously on mount of the panel.
  onMount(() => void props.notifications?.refreshDeviceState());

  return (
    <>
      <Group title="Send a notification">
        <Row label="When a session finishes">
          <Toggle
            label="When a session finishes"
            checked={notify().onDone}
            onChange={(on) => props.prefs.setPref({ notify: { onDone: on } })}
          />
        </Row>
        <Row label="When a session needs input">
          <Toggle
            label="When a session needs input"
            checked={notify().onAwaiting}
            onChange={(on) => props.prefs.setPref({ notify: { onAwaiting: on } })}
          />
        </Row>
      </Group>

      <Show when={props.notifications}>
        {(n) => (
          <Group title="This device">
            <div class="tl-set-readouts">
              <Readout
                label="Permission"
                value={PERMISSION_LABEL[n().permission()] ?? "not set"}
              />
              <Readout label="Subscribed here" value={n().deviceState()} />
              <Readout label="Bell" value={n().bellOn() ? "on" : "off"} />
            </div>
            <ActionRow
              label="Send a test"
              hint="Push is per device and per browser — enable the bell on each device you want notified."
              deviceOnly
            >
              <button
                type="button"
                class="tl-set-btn"
                title="Show a notification on THIS device only — no server. If nothing appears while permission is granted, your OS/browser is blocking notifications for this site."
                onClick={() => void n().testHere()}
              >
                This device
              </button>
              <button
                type="button"
                class="tl-set-btn"
                title="Send a real push through the server to EVERY device registered under your account (phones included)."
                onClick={() => void n().testAll()}
              >
                All devices
              </button>
            </ActionRow>
          </Group>
        )}
      </Show>
    </>
  );
};
