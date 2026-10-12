import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("defaults to loopback, port 7690 and Authentik's identity header", () => {
    const config = loadConfig({}, "devvm");
    expect(config).toEqual({
      bind: "127.0.0.1",
      port: 7690,
      authHeader: "X-Authentik-Username",
      tmuxApiUrl: "http://127.0.0.1:7684",
      sessionEventsUrl: "http://127.0.0.1:7685",
      webDir: "/usr/lib/terminal-lobby/tl-t3-view/web",
      environmentLabel: "devvm",
      stateDir: undefined,
    });
  });

  it("keeps state where systemd's StateDirectory= puts it, or where TL_T3_VIEW_STATE_DIR says", () => {
    expect(loadConfig({ STATE_DIRECTORY: "/var/lib/tl-t3-view" }, "h").stateDir).toBe(
      "/var/lib/tl-t3-view",
    );
    expect(
      loadConfig({ STATE_DIRECTORY: "/var/lib/a:/var/lib/b", TL_T3_VIEW_STATE_DIR: "/tmp/s" }, "h")
        .stateDir,
    ).toBe("/tmp/s");
    expect(loadConfig({ STATE_DIRECTORY: "/var/lib/a:/var/lib/b" }, "h").stateDir).toBe(
      "/var/lib/a",
    );
  });

  it("reads the identity header name from TL_AUTH_HEADER, as every lobby service does", () => {
    expect(loadConfig({ TL_AUTH_HEADER: " X-Forwarded-User " }, "h").authHeader).toBe(
      "X-Forwarded-User",
    );
  });

  it("takes its own listen address and upstreams from TL_T3_VIEW_*", () => {
    const config = loadConfig(
      {
        TL_T3_VIEW_BIND: "10.0.10.10",
        TL_T3_VIEW_PORT: "17690",
        TL_T3_VIEW_TMUX_API: "http://127.0.0.1:17684/",
        TL_T3_VIEW_SESSION_EVENTS: "http://127.0.0.1:17685",
        TL_T3_VIEW_WEB_DIR: "/tmp/web",
        TL_T3_VIEW_LABEL: "lobby",
      },
      "h",
    );
    expect(config).toMatchObject({
      bind: "10.0.10.10",
      port: 17690,
      tmuxApiUrl: "http://127.0.0.1:17684",
      sessionEventsUrl: "http://127.0.0.1:17685",
      webDir: "/tmp/web",
      environmentLabel: "lobby",
    });
  });

  it("ignores TL_BIND, which belongs to the Go services", () => {
    expect(loadConfig({ TL_BIND: "0.0.0.0" }, "h").bind).toBe("127.0.0.1");
  });

  it.each(["0", "-1", "65536", "80a", ""])("refuses port %j", (port) => {
    expect(() => loadConfig({ TL_T3_VIEW_PORT: port }, "h")).toThrow(ConfigError);
  });

  it("refuses to start holding the proxy secret", () => {
    expect(() => loadConfig({ TL_PROXY_SECRET: "s3cret" }, "h")).toThrow(/TL_PROXY_SECRET/);
  });

  it("treats an empty TL_PROXY_SECRET as absent", () => {
    expect(() => loadConfig({ TL_PROXY_SECRET: "" }, "h")).not.toThrow();
  });
});
