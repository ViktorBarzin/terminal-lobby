import { describe, expect, it } from "vitest";
import { MODEL_LABELS, MODEL_PHRASES, NEW_SESSION_MODELS } from "../src/lib/models";

// The composer shows these with no heading over them, so the noun has to be in
// the phrase itself. MODEL_LABELS carried it in the default state only
// ("Default model"), so choosing Opus left a control reading just "Opus" with
// nothing to say what it set — which is the bug MODEL_PHRASES exists to close.
describe("MODEL_PHRASES", () => {
  it("keeps the word model in every state, not just the default", () => {
    for (const k of NEW_SESSION_MODELS) {
      expect(MODEL_PHRASES[k], `no phrase for ${k}`).toBeTruthy();
      expect(MODEL_PHRASES[k]!.toLowerCase(), `${k} drops the noun`).toContain("model");
    }
  });

  it("still has a plain label for the surfaces that sit under a heading", () => {
    for (const k of NEW_SESSION_MODELS) {
      expect(MODEL_LABELS[k], `no label for ${k}`).toBeTruthy();
    }
  });
});
