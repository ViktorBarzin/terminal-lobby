/**
 * The Browser panel's controls (design 2026-10-01, "Taking control"): Take
 * control and Hand back for a viewer who may drive, nothing to press for one
 * who only watches, "<user> has control" while somebody else drives, and
 * input that only travels while this viewer holds control.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { BrowserPanel } from "../src/components/BrowserPanel";
import { track } from "../src/telemetry/track";

vi.mock("../src/telemetry/track", async (original) => ({
  ...(await original<typeof import("../src/telemetry/track")>()),
  track: vi.fn(),
}));

class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  host(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const hello = {
  t: "hello",
  you: "c1",
  state: "live",
  tabs: [
    { id: "t1", url: "https://example.com/", title: "Example Domain" },
    { id: "t2", url: "https://other.example/", title: "Other" },
  ],
  agentTab: "t1",
  control: { holder: null, holderId: null, since: null, lapseAt: null },
  viewport: { w: 1280, h: 800 },
};
/** Control held by this panel's own connection ("you" in the hello). */
const mine = { t: "control", holder: "viktor", holderId: "c1", since: 1, lapseAt: 600_001 };

afterEach(() => {
  sessionStorage.clear();
  FakeSocket.last = null;
  vi.unstubAllGlobals();
  vi.mocked(track).mockClear();
});

function mount(canControl: boolean, phone = false, onScreen: () => boolean = () => true) {
  vi.stubGlobal("WebSocket", FakeSocket);
  const onStop = vi.fn();
  const onClose = vi.fn();
  const r = render(() => (
    <BrowserPanel
      session="work"
      state={() => "live"}
      onScreen={onScreen}
      canControl={() => canControl}
      phone={() => phone}
      onStop={onStop}
      onClose={onClose}
    />
  ));
  const ws = FakeSocket.last!;
  ws.open();
  ws.host(hello);
  return { ...r, ws, onStop, onClose };
}

