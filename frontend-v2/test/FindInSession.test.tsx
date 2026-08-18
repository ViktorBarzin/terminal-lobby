import { render, fireEvent } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { FindInSession } from "../src/components/FindInSession";
import type { SearchHit } from "../src/types/events";

const hits: SearchHit[] = [
  {
    id: 4102,
    kind: "tool_result",
    tool: "Bash",
    field: "result",
    snippet: "mkdir: cannot create directory: permission denied",
  },
  {
    id: 3980,
    kind: "user",
    field: "message",
    snippet: "why is it saying permission denied",
  },
];

function mount(over: Partial<Parameters<typeof FindInSession>[0]> = {}) {
  const onSearch = vi.fn(async () => hits);
  const onJump = vi.fn(async () => {});
  const onClose = vi.fn();
  const r = render(() => (
    <FindInSession onSearch={onSearch} onJump={onJump} onClose={onClose} {...over} />
  ));
  const input = r.container.querySelector<HTMLInputElement>(".tl-cp-input")!;
  return { ...r, input, onSearch, onJump, onClose };
}

const enter = (el: Element) => fireEvent.keyDown(el, { key: "Enter" });

describe("<FindInSession>", () => {
  // Searching a 28.9 MB transcript once per keystroke would be a scan per
  // letter; the whole point of running it on the server is that it is one pass.
  it("does not search while you type — only on Enter", async () => {
    const { input, onSearch } = mount();
    fireEvent.input(input, { target: { value: "permission denied" } });
    expect(onSearch).not.toHaveBeenCalled();

    enter(input);
    await Promise.resolve();
    expect(onSearch).toHaveBeenCalledWith("permission denied");
  });

  it("ignores an empty query rather than asking for every event", async () => {
    const { input, onSearch } = mount();
    fireEvent.input(input, { target: { value: "   " } });
    enter(input);
    await Promise.resolve();
    expect(onSearch).not.toHaveBeenCalled();
  });

  it("lists what came back, saying where each hit was", async () => {
    const { input, container } = mount();
    fireEvent.input(input, { target: { value: "permission denied" } });
    enter(input);
    await Promise.resolve();
    await Promise.resolve();

    const rows = [...container.querySelectorAll(".tl-find-hit")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Bash · result");
    expect(rows[0]!.textContent).toContain("mkdir: cannot create");
    expect(rows[1]!.textContent).toContain("you");
  });

  it("jumps to the hit's event and closes, so the reader lands on the row", async () => {
    const { input, container, onJump, onClose } = mount();
    fireEvent.input(input, { target: { value: "permission denied" } });
    enter(input);
    await Promise.resolve();
    await Promise.resolve();

    (container.querySelector(".tl-find-hit") as HTMLElement).click();
    expect(onClose).toHaveBeenCalled();
    expect(onJump).toHaveBeenCalledWith(4102);
  });

  // One Enter runs the query, the next opens what the arrows landed on — a find
  // box with a mode switch in it would be one more thing to remember.
  it("Enter searches, then opens the selected hit", async () => {
    const { input, onJump } = mount();
    fireEvent.input(input, { target: { value: "permission denied" } });
    enter(input);
    await Promise.resolve();
    await Promise.resolve();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    enter(input);
    expect(onJump).toHaveBeenCalledWith(3980);
  });

  it("says so plainly when a session has no match", async () => {
    const { input, container } = mount({ onSearch: async () => [] });
    fireEvent.input(input, { target: { value: "nothing here" } });
    enter(input);
    await Promise.resolve();
    await Promise.resolve();
    expect(container.textContent).toContain("No matches in this session.");
  });

  it("closes on Escape", () => {
    const { input, onClose } = mount();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
