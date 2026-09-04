/**
 * The writing surface both composers share.
 *
 * Everything the LIVE composer does with it is already pinned by the nine
 * Composer suites, which pass unchanged through the extraction — that is the
 * point of them. What is asserted here is the seam the extraction opened: the
 * three things the new-session composer needs and a live session never did.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { PromptField } from "../src/components/PromptField";
import { NEW_SESSION_DRAFT_KEY } from "../src/components/NewSessionComposer";
import { DRAFTS_KEY, loadDraft, parkDraft, saveDraft } from "../src/store/drafts";
import { NAME_RE } from "../src/types/lobby";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const sent: string[] = [];
const onSend = async (text: string): Promise<boolean> => {
  sent.push(text);
  return true;
};
beforeEach(() => (sent.length = 0));

const field = (c: HTMLElement) => c.querySelector<HTMLTextAreaElement>("textarea")!;
const type = (el: HTMLTextAreaElement, text: string) => {
  el.value = text;
  fireEvent.input(el, { target: { value: text } });
};

describe("<PromptField> — an empty send", () => {
  it("refuses one by default, which is the live composer", () => {
    const { container } = render(() => <PromptField onSend={onSend} label="Message" />);
    fireEvent.keyDown(field(container), { key: "Enter" });
    expect(sent).toEqual([]);
  });

  it("lets one through when the caller says an empty box means something", () => {
    // Pressing Enter on an empty new-session composer is how you say "just give
    // me a session"; the same keystroke against a live session does nothing
    // anyone asked for.
    const { container } = render(() => (
      <PromptField onSend={onSend} label="Message" allowEmpty />
    ));
    fireEvent.keyDown(field(container), { key: "Enter" });
    expect(sent).toEqual([""]);
  });
});

describe("<PromptField> — the draft it persists under", () => {
  it("restores and clears under whatever key it was handed", () => {
    saveDraft("k7m2q9x4tp0v", { text: "half written", attachments: [], at: 1 });
    const { container } = render(() => (
      <PromptField onSend={onSend} label="Message" draftKey="k7m2q9x4tp0v" />
    ));
    expect(field(container).value).toBe("half written");

    fireEvent.keyDown(field(container), { key: "Enter" });
    expect(sent).toEqual(["half written"]);
    expect(loadDraft("k7m2q9x4tp0v")).toBeNull();
  });

  it("persists nothing at all with no key, which is a field with no session", () => {
    const { container } = render(() => <PromptField onSend={onSend} label="Message" />);
    type(field(container), "typed into nowhere");
    expect(localStorage.getItem(DRAFTS_KEY)).toBeNull();
  });

  it("keeps the new-session draft where no session can reach it", () => {
    // The composer writes for a session that does not exist yet, so its key has
    // to be one no session could ever have. `:` is outside the name charset,
    // which is what makes that true rather than merely unlikely.
    expect(NAME_RE.test(NEW_SESSION_DRAFT_KEY)).toBe(false);

    const { container } = render(() => (
      <PromptField onSend={onSend} label="Message" draftKey={NEW_SESSION_DRAFT_KEY} />
    ));
    type(field(container), "what I want to do");
    expect(loadDraft(NEW_SESSION_DRAFT_KEY)?.text).toBe("what I want to do");
  });
});

describe("<PromptField> — the controls each composer contributes", () => {
  it("puts them in their own bar group, with Send permanently last", () => {
    const { container } = render(() => (
      <PromptField
        onSend={onSend}
        label="Message"
        leftExtra={<button class="tl-left-one" />}
        rightExtra={<button class="tl-right-one" />}
      />
    ));
    const classOf = (sel: string) =>
      Array.from(container.querySelectorAll(`${sel} > *`)).map(
        (e) => (e.className || "").toString().split(" ")[0],
      );
    expect(classOf(".tl-bar-left")).toEqual(["tl-left-one"]);
    expect(classOf(".tl-bar-right")).toEqual(["tl-right-one", "tl-send"]);
  });
});

describe("<PromptField> — a draft parked from outside while it is mounted", () => {
  // A first prompt that could not be delivered is written into the NEW
  // session's draft, and by then this field is the one the person is looking
  // at: it mounted at select() time, seconds before the delivery gave up. The
  // onMount restore has already run, and the persist effect would write over
  // the parked message on the next keystroke.
  it("takes the message the delivery could not send", () => {
    const { container } = render(() => (
      <PromptField onSend={onSend} label="Message" draftKey="k7m2q9x4tp0v" />
    ));
    expect(field(container).value).toBe("");

    parkDraft("k7m2q9x4tp0v", { text: "Fix the deploy", attachments: [], at: 2 });

    expect(field(container).value).toBe("Fix the deploy");
    // And it survives typing, rather than being overwritten by the persist
    // effect on the next keystroke.
    type(field(container), "Fix the deploy now");
    expect(loadDraft("k7m2q9x4tp0v")?.text).toBe("Fix the deploy now");
  });

  it("keeps what was typed in the meantime, on a line of its own", () => {
    const { container } = render(() => (
      <PromptField onSend={onSend} label="Message" draftKey="k7m2q9x4tp0v" />
    ));
    type(field(container), "meanwhile");

    parkDraft("k7m2q9x4tp0v", { text: "Fix the deploy", attachments: [], at: 2 });

    expect(field(container).value).toBe("meanwhile\nFix the deploy");
  });

  it("ignores a park for another session's draft", () => {
    const { container } = render(() => (
      <PromptField onSend={onSend} label="Message" draftKey="k7m2q9x4tp0v" />
    ));
    parkDraft("q4m8vwx2rt5n", { text: "somebody else's", attachments: [], at: 2 });
    expect(field(container).value).toBe("");
  });

  it("brings the attachment chips with it", () => {
    const { container } = render(() => (
      <PromptField onSend={onSend} label="Message" draftKey="k7m2q9x4tp0v" />
    ));
    parkDraft("k7m2q9x4tp0v", {
      text: "look at this",
      attachments: [{ path: "/var/lib/clipboard-store/wizard/k7m2q9x4tp0v/a.png", name: "a.png", kind: "image" }],
      at: 2,
    });
    expect(field(container).value).toBe("look at this");
    expect(container.querySelectorAll(".tl-tray-item").length).toBe(1);
  });
});
