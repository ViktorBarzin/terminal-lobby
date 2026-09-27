/**
 * Tapping an agent in the panel opens its own transcript in the session's
 * place (design step 6). The drill-in is view state, not an address: the
 * session's own timeline stays mounted behind it, hidden, so Back finds the
 * reader where they left it, and the panel stays beside it with the open
 * agent marked, so another agent is one tap away.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { TextView } from "../src/components/TextView";
import type { AgentSnapshot } from "../src/components/agents.logic";
import type { AgentInfo, Event } from "../src/types/events";

interface Fake {
  url: string;
  closed: boolean;
}

const g = globalThis as unknown as { EventSource: unknown; ResizeObserver: unknown };
const realES = g.EventSource;
const realRO = g.ResizeObserver;
const sources: Fake[] = [];

function installEventSource(): void {
  sources.length = 0;
  g.EventSource = class {
    closed = false;
    onopen = null;
    onerror = null;
    onmessage = null;
    constructor(public url: string) {
      sources.push(this);
    }
    close(): void {
      this.closed = true;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
  };
}

const T0 = 1_790_000_000_000;

const agent = (id: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  description: `agent ${id}`,
  name: "",
  agentType: "",
  model: "",
  color: "blue",
  depth: 1,
  parentId: "",
  toolUseId: "",
  workflowId: "",
  phaseIndex: 0,
  label: "",
  state: "running",
  startedAt: T0,
  lastActivityAt: T0,
  endedAt: 0,
  tool: "Read",
  toolDetail: "",
  toolCalls: 1,
  outputTokens: 10,
  result: "",
  ...over,
});

const snap = (agents: AgentInfo[]): AgentSnapshot => ({
  set: { at: T0, agents, workflows: [] },
  skew: 0,
});

const SESSION: Event[] = [
  { id: 1, kind: "user", session: "demo", turnId: "t1", body: "spawn two agents" },
  { id: 2, kind: "text", session: "demo", turnId: "t1", body: "Two agents are on it." },
];

function mount(opts: { agents: AgentSnapshot; session?: string }) {
  installEventSource();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const [agents, setAgents] = createSignal<AgentSnapshot | null>(opts.agents);
  const [parked, setParked] = createSignal(false);
  const r = render(() => (
    <TextView
      session={opts.session ?? "demo"}
      events={SESSION}
      agents={agents}
      parked={parked()}
      pending={[]}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
    />
  ));
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => r.container.querySelector<T>(sel);
  const entry = (id: string) =>
    [...r.container.querySelectorAll<HTMLElement>("[data-agent]")].find(
      (e) => e.dataset.agent === id,
    );
  const tap = (id: string) => fireEvent.click(entry(id)!.querySelector("button.tl-agent-open")!);
  const session = () => q('.tl-timeline[aria-label="Session transcript"]')!;
  return { ...r, q, entry, tap, session, setAgents, setParked };
}

afterEach(() => {
  g.EventSource = realES;
  g.ResizeObserver = realRO;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("drilling into an agent", () => {
  it("opens the tapped agent's transcript in the session's place", () => {
    const v = mount({ agents: snap([agent("a1"), agent("a2")]) });
    v.tap("a2");
    // Mounted still, only hidden: going back is free and keeps the scroll.
    expect(v.session().classList.contains("tl-hidden")).toBe(true);
    expect(v.q(".tl-drill .tl-drill-title")?.textContent).toBe("agent a2");
    expect(sources[sources.length - 1]!.url).toBe("/events/demo/agents/a2?rev=1");
    // Beside the panel, which says which agent is open.
    expect(v.q(".tl-drill")?.parentElement).toBe(v.q(".tl-agents")?.parentElement);
    expect(v.entry("a2")?.dataset.open).toBe("true");
    expect(v.entry("a1")?.dataset.open).toBe("false");
  });

  it("goes back to the session with Back, and gives the focus to the entry", () => {
    const v = mount({ agents: snap([agent("a1")]) });
    v.tap("a1");
    const stream = sources[sources.length - 1]!;
    fireEvent.click(v.q("button.tl-drill-back")!);
    expect(v.q(".tl-drill")).toBeNull();
    expect(v.session().classList.contains("tl-hidden")).toBe(false);
    expect(stream.closed).toBe(true);
    expect(document.activeElement).toBe(v.entry("a1")?.querySelector("button"));
  });

  it("goes back on Escape, but not while the reader is typing", () => {
    const v = mount({ agents: snap([agent("a1")]) });
    v.tap("a1");
    fireEvent.keyDown(v.q("textarea")!, { key: "Escape" });
    expect(v.q(".tl-drill")).not.toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(v.q(".tl-drill")).toBeNull();
  });

  it("leaves an Escape another part of the app has already claimed", () => {
    const v = mount({ agents: snap([agent("a1")]) });
    v.tap("a1");
    const claim = (e: KeyboardEvent) => e.preventDefault();
    document.addEventListener("keydown", claim, true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    document.removeEventListener("keydown", claim, true);
    expect(v.q(".tl-drill")).not.toBeNull();
  });

  it("stays open when the panel goes, since the reader is still reading", () => {
    const v = mount({ agents: snap([agent("a1")]) });
    v.tap("a1");
    v.setAgents(snap([agent("a1", { state: "done", endedAt: T0 + 9000 })]));
    expect(v.q(".tl-agents")).toBeNull();
    expect(v.q(".tl-drill-meta")?.textContent).toContain("finished");
    // And after the agent has left the set altogether, it keeps what it knew.
    v.setAgents(snap([]));
    expect(v.q(".tl-drill-title")?.textContent).toBe("agent a1");
  });

  it("moves to another agent when its entry is tapped", () => {
    const v = mount({ agents: snap([agent("a1"), agent("a2")]) });
    v.tap("a1");
    const first = sources[sources.length - 1]!;
    v.tap("a2");
    expect(first.closed).toBe(true);
    expect(v.container.querySelectorAll(".tl-drill")).toHaveLength(1);
    expect(v.q(".tl-drill-title")?.textContent).toBe("agent a2");
  });

  it("closes when a find-in-session jump lands on one of the session's rows", () => {
    // jsdom lays nothing out and has no scrollIntoView at all.
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: () => {},
    });
    try {
      const v = mount({ agents: snap([agent("a1")]) });
      v.tap("a1");
      const jump = (window as unknown as { __tlScrollToEvent: (id: number) => boolean })
        .__tlScrollToEvent;
      expect(jump(2)).toBe(true);
      expect(v.q(".tl-drill")).toBeNull();
      expect(v.session().classList.contains("tl-hidden")).toBe(false);
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("parks its stream with the session's", () => {
    const v = mount({ agents: snap([agent("a1")]) });
    v.tap("a1");
    const stream = sources[sources.length - 1]!;
    v.setParked(true);
    expect(stream.closed).toBe(true);
  });

  it("opens from the strip when the view is too narrow for the margin", () => {
    g.ResizeObserver = class {
      constructor(private readonly cb: () => void) {}
      observe(el: HTMLElement): void {
        Object.defineProperty(el, "clientWidth", { configurable: true, value: 400 });
        this.cb();
      }
      disconnect(): void {}
    };
    const v = mount({ agents: snap([agent("a1")]) });
    expect(v.q(".tl-agents")?.getAttribute("data-form")).toBe("strip");
    fireEvent.click(v.q("button.tl-agents-bar")!);
    v.tap("a1");
    expect(v.q(".tl-drill-title")?.textContent).toBe("agent a1");
    expect(v.q(".tl-agents-list")).toBeNull();
    // The tap folded the entry away, so the way back lands on the strip.
    fireEvent.click(v.q("button.tl-drill-back")!);
    expect(v.q(".tl-drill")).toBeNull();
    expect(document.activeElement).toBe(v.q("button.tl-agents-bar"));
  });

  it("offers nothing to open without a session to read it from", () => {
    const v = mount({ agents: snap([agent("a1")]), session: "" });
    expect(v.entry("a1")?.querySelector("button")?.hasAttribute("disabled")).toBe(true);
  });
});

/** Stub a scroller's geometry (jsdom lays nothing out) and scroll it up the
 *  way a reader does, with a wheel turn first. */
