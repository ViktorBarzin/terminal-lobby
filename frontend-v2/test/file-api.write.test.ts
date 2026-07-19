import { describe, it, expect, vi, afterEach } from "vitest";
import {
  FileApiError,
  writeErrorMessage,
  writeFile,
} from "../src/lib/file-api";

afterEach(() => vi.unstubAllGlobals());

/** A fetch stub that records the last call and returns a fixed response. */
function stubFetch(resp: Partial<Response> & { status: number; ok: boolean }): {
  lastUrl: () => string;
  lastInit: () => RequestInit | undefined;
  calls: () => number;
} {
  let url = "";
  let init: RequestInit | undefined;
  let count = 0;
  const cancel = vi.fn(async () => {});
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, i?: RequestInit) => {
    count++;
    url = String(input);
    init = i;
    return { body: { cancel }, ...resp } as unknown as Response;
  }) as typeof fetch);
  return { lastUrl: () => url, lastInit: () => init, calls: () => count };
}

describe("writeFile — POST /files/write", () => {
  it("posts JSON {path, content} same-origin and resolves on 204", async () => {
    const f = stubFetch({ ok: true, status: 204 });
    await expect(writeFile("/home/u/a.ts", "const a = 1;")).resolves.toBeUndefined();
    expect(f.calls()).toBe(1);
    expect(f.lastUrl()).toBe("/files/write");
    const init = f.lastInit()!;
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      path: "/home/u/a.ts",
      content: "const a = 1;",
    });
  });

  it("resolves on any 2xx (200 as well as 204)", async () => {
    stubFetch({ ok: true, status: 200 });
    await expect(writeFile("/home/u/a.ts", "x")).resolves.toBeUndefined();
  });

  it.each([
    [413, /too large/i],
    [403, /not authorized/i],
    [404, /parent folder/i],
    [400, /regular file/i],
    [500, /HTTP 500/i],
  ])("maps status %i to a FileApiError with a distinct message", async (status, re) => {
    stubFetch({ ok: false, status });
    await expect(writeFile("/home/u/a.ts", "x")).rejects.toMatchObject({
      name: "FileApiError",
      status,
    });
    await stubAndExpectMessage(status, re);
  });
});

async function stubAndExpectMessage(status: number, re: RegExp): Promise<void> {
  stubFetch({ ok: false, status });
  try {
    await writeFile("/home/u/a.ts", "x");
    throw new Error("expected writeFile to reject");
  } catch (err) {
    expect(err).toBeInstanceOf(FileApiError);
    expect((err as FileApiError).message).toMatch(re);
  }
}

describe("writeErrorMessage", () => {
  it("gives distinct, human messages per status", () => {
    expect(writeErrorMessage(413)).toMatch(/too large/i);
    expect(writeErrorMessage(403)).toMatch(/not authorized/i);
    expect(writeErrorMessage(401)).toMatch(/not authorized/i);
    expect(writeErrorMessage(404)).toMatch(/parent folder/i);
    expect(writeErrorMessage(400)).toMatch(/regular file/i);
    expect(writeErrorMessage(418)).toMatch(/HTTP 418/);
  });
});
