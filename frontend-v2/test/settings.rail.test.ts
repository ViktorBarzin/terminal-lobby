/**
 * The Settings rail's model.
 *
 * The rail is the whole navigation surface now, so which entries exist — and
 * which of them a given caller may see — is worth pinning down away from the
 * DOM. Two things it has to get right: "Act as user" renders for an admin and
 * for nobody else, and a page id remembered from a previous session must not
 * strand the panel on an entry that is no longer in the rail.
 */
import { describe, it, expect } from "vitest";
import { railFor, resolvePage, type PageId } from "../src/components/settings/rail";

const ids = (admin: boolean): PageId[] => railFor({ admin }).map((e) => e.id);

describe("railFor", () => {
  it("lists the eight everyone-pages in reading order", () => {
    expect(ids(false)).toEqual([
      "appearance",
      "terminal",
      "sessions",
      "keyboard",
      "notifications",
      "network",
      "privacy",
      "skills",
    ]);
  });

  it("appends Act as user for an admin, and only for an admin", () => {
    expect(ids(true)).toEqual([...ids(false), "actas"]);
    expect(ids(false)).not.toContain("actas");
  });

  it("draws a rule above Skills and above Act as user, nowhere else", () => {
    const grouped = railFor({ admin: true })
      .filter((e) => e.startsGroup)
      .map((e) => e.id);
    expect(grouped).toEqual(["skills", "actas"]);
  });

  it("never leaves a leading rule when the admin entry is absent", () => {
    const last = railFor({ admin: false }).at(-1);
    expect(last?.id).toBe("skills");
    expect(railFor({ admin: false })[0]?.startsGroup).toBeFalsy();
  });

  it("gives every entry a label", () => {
    for (const e of railFor({ admin: true })) expect(e.label).toBeTruthy();
  });
});

describe("resolvePage", () => {
  it("keeps a remembered page that is still in the rail", () => {
    expect(resolvePage(railFor({ admin: false }), "network")).toBe("network");
  });

  it("falls back to the first page when the remembered one is gone", () => {
    // Stored while acting as an admin, read back as a plain user.
    expect(resolvePage(railFor({ admin: false }), "actas")).toBe("appearance");
  });

  it("falls back for an unknown or empty id", () => {
    expect(resolvePage(railFor({ admin: true }), "nonsense")).toBe("appearance");
    expect(resolvePage(railFor({ admin: true }), "")).toBe("appearance");
    expect(resolvePage(railFor({ admin: true }), null)).toBe("appearance");
  });
});
