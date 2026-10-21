/**
 * Settings → T3 apps, the pure half (t3/pairing.logic.ts): the pairing card's
 * state machine, the link and code a person reads or scans, the countdown, the
 * device rows, and the QR code's SVG path.
 */
import { describe, expect, it } from "vitest";
import {
  countdown,
  deviceKind,
  groupCode,
  lastUsedLabel,
  pairLink,
  pairStep,
  pairedNote,
  pollsDevices,
  qrPath,
  secondsLeft,
  type PairState,
} from "../src/t3/pairing.logic";

const NOW = 1_800_000_000_000; // ms
const IN_FIVE = NOW / 1000 + 300; // unix s

describe("the pairing card", () => {
  const showing: PairState = {
    kind: "showing",
    code: "ABCDEFGHJKLM",
    expiresAt: IN_FIVE,
    known: ["laptop"],
  };

  it("asks for a code, then shows the one tmux-api minted", () => {
    const asking = pairStep({ kind: "idle" }, { type: "request" });
    expect(asking).toEqual({ kind: "requesting" });
    expect(
      pairStep(asking, {
        type: "granted",
        code: "ABCDEFGHJKLM",
        expiresAt: IN_FIVE,
        known: ["laptop"],
      }),
    ).toEqual(showing);
  });

  it("keeps showing the code until its expiry, then offers a new one", () => {
    expect(pairStep(showing, { type: "tick", nowMs: NOW + 299_000 })).toBe(showing);
    expect(pairStep(showing, { type: "tick", nowMs: NOW + 300_000 })).toEqual({ kind: "expired" });
  });

  it("asks again from an expired code or an error", () => {
    expect(pairStep({ kind: "expired" }, { type: "request" })).toEqual({ kind: "requesting" });
    expect(pairStep({ kind: "error", message: "x" }, { type: "request" })).toEqual({
      kind: "requesting",
    });
    expect(pairStep(showing, { type: "request" })).toEqual({ kind: "requesting" });
  });

  it("shows the server's words when the request fails, a 429 included", () => {
    const failed = pairStep(
      { kind: "requesting" },
      { type: "failed", message: "too many pairing codes outstanding; wait for one to expire" },
    );
    expect(failed).toEqual({
      kind: "error",
      message: "too many pairing codes outstanding; wait for one to expire",
    });
  });

  it("ignores a second press while a request is in flight, and stray answers", () => {
    const asking: PairState = { kind: "requesting" };
    expect(pairStep(asking, { type: "request" })).toBe(asking);
    expect(
      pairStep({ kind: "idle" }, { type: "granted", code: "X", expiresAt: IN_FIVE, known: [] }),
    ).toEqual({ kind: "idle" });
    expect(pairStep({ kind: "idle" }, { type: "failed", message: "x" })).toEqual({ kind: "idle" });
    expect(pairStep({ kind: "idle" }, { type: "tick", nowMs: NOW })).toEqual({ kind: "idle" });
  });

  it("treats a code that is already past its expiry as expired", () => {
    const stale = pairStep(
      { kind: "requesting" },
      { type: "granted", code: "ABCDEFGHJKLM", expiresAt: NOW / 1000 - 1, known: [] },
    );
    expect(pairStep(stale, { type: "tick", nowMs: NOW })).toEqual({ kind: "expired" });
  });
});