function scrolledUp(el: HTMLElement): { top: number } {
  const geom = { top: 700 };
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => geom.top,
    set: (v: number) => {
      geom.top = Math.max(0, Math.min(v, 700));
    },
  });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 1000 });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 300 });
  fireEvent.wheel(el, { deltaY: -120 });
  geom.top = 100;
  fireEvent.scroll(el);
  return geom;
}

describe("the Latest band while an agent is open", () => {
  it("follows the drill-in's own timeline, and takes that one to its end", () => {
    const v = mount({ agents: snap([agent("a1")]) });
    scrolledUp(v.session());
    expect(v.q(".tl-latest"), "the session's reader scrolled up").not.toBeNull();

    v.tap("a1");
    expect(v.q(".tl-latest"), "the agent's transcript opens at its end").toBeNull();

    const drill = v.q(".tl-drill .tl-timeline")!;
    const geom = scrolledUp(drill);
    expect(v.q(".tl-latest")).not.toBeNull();
    fireEvent.click(v.q(".tl-latest")!);
    expect(geom.top).toBe(700);
    expect(v.q(".tl-latest")).toBeNull();

    fireEvent.click(v.q("button.tl-drill-back")!);
    expect(v.q(".tl-latest"), "back at the session, still scrolled up").not.toBeNull();
  });
});
