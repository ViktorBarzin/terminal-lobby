import { describe, expect, it } from "vitest";
import {
  attributeSenders,
  draftState,
  othersPresent,
  presentLabel,
  type PresencePerson,
  type SenderRecord,
} from "../src/components/presence.logic";

const person = (p: Partial<PresencePerson> & { id: string; user: string }): PresencePerson => ({
  name: p.user,
  mode: "rw",
  ...p,
});

describe("othersPresent", () => {
  it("leaves out you, on every device, and lists each other account once", () => {
    const people = [
      person({ id: "a1", user: "wizard" }),
      person({ id: "a2", user: "wizard" }),
      person({ id: "b1", user: "emo", name: "emo" }),
      person({ id: "b2", user: "emo", name: "emo", draft: "hi", draftAt: 5 }),
      person({ id: "c1", user: "carol", mode: "ro" }),
    ];
    const got = othersPresent(people, "wizard");
    expect(got.map((p) => p.user)).toEqual(["carol", "emo"]);
    // The tab with a draft is the one that speaks for the account.
    expect(got.find((p) => p.user === "emo")?.draft).toBe("hi");
  });

  it("is empty when you are alone", () => {
    expect(othersPresent([person({ id: "a", user: "wizard" })], "wizard")).toEqual([]);
  });
});

describe("presentLabel", () => {
  it("names who is here and who only watches", () => {
    expect(presentLabel([])).toBe("");
    expect(presentLabel([person({ id: "1", user: "emo" })])).toBe("emo here");
    expect(
      presentLabel([
        person({ id: "1", user: "emo" }),
        person({ id: "2", user: "bob", mode: "ro" }),
      ]),
    ).toBe("emo, bob (watching) here");
    const many = ["a", "b", "c", "d"].map((u) => person({ id: u, user: u }));
    expect(presentLabel(many)).toBe("a, b and 2 more here");
  });
});

describe("draftState", () => {
  it("is typing while the draft is moving, a draft once it rests, and nothing when empty", () => {
    expect(draftState(person({ id: "1", user: "emo" }), 10_000)).toBe("none");
    expect(draftState(person({ id: "1", user: "emo", draft: "x", draftAt: 9_000 }), 10_000)).toBe(
      "typing",
    );
    expect(draftState(person({ id: "1", user: "emo", draft: "x", draftAt: 1_000 }), 10_000)).toBe(
      "resting",
    );
  });
});

describe("attributeSenders", () => {
  const rec = (text: string, at: number, user: string, name = user): SenderRecord => ({
    text,
    at,
    user,
    name,
  });

  it("labels nothing while only the owner has ever sent", () => {
    const rows = [{ key: "u1", body: "hello", at: 1000 }];
    expect(attributeSenders(rows, [rec("hello", 900, "wizard")], "wizard").size).toBe(0);
  });

  it("labels each message with whoever sent it once a guest has sent", () => {
    const rows = [
      { key: "u1", body: "hello", at: 1_000 },
      { key: "u2", body: "check the release", at: 5_000 },
      { key: "u3", body: "typed in the terminal", at: 9_000 },
    ];
    const got = attributeSenders(
      rows,
      [rec("hello", 900, "wizard", "vbarzin"), rec("check the release", 4_800, "emo")],
      "wizard",
    );
    expect(got.get("u1")).toBe("vbarzin");
    expect(got.get("u2")).toBe("emo");
    expect(got.has("u3")).toBe(false);
  });

  it("uses each record once, in order, when the same words are sent twice", () => {
    const rows = [
      { key: "u1", body: "yes", at: 1_000 },
      { key: "u2", body: "yes", at: 60_000 },
    ];
    const got = attributeSenders(
      rows,
      [rec("yes", 900, "emo"), rec("yes", 59_000, "wizard")],
      "wizard",
    );
    expect(got.get("u1")).toBe("emo");
    expect(got.get("u2")).toBe("wizard");
  });

  it("ignores a record from long before the message", () => {
    const rows = [{ key: "u1", body: "yes", at: 10 * 60 * 60 * 1000 }];
    expect(attributeSenders(rows, [rec("yes", 0, "emo")], "wizard").size).toBe(0);
  });

  it("matches across trailing whitespace", () => {
    const rows = [{ key: "u1", body: "hello\n", at: 1_000 }];
    expect(attributeSenders(rows, [rec("  hello", 900, "emo")], "wizard").get("u1")).toBe("emo");
  });
});
