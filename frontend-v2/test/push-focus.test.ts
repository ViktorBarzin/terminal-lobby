/**
 * What this device tells the server it has ON SCREEN, all the way to the wire.
 *
 * The other three "is this in front of you" suppressions — the unseen mark, the
 * icon badge, the foreground banner — moved to the whole visible set when tiles
 * shipped. Push did not, because the wire carried one name: `{"session":"auth"}`
 * against a server that compared it for equality. A two-tile workspace with
 * `auth` focused therefore left `deploy` fully notifiable, and a push landed on
 * the phone about a session being read on the desktop in front of it.
 *
 * The push module is NOT mocked here, unlike test/notify.focus.wiring.test.ts:
 * the defect lived in the request body, so the thing worth asserting is the
 * bytes, and a mock of `reportFocus` is exactly the shape of assertion that let
 * this ship. What is stubbed is the browser under it — a service worker, a
 * subscription, and fetch — so the real `reportFocus` runs and its POST is read
 * off the stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { reportFocus, PUSH_SUBS_API } from "../src/pwa/push";
import { createNotificationSystem } from "../src/notify/notifications";
import type { TitleSession } from "../src/notify/title";
import type { FaviconKind } from "../src/notify/favicon";

// Canvas-free, as every test that mounts this system does: jsdom has no 2d
// context and the badger is not what is under test.
vi.mock("../src/notify/favicon", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/notify/favicon")>();
  return { ...actual, createFaviconBadger: () => ({ apply: (_: FaviconKind) => {} }) };
});

const ENDPOINT = "https://push.example/abc";
const FOCUS_API = "/api/sessions/push/focus";

/** One focus report as it left the page. */
interface FocusPost {
  endpoint: string;
  sessions: string[];
  session: string;
}

/**
 * A service worker container complete enough for the modules that reach for one
 * on mount, not only for the one under test: pwa/register.ts registers /sw.js
 * and listens for its messages the moment `"serviceWorker" in navigator` is
 * true, so a container with `ready` alone throws on mount and the reporter never
 * runs. `ready` resolves to whatever registration the caller wants.
 */
function stubServiceWorker(registration: unknown): void {
  Object.defineProperty(navigator, "serviceWorker", {
    value: {
      ready: Promise.resolve(registration),
      register: async () => registration,
      getRegistration: async () => registration,
      addEventListener: () => {},
      removeEventListener: () => {},
      controller: null,
    },
    configurable: true,
    writable: true,
  });
}

/**
 * A browser the server pushes to: a service worker with a subscription, and a
 * subscription list from the server that contains this device's endpoint (which
 * is what `deviceSubscriptionState` — and therefore the whole reporter — waits
 * for before it says anything at all).
 */
function stubPushBrowser(): FocusPost[] {
  const sub = { endpoint: ENDPOINT, toJSON: () => ({ endpoint: ENDPOINT }) };
  stubServiceWorker({ pushManager: { getSubscription: async () => sub } });
  (window as unknown as { PushManager: unknown }).PushManager = class {};
  const posts: FocusPost[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === PUSH_SUBS_API) return new Response(JSON.stringify([{ endpoint: ENDPOINT }]));
      if (url === FOCUS_API && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as FocusPost);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    }),
  );
  return posts;
}

/** Let the device-subscription check and the report promise settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

interface Harness {
  setSelected: (s: string | null) => void;
  setVisible: (v: readonly string[]) => void;
  dispose: () => void;
}

/**
 * The system as the shell wires it: `selected` is the tile taking keystrokes and
 * `visible` is every tile on screen (App.tsx passes exactly these two). Omit
 * `visible` entirely for the lobby, where a lone session is the whole screen.
 */
function mount(selected: string | null, visible?: readonly string[]): Harness {
  const [sessions] = createSignal<TitleSession[]>([]);
  const [sel, setSelected] = createSignal<string | null>(selected);
  const [vis, setVisible] = createSignal<readonly string[]>(visible ?? []);
  const [loading] = createSignal(false);
  let dispose!: () => void;
  createRoot((d) => {
    dispose = d;
    createNotificationSystem({
      sessions,
      selected: sel,
      ...(visible === undefined ? {} : { visible: vis }),
      osUser: () => "wizard",
      notifyPrefs: () => ({ onDone: true, onAwaiting: true }),
      loading,
      toast: () => {},
      onActivateSession: () => {},
    });
  });
  return { setSelected, setVisible, dispose };
}

