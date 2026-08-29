import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { Composer } from "../src/components/Composer";
import { installImageClipboard } from "../src/clipboard/attach";

const noop = () => {};
/** the default onSend contract: the send reached the session. */
const sent = async (): Promise<boolean> => true;

describe("<Composer> — send routing", () => {
  it("desktop (no sendToTerminal): Enter calls onSend with the trimmed text", async () => {
    const onSend = vi.fn(sent);
    const { getByLabelText } = render(() => (
      <Composer
        working={false}
        pending={[]}
        onSend={onSend}
        onStop={noop}
        onResolve={noop}
      />
    ));
    const ta = getByLabelText("Message to send to the session") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "  hello world  " } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("hello world");
    await Promise.resolve();
    expect(ta.value).toBe(""); // cleared after send
  });

  // Sending used to fork on a coarse pointer and post the bytes into the
  // terminal IFRAME. In Text mode that iframe has not attached — the attach is
  // lazy — so the post was dropped, the field was cleared, and the message went
  // nowhere: type on a phone, press send, watch the text vanish. There is one
  // route now, on every device.
  it("sends through the control channel even when a pty bridge is offered", async () => {
    const sendToTerminal = vi.fn();
    const onSend = vi.fn(sent);
    const { getByLabelText } = render(() => (
      <Composer
        working={false}
        pending={[]}
        onSend={onSend}
        onStop={noop}
        onResolve={noop}
        sendToTerminal={sendToTerminal}
      />
    ));
    const ta = getByLabelText("Message to send to the session") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "  hello there  " } });
    fireEvent.keyDown(ta, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("hello there");
    expect(sendToTerminal).not.toHaveBeenCalled();
    expect(ta.value).toBe("");
  });

  it("sends a multiline message as one whole message", async () => {
    const onSend = vi.fn(sent);
    const { getByLabelText } = render(() => (
      <Composer working={false} pending={[]} onSend={onSend} onStop={noop} onResolve={noop} />
    ));
    const ta = getByLabelText("Message to send to the session") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "first\nsecond\nthird" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    // The newlines stay INSIDE one message; the server's injector is what turns
    // it into a bracketed paste plus a separate submit (sessionio.Injector).
    expect(onSend).toHaveBeenCalledWith("first\nsecond\nthird");
  });

  it("Shift+Enter does NOT submit (soft newline in the field)", () => {
    const onSend = vi.fn(sent);
    const sendToTerminal = vi.fn();
    const { getByLabelText } = render(() => (
      <Composer
        working={false}
        pending={[]}
        onSend={onSend}
        onStop={noop}
        onResolve={noop}
        sendToTerminal={sendToTerminal}
      />
    ));
    const ta = getByLabelText("Message to send to the session") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "half" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(sendToTerminal).not.toHaveBeenCalled();
  });

  it("empty / whitespace-only input never sends", () => {
    const onSend = vi.fn(sent);
    const { getByLabelText } = render(() => (
      <Composer
        working={false}
        pending={[]}
        onSend={onSend}
        onStop={noop}
        onResolve={noop}
      />
    ));
    const ta = getByLabelText("Message to send to the session") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "   " } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("carries the mobile iOS input attributes (QuickType-friendly)", () => {
    const { getByLabelText } = render(() => (
      <Composer working={false} pending={[]} onSend={sent} onStop={noop} onResolve={noop} />
    ));
    const ta = getByLabelText("Message to send to the session") as HTMLTextAreaElement;
    expect(ta.getAttribute("autocapitalize")).toBe("off");
    expect(ta.getAttribute("autocorrect")).toBe("on");
    expect(ta.getAttribute("enterkeyhint")).toBe("send");
    // autocomplete is DELIBERATELY absent (setting it 'off' kills iOS QuickType).
    expect(ta.hasAttribute("autocomplete")).toBe(false);
  });
});

/**
 * An uploaded image's path is typed onto the pty input line by
 * installImageClipboard, and the message the operator then sends must not fuse
 * with it into one token. The composer's own send goes through the control
 * channel, so what this pins down is the SPACING contract of the path emitter:
 * the path arrives with its trailing space, whatever sends next.
 */
