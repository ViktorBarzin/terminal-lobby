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

function mount(canControl: boolean) {
  vi.stubGlobal("WebSocket", FakeSocket);
  const onStop = vi.fn();
  const onClose = vi.fn();
  const r = render(() => (
    <BrowserPanel
      session="work"
      state={() => "live"}
      active={() => true}
      canControl={() => canControl}
      phone={() => false}
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
