import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  approvalAnswer,
  promptIdOf,
  questionAnswers,
  resolveDispatchMode,
} from "../src/commands/policy.ts";

const run = (status: "running" | "starting" | "completed" | "queued") => ({
  id: RunId.make(`run-${status}`),
  status,
});

describe("resolveDispatchMode", () => {
  it("keeps the requested mode when the client names no intent", () => {
    expect(
      resolveDispatchMode([run("running")], { type: "queue_after_active" }, undefined),
    ).toEqual({
      type: "queue_after_active",
    });
  });

  it("starts anything when no run is active", () => {
    for (const intent of ["auto", "steer", "restart"] as const) {
      expect(
        resolveDispatchMode(
          [run("completed"), run("queued")],
          { type: "queue_after_active" },
          intent,
        ),
      ).toEqual({
        type: "start_immediately",
      });
    }
  });

  it("steers or restarts the active run when asked", () => {
    const runs = [run("completed"), run("running")];
    expect(resolveDispatchMode(runs, { type: "start_immediately" }, "steer")).toEqual({
      type: "steer_active",
      targetRunId: "run-running",
    });
    expect(resolveDispatchMode(runs, { type: "start_immediately" }, "restart")).toEqual({
      type: "restart_active",
      targetRunId: "run-running",
    });
  });

  it("queues behind a run still starting, and steers a running one on auto", () => {
    expect(resolveDispatchMode([run("starting")], { type: "start_immediately" }, "auto")).toEqual({
      type: "queue_after_active",
    });
    expect(resolveDispatchMode([run("running")], { type: "start_immediately" }, "auto")).toEqual({
      type: "steer_active",
      targetRunId: "run-running",
    });
  });
});

describe("answers", () => {
  it("passes T3's command id as the prompt id the lobby accepts", () => {
    expect(promptIdOf("c1eaff2f-bfd0-46ed-b84a-d7e4b7c2b220")).toBe(
      "c1eaff2f-bfd0-46ed-b84a-d7e4b7c2b220",
    );
    expect(promptIdOf("a:b/c")).toBe("abc");
    expect(promptIdOf("::")).toBeUndefined();
  });

  it("turns an approval into a permission row or a plan choice", () => {
    expect(approvalAnswer("permission", "t1", "accept")).toEqual({
      toolId: "t1",
      permission: { option: 1 },
    });
    expect(approvalAnswer("permission", "t1", "decline")).toEqual({
      toolId: "t1",
      permission: { option: 2 },
    });
    expect(approvalAnswer("plan", "p1", "acceptForSession")).toEqual({
      toolId: "p1",
      plan: { option: 1, label: "Approve plan" },
    });
    expect(approvalAnswer("plan", "p1", "cancel")).toEqual({
      toolId: "p1",
      plan: { option: 2, label: "Keep planning" },
    });
  });

  it("keys answers by question text and refuses a question left blank", () => {
    const qs = [
      { question: "Colour?", options: [{ label: "Red" }, { label: "Blue" }] },
      { question: "Sizes?", multiSelect: true, options: [{ label: "S" }, { label: "M" }] },
    ];
    expect(questionAnswers(qs, { "Colour?": "Blue", "Sizes?": ["S", "M"] })).toEqual({
      "Colour?": ["Blue"],
      "Sizes?": ["S", "M"],
    });
    expect(questionAnswers(qs, { "Colour?": "Blue" })).toBeUndefined();
  });
});