describe("<Composer> — an image path already on the line", () => {
  it("leaves the pasted path ending in a separator", async () => {
    const STORE = "/var/lib/clipboard-store/wizard/qa-sess";
    let line = "";
    const clip = installImageClipboard({
      session: () => "qa-sess",
      sendToPty: (t: string) => {
        line += t;
        return true;
      },
      upload: async () => ({ path: `${STORE}/pasted.png`, stored: true }),
      toast: () => 0,
      dismiss: () => {},
    });
    const pasteEv = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEv, "clipboardData", {
      value: {
        items: [
          {
            type: "image/png",
            getAsFile: () => new File([new Uint8Array([1])], "s.png", { type: "image/png" }),
          },
        ],
      },
    });
    document.dispatchEvent(pasteEv);
    await vi.waitFor(() => expect(line).not.toBe(""));
    clip.dispose();

    expect(line).toBe(`${STORE}/pasted.png `);
    expect(line.endsWith(" ")).toBe(true);
  });
});

/**
 * An IME (Japanese, Chinese, Korean, and iOS/WebKit autocomplete) delivers the
 * candidate-commit key as `keydown` with `key === "Enter"` and
 * `isComposing === true`. Committing a candidate must NOT send the message —
 * the user is still choosing the word. `KeyboardEvent.isComposing` is the
 * standard guard for exactly this.
 *
 * Composer ships the mobile/PWA input subsystem (mobile/compose.ts, SoftKeys,
 * the QuickType-friendly textarea attributes) aimed at the population that hits
 * this daily.
 */
describe("<Composer> — Enter during IME composition", () => {
  const mount = (extra: { sendToTerminal?: (b: string) => void } = {}) => {
    const onSend = vi.fn(sent);
    const { getByLabelText } = render(() => (
      <Composer
        working={false}
        pending={[]}
        onSend={onSend}
        onStop={noop}
        onResolve={noop}
        {...extra}
      />
    ));
    const ta = getByLabelText(
      "Message to send to the session",
    ) as HTMLTextAreaElement;
    return { onSend, ta };
  };

  it("does not submit, and keeps the candidate text in the field", () => {
    const { onSend, ta } = mount();
    fireEvent.input(ta, { target: { value: "にほんご" } });
    fireEvent.keyDown(ta, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(ta.value).toBe("にほんご");
  });

  it("does not fire the mobile pty frames either", () => {
    const sendToTerminal = vi.fn();
    const { onSend, ta } = mount({ sendToTerminal });
    fireEvent.input(ta, { target: { value: "にほんご" } });
    fireEvent.keyDown(ta, { key: "Enter", isComposing: true });
    expect(sendToTerminal).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(ta.value).toBe("にほんご");
  });

  it("a plain Enter after the composition ends still submits", () => {
    const { onSend, ta } = mount();
    fireEvent.input(ta, { target: { value: "にほんご" } });
    fireEvent.keyDown(ta, { key: "Enter", isComposing: true }); // commit
    fireEvent.keyDown(ta, { key: "Enter" }); // send
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("にほんご");
  });
});

/**
 * A prompt the session cannot deliver (a 502 from the injector, a dead session)
 * used to be destroyed: submit cleared the textarea by writing the DOM
 * ref directly, and no state anywhere else held the text. The composer now
 * clears optimistically and puts the text BACK when the send is refused — so a
 * rejected prompt is retryable instead of retyped.
 */
describe("<Composer> — a refused send keeps the typed text", () => {
  const typeAndSend = (
    onSend: (t: string) => Promise<boolean>,
  ): HTMLTextAreaElement => {
    const { getByLabelText } = render(() => (
      <Composer
        working={false}
        pending={[]}
        onSend={onSend}
        onStop={noop}
        onResolve={noop}
      />
    ));
    const ta = getByLabelText("Message to send to the session") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "the long prompt I do not want to retype" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    return ta;
  };

  it("restores the text when the send is refused", async () => {
    const ta = typeAndSend(async () => false);
    await Promise.resolve();
    await Promise.resolve();
    expect(ta.value).toBe("the long prompt I do not want to retype");
  });

  it("leaves the field empty when the send succeeds", async () => {
    const ta = typeAndSend(async () => true);
    await Promise.resolve();
    await Promise.resolve();
    expect(ta.value).toBe("");
  });

  it("does not clobber a new message typed while the send was in flight", async () => {
    let settle: (ok: boolean) => void = () => {};
    const ta = typeAndSend(() => new Promise<boolean>((r) => (settle = r)));
    expect(ta.value).toBe(""); // cleared optimistically
    fireEvent.input(ta, { target: { value: "something else" } });
    settle(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(ta.value).toBe("something else");
  });
});
