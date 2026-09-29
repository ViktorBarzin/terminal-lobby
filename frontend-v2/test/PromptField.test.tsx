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
import { trackPrompt } from "../src/lib/leaving";

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

describe("<PromptField> — Send, while there is nothing to send", () => {
  const send = (c: HTMLElement) => c.querySelector<HTMLButtonElement>(".tl-send")!;

  // The refusal above is silent on Enter. The round button puts it on the
  // control, before it is pressed, on every composer since the T3 pass
  // (2026-09-27): greyed while the field is empty and nothing runs. On the
  // new-session composer that is what says Enter will not create a session.
  it("draws it unavailable until there is something to send", () => {
    const { container } = render(() => <PromptField onSend={onSend} label="Message" />);
    expect(send(container).disabled).toBe(true);
    type(field(container), "fix the deploy");
    expect(send(container).disabled).toBe(false);
    type(field(container), "  ");
    expect(send(container).disabled).toBe(true);
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
    const { container } = render(() => <PromptField onSend={onSend} label="Message" noPlus />);
    expect(container.querySelector(".tl-plus")).toBeNull();
    expect(
      container.querySelector(".tl-pill")!.firstElementChild!.classList.contains("tl-field"),
    ).toBe(true);
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
    expect(field(container).value).toBe("look at this [img: a.png] ");
    expect(container.querySelectorAll(".tl-inline-chip").length).toBe(1);
  });
});

/**
 * Deployed review round 2 (2026-09-28): a send to a suspended session is held
 * 5-6 s while Claude wakes. A reload inside that window cut the prompt's
 * request off, the send read that as a refusal and the field put the words
 * back and saved them as the draft just before the page went. The server had
 * the prompt: after the reload Claude answered it and the same words sat in
 * the field with Send armed. A prompt request the page left behind may well
 * have landed, so its words do not come back. A send cut off before any prompt
 * request went out (still waking the session) was never delivered, and its
 * words still come back.
 */
describe("<PromptField> — a send the page leaves behind", () => {
  const cutOff = (tracked: boolean) => {
    let fail: () => void = () => {};
    const gate = new Promise<boolean>((_, reject) => {
      fail = () => reject(new TypeError("Failed to fetch"));
    });
    const send = (): Promise<boolean> => (tracked ? trackPrompt(gate) : gate).catch(() => false);
    return { send, fail: () => fail() };
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  // Chromium rejects the request right after beforeunload, before pagehide
  // (measured on the local build, 2026-09-28: beforeunload at 3608 ms, the
  // rejection at 3619, pagehide at 3645). iOS Safari fires no beforeunload.
  it.each(["beforeunload", "pagehide"])(
    "does not bring back words whose prompt request was in flight (%s)",
    async (going) => {
      const s = cutOff(true);
      const { container } = render(() => (
        <PromptField onSend={s.send} label="Message" draftKey="k7m2q9x4tp0v" />
      ));
      type(field(container), "reply with mango");
      fireEvent.keyDown(field(container), { key: "Enter" });
      window.dispatchEvent(new Event(going));
      s.fail();
      await settle();
      expect(field(container).value).toBe("");
      expect(loadDraft("k7m2q9x4tp0v")).toBeNull();
    },
  );

  it("brings back words that never left, and words refused while the page stays", async () => {
    const early = cutOff(false);
    const a = render(() => (
      <PromptField onSend={early.send} label="Message" draftKey="k7m2q9x4tp0v" />
    ));
    type(field(a.container), "reply with kiwi");
    fireEvent.keyDown(field(a.container), { key: "Enter" });
    window.dispatchEvent(new Event("pagehide"));
    early.fail();
    await settle();
    expect(field(a.container).value).toBe("reply with kiwi");
    a.unmount();
    localStorage.clear();

    const refused = cutOff(true);
    const b = render(() => (
      <PromptField onSend={refused.send} label="Message" draftKey="k7m2q9x4tp0v" />
    ));
    type(field(b.container), "reply with pear");
    fireEvent.keyDown(field(b.container), { key: "Enter" });
    refused.fail();
    await settle();
    expect(field(b.container).value).toBe("reply with pear");
  });
});

describe("<PromptField> — @ completion after an Escape", () => {
  const options = (c: HTMLElement) =>
    Array.from(c.querySelectorAll(".tl-complete-item")).map((o) => o.textContent ?? "");
  const settle = () => new Promise((r) => setTimeout(r, 0));

  // Deployed review round 2 of the T3 pass (2026-09-29): one Escape on the @
  // menu emptied the listing but kept the note of which folder it was for, so
  // no later @ in that folder fetched it again and the menu never reopened,
  // not even after a trip to the Terminal view and back.
  it("opens again on the next @ in the same folder", async () => {
    const asked: string[] = [];
    const onListDir = async (dir: string) => {
      asked.push(dir);
      return ["alpha.txt", "sub/"];
    };
    const { container } = render(() => (
      <PromptField onSend={onSend} label="Message" onListDir={onListDir} />
    ));
    const ta = field(container);
    type(ta, "@");
    await settle();
    expect(options(container).some((o) => o.includes("@alpha.txt"))).toBe(true);

    fireEvent.keyDown(ta, { key: "Escape" });
    expect(options(container)).toEqual([]);

    type(ta, "");
    type(ta, "@");
    await settle();
    expect(options(container).some((o) => o.includes("@alpha.txt"))).toBe(true);

    type(ta, "hello @al");
    await settle();
    expect(options(container).some((o) => o.includes("@alpha.txt"))).toBe(true);
  });
});
