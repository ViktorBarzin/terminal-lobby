import { describe, it, expect } from "vitest";
import { uploadBlob } from "../src/clipboard/upload";

const blob = (): Blob =>
  new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

const okResp = (path: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ path }),
    text: async () => "",
  }) as unknown as Response;

const errResp = (status: number, text: string): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => text,
  }) as unknown as Response;

/** a fetch stub that records the last call and returns a fixed response. */
function capturingFetch(resp: Response): {
  fetchImpl: typeof fetch;
  calls: () => number;
  lastUrl: () => string;
  lastBody: () => FormData;
} {
  let count = 0;
  let url = "";
  let body: FormData = new FormData();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    count++;
    url = String(input);
    body = (init?.body as FormData) ?? new FormData();
    return resp;
  }) as typeof fetch;
  return {
    fetchImpl,
    calls: () => count,
    lastUrl: () => url,
    lastBody: () => body,
  };
}

describe("uploadBlob — POST /clipboard/upload", () => {
  it("posts the blob under the given field + session and returns the path", async () => {
    const f = capturingFetch(okResp("/store/u/s/pasted-1.png"));
    const path = await uploadBlob(blob(), {
      session: "sess",
      field: "image",
      fetchImpl: f.fetchImpl,
    });
    expect(path).toBe("/store/u/s/pasted-1.png");
    expect(f.calls()).toBe(1);
    expect(f.lastUrl()).toBe("/clipboard/upload");
    const fd = f.lastBody();
    expect(fd.get("session")).toBe("sess");
    expect(fd.get("image")).toBeInstanceOf(Blob);
  });

  it("uses the `file` field + filename for non-image drops", async () => {
    const f = capturingFetch(okResp("/tmp/clipboard-files/x.pdf"));
    await uploadBlob(blob(), {
      session: "s",
      field: "file",
      filename: "notes.pdf",
      fetchImpl: f.fetchImpl,
    });
    const entry = f.lastBody().get("file");
    expect(entry).toBeInstanceOf(Blob);
    // when a filename is given, FormData records it as a File name.
    expect((entry as File).name).toBe("notes.pdf");
  });

  it("throws with the server body on a non-2xx response", async () => {
    const f = capturingFetch(errResp(400, "Not an image"));
    await expect(
      uploadBlob(blob(), { session: "s", field: "image", fetchImpl: f.fetchImpl }),
    ).rejects.toThrow("Not an image");
  });

  it("throws when the response carries no path", async () => {
    const f = capturingFetch(okResp(undefined));
    await expect(
      uploadBlob(blob(), { session: "s", field: "image", fetchImpl: f.fetchImpl }),
    ).rejects.toThrow(/path/);
  });
});
