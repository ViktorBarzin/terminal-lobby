import { describe, it, expect } from "vitest";
import {
  fileSummary,
  humanBytes,
  installableCount,
  peerAction,
  peerLabel,
  peersWorthShowing,
  pluginStatus,
  restartTargets,
  skillStatus,
} from "../src/store/skills.logic";
import type { PeerSkill, Plugin, Skill } from "../src/lib/skills-api";

const skill = (over: Partial<Skill> = {}): Skill => ({
  name: "tdd",
  files: 2,
  executable: 0,
  bytes: 2048,
  hash: "sha256:a",
  enabled: true,
  ...over,
});

const peer = (over: Partial<PeerSkill> = {}): PeerSkill => ({
  ...skill(),
  verdict: "absent",
  ...over,
});

describe("skillStatus", () => {
  it("says where a skill came from", () => {
    expect(skillStatus(skill()).label).toBe("own");
    expect(skillStatus(skill({ from: "emo" })).label).toBe("from emo");
  });

  it("puts an available update ahead of provenance, since it is the actionable one", () => {
    const st = skillStatus(skill({ from: "emo", updateAvailable: true }));
    expect(st.label).toBe("from emo · update");
    expect(st.tone).toBe("accent");
    expect(st.detail).toContain("changed their copy");
  });

  it("warns that an update would displace local edits", () => {
    const st = skillStatus(skill({ from: "emo", updateAvailable: true, locallyModified: true }));
    expect(st.detail).toContain("backs yours up first");
  });

  it("reports a local edit without implying there is something to pull", () => {
    const st = skillStatus(skill({ from: "emo", locallyModified: true }));
    expect(st.label).toBe("from emo · edited");
    expect(st.tone).not.toBe("accent");
  });

  it("mentions a symlinked entry, which is how provisioned skills still look", () => {
    expect(skillStatus(skill({ symlink: true })).label).toBe("own · linked");
  });
});

describe("pluginStatus", () => {
  it("shows the installed version", () => {
    expect(pluginStatus({ id: "x@o", name: "x", marketplace: "o", version: "5.1.0", enabled: true }).label)
      .toBe("5.1.0");
  });

  it("names the newer version when the marketplace advertises one", () => {
    const p: Plugin = {
      id: "superpowers@official",
      name: "superpowers",
      marketplace: "official",
      version: "5.1.0",
      enabled: true,
      latest: "5.3.0",
      stale: true,
    };
    expect(pluginStatus(p).label).toBe("5.1.0 · 5.3.0");
    expect(pluginStatus(p).tone).toBe("accent");
  });

  it("stays quiet when no version could be read rather than inventing one", () => {
    const p: Plugin = { id: "x@o", name: "x", marketplace: "o", version: "", enabled: true };
    expect(pluginStatus(p).label).toBe("unknown");
    expect(pluginStatus(p).tone).toBe("muted");
  });
});

describe("peerAction", () => {
  it("offers nothing for a byte-identical skill", () => {
    expect(peerAction(peer({ verdict: "same" }))).toBe("none");
    expect(peerLabel(peer({ verdict: "same" })).label).toBe("same as yours");
  });

  it("offers a plain install when the name is free", () => {
    expect(peerAction(peer({ verdict: "absent" }))).toBe("install");
    expect(peerLabel(peer({ verdict: "absent" })).label).toBe("");
  });

  it("makes a collision a replace, and flags it", () => {
    expect(peerAction(peer({ verdict: "differs" }))).toBe("replace");
    const l = peerLabel(peer({ verdict: "differs" }));
    expect(l.label).toBe("differs");
    expect(l.tone).toBe("warn");
  });
});

describe("installableCount", () => {
  it("counts only what is actually takeable", () => {
    // The real shape of these two accounts: 4 identical, 9 differing, 8 absent.
    const skills = [
      ...Array.from({ length: 4 }, (_, i) => peer({ name: `same${i}`, verdict: "same" as const })),
      ...Array.from({ length: 9 }, (_, i) => peer({ name: `diff${i}`, verdict: "differs" as const })),
      ...Array.from({ length: 8 }, (_, i) => peer({ name: `new${i}`, verdict: "absent" as const })),
    ];
    expect(installableCount({ user: "emo", skills })).toBe(17);
  });

  it("is zero for an unreachable peer rather than throwing on a missing list", () => {
    expect(installableCount({ user: "emo", unreachable: true })).toBe(0);
  });
});

describe("peersWorthShowing", () => {
  it("keeps an unreachable peer, because that is information", () => {
    const out = peersWorthShowing([
      { user: "zoe", skills: [] },
      { user: "emo", unreachable: true },
      { user: "abe", skills: [peer()] },
    ]);
    expect(out.map((p) => p.user)).toEqual(["abe", "emo"]);
  });
});

describe("restartTargets", () => {
  it("marks a mid-turn session unrestartable and lists it first", () => {
    const rows = restartTargets([
      { name: "notes", state: "done" },
      { name: "infra-work", state: "running" },
      { name: "tripit", state: "awaiting" },
    ]);
    expect(rows.map((r) => r.name)).toEqual(["infra-work", "notes", "tripit"]);
    expect(rows[0]!.restartable).toBe(false);
    expect(rows.slice(1).every((r) => r.restartable)).toBe(true);
  });

  it("treats a session with no recorded state as idle", () => {
    const [row] = restartTargets([{ name: "plain" }]);
    expect(row!.state).toBe("idle");
    expect(row!.restartable).toBe(true);
  });

  it("is empty when there are no sessions", () => {
    expect(restartTargets([])).toEqual([]);
  });
});

describe("fileSummary", () => {
  it("says how many files would run, because that is what installing takes on", () => {
    expect(fileSummary(skill({ files: 4, executable: 2, bytes: 6100 }))).toBe("4 files · 2 executable · 6 KB");
  });

  it("leaves the executable count out when there is none", () => {
    expect(fileSummary(skill({ files: 1, executable: 0, bytes: 900 }))).toBe("1 file · 900 B");
  });

  it("scales the size unit", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(1023)).toBe("1023 B");
    expect(humanBytes(2048)).toBe("2 KB");
    expect(humanBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
