/**
 * The Browser panel's controls (design 2026-10-01, "Taking control"): Take
 * control and Hand back for a viewer who may drive, nothing to press for one
 * who only watches, "<user> has control" while somebody else drives, and
 * input that only travels while this viewer holds control.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { BrowserPanel } from "../src/components/BrowserPanel";

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
  state: "live",
  tabs: [
    { id: "t1", url: "https://example.com/", title: "Example Domain" },
    { id: "t2", url: "https://other.example/", title: "Other" },
  ],
  agentTab: "t1",
  control: { holder: null, since: null, lapseAt: null },
  viewport: { w: 1280, h: 800 },
};

afterEach(() => {
  FakeSocket.last = null;
  vi.unstubAllGlobals();
});

function mount(canControl: boolean, phone = false) {
  vi.stubGlobal("WebSocket", FakeSocket);
  const onStop = vi.fn();
  const onClose = vi.fn();
  const r = render(() => (
    <BrowserPanel
      session="work"
      state={() => "live"}
      active={() => true}
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
    ws.host({ t: "control", holder: "viktor", since: 1, lapseAt: 600_001 });
    fireEvent.click(getByText("Hand back"));
    expect(ws.sent.at(-1)).toEqual({ t: "handBack" });
  });

  it("sends the address bar and the toolbar only while in control", () => {
    const { getByText, getByLabelText, ws } = mount(true);
    fireEvent.click(getByLabelText("Reload"));
    expect(ws.sent.some((m) => m.t === "reload")).toBe(false);
    fireEvent.click(getByText("Take control"));
    ws.host({ t: "control", holder: "viktor", since: 1, lapseAt: 600_001 });
    fireEvent.click(getByLabelText("Reload"));
    expect(ws.sent.at(-1)).toEqual({ t: "reload" });
    const address = getByLabelText("Address") as HTMLInputElement;
    fireEvent.input(address, { target: { value: "wikipedia.org" } });
    fireEvent.submit(address.form!);
    expect(ws.sent.at(-1)).toEqual({ t: "navigate", url: "wikipedia.org" });
  });

  it("says who else has control, and offers to take it over", () => {
    const { getByText, ws } = mount(true);
    ws.host({ t: "control", holder: "emo", since: 1, lapseAt: 600_001 });
    expect(getByText("emo has control")).toBeInTheDocument();
    expect(getByText("Take control")).toBeInTheDocument();
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
    r.ws.host({ t: "control", holder: "viktor", since: 1, lapseAt: 600_001 });
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
