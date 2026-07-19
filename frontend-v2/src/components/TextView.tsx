import { type Component } from "solid-js";
import type { Event, PermissionDecision } from "../types/events";
import type { PendingPermission } from "./timeline.logic";
import { MessagesTimeline } from "./MessagesTimeline";
import { Composer } from "./Composer";

/**
 * Text mode — the PRIMARY view. Structured transcript render (MessagesTimeline)
 * above a composer with the docked permission panel.
 */
export const TextView: Component<{
  events: Event[];
  working: boolean;
  pending: PendingPermission[];
  onSend: (text: string) => void;
  onStop: () => void;
  onResolve: (reqId: string, decision: PermissionDecision) => void;
  /** Mobile: forward composed bytes to the live pty (bracketed paste + submit). */
  sendToTerminal?: (bytes: string) => void;
  /** open a file path in the preview overlay (transcript Read/Edit/Write rows). */
  onOpenPreview?: (path: string) => void;
}> = (props) => {
  return (
    <div class="tl-textview">
      <MessagesTimeline events={props.events} onOpenPreview={props.onOpenPreview} />
      <Composer
        working={props.working}
        pending={props.pending}
        onSend={props.onSend}
        onStop={props.onStop}
        onResolve={props.onResolve}
        sendToTerminal={props.sendToTerminal}
      />
    </div>
  );
};