describe("<BrowserPanel>", () => {
  it("shows the agent's tab, its address and the tab strip", () => {
    const { getByText, getByLabelText, getAllByRole } = mount(true);
    expect(getByText("Example Domain", { selector: ".tl-browser-title" })).toBeInTheDocument();
    expect((getByLabelText("Address") as HTMLInputElement).value).toBe("https://example.com/");
    expect(getAllByRole("tab")).toHaveLength(2);
  });

  it("watches another tab when one is picked", () => {
    const { getAllByRole, ws } = mount(true);
    fireEvent.click(getAllByRole("tab")[1]!);
    expect(ws.sent.at(-1)).toEqual({ t: "subscribe", tab: "t2" });
  });

  it("takes control and hands it back", () => {
    const { getByText, ws } = mount(true);
    fireEvent.click(getByText("Take control"));
    expect(ws.sent.at(-1)).toEqual({ t: "takeControl" });
    ws.host(mine);
    fireEvent.click(getByText("Hand back"));
    expect(ws.sent.at(-1)).toEqual({ t: "handBack" });
  });

  it("sends the address bar and the toolbar only while in control", () => {
    const { getByText, getByLabelText, ws } = mount(true);
    fireEvent.click(getByLabelText("Reload"));
    expect(ws.sent.some((m) => m.t === "reload")).toBe(false);
    fireEvent.click(getByText("Take control"));
    ws.host(mine);
    fireEvent.click(getByLabelText("Reload"));
    expect(ws.sent.at(-1)).toEqual({ t: "reload" });
    const address = getByLabelText("Address") as HTMLInputElement;
    fireEvent.input(address, { target: { value: "wikipedia.org" } });
    fireEvent.submit(address.form!);
    expect(ws.sent.at(-1)).toEqual({ t: "navigate", url: "wikipedia.org" });
  });

  it("says who else has control, and offers to take it over", () => {
    const { getByText, ws } = mount(true);
    ws.host({ t: "control", holder: "emo", holderId: "c9", since: 1, lapseAt: 600_001 });
    expect(getByText("emo has control")).toBeInTheDocument();
    expect(getByText("Take control")).toBeInTheDocument();
  });

  it("knows it holds control from the host's ids, without having asked on this connection", () => {
    // A reload keeps control with the old connection until it lapses; a panel
    // whose own connection holds it (the hello says so) drives at once.
    const { getByText, queryByText, getByLabelText, ws } = mount(true);
    ws.host(mine);
    expect(getByText("Hand back")).toBeInTheDocument();
    expect(queryByText(/has control/)).toBeNull();
    fireEvent.click(getByLabelText("Reload"));
    expect(ws.sent.at(-1)).toEqual({ t: "reload" });
  });

  it("treats the same person on another device as someone else, named as the lobby knows them", () => {
    const { getByText, getByLabelText, ws } = mount(true);
    fireEvent.click(getByText("Take control"));
    ws.host(mine);
    // The phone took over: the name is the same, the connection is not.
    ws.host({ t: "control", holder: "viktor", holderId: "c2", since: 1, lapseAt: 600_001 });
    expect(getByText("viktor has control")).toBeInTheDocument();
    expect(getByText("Take control")).toBeInTheDocument();
    const before = ws.sent.length;
    fireEvent.click(getByLabelText("Reload"));
    expect(ws.sent.length).toBe(before);
  });

  it("offers a watch-only viewer nothing to drive with", () => {
    const { queryByText } = mount(false);
    expect(queryByText("Take control")).toBeNull();
    expect(queryByText("Stop")).toBeInTheDocument();
  });

  it("stops the turn and closes", () => {
    const { getByText, getByLabelText, onStop, onClose } = mount(true);
    fireEvent.click(getByText("Stop"));
    expect(onStop).toHaveBeenCalledTimes(1);
    fireEvent.click(getByLabelText("Close the browser panel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says when the browser has closed", () => {
    const { getByText, ws } = mount(true);
    ws.host({ t: "state", state: "closed" });
    expect(getByText("The browser closed.")).toBeInTheDocument();
  });
});

/**
 * The panel's stream on Viktor's iPhone (telemetry 2026-10-02): it opened,
 * went quiet about 3s later, closed when the 15s linger ran out, and four Take
 * control presses after that went nowhere. The panel no longer asks an
 * IntersectionObserver or the text stream's parking, and a press cannot be
 * made on a stream that is not there to carry it.
 */
describe("<BrowserPanel> stream", () => {
  const hide = (state: "hidden" | "visible") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("keeps streaming when an IntersectionObserver says the page is out of sight", () => {
    class Unseen {
      constructor(private readonly cb: IntersectionObserverCallback) {}
      observe(): void {
        this.cb(
          [{ isIntersecting: false } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect(): void {}
    }
    vi.stubGlobal("IntersectionObserver", Unseen);
    const { ws } = mount(true);
    expect(ws.sent).toContainEqual({ t: "subscribe", tab: null });
    expect(ws.sent.some((m) => m.t === "unsubscribe")).toBe(false);
  });

  it("stops the frames when its session leaves the screen", () => {
    const [onScreen, setOnScreen] = createSignal(true);
    const { ws } = mount(true, false, onScreen);
    setOnScreen(false);
    expect(ws.sent.at(-1)).toEqual({ t: "unsubscribe" });
  });

  it("keeps streaming for the person in control until the page is hidden", () => {
    const [onScreen, setOnScreen] = createSignal(true);
    const { ws } = mount(true, false, onScreen);
    ws.host(mine);
    setOnScreen(false);
    expect(ws.sent.some((m) => m.t === "unsubscribe")).toBe(false);
    hide("hidden");
    expect(ws.sent.at(-1)).toEqual({ t: "unsubscribe" });
    hide("visible");
    expect(ws.sent.at(-1)).toEqual({ t: "subscribe", tab: null });
  });

  it("says Connecting… on a disabled button until the host has said hello", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const { getByRole } = render(() => (
      <BrowserPanel
        session="work"
        state={() => "live"}
        onScreen={() => true}
        canControl={() => true}
        phone={() => false}
        onStop={() => undefined}
        onClose={() => undefined}
      />
    ));
    const ws = FakeSocket.last!;
    const button = () => getByRole("button", { name: /Connecting|Take control/ });
    expect(button()).toHaveTextContent("Connecting…");
    expect(button()).toBeDisabled();
    ws.open();
    expect(button()).toBeDisabled();
    fireEvent.click(button());
    expect(ws.sent.some((m) => m.t === "takeControl")).toBe(false);
    expect(track).not.toHaveBeenCalled();
    ws.host(hello);
    expect(button()).toHaveTextContent("Take control");
    expect(button()).toBeEnabled();
  });

  it("goes back to Connecting… when the stream drops, Hand back included", () => {
    const { getByText, ws } = mount(true);
    ws.host(mine);
    expect(getByText("Hand back")).toBeEnabled();
    ws.readyState = 3;
    ws.onclose?.();
    expect(getByText("Connecting…")).toBeDisabled();
  });

  it("records one take_control per press, and sends one takeControl", () => {
    const { getByText, ws } = mount(true);
    fireEvent.click(getByText("Take control"));
    // A second tap before the host answers is the same press: nothing more.
    fireEvent.click(getByText("Taking control…"));
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("browser.take_control");
    expect(ws.sent.filter((m) => m.t === "takeControl")).toHaveLength(1);
    ws.host(mine);
    fireEvent.click(getByText("Hand back"));
    ws.host({ t: "control", holder: null, holderId: null, since: null, lapseAt: null });
    fireEvent.click(getByText("Take control"));
    expect(vi.mocked(track).mock.calls.filter(([e]) => e === "browser.take_control")).toHaveLength(
      2,
    );
  });

  it("lets Take control be pressed again when the host does not answer", () => {
    vi.useFakeTimers();
    try {
      const { getByText, ws } = mount(true);
      fireEvent.click(getByText("Take control"));
      vi.advanceTimersByTime(5_000);
      fireEvent.click(getByText("Take control"));
      expect(ws.sent.filter((m) => m.t === "takeControl")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * A tap on a phone (review 2026-10-01). The tap clicks the page and focuses
 * the hidden field the soft keyboard types into. Chrome then sends the tap's
 * compat mousedown after touchend, and a mousedown on the focusable stage moved
 * the focus off that field straight away: measured in Chrome's touch
 * emulation, activeElement ended on .tl-browser-stage and typing went nowhere.
 * jsdom has no focus-on-mousedown, so `press` plays the browser's part: a
 * mousedown whose default is not cancelled focuses the stage, as Chrome does.
 */
describe("<BrowserPanel> on a phone", () => {
  const drivePhone = () => {
    const r = mount(true, true);
    fireEvent.click(r.getByText("Take control"));
    r.ws.host(mine);
    r.ws.host({ t: "frame", tab: "t1", jpeg: "AAAA", w: 1280, h: 800 });
    const stage = r.container.querySelector<HTMLDivElement>(".tl-browser-stage")!;
    const img = r.container.querySelector<HTMLImageElement>(".tl-browser-frame")!;
    img.getBoundingClientRect = () => new DOMRect(0, 0, 1280, 800);
    return {
      ...r,
      stage,
      ime: () => r.container.querySelector<HTMLInputElement>(".tl-browser-ime")!,
    };
  };
  const tap = (stage: Element) => {
    const at = { pointerId: 7, pointerType: "touch", clientX: 200, clientY: 100 };
    fireEvent.pointerDown(stage, at);
    fireEvent.pointerUp(stage, at);
  };
  const press = (stage: HTMLElement, el: Element, type: "mousedown" | "click"): boolean => {
    const through = el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    if (type === "mousedown" && through) stage.focus();
    return through;
  };

  it("clicks the page and keeps the keyboard's field focused through the tap's mousedown", () => {
    const { stage, ime, ws } = drivePhone();
    const canvas = stage.querySelector(".tl-browser-canvas")!;
    tap(stage);
    expect(ws.sent.at(-1)).toEqual({
      t: "mouse",
      type: "click",
      x: 200,
      y: 100,
      button: "left",
      clickCount: 1,
    });
    expect(document.activeElement).toBe(ime());
    expect(press(stage, canvas, "mousedown")).toBe(false);
    expect(document.activeElement).toBe(ime());
    expect(press(stage, canvas, "click")).toBe(false);
  });

  it("sends what the soft keyboard types", () => {
    const { stage, ws } = drivePhone();
    tap(stage);
    press(stage, stage.querySelector(".tl-browser-canvas")!, "mousedown");
    // The keyboard types into whatever holds the focus.
    const field = document.activeElement as HTMLInputElement;
    field.value = "Sofia";
    fireEvent.input(field);
    expect(ws.sent.at(-1)).toEqual({ t: "insertText", text: "Sofia" });
  });

  it("holds only the tap's own mousedown", () => {
    const { stage } = drivePhone();
    const canvas = stage.querySelector(".tl-browser-canvas")!;
    tap(stage);
    press(stage, canvas, "mousedown");
    press(stage, canvas, "click");
    expect(press(stage, canvas, "mousedown")).toBe(true);
  });

  it("gives up the hold when no mousedown comes", () => {
    vi.useFakeTimers();
    try {
      const { stage } = drivePhone();
      tap(stage);
      vi.advanceTimersByTime(1000);
      expect(press(stage, stage.querySelector(".tl-browser-canvas")!, "mousedown")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Popups a headless frame does not show (design, "What a headless frame does
 * not show"): the host tells the person in control about a select's list, a
 * JavaScript dialog or a file chooser, and the panel draws its own.
 */
describe("<BrowserPanel> popups", () => {
  const driving = (phone = false) => {
    const r = mount(true, phone);
    fireEvent.click(r.getByText("Take control"));
    r.ws.host(mine);
    r.ws.host({ t: "frame", tab: "t1", jpeg: "AAAA", w: 1280, h: 800 });
    const img = r.container.querySelector<HTMLImageElement>(".tl-browser-frame")!;
    img.getBoundingClientRect = () => new DOMRect(0, 0, 1280, 800);
    const stage = r.container.querySelector<HTMLDivElement>(".tl-browser-stage")!;
    stage.getBoundingClientRect = () => new DOMRect(0, 0, 1280, 800);
    return r;
  };
  const list = (multiple: boolean) => ({
    t: "popup",
    kind: "select",
    tab: "t1",
    multiple,
    rect: { x: 10, y: 10, w: 200, h: 30 },
    options: [
      { value: "a", label: "Apple", selected: true, disabled: false },
      { value: "b", label: "Banana", selected: false, disabled: false },
      { value: "c", label: "Cherry", selected: false, disabled: true },
    ],
  });

  it("lists a select's options over the page, and picking one chooses it", () => {
    const { ws, getByRole, queryByRole } = driving();
    ws.host(list(false));
    const box = getByRole("listbox", { name: "Choose an option" }).parentElement!;
    expect(getByRole("option", { name: "Apple" })).toHaveAttribute("aria-selected", "true");
    expect(getByRole("option", { name: "Cherry" })).toBeDisabled();
    expect(box.style.left).toBe("10px");
    expect(box.style.top).toBe("42px");
    fireEvent.click(getByRole("option", { name: "Banana" }));
    expect(ws.sent.at(-1)).toEqual({ t: "choose", value: "b", tab: "t1" });
    expect(queryByRole("listbox")).toBeNull();
  });

  it("chooses several in a multiple select with Done", () => {
    const { ws, getByRole } = driving();
    ws.host(list(true));
    fireEvent.click(getByRole("option", { name: "Banana" }));
    fireEvent.click(getByRole("option", { name: "Apple" }));
    expect(ws.sent.some((m) => m.t === "choose")).toBe(false);
    fireEvent.click(getByRole("button", { name: "Done" }));
    expect(ws.sent.at(-1)).toEqual({ t: "choose", values: ["b"], tab: "t1" });
  });

  it("closes a list without choosing on Escape or a press beside it", () => {
    const { ws, getByRole, queryByRole, container } = driving();
    ws.host(list(false));
    fireEvent.keyDown(getByRole("listbox"), { key: "Escape" });
    expect(queryByRole("listbox")).toBeNull();
    ws.host(list(false));
    fireEvent.pointerDown(container.querySelector(".tl-browser-popup-backdrop")!);
    expect(queryByRole("listbox")).toBeNull();
    expect(ws.sent.some((m) => m.t === "choose" || m.t === "mouse")).toBe(false);
  });

  it("shows a select's list as a sheet across a phone", () => {
    const { ws, getByRole } = driving(true);
    ws.host(list(false));
    const box = getByRole("listbox").parentElement!;
    expect(box).toHaveAttribute("data-sheet");
    expect(box.style.left).toBe("");
  });

  it("shows a prompt and sends what was typed with OK", () => {
    const { ws, getByRole, queryByRole } = driving();
    ws.host({
      t: "popup",
      kind: "dialog",
      tab: "t1",
      type: "prompt",
      message: "Your name?",
      defaultValue: "Ada",
    });
    const dialog = getByRole("alertdialog", { name: "The page asks" });
    expect(dialog).toHaveTextContent("Your name?");
    const field = getByRole("textbox", { name: "Answer" }) as HTMLInputElement;
    expect(field.value).toBe("Ada");
    fireEvent.input(field, { target: { value: "Grace" } });
    fireEvent.click(getByRole("button", { name: "OK" }));
    expect(ws.sent.at(-1)).toEqual({ t: "dialog", accept: true, text: "Grace", tab: "t1" });
    expect(queryByRole("alertdialog")).toBeNull();
  });

  it("answers a confirm with Cancel, and an alert has only OK", () => {
    const { ws, getByRole, queryByRole } = driving();
    ws.host({
      t: "popup",
      kind: "dialog",
      tab: "t1",
      type: "confirm",
      message: "Leave?",
      defaultValue: "",
    });
    expect(queryByRole("textbox", { name: "Answer" })).toBeNull();
    fireEvent.click(getByRole("button", { name: "Cancel" }));
    expect(ws.sent.at(-1)).toEqual({ t: "dialog", accept: false, tab: "t1" });
    ws.host({
      t: "popup",
      kind: "dialog",
      tab: "t1",
      type: "alert",
      message: "Saved",
      defaultValue: "",
    });
    expect(queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(getByRole("button", { name: "OK" }));
    expect(ws.sent.at(-1)).toEqual({ t: "dialog", accept: true, tab: "t1" });
  });

  it("says a file chooser is not supported", () => {
    const { ws, getByText, getByRole, queryByText } = driving();
    ws.host({ t: "popup", kind: "filechooser", tab: "t1" });
    expect(getByText("File upload is not supported in the browser panel.")).toBeInTheDocument();
    fireEvent.click(getByRole("button", { name: "Dismiss" }));
    expect(queryByText("File upload is not supported in the browser panel.")).toBeNull();
  });

  it("covers only the page with a dialog, so Stop, Hand back and close stay pressable", () => {
    const { ws, getByRole, getByText, getByLabelText, container, onStop, onClose } = driving();
    ws.host({
      t: "popup",
      kind: "dialog",
      tab: "t1",
      type: "confirm",
      message: "Leave?",
      defaultValue: "",
    });
    const layer = getByRole("alertdialog").parentElement!;
    const page = container.querySelector(".tl-browser-pagebox")!;
    const stage = container.querySelector(".tl-browser-stage")!;
    // Inside the box that holds the page, beside the stage rather than in it,
    // so a press on the dialog never reaches the stage's handlers.
    expect(layer.parentElement).toBe(page);
    expect(stage.parentElement).toBe(page);
    expect(stage.contains(layer)).toBe(false);
    for (const el of [
      getByText("Stop"),
      getByText("Hand back"),
      getByLabelText("Close the browser panel"),
    ]) {
      expect(page.contains(el)).toBe(false);
    }
    fireEvent.click(getByText("Stop"));
    expect(onStop).toHaveBeenCalledTimes(1);
    fireEvent.click(getByText("Hand back"));
    expect(ws.sent.at(-1)).toEqual({ t: "handBack" });
    fireEvent.click(getByLabelText("Close the browser panel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("goes away when the host says the popup is gone", () => {
    const { ws, queryByRole } = driving();
    ws.host({
      t: "popup",
      kind: "dialog",
      tab: "t1",
      type: "alert",
      message: "Saved",
      defaultValue: "",
    });
    ws.host({ t: "popup", kind: "none", tab: "t1" });
    expect(queryByRole("alertdialog")).toBeNull();
  });

  it("draws nothing for a viewer who does not hold control", () => {
    const { ws, queryByRole } = mount(true);
    ws.host({ t: "frame", tab: "t1", jpeg: "AAAA", w: 1280, h: 800 });
    ws.host(list(false));
    ws.host({
      t: "popup",
      kind: "dialog",
      tab: "t1",
      type: "alert",
      message: "Saved",
      defaultValue: "",
    });
    expect(queryByRole("listbox")).toBeNull();
    expect(queryByRole("alertdialog")).toBeNull();
  });
});

/**
 * Control across a new stream instance. Closing and reopening the panel, or
 * iOS reloading a backgrounded home-screen lobby, made a fresh stream that
 * remembered no "you", so the person lost control and saw their own name as
 * the one in control. The panel keeps its last "you" in sessionStorage.
 */
describe("<BrowserPanel> resuming control in a new stream", () => {
  const held = (id: string) => ({ holder: "viktor", holderId: id, since: 1, lapseAt: 600_001 });
  const openPanel = () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const r = render(() => (
      <BrowserPanel
        session="work"
        state={() => "live"}
        onScreen={() => true}
        canControl={() => true}
        phone={() => false}
        onStop={() => undefined}
        onClose={() => undefined}
      />
    ));
    const ws = FakeSocket.last!;
    ws.open();
    return { ...r, ws };
  };
  const realStorage = Object.getOwnPropertyDescriptor(window, "sessionStorage");
  afterEach(() => {
    if (realStorage) Object.defineProperty(window, "sessionStorage", realStorage);
    sessionStorage.clear();
  });

  it("names the closed panel's connection when it opens again, and keeps control", () => {
    const first = openPanel();
    first.ws.host({ ...hello, you: "c1", control: held("c1") });
    expect(first.getByText("Hand back")).toBeInTheDocument();
    first.unmount();

    const again = openPanel();
    again.ws.host({ ...hello, you: "c2", control: held("c1") });
    expect(again.ws.sent[0]).toEqual({ t: "resume", prev: "c1" });
    // Until the host moves it, the old connection holds control.
    expect(again.getByText("viktor has control")).toBeInTheDocument();
    again.ws.host({ t: "control", ...held("c2") });
    expect(again.getByText("Hand back")).toBeInTheDocument();
    expect(again.queryByText(/has control/)).toBeNull();
  });

  it("names it after a reload, from what the tab kept", () => {
    // A reload keeps sessionStorage and nothing else this panel held.
    sessionStorage.setItem("tl.browser.you:/work", "c1");
    const { ws } = openPanel();
    ws.host({ ...hello, you: "c2", control: held("c1") });
    expect(ws.sent[0]).toEqual({ t: "resume", prev: "c1" });
  });

  it("works without sessionStorage, resuming within its own stream", () => {
    vi.useFakeTimers();
    try {
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        get: () => {
          throw new DOMException("blocked", "SecurityError");
        },
      });
      const { ws, getByText } = openPanel();
      ws.host({ ...hello, you: "c1", control: held("c1") });
      expect(getByText("Hand back")).toBeInTheDocument();
      ws.readyState = 3;
      ws.onclose?.();
      vi.advanceTimersByTime(2_000);
      const next = FakeSocket.last!;
      expect(next).not.toBe(ws);
      next.open();
      next.host({ ...hello, you: "c2", control: held("c1") });
      expect(next.sent[0]).toEqual({ t: "resume", prev: "c1" });
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The Browser cursor (Viktor, 2026-10-02): one arrow over the page, where the
 * host says the mouse is, whoever drives it. It glides from one report to the
 * next and a ring pulses where a press lands.
 */
describe("<BrowserPanel> cursor", () => {
  const watching = () => {
    const r = mount(true);
    r.ws.host({ t: "frame", tab: "t1", jpeg: "AAAA", w: 1280, h: 800 });
    const img = r.container.querySelector<HTMLImageElement>(".tl-browser-frame")!;
    // A 640x600 box: the picture is drawn at half scale with 100px bars.
    img.getBoundingClientRect = () => new DOMRect(30, 40, 640, 600);
    const cursor = () => r.container.querySelector<HTMLElement>(".tl-browser-cursor");
    const ripples = () => r.container.querySelectorAll(".tl-browser-ripple");
    const at = (x: number, y: number, kind = "move", tab = "t1") =>
      r.ws.host({ t: "cursor", tab, x, y, kind });
    return { ...r, cursor, ripples, at };
  };

  it("is hidden until the host says where the mouse is on the shown tab", () => {
    const { cursor, at } = watching();
    expect(cursor()).toBeNull();
    at(10, 10, "move", "t2");
    expect(cursor()).toBeNull();
    at(640, 400);
    expect(cursor()).not.toBeNull();
  });

  it("sits on the picture, past the letterbox bar, in the picture's own pixels", () => {
    const { cursor, at } = watching();
    at(640, 400);
    expect(cursor()!.style.transform).toBe("translate(320px, 300px)");
    at(0, 0);
    expect(cursor()!.style.transform).toBe("translate(0px, 100px)");
  });

  it("appears in place, then glides to each new position", () => {
    const { cursor, at } = watching();
    at(640, 400);
    expect(cursor()).not.toHaveAttribute("data-glide");
    at(700, 400);
    expect(cursor()).toHaveAttribute("data-glide");
  });

  it("appears in place on another tab rather than gliding across from the last one", () => {
    const { cursor, at, getAllByRole } = watching();
    at(640, 400);
    at(700, 400);
    fireEvent.click(getAllByRole("tab")[1]!);
    expect(cursor()).toBeNull();
    at(100, 100, "move", "t2");
    expect(cursor()).not.toHaveAttribute("data-glide");
  });

  it("rings where a press lands, once for a press and its click", () => {
    const { ripples, at } = watching();
    at(640, 400);
    expect(ripples()).toHaveLength(0);
    at(640, 400, "down");
    at(640, 400, "up");
    at(640, 400, "click");
    expect(ripples()).toHaveLength(1);
    expect((ripples()[0] as HTMLElement).style.left).toBe("320px");
    expect((ripples()[0] as HTMLElement).style.top).toBe("300px");
  });

  it("lets the ring go once it has played", () => {
    vi.useFakeTimers();
    try {
      const { ripples, at } = watching();
      at(640, 400, "down");
      vi.advanceTimersByTime(1_000);
      expect(ripples()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is drawn for a watcher too, and stays out of the way of presses", () => {
    const { cursor, at, container } = watching();
    at(640, 400);
    const layer = container.querySelector(".tl-browser-cursor-layer")!;
    expect(layer).toHaveAttribute("aria-hidden", "true");
    expect(layer.contains(cursor())).toBe(true);
    expect(container.querySelector(".tl-browser-canvas")!.contains(layer)).toBe(true);
  });
});

/**
 * One cursor for the person in control (Viktor, 2026-10-02). On a desktop
 * they saw their own pointer and the drawn cursor trailing it a round trip
 * later.
 */
describe("<BrowserPanel> the cursor of the person in control", () => {
  const driving = (phone = false) => {
    const r = mount(true, phone);
    r.ws.host(mine);
    r.ws.host({ t: "frame", tab: "t1", jpeg: "AAAA", w: 1280, h: 800 });
    const stage = r.container.querySelector<HTMLDivElement>(".tl-browser-stage")!;
    const img = r.container.querySelector<HTMLImageElement>(".tl-browser-frame")!;
    // A 640x600 box: the picture is drawn at half scale with 100px bars, so
    // client (350, 340) is the page's (640, 400), drawn at (320, 300).
    img.getBoundingClientRect = () => new DOMRect(30, 40, 640, 600);
    const cursor = () => r.container.querySelector<HTMLElement>(".tl-browser-cursor");
    const ripples = () => r.container.querySelectorAll(".tl-browser-ripple");
    const echo = (x: number, y: number, kind = "move") =>
      r.ws.host({ t: "cursor", tab: "t1", x, y, kind });
    const mouse = { pointerId: 1, pointerType: "mouse" };
    return { ...r, stage, cursor, ripples, echo, mouse };
  };

  it("draws the cursor at the mouse at once, hides the real pointer, and ignores the echo", () => {
    const { stage, cursor, echo, mouse } = driving();
    echo(0, 0);
    fireEvent.pointerMove(stage, { ...mouse, clientX: 350, clientY: 340 });
    expect(cursor()!.style.transform).toBe("translate(320px, 300px)");
    expect(cursor()).not.toHaveAttribute("data-glide");
    expect(stage).toHaveAttribute("data-own-cursor");
    // The host's echo of an earlier move arrives a round trip later.
    echo(100, 100);
    expect(cursor()!.style.transform).toBe("translate(320px, 300px)");
    fireEvent.pointerMove(stage, { ...mouse, clientX: 360, clientY: 340 });
    expect(cursor()!.style.transform).toBe("translate(330px, 300px)");
    expect(cursor()).not.toHaveAttribute("data-glide");
  });

  it("goes back to the host's cursor when the mouse leaves the page", () => {
    const { stage, cursor, echo, mouse } = driving();
    fireEvent.pointerMove(stage, { ...mouse, clientX: 350, clientY: 340 });
    echo(100, 100);
    fireEvent.pointerLeave(stage, mouse);
    expect(stage).not.toHaveAttribute("data-own-cursor");
    expect(cursor()!.style.transform).toBe("translate(50px, 150px)");
  });

  it("goes back to the host's cursor when control ends", () => {
    const { stage, cursor, echo, mouse, ws } = driving();
    fireEvent.pointerMove(stage, { ...mouse, clientX: 350, clientY: 340 });
    echo(100, 100);
    ws.host({ t: "control", holder: null, holderId: null, since: null, lapseAt: null });
    expect(stage).not.toHaveAttribute("data-own-cursor");
    expect(cursor()!.style.transform).toBe("translate(50px, 150px)");
  });

  it("shows the real pointer, and no drawn one, beside the picture", () => {
    const { stage, cursor, echo, mouse } = driving();
    echo(100, 100);
    fireEvent.pointerMove(stage, { ...mouse, clientX: 350, clientY: 100 });
    expect(stage).not.toHaveAttribute("data-own-cursor");
    expect(cursor()).toBeNull();
  });

  it("rings a press at once, and once, whatever the host echoes after", () => {
    const { stage, ripples, echo, mouse } = driving();
    fireEvent.pointerMove(stage, { ...mouse, clientX: 350, clientY: 340 });
    fireEvent.pointerDown(stage, { ...mouse, button: 0, clientX: 350, clientY: 340 });
    expect(ripples()).toHaveLength(1);
    expect((ripples()[0] as HTMLElement).style.left).toBe("320px");
    fireEvent.pointerUp(stage, { ...mouse, button: 0, clientX: 350, clientY: 340 });
    // The mouse may have left before the echo comes; it is still this press.
    fireEvent.pointerLeave(stage, mouse);
    echo(640, 400, "down");
    echo(640, 400, "up");
    echo(640, 400, "click");
    expect(ripples()).toHaveLength(1);
  });

  it("leaves a watcher's real pointer alone and draws the host's cursor", () => {
    const r = mount(true);
    r.ws.host({ t: "frame", tab: "t1", jpeg: "AAAA", w: 1280, h: 800 });
    const stage = r.container.querySelector<HTMLDivElement>(".tl-browser-stage")!;
    const img = r.container.querySelector<HTMLImageElement>(".tl-browser-frame")!;
    img.getBoundingClientRect = () => new DOMRect(30, 40, 640, 600);
    r.ws.host({ t: "cursor", tab: "t1", x: 100, y: 100, kind: "move" });
    fireEvent.pointerMove(stage, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 350,
      clientY: 340,
    });
    expect(stage).not.toHaveAttribute("data-own-cursor");
    expect(r.container.querySelector<HTMLElement>(".tl-browser-cursor")!.style.transform).toBe(
      "translate(50px, 150px)",
    );
  });
});
