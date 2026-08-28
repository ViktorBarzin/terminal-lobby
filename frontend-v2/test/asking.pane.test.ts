/**
 * The question the PANE reports, for the window where the transcript has not
 * caught up.
 *
 * Claude Code does not always write the AskUserQuestion record while its dialog
 * is up — two of five consecutive calls in one session were written only when
 * the question was answered, 112 s later in one case (measured 2026-08-28). The
 * server reads the pane for those and reports it as a `meta: "asking"` event;
 * the transcript still wins whenever it holds the call.
 */
import { describe, it, expect } from "vitest";
import { askingFromPane, deriveRows, pendingQuestion } from "../src/components/timeline.logic";
import type { Event } from "../src/types/events";

let id = 0;
const asking = (body: string): Event =>
  ({ id: ++id, kind: "meta", meta: "asking", body, session: "qa" }) as unknown as Event;

const dialog = JSON.stringify({
  questions: [
    {
      question: "Which colour should the badge be?",
      header: "Colour",
      multiSelect: false,
      options: [{ label: "Red", description: "Make it red." }, { label: "Blue", description: "" }],
    },
  ],
  count: 1,
});

describe("askingFromPane", () => {
  it("reports the question the pane is showing", () => {
    const a = askingFromPane([asking(dialog)]);
    expect(a?.questions[0]?.question).toBe("Which colour should the badge be?");
    expect(a?.questions[0]?.options.map((o) => o.label)).toEqual(["Red", "Blue"]);
    expect(a?.partial).toBe(false);
  });

  it("lets go the moment the dialog does", () => {
    expect(askingFromPane([asking(dialog), asking("")])).toBeNull();
  });

  it("keeps only the newest reading", () => {
    const other = JSON.stringify({
      questions: [{ question: "Which shape?", header: "Shape", multiSelect: false, options: [{ label: "Circle", description: "" }] }],
      count: 1,
    });
    expect(askingFromPane([asking(dialog), asking(other)])?.questions[0]?.question).toBe("Which shape?");
  });

  it("carries the headers of a call the pane can only show one question of", () => {
    const multi = JSON.stringify({
      questions: [{ question: "Pick fruits", header: "", multiSelect: true, options: [{ label: "Apple", description: "" }] }],
      headers: ["Fruit", "Drink"],
      count: 2,
      partial: true,
    });
    const a = askingFromPane([asking(multi)]);
    expect(a?.partial).toBe(true);
    expect(a?.headers).toEqual(["Fruit", "Drink"]);
    expect(a?.count).toBe(2);
  });

  it("ignores a body that is not a dialog", () => {
    expect(askingFromPane([asking("not json")])).toBeNull();
    expect(askingFromPane([asking("{}")])).toBeNull();
  });

  it("does not put a row in the transcript", () => {
    const rows = deriveRows([asking(dialog)]);
    expect(rows.filter((r) => r.kind === "question")).toHaveLength(0);
    expect(pendingQuestion(rows)).toBeNull();
  });
});

/**
 * A reading is only good while nothing has happened since.
 *
 * Same rule the transcript's own questions follow: a question is being asked
 * only while it is the last thing that happened. The server withdraws a reading
 * when the dialog goes, but a client that reconnects mid-flight, or a server a
 * tick behind, must not dock a card over a question the session has moved past.
 */
describe("a reading the session has moved past", () => {
  const after = (kind: string): Event =>
    ({ id: ++id, kind, session: "qa", body: "" }) as unknown as Event;

  it("is dropped once the transcript shows the session moved on", () => {
    for (const kind of ["tool_result", "text", "turn_end", "user"]) {
      expect(askingFromPane([asking(dialog), after(kind)])).toBeNull();
    }
  });

  it("survives a mode marker, which says nothing about the question", () => {
    const mode = {
      id: ++id,
      kind: "meta",
      meta: "permission-mode",
      body: "bypassPermissions",
      session: "qa",
    } as unknown as Event;
    expect(askingFromPane([asking(dialog), mode])?.questions[0]?.header).toBe("Colour");
  });
});
