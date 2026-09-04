/**
 * A menu missing its per-user half has to say so.
 *
 * `store.commands` returned `[]` for a failed fetch and `[]` for a user with no
 * skills, so the two were indistinguishable and the menu looked complete either
 * way. Measured 2026-09-04: with `/commands/{session}` unrouted, GET returned
 * 9,406 bytes of `text/html`, `res.json()` threw, the catch returned `[]`, and
 * the `/` menu offered the 95 built-ins and none of this user's 34 skills, with
 * nothing logged. The production IngressRoute's own comment anticipates the
 * degradation; what was missing was any way to see it had happened.
 */
import { describe, it, expect } from "vitest";
import { readCatalogue } from "../src/store/catalogue";

const res = (body: unknown, init: { ok?: boolean; status?: number } = {}): Response =>
  ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => {
      if (typeof body === "string") throw new SyntaxError("Unexpected token < in JSON");
      return body;
    },
  }) as unknown as Response;

describe("readCatalogue", () => {
  it("reads a real catalogue", async () => {
    const got = await readCatalogue(async () =>
      res([
        { name: "/grilling", description: "Interview relentlessly.", source: "skill" },
        { name: "/doc-tone", description: "Tone pass.", source: "skill" },
      ]),
    );
    expect(got.ok).toBe(true);
    expect(got.commands.map((c) => c.name)).toEqual(["/grilling", "/doc-tone"]);
  });

  it("tells an empty catalogue from a broken one", async () => {
    const empty = await readCatalogue(async () => res([]));
    expect(empty).toEqual({ commands: [], ok: true });
  });

  it("reports the html the ingress serves when a route is missing", async () => {
    const got = await readCatalogue(async () => res("<!doctype html><html>…"));
    expect(got).toEqual({ commands: [], ok: false });
  });

  it("reports a non-2xx", async () => {
    const got = await readCatalogue(async () => res(null, { ok: false, status: 404 }));
    expect(got).toEqual({ commands: [], ok: false });
  });

  it("reports a fetch that never arrived", async () => {
    const got = await readCatalogue(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    expect(got).toEqual({ commands: [], ok: false });
  });

  it("reports a body that is JSON but not a list", async () => {
    const got = await readCatalogue(async () => res({ error: "nope" }));
    expect(got).toEqual({ commands: [], ok: false });
  });

  it("treats a null body as an empty catalogue, which is what the service sends", async () => {
    // Go's encoding/json writes `null` for a nil slice, and a user with no
    // skills and no commands is exactly that.
    const got = await readCatalogue(async () => res(null));
    expect(got).toEqual({ commands: [], ok: true });
  });

  it("drops a row with no name rather than offering a bare slash", async () => {
    const got = await readCatalogue(async () =>
      res([{ name: "/real", source: "skill" }, { source: "skill" }, { name: "" }]),
    );
    expect(got.ok).toBe(true);
    expect(got.commands.map((c) => c.name)).toEqual(["/real"]);
  });
});
