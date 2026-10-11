import { describe, expect, it } from "vitest";
import {
  attributeSenders,
  draftState,
  SENDER_COLORS,
  sessionColors,
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
    expect(got.get("u1")?.name).toBe("vbarzin");
    expect(got.get("u2")?.user).toBe("emo");
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
    expect(got.get("u1")?.user).toBe("emo");
    expect(got.get("u2")?.user).toBe("wizard");
  });

  it("ignores a record from long before the message", () => {
    const rows = [{ key: "u1", body: "yes", at: 10 * 60 * 60 * 1000 }];
    expect(attributeSenders(rows, [rec("yes", 0, "emo")], "wizard").size).toBe(0);
  });

  it("matches across trailing whitespace", () => {
    const rows = [{ key: "u1", body: "hello\n", at: 1_000 }];
    expect(attributeSenders(rows, [rec("  hello", 900, "emo")], "wizard").get("u1")?.user).toBe("emo");
  });
});

describe("sessionColors", () => {
  const rec = (user: string, at: number): SenderRecord => ({ text: "x", at, user, name: user });

  it("gives the owner the first colour, then senders in the order they first sent", () => {
    const got = sessionColors("wizard", [rec("emo", 5), rec("bob", 9), rec("emo", 12)], []);
    expect(got.get("wizard")).toBe(0);
    expect(got.get("emo")).toBe(1);
    expect(got.get("bob")).toBe(2);
  });

  it("colours someone present who has not sent yet after everyone who has", () => {
    const got = sessionColors(
      "wizard",
      [rec("emo", 5)],
      [person({ id: "1", user: "zed" }), person({ id: "2", user: "ann" }), person({ id: "3", user: "emo" })],
    );
    expect([got.get("wizard"), got.get("emo"), got.get("ann"), got.get("zed")]).toEqual([0, 1, 2, 3]);
  });

  it("is the same on every screen, whoever is looking", () => {
    const senders = [rec("emo", 5), rec("wizard", 7)];
    const people = [person({ id: "a", user: "wizard" }), person({ id: "b", user: "emo" })];
    expect([...sessionColors("wizard", senders, people)]).toEqual([
      ...sessionColors("wizard", [...senders], [...people].reverse()),
    ]);
  });

  it("wraps round the palette past its last colour", () => {
    const many = Array.from({ length: SENDER_COLORS + 1 }, (_, i) => rec(`u${i}`, i));
    expect(sessionColors("owner", many, []).get(`u${SENDER_COLORS - 1}`)).toBe(0);
  });
});
