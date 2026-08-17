import { describe, it, expect, beforeEach } from "vitest";
import {
  DRAFTS_KEY,
  loadDraft,
  pruneDrafts,
  saveDraft,
  type Draft,
} from "../src/store/drafts";

/**
 * Composer drafts, persisted per session
 * (docs/plans/2026-08-17-text-view-attachments-design.md, decision 10). Both the
 * typed text and the tray survive a reload and a session switch, because on a
 * phone iOS evicts a backgrounded tab and losing a half-written message with a
 * photo attached to it is the case this exists for.
 *
 * Pruned to the live session list exactly as store/visits.ts prunes, so a killed
 * session cannot leak an entry forever.
 */

const draft = (over: Partial<Draft> = {}): Draft => ({
  text: "what's wrong here?",
  attachments: [
    {
      path: "/var/lib/clipboard-store/wizard/qa/pasted-20260817-a1.png",
      name: "pasted-20260817-a1.png",
      kind: "image",
    },
  ],
  at: 1_000_000,
  ...over,
});

const raw = (): unknown => JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "null");

beforeEach(() => {
  localStorage.clear();
});

describe("saveDraft / loadDraft", () => {
  it("round-trips the text and the tray", () => {
    saveDraft("qa", draft());
    expect(loadDraft("qa")).toEqual(draft());
  });

  it("has nothing for a session that was never written", () => {
    expect(loadDraft("qa")).toBeNull();
  });

  it("keeps sessions apart", () => {
    saveDraft("qa", draft({ text: "first" }));
    saveDraft("other", draft({ text: "second" }));
    expect(loadDraft("qa")?.text).toBe("first");
    expect(loadDraft("other")?.text).toBe("second");
  });

  // An empty draft is not worth a storage entry, and leaving one behind means a
  // cleared composer comes back looking un-cleared.
  it("removes the entry when both halves are empty", () => {
    saveDraft("qa", draft());
    saveDraft("qa", { text: "", attachments: [], at: 2_000_000 });
    expect(loadDraft("qa")).toBeNull();
    expect(raw()).toEqual({});
  });

  it("keeps a draft that is only attachments — sending those alone is allowed", () => {
    saveDraft("qa", draft({ text: "" }));
    expect(loadDraft("qa")?.attachments).toHaveLength(1);
  });

  it("keeps a draft that is only text", () => {
    saveDraft("qa", draft({ attachments: [] }));
    expect(loadDraft("qa")?.text).toBe("what's wrong here?");
  });
});

describe("loadDraft on a hostile or stale store", () => {
  it("survives a corrupt entry", () => {
    localStorage.setItem(DRAFTS_KEY, "{not json");
    expect(loadDraft("qa")).toBeNull();
  });

  it("survives a non-object document", () => {
    localStorage.setItem(DRAFTS_KEY, "[1,2,3]");
    expect(loadDraft("qa")).toBeNull();
  });

  it("drops a record whose shape is wrong rather than handing it to the composer", () => {
    localStorage.setItem(
      DRAFTS_KEY,
      JSON.stringify({ qa: { text: 42, attachments: "nope", at: "soon" } }),
    );
    expect(loadDraft("qa")).toBeNull();
  });

  it("drops attachment entries that are not attachments, keeping the good ones", () => {
    localStorage.setItem(
      DRAFTS_KEY,
      JSON.stringify({
        qa: {
          text: "hi",
          at: 1,
          attachments: [
            { path: "/var/lib/clipboard-store/wizard/qa/a.png", name: "a.png", kind: "image" },
            { path: 7, name: "bad" },
            null,
            { path: "relative.png", name: "relative.png", kind: "image" },
          ],
        },
      }),
    );
    const got = loadDraft("qa");
    expect(got?.attachments.map((a) => a.name)).toEqual(["a.png"]);
  });
});

describe("pruneDrafts", () => {
  it("drops drafts for sessions that no longer exist", () => {
    saveDraft("alive", draft());
    saveDraft("dead", draft());
    pruneDrafts(["alive"]);
    expect(loadDraft("alive")).not.toBeNull();
    expect(loadDraft("dead")).toBeNull();
  });

  // A poll that returns nothing (a request in flight, tmux briefly unreachable)
  // must not be read as "every session died".
  it("keeps everything when the live list is empty", () => {
    saveDraft("qa", draft());
    pruneDrafts([]);
    expect(loadDraft("qa")).not.toBeNull();
  });

  it("is a no-op on an empty store", () => {
    pruneDrafts(["alive"]);
    expect(localStorage.getItem(DRAFTS_KEY)).toBeNull();
  });
});
