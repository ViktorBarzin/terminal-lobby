import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { Composer } from "../src/components/Composer";
import { BRACKET_END, BRACKET_START } from "../src/mobile/compose";
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

  it("mobile (sendToTerminal): sends a bracketed paste THEN a separate submit", () => {
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
    fireEvent.input(ta, { target: { value: "run this" } });
    fireEvent.keyDown(ta, { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();
    expect(sendToTerminal).toHaveBeenCalledTimes(2);
    expect(sendToTerminal).toHaveBeenNthCalledWith(
      1,
      `${BRACKET_START}run this${BRACKET_END}`,
    );
    expect(sendToTerminal).toHaveBeenNthCalledWith(2, "\r");
    expect(ta.value).toBe("");
  });

  it("mobile: a multiline message stays ONE bracketed paste (soft newlines)", () => {
    const sendToTerminal = vi.fn();
    const { getByLabelText } = render(() => (
      <Composer
        working={false}
        pending={[]}
        onSend={sent}
        onStop={noop}
        onResolve={noop}
        sendToTerminal={sendToTerminal}
      />
    ));
    const ta = getByLabelText("Message to send to the session") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "line 1\nline 2" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    // Both lines in one paste; the CR (submit) is the SEPARATE second frame.
    expect(sendToTerminal).toHaveBeenNthCalledWith(
      1,
      `${BRACKET_START}line 1\nline 2${BRACKET_END}`,
    );
    expect(sendToTerminal).toHaveBeenNthCalledWith(2, "\r");
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
 * On a coarse pointer the composer sends through the pty bridge, not through
 * /prompt — so the inject-side of the paste-glue bug has a SECOND path. This
 * models the pty input line: an uploaded image path is typed at it and left
 * there (installImageClipboard), then the mobile branch's bracketed paste lands
 * at the cursor. The two must not fuse into one token.
 */
describe("<Composer> — mobile send onto a line that already holds an image path", () => {
  it("appends the prompt as its own token after the pasted path", async () => {
    const STORE = "/var/lib/clipboard-store/wizard/qa-sess";
    let line = ""; // the pty input line

    // 1. the image paste types its path at the line (the real emitter)
    const clip = installImageClipboard({
      session: () => "qa-sess",
      sendToPty: (t: string) => {
        line += t;
        return true;
      },
      upload: async () => `${STORE}/pasted.png`,
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

    // 2. the mobile composer sends through the same pty bridge
    const { getByLabelText } = render(() => (
      <Composer
        working={false}
        pending={[]}
        onSend={sent}
        onStop={noop}
        onResolve={noop}
        sendToTerminal={(bytes) => {
          // the terminal inserts a bracketed paste's CONTENT at the cursor;
          // the trailing \r submits the line.
          if (bytes === "\r") return;
          line += bytes.replace(BRACKET_START, "").replace(BRACKET_END, "");
        }}
      />
    ));
    const ta = getByLabelText("Message to send to the session") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "what colour is this" } });
    fireEvent.keyDown(ta, { key: "Enter" });

    expect(line).toBe(`${STORE}/pasted.png what colour is this`);
    expect(line).not.toContain(".pngwhat");
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
 * A prompt the session refuses (409 "a turn is already running", a 502, a dead
 * session) used to be destroyed: submit cleared the textarea by writing the DOM
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