describe("the focus report on the wire", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(document, "hasFocus", { value: () => true, configurable: true });
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });
  afterEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(navigator as object, "serviceWorker");
    Reflect.deleteProperty(window as object, "PushManager");
    vi.unstubAllGlobals();
  });

  // The defect, in one assertion: BOTH names leave the page.
  it("a two-tile workspace reports both sessions", async () => {
    const posts = stubPushBrowser();
    const app = mount("auth", ["auth", "deploy"]);
    await settle();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.sessions).toEqual(["auth", "deploy"]);
    app.dispose();
  });

  // The compatibility half, and the reason `session` did not simply become an
  // array. The SPA and tmux-api deploy separately: a server that predates this
  // change reads `session` and nothing else, and it must still suppress the
  // focused tile rather than fall back to "showing nothing" and push about the
  // session under the reader's eyes.
  it("names the focused tile too, for a server that only understands one", async () => {
    const posts = stubPushBrowser();
    const app = mount("auth", ["auth", "deploy"]);
    await settle();
    expect(posts[0]).toEqual({
      endpoint: ENDPOINT,
      sessions: ["auth", "deploy"],
      session: "auth",
    });
    app.dispose();
  });

  // Splitting a session in changes what you can SEE without changing which tile
  // has the keyboard, so an effect watching only `selected` never fires. That is
  // what made this invisible from inside the app: the first report was right and
  // no later one was ever sent.
  it("reports again when a tile is added without the focus moving", async () => {
    const posts = stubPushBrowser();
    const app = mount("auth", ["auth"]);
    await settle();
    expect(posts.map((p) => p.sessions)).toEqual([["auth"]]);

    app.setVisible(["auth", "deploy"]);
    await settle();
    expect(posts.map((p) => p.sessions)).toEqual([["auth"], ["auth", "deploy"]]);
    app.dispose();
  });

  // And closing one un-reports it at once, or a session nobody can see any more
  // stays silenced for the rest of the server's 90-second TTL.
  it("drops a closed tile from the next report", async () => {
    const posts = stubPushBrowser();
    const app = mount("auth", ["auth", "deploy"]);
    await settle();
    app.setVisible(["auth"]);
    await settle();
    expect(posts.map((p) => p.sessions)).toEqual([["auth", "deploy"], ["auth"]]);
    app.dispose();
  });

  // A drag that swaps two tiles moves no session on or off the screen. The
  // report is a SET, so it is not news — and a POST per divider drag would be.
  it("says nothing when the same two tiles change places", async () => {
    const posts = stubPushBrowser();
    const app = mount("auth", ["auth", "deploy"]);
    await settle();
    app.setVisible(["deploy", "auth"]);
    await settle();
    expect(posts).toHaveLength(1);
    app.dispose();
  });

  // Moving the keyboard between two tiles changes nothing a current server
  // reads — both are in the set either way — but a server that predates this
  // change reads `session` alone, and it has to follow the focus the way it
  // always has. One POST per focus change is what this has always sent.
  it("reports again when the keyboard moves between two visible tiles", async () => {
    const posts = stubPushBrowser();
    const app = mount("auth", ["auth", "deploy"]);
    await settle();
    app.setSelected("deploy");
    await settle();
    expect(posts.map((p) => p.session)).toEqual(["auth", "deploy"]);
    expect(posts.map((p) => p.sessions)).toEqual([
      ["auth", "deploy"],
      ["auth", "deploy"],
    ]);
    app.dispose();
  });

  // The lobby, unchanged: no visible set supplied, and the selected session is
  // the whole screen. A workspace of one is a bare leaf (ADR-0027), so this is
  // the same statement the report has always made.
  it("reports a lone session exactly as it always did", async () => {
    const posts = stubPushBrowser();
    const app = mount("billing");
    await settle();
    expect(posts[0]).toEqual({
      endpoint: ENDPOINT,
      sessions: ["billing"],
      session: "billing",
    });
    app.dispose();
  });

  // Looking away is announced rather than waited out, and it must clear the
  // WHOLE set: a window sitting behind another one is not reading any of it.
  it("reports nothing on screen when the window loses focus", async () => {
    const posts = stubPushBrowser();
    const app = mount("auth", ["auth", "deploy"]);
    await settle();
    Object.defineProperty(document, "hasFocus", { value: () => false, configurable: true });
    window.dispatchEvent(new Event("blur"));
    await settle();
    expect(posts[1]).toEqual({ endpoint: ENDPOINT, sessions: [], session: "" });
    app.dispose();
  });
});

/**
 * The transport on its own, without the app on top: the body shape is the
 * contract two separately-deployed halves meet on, so it is worth one test that
 * cannot be affected by how the page decides what to say.
 */
describe("reportFocus", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator as object, "serviceWorker");
    Reflect.deleteProperty(window as object, "PushManager");
    vi.unstubAllGlobals();
  });

  it("puts the set and the focused name in one body", async () => {
    const posts = stubPushBrowser();
    expect(await reportFocus(["auth", "deploy"], "auth")).toBe(true);
    expect(posts).toEqual([{ endpoint: ENDPOINT, sessions: ["auth", "deploy"], session: "auth" }]);
  });

  // A device with no subscription has nothing to report under, and says so by
  // answering false rather than throwing — the caller retries on the next tick.
  it("stays quiet on a browser with no push subscription", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      value: { ready: Promise.resolve({ pushManager: { getSubscription: async () => null } }) },
      configurable: true,
      writable: true,
    });
    (window as unknown as { PushManager: unknown }).PushManager = class {};
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await reportFocus(["auth"], "auth")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
