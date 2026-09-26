/**
 * The `agents` frame, read off the wire.
 *
 * The panel's logic assumes every field is present, so the parse is where a
 * short or odd payload becomes a whole one: an older server that omits a field,
 * a nil Go slice that marshals as `null`, a state this client has never heard
 * of. A frame that is not an object at all is refused outright.
 */
import { describe, it, expect } from "vitest";
import { parseAgentSet } from "../src/types/events";

describe("parseAgentSet", () => {
  it("keeps an agent's waiting flag, which the presence rule reads", () => {
    const frame = (extra: Record<string, unknown>) =>
      parseAgentSet(
        JSON.stringify({
          at: 1,
          agents: [{ id: "a1", state: "running", ...extra }],
          workflows: [],
        }),
      );
    expect(frame({ waiting: true })?.agents[0]?.waiting).toBe(true);
    // Absent, or anything but true, is not waiting.
    expect(frame({})?.agents[0]?.waiting).toBeUndefined();
    expect(frame({ waiting: "yes" })?.agents[0]?.waiting).toBeUndefined();
  });

  it("reads a whole frame as sent", () => {
    const set = parseAgentSet(
      JSON.stringify({
        at: 1_790_000_000_000,
        agents: [
          {
            id: "a1",
            description: "Find prior art",
            name: "priorart-recon",
            agentType: "general-purpose",
            model: "claude-opus-5-5",
            color: "yellow",
            depth: 1,
            parentId: "",
            toolUseId: "toolu_1",
            workflowId: "",
            phaseIndex: 0,
            label: "",
            state: "running",
            startedAt: 1_789_999_990_000,
            lastActivityAt: 1_789_999_999_000,
            endedAt: 0,
            tool: "Read",
            toolDetail: "src/app.css",
            toolCalls: 4,
            outputTokens: 1200,
            result: "",
          },
        ],
        workflows: [
          {
            id: "wf_1",
            name: "cut-dead-paths",
            summary: "Cut the dead frontend paths",
            state: "running",
            startedAt: 1_789_999_000_000,
            endedAt: 0,
            phases: [{ index: 1, title: "Survey", detail: "read" }],
            currentPhase: 1,
            agentCount: 5,
            tokens: 90_000,
            toolCalls: 40,
          },
        ],
      }),
    );
    expect(set?.at).toBe(1_790_000_000_000);
    expect(set?.agents[0]).toMatchObject({
      id: "a1",
      tool: "Read",
      toolCalls: 4,
      state: "running",
    });
    expect(set?.workflows[0]?.phases).toEqual([{ index: 1, title: "Survey", detail: "read" }]);
  });

  it.each([
    ["not JSON", "{"],
    ["a number", "7"],
    ["an array", "[]"],
    ["null", "null"],
  ])("refuses a frame that is %s", (_what, data) => {
    expect(parseAgentSet(data)).toBeNull();
  });

  it("fills in every field a short entry leaves out", () => {
    const set = parseAgentSet(JSON.stringify({ at: 5, agents: [{ id: "a1" }] }));
    expect(set?.agents[0]).toEqual({
      id: "a1",
      description: "",
      name: "",
      agentType: "",
      model: "",
      color: "",
      depth: 0,
      parentId: "",
      toolUseId: "",
      workflowId: "",
      phaseIndex: 0,
      label: "",
      state: "done",
      startedAt: 0,
      lastActivityAt: 0,
      endedAt: 0,
      tool: "",
      toolDetail: "",
      toolCalls: 0,
      outputTokens: 0,
      result: "",
    });
    expect(set?.workflows).toEqual([]);
  });

  it("reads a nil Go slice as an empty list", () => {
    const set = parseAgentSet(JSON.stringify({ at: 5, agents: null, workflows: null }));
    expect(set).toEqual({ at: 5, agents: [], workflows: [] });
  });

  it("drops an entry with no id rather than render a row nothing can name", () => {
    const set = parseAgentSet(
      JSON.stringify({ at: 5, agents: [{ description: "no id" }, 3, { id: "a2" }] }),
    );
    expect(set?.agents.map((a) => a.id)).toEqual(["a2"]);
  });

  it("never reads a state it does not know as running", () => {
    const set = parseAgentSet(
      JSON.stringify({
        at: 5,
        agents: [{ id: "a1", state: "paused" }],
        workflows: [{ id: "wf_1", state: "sleeping" }],
      }),
    );
    expect(set?.agents[0]?.state).toBe("done");
    expect(set?.workflows[0]?.state).toBe("done");
  });
});
