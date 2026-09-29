/**
 * Claude's folder-trust dialog, seen from the Text view.
 *
 * Deployed review round 5 (2026-09-29): with the dialog up the header read
 * "idle" and the conversation "No messages yet.", with the parked prompt in the
 * field and nothing saying Claude was blocked; the only word was a toast. No
 * card answers the dialog, so the view says so in a band above the composer,
 * with the Terminal one press away, and the header reads "waiting for you".
 */
import { describe, it, expect, vi } from "vitest";
import { render, waitFor, fireEvent } from "@solidjs/testing-library";
import { TextView } from "../src/components/TextView";
import { trustDialogUp } from "../src/lib/first-prompt";

const TRUST_PANE = `
 Quick safety check: Is this a project you
 created or one you trust?

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;

describe("trustDialogUp", () => {
  it("reads the dialog off the pane", () => {
    expect(trustDialogUp(TRUST_PANE)).toBe(true);
  });

  it("does not read the conversation quoting it over an input box", () => {
    const quoted =
      '● It shows "No, exit" and "Yes, I trust this folder".\n' +
      "╭────╮\n│ >  │\n╰────╯\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n";
    expect(trustDialogUp(quoted)).toBe(false);
  });
});

describe("<TextView> with the trust dialog on the pane", () => {
  it("says Claude is waiting on it, and offers the Terminal", async () => {
    const onOpenTerminal = vi.fn();
    const onLiveState = vi.fn();
    const { container } = render(() => (
      <TextView
        events={[]}
        pending={[]}
        harness="claude"
        onSend={async () => true}
        onStop={() => {}}
        onResolve={() => {}}
        onPane={async () => ({ pane: TRUST_PANE, state: "done" })}
        onOpenTerminal={onOpenTerminal}
        onLiveState={onLiveState}
      />
    ));
    await waitFor(() => expect(container.querySelector(".tl-trust-band")).not.toBeNull(), {
      timeout: 2000,
    });
    expect(container.querySelector(".tl-trust-band")!.textContent).toMatch(/trust this folder/);
    fireEvent.click(container.querySelector(".tl-trust-band button")!);
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onLiveState).toHaveBeenLastCalledWith("awaiting"));
  });
});
