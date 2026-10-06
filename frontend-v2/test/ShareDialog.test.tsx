/**
 * The Share dialog end to end against a stubbed tmux-api: it lists only this
 * session's links, refuses the long lifetimes once "Can type" is chosen and
 * warns about it, and shows a new link's URL once with the copy-it-now note.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { ShareDialog } from "../src/components/ShareDialog";
import type { LinkView, Session } from "../src/types/lobby";

const SESSION: Session = {
  name: "auth",
  id: "$4",
  title: "Auth work",
  attached: 1,
  lastActivity: 0,
  created: 0,
};

const link = (over: Partial<LinkView>): LinkView => ({
  id: "L1",
  session: "auth",
  sessionId: "$4",
  mode: "ro",
  createdAt: 0,
  expiresAt: 0,
  visitors: [],
  ...over,
});

interface Call {
  url: string;
  method: string;
  body?: string;
}

function stubApi(links: LinkView[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body as string | undefined });
      if (method === "POST") {
        return new Response(
          JSON.stringify({ link: link({ id: "NEW", mode: "rw" }), token: "secret-token" }),
          { status: 201 },
        );
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify(links), { status: 200 });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () =>
  render(() => (
    <ShareDialog
      target={{ id: "$4", name: "auth" }}
      sessions={() => [SESSION]}
      onClose={() => {}}
    />
  ));

describe("ShareDialog", () => {
  it("lists this session's links with their visitors, and not another session's", async () => {
    stubApi([
      link({
        id: "L1",
        mode: "rw",
        note: "for Ana",
        visitors: [
          { guest: 1, mode: "rw", since: 0 },
          { guest: 2, mode: "ro", since: 0 },
        ],
      }),
      link({ id: "L2", session: "other", sessionId: "$9", note: "elsewhere" }),
    ]);
    mount();
    expect(await screen.findByText("for Ana")).toBeTruthy();
    expect(screen.getByText("guest 1 (driving), guest 2")).toBeTruthy();
    expect(screen.getByText("Drive")).toBeTruthy();
    expect(screen.getByText("until revoked")).toBeTruthy();
    expect(screen.queryByText("elsewhere")).toBeNull();
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Share Auth work");
  });

  it("disables 7 days and Until revoked for Can type, and warns", async () => {
    stubApi([]);
    mount();
    await screen.findByText("No public links to this session.");
    fireEvent.click(screen.getByRole("radio", { name: "7 days" }));
    fireEvent.click(screen.getByRole("radio", { name: "Can type" }));
    const seven = screen.getByRole("radio", { name: "7 days" }) as HTMLButtonElement;
    const never = screen.getByRole("radio", { name: "Until revoked" }) as HTMLButtonElement;
    expect(seven.disabled).toBe(true);
    expect(never.disabled).toBe(true);
    // The chosen 7 days dropped to the longest lifetime a typing link allows.
    expect(screen.getByRole("radio", { name: "24 hours" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("note").textContent).toMatch(/shell as you/);
  });

  it("creates a link and shows its URL once, with the can't-be-shown-again note", async () => {
    const calls = stubApi([]);
    mount();
    await screen.findByText("No public links to this session.");
    fireEvent.click(screen.getByRole("radio", { name: "Can type" }));
    fireEvent.input(screen.getByLabelText("Note"), { target: { value: "pairing" } });
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    const field = (await screen.findByLabelText("Link URL")) as HTMLInputElement;
    expect(field.value).toBe(`${window.location.origin}/s/#secret-token`);
    expect(screen.getByText(/it can't be shown again/)).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/sessions/links");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({
      name: "auth",
      mode: "rw",
      ttl: "24h",
      note: "pairing",
    });
  });

  it("revokes a link by id", async () => {
    const calls = stubApi([link({ id: "L1", note: "for Ana" })]);
    mount();
    await screen.findByText("for Ana");
    fireEvent.click(screen.getByRole("button", { name: "Revoke watch link" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/sessions/links/L1")).toBe(
        true,
      ),
    );
  });
});
