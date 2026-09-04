/**
 * Turning held files into tray chips, once there is a session to own them.
 *
 * The new-session composer cannot upload when a file is picked: the session it
 * belongs to does not exist until Enter is pressed, and nothing may be written
 * into a bucket for a session that may never be created. So the files are held
 * and this runs after the create, which is the one place both halves are known.
 */
import { describe, it, expect } from "vitest";
import { uploadAttachments } from "../src/clipboard/attach-files";

const file = (name: string, type: string): File =>
  new File([new Uint8Array([1, 2, 3])], name, { type });

/** A clipboard-upload that answers from a script, recording the form fields. */
function server(answers: readonly (Record<string, unknown> | number)[]) {
  const seen: { session: string; field: string; filename: string }[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const fd = init?.body as FormData;
    const field = fd.has("image") ? "image" : "file";
    const blob = fd.get(field) as File;
    seen.push({ session: String(fd.get("session")), field, filename: blob.name });
    const a = answers[Math.min(i++, answers.length - 1)] ?? { path: "/x", stored: true };
    if (typeof a === "number") return new Response("nope", { status: a });
    return new Response(JSON.stringify(a), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const notes = () => {
  const said: string[] = [];
  return { said, notify: (m: string) => void said.push(m) };
};

describe("uploadAttachments", () => {
  it("uploads into the session's own bucket and returns the chips", async () => {
    const s = server([
      { path: "/var/lib/clipboard-store/wizard/k7m2q9x4tp0z/shot-a1.png", stored: true },
    ]);
    const out = await uploadAttachments([file("shot.png", "image/png")], "k7m2q9x4tp0z", {
      fetchImpl: s.fetchImpl,
    });
    expect(s.seen).toEqual([
      { session: "k7m2q9x4tp0z", field: "image", filename: "shot.png" },
    ]);
    expect(out).toEqual([
      {
        path: "/var/lib/clipboard-store/wizard/k7m2q9x4tp0z/shot-a1.png",
        name: "shot-a1.png",
        kind: "image",
      },
    ]);
  });

  it("routes a document down the file field, where it is an ephemeral transfer", async () => {
    const s = server([{ path: "/tmp/clipboard-files/notes.pdf", stored: false }]);
    const n = notes();
    const out = await uploadAttachments([file("notes.pdf", "application/pdf")], "sess", {
      fetchImpl: s.fetchImpl,
      notify: n.notify,
    });
    expect(s.seen[0]!.field).toBe("file");
    // No chip: nothing can read it back, so it does not join the tray and does
    // not reach the prompt. The path is handed over instead, which is the only
    // honest thing to do with a file that did land somewhere.
    expect(out).toEqual([]);
    expect(n.said.join(" ")).toContain("/tmp/clipboard-files/notes.pdf");
  });

  it("keeps going past one failure and says which file it was", async () => {
    const s = server([500, { path: "/var/lib/clipboard-store/w/s/b.png", stored: true }]);
    const n = notes();
    const out = await uploadAttachments(
      [file("a.png", "image/png"), file("b.png", "image/png")],
      "s",
      { fetchImpl: s.fetchImpl, notify: n.notify },
    );
    expect(out.map((a) => a.name)).toEqual(["b.png"]);
    expect(n.said.join(" ")).toContain("a.png");
  });

  it("flags HEIC, which neither Chromium nor Claude's Read can open", async () => {
    const s = server([{ path: "/var/lib/clipboard-store/w/s/IMG_1.heic", stored: true }]);
    const n = notes();
    await uploadAttachments([file("IMG_1.HEIC", "image/heic")], "s", {
      fetchImpl: s.fetchImpl,
      notify: n.notify,
    });
    expect(n.said.join(" ")).toContain("HEIC");
  });

  it("uploads nothing for an empty list", async () => {
    const s = server([]);
    expect(await uploadAttachments([], "s", { fetchImpl: s.fetchImpl })).toEqual([]);
    expect(s.seen).toEqual([]);
  });
});
