/**
 * The public-link page reads a transcript's pictures through the link's own
 * routes (ADR-0040). Installing them must reroute every picture builder the
 * timeline uses, and the lobby, which never installs them, must be untouched.
 */
import { describe, expect, it } from "vitest";

describe("link transcript routes", () => {
  it("leave the lobby's picture URLs alone until installed, then reroute all of them", async () => {
    const config = await import("../src/lib/config");
    const { contentUrlFor, pictureUrlFor } = await import("../src/lib/attachments");
    expect(config.toolImageUrl("s", "toolu_1", 0)).toContain("/result/s/toolu_1/image/0");
    expect(config.linkPictureUrl("/x.png")).toBeNull();

    config.useLinkTranscriptRoutes({
      toolImage: (t, n) => `L/tool/${t}/${n}`,
      promptImage: (r, n) => `L/prompt/${r}/${n}`,
      picture: (p) => `L/pic${p}`,
    });
    expect(config.toolImageUrl("s", "toolu_1", 0)).toBe("L/tool/toolu_1/0");
    expect(config.promptImageUrl("s", "rec", 3)).toBe("L/prompt/rec/3");
    expect(pictureUrlFor("/home/w/shot.png")).toBe("L/pic/home/w/shot.png");
    // A store path owned by someone the visitor is not: the link decides, not `me`.
    expect(contentUrlFor("/var/lib/clipboard-store/w/s/pasted-1.png", "")).toBe(
      "L/pic/var/lib/clipboard-store/w/s/pasted-1.png",
    );
  });
});
