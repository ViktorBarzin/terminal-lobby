/**
 * A toast can carry one action, which is how the phone offers Undo after a
 * swipe closes a session (2026-11-23). Pressing it runs the action and takes
 * the toast away.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@solidjs/testing-library";
import { Toaster } from "../src/components/Toaster";
import { createToastController } from "../src/store/toast";

describe("a toast with an action", () => {
  it("draws the action as a button that runs it and dismisses the toast", () => {
    const controller = createToastController();
    const run = vi.fn();
    controller.push({ kind: "info", message: "Closed “alpha”", action: { label: "Undo", run } });
    const { getByRole, queryByText } = render(() => <Toaster controller={controller} />);

    fireEvent.click(getByRole("button", { name: "Undo" }));

    expect(run).toHaveBeenCalledOnce();
    expect(queryByText("Closed “alpha”")).toBeNull();
    controller.dispose();
  });
});