describe("noticing the code was used", () => {
  const showing: PairState = {
    kind: "showing",
    code: "ABCDEFGHJKLM",
    expiresAt: IN_FIVE,
    known: ["laptop"],
  };
  const laptop = { id: "laptop", label: "T3 desktop" };
  const phone = { id: "phone", label: "Pixel 9" };

  it("polls the device list only while a code is showing", () => {
    expect(pollsDevices(showing)).toBe(true);
    for (const state of [
      { kind: "idle" },
      { kind: "requesting" },
      { kind: "expired" },
      { kind: "error", message: "x" },
      { kind: "paired", label: "Pixel 9" },
    ] as PairState[]) {
      expect(pollsDevices(state), state.kind).toBe(false);
    }
  });

  it("keeps the code while the list holds only the devices paired before it", () => {
    expect(pairStep(showing, { type: "devices", devices: [laptop] })).toBe(showing);
    expect(pairStep(showing, { type: "devices", devices: [] })).toBe(showing);
  });

  it("clears the code and names the device that appeared since it was minted", () => {
    expect(pairStep(showing, { type: "devices", devices: [phone, laptop] })).toEqual({
      kind: "paired",
      label: "Pixel 9",
    });
  });

  it("ignores a device list that arrives when no code is showing", () => {
    for (const state of [
      { kind: "idle" },
      { kind: "requesting" },
      { kind: "expired" },
      { kind: "paired", label: "Pixel 9" },
    ] as PairState[]) {
      expect(pairStep(state, { type: "devices", devices: [phone] })).toBe(state);
    }
  });

  it("asks for another code after a pairing, and stops counting down", () => {
    const paired: PairState = { kind: "paired", label: "Pixel 9" };
    expect(pairStep(paired, { type: "request" })).toEqual({ kind: "requesting" });
    expect(pairStep(paired, { type: "tick", nowMs: NOW + 400_000 })).toBe(paired);
  });

  it("says which device paired, or a generic name when it gave none", () => {
    expect(pairedNote("Pixel 9")).toBe("Paired: Pixel 9");
    expect(pairedNote("")).toBe("Paired: T3 app");
  });
});

describe("the countdown", () => {
  it("counts whole seconds left, rounded up, never below zero", () => {
    expect(secondsLeft(IN_FIVE, NOW)).toBe(300);
    expect(secondsLeft(IN_FIVE, NOW + 299_001)).toBe(1);
    expect(secondsLeft(IN_FIVE, NOW + 300_000)).toBe(0);
    expect(secondsLeft(IN_FIVE, NOW + 900_000)).toBe(0);
  });

  it("reads as minutes and seconds", () => {
    expect(countdown(300)).toBe("5:00");
    expect(countdown(299)).toBe("4:59");
    expect(countdown(61)).toBe("1:01");
    expect(countdown(9)).toBe("0:09");
    expect(countdown(0)).toBe("0:00");
  });
});

describe("what a person reads or scans", () => {
  it("links to T3's own pair route with the code in the fragment", () => {
    expect(pairLink("https://t3.viktorbarzin.me", "ABCDEFGHJKLM")).toBe(
      "https://t3.viktorbarzin.me/pair#token=ABCDEFGHJKLM",
    );
  });

  it("groups the code in fours for reading aloud or typing", () => {
    expect(groupCode("ABCDEFGHJKLM")).toBe("ABCD EFGH JKLM");
    expect(groupCode("ABCDEF")).toBe("ABCD EF");
    expect(groupCode("")).toBe("");
  });
});

describe("a paired device's row", () => {
  it("names the kind of device and its OS when the app said", () => {
    expect(deviceKind({ deviceType: "mobile", os: "ios" })).toBe("mobile · ios");
    expect(deviceKind({ deviceType: "desktop", os: "" })).toBe("desktop");
    expect(deviceKind({ deviceType: "", os: "" })).toBe("");
  });

  it("says when it was last used, or that it has not been", () => {
    const fmt = (s: number) => `day ${s}`;
    expect(lastUsedLabel(0, fmt)).toBe("not used yet");
    expect(lastUsedLabel(1_700_000_000, fmt)).toBe("last used day 1700000000");
  });
});

describe("the QR code's SVG path", () => {
  it("draws one unit square per dark module, offset by the quiet zone", () => {
    const dark = new Set(["0,0", "1,1"]);
    const bitmap = { size: 2, get: (x: number, y: number) => dark.has(`${x},${y}`) };
    expect(qrPath(bitmap, 4)).toBe("M4 4h1v1h-1zM5 5h1v1h-1z");
  });

  it("is empty for a blank bitmap", () => {
    expect(qrPath({ size: 3, get: () => false }, 0)).toBe("");
  });
});
