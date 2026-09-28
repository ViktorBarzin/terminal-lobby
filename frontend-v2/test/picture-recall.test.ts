/**
 * ↑ gives back a picture message with its picture, on any browser.
 *
 * Claude Code records a picture pasted at the end of a prompt as "[Image #N]"
 * at its start, which names nothing the composer can attach again. The
 * browser that sent it keeps its own copy (store/sentPictures.ts); any other
 * browser gave back the literal "[Image #2]Again, colour? one word", and
 * Enter sent that with no picture while Claude answered from memory (deployed
 * review round 4, 2026-09-28). The CLI follows such a prompt with a note
 * naming the picture's file, which session-events passes on as a
 * picture-source marker.
 */
import { describe, it, expect } from "vitest";
import type { Event, SessionState } from "../src/types/events";
import { deriveRows, promptHistory } from "../src/components/timeline.logic";

let seq = 0;
const ev = (e: Partial<Event> & { kind: Event["kind"] }): Event => ({
  id: ++seq,
  session: "demo",
  turnId: "t1",
  ...e,
});

const PATH = "/var/lib/clipboard-store/wizard/qa-skimg/pasted-20260928-203521-6c64bc5c.png";

describe("a picture the CLI numbered", () => {
  it("comes back from history as the words and the picture's file", () => {
    const events = [
      ev({ kind: "user", body: "[Image #2]Name this colour, one word, no tools." }),
      ev({ kind: "meta", meta: "picture-source", body: PATH }),
    ];
    expect(promptHistory(events)).toEqual([`Name this colour, one word, no tools. ${PATH}`]);
  });

  it("puts each numbered picture's file back, in order", () => {
    const events = [
      ev({ kind: "user", body: "[Image #3][Image #4]and these two?" }),
      ev({
        kind: "meta",
        meta: "picture-source",
        body: "/var/lib/clipboard-store/w/s/a.png\n/var/lib/clipboard-store/w/s/b.png",
      }),
    ];
    expect(promptHistory(events)).toEqual([
      "and these two? /var/lib/clipboard-store/w/s/a.png /var/lib/clipboard-store/w/s/b.png",
    ]);
  });

  it("keeps what the server's history already gave back", () => {
    const seed: SessionState = { at: 0, queue: [], prompts: [`Name this colour. ${PATH}`] };
    expect(promptHistory([], seed)).toEqual([`Name this colour. ${PATH}`]);
  });

  it("leaves a prompt with no placeholder alone", () => {
    const events = [
      ev({ kind: "user", body: `look at ${PATH}` }),
      ev({ kind: "meta", meta: "picture-source", body: PATH }),
    ];
    expect(promptHistory(events)).toEqual([`look at ${PATH}`]);
  });

  it("draws no row for the marker", () => {
    const rows = deriveRows([
      ev({ kind: "user", body: "[Image #2]Name this colour." }),
      ev({ kind: "meta", meta: "picture-source", body: PATH }),
    ]);
    expect(rows.some((r) => r.kind === "meta")).toBe(false);
  });
});
