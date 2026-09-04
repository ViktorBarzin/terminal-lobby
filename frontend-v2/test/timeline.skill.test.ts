/**
 * A skill load is one card, not two rows.
 *
 * Viktor, 2026-09-04: *"I want to have special visualisation for skills to show
 * the user that the skill is applied"*, then, on how much: *"I just want the
 * skill to be marked somewhat that's it's a skill"*, and *"Name only"*.
 *
 * The transcript writes a load twice: the `Skill` tool call, which classified as
 * `dynamic_tool_call` and rendered with the generic tool treatment, and the
 * SKILL.md body, which sessionio collapses to a `meta:skill` event. Two
 * forgettable rows for one thing that happened.
 */
import { describe, it, expect } from "vitest";
import { deriveRows } from "../src/components/timeline.logic";
import type { Event } from "../src/types/events";

/**
 * Every leaf, folded turns included.
 *
 * A settled turn past a few rows collapses into a `turn-fold` carrying its
 * leaves in `hidden` — the same walk timeline.logic does when it needs them all.
 */
const leaves = (rows: ReturnType<typeof deriveRows>) =>
  rows.flatMap((r) => (r.kind === "turn-fold" ? r.hidden : [r]));

let id = 0;
const ev = (e: Partial<Event> & Pick<Event, "kind">): Event =>
  ({ id: ++id, session: "s", at: 1_700_000_000_000, ...e }) as Event;

const reset = () => {
  id = 0;
};

/** A settled turn, so nothing renders as still working. */
const turn = (...inner: Event[]): Event[] => [
  ev({ kind: "user", body: "go" }),
  ...inner,
  ev({ kind: "turn_end" }),
];

const skillCall = (name: string, args?: string) =>
  ev({
    kind: "tool_use",
    tool: "Skill",
    toolId: `tu-${name}`,
    body: JSON.stringify(args ? { skill: name, args } : { skill: name }),
  });

const skillLoaded = (name: string, bytes: number) =>
  ev({ kind: "meta", meta: "skill", body: name, bytes });

describe("the Skill tool call", () => {
  it("is its own item type, so the view never branches on the tool's name", () => {
    reset();
    const rows = leaves(deriveRows(turn(skillCall("grilling"))));
    const row = rows.find((r) => r.kind === "tool");
    expect(row).toBeDefined();
    expect(row!.kind === "tool" && row!.itemType).toBe("skill");
  });

  it("is labelled with the skill, not with the word Skill", () => {
    reset();
    const rows = leaves(deriveRows(turn(skillCall("grilling"))));
    const row = rows.find((r) => r.kind === "tool");
    expect(row!.kind === "tool" && row!.label).toBe("grilling");
  });
});

describe("folding the two records into one card", () => {
  it("puts the collapsed size on the call and drops the marker row", () => {
    reset();
    const rows = leaves(deriveRows(turn(skillCall("grilling"), skillLoaded("grilling", 16_584))));
    const tools = rows.filter((r) => r.kind === "tool");
    const metas = rows.filter((r) => r.kind === "meta");
    expect(tools).toHaveLength(1);
    expect(metas).toHaveLength(0);
    expect(tools[0]!.kind === "tool" && tools[0]!.bytes).toBe(16_584);
  });

  it("folds a skill whose body carried no marker, which is why the receipt drives it", () => {
    // workflow-authoring: 14 of the 24 bodies with no `Base directory` line.
    reset();
    const rows = leaves(
      deriveRows(
        turn(skillCall("workflow-authoring"), skillLoaded("workflow-authoring", 16_705)),
      ),
    );
    expect(rows.filter((r) => r.kind === "meta")).toHaveLength(0);
    const row = rows.find((r) => r.kind === "tool")!;
    expect(row.kind === "tool" && row.label).toBe("workflow-authoring");
    expect(row.kind === "tool" && row.bytes).toBe(16_705);
  });

  it("keeps two loads apart", () => {
    reset();
    const rows = leaves(
      deriveRows(
        turn(
          skillCall("grilling"),
          skillLoaded("grilling", 3_100),
          skillCall("domain-modeling"),
          skillLoaded("domain-modeling", 4_200),
        ),
      ),
    );
    const tools = rows.filter((r) => r.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools.map((r) => (r.kind === "tool" ? [r.label, r.bytes] : []))).toEqual([
      ["grilling", 3_100],
      ["domain-modeling", 4_200],
    ]);
  });

  it("does not fold a load onto a call for a different skill", () => {
    reset();
    const rows = leaves(deriveRows(turn(skillCall("grilling"), skillLoaded("doc-tone", 2_000))));
    const tool = rows.find((r) => r.kind === "tool")!;
    expect(tool.kind === "tool" && tool.bytes).toBeUndefined();
    // Unfolded, so the load still shows rather than vanishing.
    expect(rows.filter((r) => r.kind === "meta" && r.meta === "skill")).toHaveLength(1);
  });

  it("still shows a load with no call before it", () => {
    // The marker path with no Skill tool_use: a skill the harness injected.
    reset();
    const rows = leaves(deriveRows(turn(skillLoaded("doc-tone", 2_400))));
    const meta = rows.find((r) => r.kind === "meta" && r.meta === "skill");
    expect(meta).toBeDefined();
    expect(meta!.kind === "meta" && meta!.body).toBe("doc-tone");
  });

  it("folds across the tool result the receipt arrived on", () => {
    reset();
    const rows = leaves(
      deriveRows(
        turn(
          skillCall("grilling"),
          ev({ kind: "tool_result", toolId: "tu-grilling", body: "Launching skill: grilling" }),
          skillLoaded("grilling", 3_125),
        ),
      ),
    );
    expect(rows.filter((r) => r.kind === "meta")).toHaveLength(0);
    const tool = rows.find((r) => r.kind === "tool")!;
    expect(tool.kind === "tool" && tool.bytes).toBe(3_125);
    expect(tool.kind === "tool" && tool.done).toBe(true);
  });

  it("leaves a failed call as a failed call", () => {
    // No body is injected when the skill name does not resolve, so there is
    // nothing to fold and the error has to stay visible.
    reset();
    const rows = leaves(
      deriveRows(
        turn(
          skillCall("nope"),
          ev({ kind: "tool_result", toolId: "tu-nope", body: "no such skill", isError: true }),
        ),
      ),
    );
    const tool = rows.find((r) => r.kind === "tool")!;
    expect(tool.kind === "tool" && tool.isError).toBe(true);
    expect(tool.kind === "tool" && tool.bytes).toBeUndefined();
  });
});
