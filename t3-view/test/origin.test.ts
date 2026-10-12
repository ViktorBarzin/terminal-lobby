import { describe, expect, it } from "vitest";

import { frameAncestors, isCrossSiteWrite, isSameOriginUpgrade } from "../src/origin.ts";

const HOST = "t3view.viktorbarzin.me";

describe("isSameOriginUpgrade", () => {
  it("accepts a handshake whose Origin names the sidecar's own host", () => {
    expect(isSameOriginUpgrade({ host: HOST, origin: `https://${HOST}` })).toBe(true);
    expect(isSameOriginUpgrade({ host: "127.0.0.1:17691", origin: "http://127.0.0.1:17691" })).toBe(
      true,
    );
  });

  it("compares hosts without regard to case, as session-events sameOrigin does", () => {
    expect(isSameOriginUpgrade({ host: "T3View.viktorbarzin.me", origin: `https://${HOST}` })).toBe(
      true,
    );
  });

  it.each([
    ["a sibling page on the same site", "https://pages.viktorbarzin.me"],
    ["the lobby itself", "https://terminal.viktorbarzin.me"],
    ["another site", "https://evil.example"],
    ["the same host on another port", `https://${HOST}:8443`],
    ["an opaque origin", "null"],
    ["not a URL", "t3view.viktorbarzin.me"],
  ])("refuses %s", (_name, origin) => {
    expect(isSameOriginUpgrade({ host: HOST, origin })).toBe(false);
  });

  it("refuses a handshake with no Origin or no Host", () => {
    expect(isSameOriginUpgrade({ host: HOST })).toBe(false);
    expect(isSameOriginUpgrade({ origin: `https://${HOST}` })).toBe(false);
  });
});

describe("isCrossSiteWrite", () => {
  it("lets every GET and HEAD through, since none of them changes state", () => {
    expect(isCrossSiteWrite("GET", { "sec-fetch-site": "cross-site" })).toBe(false);
    expect(isCrossSiteWrite("HEAD", { "sec-fetch-site": "same-site" })).toBe(false);
  });

  it("refuses a write a browser marks as coming from another origin", () => {
    expect(isCrossSiteWrite("POST", { "sec-fetch-site": "same-site" })).toBe(true);
    expect(isCrossSiteWrite("POST", { "sec-fetch-site": "cross-site" })).toBe(true);
  });

  it("allows a write from the sidecar's own pages, and from a client that sends no fetch metadata", () => {
    expect(isCrossSiteWrite("POST", { "sec-fetch-site": "same-origin" })).toBe(false);
    expect(isCrossSiteWrite("POST", { "sec-fetch-site": "none" })).toBe(false);
    expect(isCrossSiteWrite("POST", {})).toBe(false);
  });
});

describe("frameAncestors", () => {
  it("lets only the lobby beside the sidecar frame its pages", () => {
    expect(frameAncestors(HOST)).toBe("frame-ancestors https://terminal.viktorbarzin.me");
    expect(frameAncestors("T3View.Example.org:443")).toBe(
      "frame-ancestors https://terminal.example.org",
    );
  });

  it("lets a loopback lobby frame a loopback sidecar, for the local check", () => {
    for (const host of ["127.0.0.1:17691", "localhost:17691", "[::1]:17691"]) {
      expect(frameAncestors(host)).toBe(
        "frame-ancestors http://localhost:* http://127.0.0.1:* http://[::1]:*",
      );
    }
  });

  it("lets nothing frame a host with no lobby beside it", () => {
    for (const host of [undefined, "", "devvm", "viktorbarzin.me", "10.0.10.10:7690"]) {
      expect(frameAncestors(host)).toBe("frame-ancestors 'none'");
    }
  });
});
