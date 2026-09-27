/**
 * The plan card's question line is the plan's own title (prototype 6-plan):
 * a plan that opens with a heading shows it as the card's bold line, and the
 * well under it starts with the steps.
 */
import { describe, it, expect } from "vitest";
import { splitPlanTitle } from "../src/components/plan.logic";

describe("splitPlanTitle", () => {
  it.each([
    ["# Add a size check\n\n1. Read it.", "Add a size check", "1. Read it."],
    ["## Plan: tidy\n- one", "Plan: tidy", "- one"],
    ["\n\n###  Spaced  title  \nbody", "Spaced  title", "body"],
    ["# Port it to C#\nbody", "Port it to C#", "body"],
    ["# Closed ##\nbody", "Closed", "body"],
  ])("takes the leading heading of %j as the title", (plan, title, rest) => {
    expect(splitPlanTitle(plan)).toEqual({ title, rest });
  });

  it.each([
    "1. No heading first.\n# Later",
    "#### Too deep to be a title\nbody",
    "#hashtag is not a heading",
    "",
  ])("leaves %j whole", (plan) => {
    expect(splitPlanTitle(plan)).toEqual({ title: "", rest: plan });
  });
});
