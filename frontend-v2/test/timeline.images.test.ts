import { describe, it, expect } from "vitest";
import type { Event, ImageRef } from "../src/types/events";
import { deriveRows, sameRow, type ToolRow, type UserRow } from "../src/components/timeline.logic";

/**
 * Pictures reach the rows as REFERENCES (2026-09-24): a terminal paste rides on
 * its prompt as `images` plus the record's uuid, a Read of an image rides on its
 * tool result as `images`, and a screenshot tool's written files ride as
 * `files`. The rows carry them through untouched, and a row whose pictures
 * arrive or change has to read as changed, or its view would never draw them.
 */

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
});

const PASTE: ImageRef = { n: 0, mediaType: "image/png", bytes: 73251, paste: 1 };
const READ: ImageRef = { n: 0, mediaType: "image/jpeg", bytes: 139874 };
const RECORD = "1ecbc9e7-ef70-4213-bd81-82c2dfcb5169";

const userRow = (rows: ReturnType<typeof deriveRows>): UserRow =>
  rows.find((r): r is UserRow => r.kind === "user")!;
const toolRow = (rows: ReturnType<typeof deriveRows>): ToolRow =>
  rows.find((r): r is ToolRow => r.kind === "tool")!;

describe("pictures on the user row", () => {
  it("carries a terminal paste's references and its record", () => {
    const rows = deriveRows([
      ev({
        id: 1,
        kind: "user",
        body: "[Image #1]\n\nwhat is wrong?",
        images: [PASTE],
        record: RECORD,
      }),
    ]);
    const row = userRow(rows);
    expect(row.images).toEqual([PASTE]);
    expect(row.record).toBe(RECORD);
  });

  it("adds no picture fields to a prompt that has none", () => {
    const row = userRow(deriveRows([ev({ id: 1, kind: "user", body: "hi" })]));
    expect("images" in row).toBe(false);
    expect("record" in row).toBe(false);
  });

  it("reads as changed when the pictures arrive", () => {
    const before = userRow(deriveRows([ev({ id: 1, kind: "user", body: "[Image #1]" })]));
    const after = userRow(
      deriveRows([
        ev({ id: 1, kind: "user", body: "[Image #1]", images: [PASTE], record: RECORD }),
      ]),
    );
    expect(sameRow(before, after)).toBe(false);
  });
});

describe("pictures on the tool row", () => {
  it("carries a Read result's image references onto the paired row", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "look" }),
      ev({
        id: 2,
        kind: "tool_use",
        tool: "Read",
        toolId: "t1",
        body: '{"file_path":"/tmp/a.png"}',
      }),
      ev({ id: 3, kind: "tool_result", toolId: "t1", images: [READ] }),
    ]);
    const row = toolRow(rows);
    expect(row.images).toEqual([READ]);
    expect(row.result).toBe("");
    expect(row.done).toBe(true);
  });

  it("carries a screenshot's files onto the paired row", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "shoot" }),
      ev({
        id: 2,
        kind: "tool_use",
        tool: "mcp__playwright__browser_take_screenshot",
        toolId: "t1",
        body: '{"filename":"page-top.png"}',
      }),
      ev({
        id: 3,
        kind: "tool_result",
        toolId: "t1",
        body: "- [Screenshot of viewport](./page-top.png)",
        files: ["/home/wizard/page-top.png"],
      }),
    ]);
    expect(toolRow(rows).files).toEqual(["/home/wizard/page-top.png"]);
  });

  it("carries both onto an orphan result whose call is out of the window", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "look" }),
      ev({ id: 3, kind: "tool_result", toolId: "gone", images: [READ], files: ["/tmp/b.png"] }),
    ]);
    const row = toolRow(rows);
    expect(row.images).toEqual([READ]);
    expect(row.files).toEqual(["/tmp/b.png"]);
  });

  it("adds no picture fields to a result that has none", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go" }),
      ev({ id: 2, kind: "tool_use", tool: "Bash", toolId: "t1", body: '{"command":"ls"}' }),
      ev({ id: 3, kind: "tool_result", toolId: "t1", body: "a\nb" }),
    ]);
    const row = toolRow(rows);
    expect("images" in row).toBe(false);
    expect("files" in row).toBe(false);
  });

  it("reads as changed when a result's pictures land", () => {
    const call = [
      ev({ id: 1, kind: "user", body: "look" }),
      ev({
        id: 2,
        kind: "tool_use",
        tool: "Read",
        toolId: "t1",
        body: '{"file_path":"/tmp/a.png"}',
      }),
    ];
    const plain = toolRow(deriveRows([...call, ev({ id: 3, kind: "tool_result", toolId: "t1" })]));
    const pictured = toolRow(
      deriveRows([...call, ev({ id: 3, kind: "tool_result", toolId: "t1", images: [READ] })]),
    );
    expect(sameRow(plain, pictured)).toBe(false);
  });
});
