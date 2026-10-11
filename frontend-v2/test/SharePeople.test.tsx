/**
 * The People half of the Share dialog against a stubbed tmux-api: who has
 * access to this session, inviting someone (Drive by default), switching a
 * person to Watch, and removing them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { SharePeople } from "../src/components/SharePeople";
import type { ShareView } from "../src/lib/shares-api";

interface Call {
  url: string;
  method: string;
  body?: string;
}

function stubApi(shares: ShareView[], users: string[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body as string | undefined });
      if (method !== "GET") return new Response(null, { status: method === "POST" ? 201 : 204 });
      if (url.includes("/users")) return new Response(JSON.stringify(users), { status: 200 });
      return new Response(JSON.stringify(shares), { status: 200 });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const share = (over: Partial<ShareView>): ShareView => ({
  owner: "viktor",
  name: "auth",
  guest: "emo",
  mode: "rw",
  ...over,
});

describe("SharePeople", () => {
  it("lists who may open this session, and not another session's guests", async () => {
    stubApi([share({}), share({ name: "other", guest: "bob" }), share({ owner: "emo", guest: "viktor" })], []);
    render(() => <SharePeople name="auth" me="viktor" />);
    await screen.findByText("emo");
    expect(screen.queryByText("bob")).toBeNull();
    expect(screen.getByRole("radio", { name: "Drive" }).getAttribute("aria-checked")).toBe("true");
  });

  it("says when only you can open it", async () => {
    stubApi([], []);
    render(() => <SharePeople name="auth" me="viktor" />);
    await screen.findByText("Only you can open this session.");
  });

  it("invites someone to drive by default", async () => {
    const calls = stubApi([], ["bob", "emo", "viktor"]);
    render(() => <SharePeople name="auth" me="viktor" />);
    const pick = (await screen.findByLabelText("Invite")) as HTMLSelectElement;
    // You are not offered to yourself.
    expect([...pick.options].map((o) => o.value)).toEqual(["", "bob", "emo"]);
    fireEvent.change(pick, { target: { value: "emo" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toMatch(/\/shares$/);
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ name: "auth", guest: "emo", mode: "rw" });
  });

  it("moves a person to watching, and removes them", async () => {
    const calls = stubApi([share({})], []);
    render(() => <SharePeople name="auth" me="viktor" />);
    await screen.findByText("emo");
    fireEvent.click(screen.getByRole("radio", { name: "Watch" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "POST")?.body ?? "{}").mode).toBe("ro");
    fireEvent.click(screen.getByRole("button", { name: "Remove emo" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")?.url).toMatch(/\/shares\/viktor\/auth\/emo$/);
  });

  it("offers the session's link once someone has access", async () => {
    stubApi([share({})], []);
    render(() => <SharePeople name="auth" me="viktor" />);
    const field = (await screen.findByLabelText("Session link for the people above")) as HTMLInputElement;
    expect(field.value).toMatch(/\/#auth@viktor$/);
  });
});
