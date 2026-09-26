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
import { PromptField, type PromptFieldSinks } from "../src/components/PromptField";
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

  it("refuses whitespace, which is nothing typed with the shift key down", () => {
    const { container } = render(() => <PromptField onSend={onSend} label="Message" />);
    type(field(container), "   ");
    fireEvent.keyDown(field(container), { key: "Enter" });
    expect(sent).toEqual([]);
  });
});

describe("<PromptField> — Send, when the caller needs something in the box", () => {
  const send = (c: HTMLElement) => c.querySelector<HTMLButtonElement>(".tl-send")!;

  // The refusal above is silent, and silence is only tolerable where nothing
  // was going to happen anyway. On the new-session composer Enter CREATES the
  // session, so a keystroke that does nothing reads as the app being broken.
  // `sendNeedsInput` puts the refusal on the control, before it is pressed.
  it("draws it unavailable until there is something to send", () => {
    const { container } = render(() => (
      <PromptField onSend={onSend} label="Message" sendNeedsInput />
    ));
    expect(send(container).disabled).toBe(true);
    type(field(container), "fix the deploy");
    expect(send(container).disabled).toBe(false);
    type(field(container), "  ");
    expect(send(container).disabled).toBe(true);
  });

  it("leaves it available by default, which is the live composer", () => {
    const { container } = render(() => <PromptField onSend={onSend} label="Message" />);
    expect(send(container).disabled).toBe(false);
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

/**
 * The pill: `+` first, Send last, the field between.
 *
 * Each composer used to hand its own controls in through `leftExtra` and
 * `rightExtra`, which landed in the two groups of a bar under the field. The
 * Quiet line composer (2026-09-24) moved those controls to a line of dials
 * above the pill, which each composer draws itself, so the field takes no
 * controls from outside any more.
 */
describe("<PromptField>: the pill", () => {
  it("puts + first and Send last, with the field between", () => {
    const { container } = render(() => <PromptField onSend={onSend} label="Message" />);
    const pill = container.querySelector(".tl-pill")!;
    expect(pill.firstElementChild!.classList.contains("tl-plus")).toBe(true);
    const end = pill.lastElementChild!;
    expect(end.classList.contains("tl-pill-end")).toBe(true);
    expect(end.lastElementChild!.classList.contains("tl-send")).toBe(true);
  });

  it("drops the + for a field that takes nothing but words", () => {
    const { container } = render(() => <PromptField onSend={onSend} label="Message" noTray />);
    expect(container.querySelector(".tl-plus")).toBeNull();
    expect(
      container.querySelector(".tl-pill")!.firstElementChild!.classList.contains("tl-field"),
    ).toBe(true);
  });
});

/**
 * Sending another way, on the field's own terms.
 *
 * The plan card's "Approve with this feedback" sends the composer's text by a
 * route of its own. It goes through the field, so the text is composed,
 * cleared and restored exactly as Send does it: never cleared without either a
 * confirmed send or a restore (memory #11256).
 */
describe("<PromptField>: the sinks a card outside it can use", () => {
  const mountWithSinks = () => {
    let sinks: PromptFieldSinks | undefined;
    const r = render(() => (
      <PromptField onSend={onSend} label="Message" register={(s) => (sinks = s)} />
    ));
    return { ...r, sinks: () => sinks! };
  };

  it("says whether there is anything to send, as it is typed", () => {
    const { container, sinks } = mountWithSinks();
    expect(sinks().hasInput()).toBe(false);
    type(field(container), "change step 2");
    expect(sinks().hasInput()).toBe(true);
    type(field(container), "   ");
    expect(sinks().hasInput()).toBe(false);
  });

  it("sends through the route it is handed, not through Send's", async () => {
    const { container, sinks } = mountWithSinks();
    type(field(container), "approve, but keep the tests");
    const via: string[] = [];
    const ok = await sinks().submitVia(async (t) => {
      via.push(t);
      return true;
    });
    expect(ok).toBe(true);
    expect(via).toEqual(["approve, but keep the tests"]);
    expect(sent).toEqual([]);
    expect(field(container).value).toBe("");
  });

  it("puts the text back when that route refuses, or throws", async () => {
    const { container, sinks } = mountWithSinks();
    type(field(container), "keep me");
    expect(await sinks().submitVia(async () => false)).toBe(false);
    expect(field(container).value).toBe("keep me");
    expect(
      await sinks().submitVia(async () => {
        throw new Error("gone");
      }),
    ).toBe(false);
    expect(field(container).value).toBe("keep me");
  });

  it("sends nothing, and says so, when there is nothing written", async () => {
    const { sinks } = mountWithSinks();
    let called = false;
    expect(
      await sinks().submitVia(async () => {
        called = true;
        return true;
      }),
    ).toBe(false);
    expect(called).toBe(false);
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

  // A parked first prompt carries its paths in the text, so it arrives with no
  // attachments of its own. One that does bring them — anything else that parks
  // — gets them anchored into the message rather than shown in a tray that no
  // longer exists.
  it("brings the attachment chips with it", () => {
    const { container } = render(() => (
      <PromptField onSend={onSend} label="Message" draftKey="k7m2q9x4tp0v" />
    ));
    parkDraft("k7m2q9x4tp0v", {
      text: "look at this",
      attachments: [
        {
          path: "/var/lib/clipboard-store/wizard/k7m2q9x4tp0v/a.png",
          name: "a.png",
          kind: "image",
        },
      ],
      at: 2,
    });
    expect(field(container).value).toBe("look at this [img: a.png]");
    expect(container.querySelectorAll(".tl-inline-chip").length).toBe(1);
  });
});
