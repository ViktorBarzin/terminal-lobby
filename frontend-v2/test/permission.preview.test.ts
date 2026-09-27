/**
 * What the permission card shows in its well: the call the prompt asks about,
 * read from the transcript, rather than the pane's lines.
 *
 * Found live on 2026-09-27: for an Edit that appended a function, the well
 * showed the file name and the two unchanged lines above the change, and the
 * added lines were below its fold; a Bash prompt carried the pane's bar and
 * "This command requires approval".
 */
import { describe, it, expect } from "vitest";
import { permissionPreview } from "../src/components/permission.logic";
import type { PermissionReading } from "../src/components/timeline.logic";
import type { Event } from "../src/types/events";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });
const use = (id: number, tool: string, toolId: string, input: unknown): Event =>
  ev({ id, kind: "tool_use", tool, toolId, body: JSON.stringify(input) });
const done = (id: number, toolId: string): Event =>
  ev({ id, kind: "tool_result", toolId, body: "ok" });

const reading = (title: string, detail: string[]): PermissionReading => ({
  id: 1,
  title,
  detail,
  prompt: "Do you want to proceed?",
  options: [
    { number: 1, label: "Yes" },
    { number: 2, label: "No" },
  ],
});

const EDIT = reading("Edit file", ["calc.py", "1 def add(a, b):", "2     return a + b"]);
const APPEND = {
  file_path: "/tmp/proj/calc.py",
  old_string: "    return a + b",
  new_string: '    return a + b\n\n\ndef subtract(a, b):\n    """Subtract b from a."""\n    return a - b',
};

describe("permissionPreview", () => {
  it("shows an Edit's change, with one unchanged line before it", () => {
    const p = permissionPreview(EDIT, [use(1, "Edit", "e1", APPEND)]);
    expect(p).toEqual({
      kind: "diff",
      file: "calc.py",
      lines: [
        { sign: " ", text: "    return a + b" },
        { sign: "+", text: "def subtract(a, b):" },
        { sign: "+", text: '    """Subtract b from a."""' },
        { sign: "+", text: "    return a - b" },
      ],
    });
  });

  it("marks the lines an Edit takes out and puts in, and keeps one line after", () => {
    const p = permissionPreview(EDIT, [
      use(1, "Edit", "e1", {
        file_path: "/tmp/proj/calc.py",
        old_string: "def add(a, b):\n    return a + b\n# end",
        new_string: "def add(a, b):\n    return b + a\n# end",
      }),
    ]);
    expect(p?.kind === "diff" ? p.lines : null).toEqual([
      { sign: " ", text: "def add(a, b):" },
      { sign: "-", text: "    return a + b" },
      { sign: "+", text: "    return b + a" },
      { sign: " ", text: "# end" },
    ]);
  });

  it("shows a Bash call's command and description, without the pane's chrome", () => {
    const command =
      'python3 -c "from calc import subtract; print(subtract(5, 3), subtract(3, 5), subtract(2.5, 1)); print(repr(subtract.__doc__))"';
    const p = permissionPreview(
      reading("Bash command", [
        '│ python3 -c "from calc import subtract; print(subtract(5, 3), subtract(3,',
        '│ 5), subtract(2.5, 1)); print(repr(subtract.__doc__))"',
        "Run subtract and print its docstring",
        "This command requires approval",
      ]),
      [use(1, "Bash", "b1", { command, description: "Run subtract and print its docstring" })],
    );
    expect(p).toEqual({
      kind: "command",
      command,
      description: "Run subtract and print its docstring",
    });
  });

  it("leaves out blank lines, which say nothing about where the change is", () => {
    const p = permissionPreview(EDIT, [
      use(1, "Edit", "e1", {
        file_path: "/tmp/proj/calc.py",
        old_string: "    return a + b\n",
        new_string: "    return a + b\n\ndef divide(a, b):\n    return a / b\n",
      }),
    ]);
    expect(p?.kind === "diff" ? p.lines.map((l) => l.sign + l.text) : null).toEqual([
      "     return a + b",
      "+def divide(a, b):",
      "+    return a / b",
    ]);
  });

  it("picks the call the prompt names when two wait together", () => {
    const p = permissionPreview(reading("Bash command", ["ls -la", "List the files"]), [
      use(1, "Edit", "e1", APPEND),
      use(2, "Bash", "b1", { command: "ls -la", description: "List the files" }),
    ]);
    expect(p?.kind).toBe("command");
  });

  it("leaves a call that has its result out, and has nothing when no call matches", () => {
    expect(permissionPreview(EDIT, [use(1, "Edit", "e1", APPEND), done(2, "e1")])).toBeNull();
    expect(
      permissionPreview(EDIT, [use(1, "Edit", "e1", { ...APPEND, file_path: "/r/other.py" })]),
    ).toBeNull();
    expect(permissionPreview(reading("Read file", ["/etc/hostname"]), [])).toBeNull();
  });
});
