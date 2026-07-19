# Pillar #1 — `session-events` service — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A new devvm Go service (`session-events`, :7685) that turns a live Claude-Code-in-tmux session into a resumable structured event stream for the web text-mode, and drives it (prompt/cancel/permission) — all in the same session the terminal attaches to.

**Architecture:** Stdlib `net/http` (homelab Go pattern), sibling to `tmux-api`, same `X-Authentik-Username`→OS-user auth. It **observes** (tail transcript JSONL + receive Claude Code hooks) and **nudges** (inject into the tmux pty); it never owns Claude. Read path streams normalized events over **SSE** with `Last-Event-ID` resume. A durable per-session **hook-event store** carries permission/notification events (which are not in the transcript) under the same cursor space.

**Tech Stack:** Go stdlib (`net/http`, `bufio`, `os`, `encoding/json`), `fsnotify` for tail (or poll fallback), tmux via `os/exec` (`sudo -u <user> tmux`), reuse `tmux-api`'s user-map parsing.

**Isolation:** worktree `session-events`. Land to master per-increment when green; deploy behind the canary + golden-master gate (never straight to the live URL).

---

## File structure (`session-events/`)

- `main.go` — flags, mux, middleware (auth → OS user), route table, `:7685`, `GET /health`.
- `authuser.go` — `X-Authentik-Username` → OS user via `/etc/ttyd-user-map` (port tmux-api's parser; shared contract).
- `event.go` — the normalized `Event` type + `Kind` enum + JSON wire shape (the renderer's contract).
- `normalize.go` — `Normalizer`: transcript JSONL line → `[]Event`; pairs `tool_use`↔`tool_result` by `tool_use_id`; synthesizes `turnId`.
- `normalize_test.go`, `event_test.go` — pure-logic unit tests (no I/O).
- `tail.go` — `Tailer`: resumable byte-offset tail of a transcript file; emits raw lines from offset N.
- `tail_test.go` — against a temp file (append → observe).
- `sessionmap.go` — tmux-session ↔ {cwd, claudeSessionId, transcriptPath}; fed by the SessionStart hook.
- `hookstore.go` — durable append-only per-session hook-event log (permissions/notifications) with its own offset; merged into the cursor space.
- `hooks.go` — `POST /hooks/{event}` receivers (SessionStart, PermissionRequest, Stop/SubagentStop); permission long-poll hold + resolve.
- `sse.go` — `GET /events/{session}`: resolve cursor from `Last-Event-ID`, snapshot-or-replay, live tail, heartbeats.
- `inject.go` — `POST /prompt/{session}` (bracketed-paste+submit via tmux), `POST /cancel/{session}` (interrupt); turn-state gate (409 if running).
- `permission.go` — `POST /permission/{requestId}` (allow/deny) → releases the held hook.
- `*_test.go` per file; `integration_test.go` — scratch `tmux -L se-test` end-to-end.
- `devvm/` additions: `session-events.service`, hook wrapper scripts, `session-events` in `deploy.sh`.

---

## Task 1: Event type + wire shape

**Files:** Create `session-events/event.go`, `session-events/event_test.go`

- [ ] **Step 1: Write the failing test**

```go
package main

import "testing"

func TestEventJSONWireShape(t *testing.T) {
	e := Event{ID: 42, Kind: KindText, Session: "demo", TurnID: "t1", Body: "hello"}
	got := string(e.JSON())
	want := `{"id":42,"kind":"text","session":"demo","turnId":"t1","body":"hello"}`
	if got != want {
		t.Fatalf("wire shape mismatch:\n got=%s\nwant=%s", got, want)
	}
}

func TestEventKindsAreStable(t *testing.T) {
	for k, s := range map[Kind]string{
		KindSession: "session", KindUser: "user", KindText: "text",
		KindToolUse: "tool_use", KindToolResult: "tool_result", KindResult: "result",
		KindState: "state", KindPermissionRequest: "permission_request",
		KindPermissionResolved: "permission_resolved", KindError: "error", KindTurnEnd: "turn_end",
	} {
		if string(k) != s {
			t.Fatalf("kind %q != %q", k, s)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails** — `cd session-events && go test ./... -run TestEvent -v` → FAIL (undefined Event/Kind).

- [ ] **Step 3: Write minimal implementation** (`event.go`)

```go
package main

import "encoding/json"

type Kind string

const (
	KindSession            Kind = "session"
	KindUser               Kind = "user"
	KindText               Kind = "text"
	KindToolUse            Kind = "tool_use"
	KindToolResult         Kind = "tool_result"
	KindResult             Kind = "result"
	KindState              Kind = "state"
	KindPermissionRequest  Kind = "permission_request"
	KindPermissionResolved Kind = "permission_resolved"
	KindError              Kind = "error"
	KindTurnEnd            Kind = "turn_end"
)

// Event is the renderer's contract. Field order is fixed by the struct so the
// wire shape is stable; omitempty keeps optional fields absent.
type Event struct {
	ID      int64  `json:"id"`
	Kind    Kind   `json:"kind"`
	Session string `json:"session"`
	TurnID  string `json:"turnId,omitempty"`
	Body    string `json:"body,omitempty"`
	Tool    string `json:"tool,omitempty"`
	ToolID  string `json:"toolId,omitempty"`
	IsError bool   `json:"isError,omitempty"`
	At      int64  `json:"at,omitempty"`
}

func (e Event) JSON() []byte { b, _ := json.Marshal(e); return b }
```

- [ ] **Step 4: Run test to verify it passes** — `go test ./... -run TestEvent -v` → PASS.

- [ ] **Step 5: Commit** — `git add session-events/event.go session-events/event_test.go && git commit -m "feat(session-events): normalized Event type + stable wire shape"`

---

## Task 2: Transcript normalizer (the core pure logic)

**Files:** Create `session-events/normalize.go`, `session-events/normalize_test.go`

Transcript JSONL lines look like `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}|{"type":"tool_use","id":"tu_1","name":"Bash","input":{...}}]},"uuid":"...","timestamp":"..."}` and `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"...","is_error":false}]}}`.

- [ ] **Step 1: Write the failing test**

```go
package main

import "testing"

func TestNormalizeAssistantTextAndToolPairing(t *testing.T) {
	n := NewNormalizer("demo")
	var out []Event
	out = append(out, n.Line([]byte(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"},{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls"}}]},"uuid":"a1","timestamp":"2026-07-19T00:00:00Z"}`))...)
	out = append(out, n.Line([]byte(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"file.txt","is_error":false}]}},"uuid":"a2"}`))...)

	if len(out) != 3 {
		t.Fatalf("want 3 events (text, tool_use, tool_result), got %d: %+v", len(out), out)
	}
	if out[0].Kind != KindText || out[0].Body != "hi" {
		t.Fatalf("event0 = %+v", out[0])
	}
	if out[1].Kind != KindToolUse || out[1].Tool != "Bash" || out[1].ToolID != "tu_1" {
		t.Fatalf("event1 = %+v", out[1])
	}
	if out[2].Kind != KindToolResult || out[2].ToolID != "tu_1" || out[2].Body != "file.txt" {
		t.Fatalf("event2 = %+v", out[2])
	}
}

func TestNormalizeSkipsMetaLines(t *testing.T) {
	n := NewNormalizer("demo")
	if got := n.Line([]byte(`{"type":"mode","mode":"default","sessionId":"x"}`)); len(got) != 0 {
		t.Fatalf("meta line should yield no events, got %+v", got)
	}
}
```

- [ ] **Step 2: Run to verify it fails** — `go test ./... -run TestNormalize -v` → FAIL.

- [ ] **Step 3: Write minimal implementation** (`normalize.go`)

```go
package main

import "encoding/json"

type Normalizer struct {
	session string
	seq     int64
	turnID  string
}

func NewNormalizer(session string) *Normalizer { return &Normalizer{session: session} }

type rawLine struct {
	Type    string `json:"type"`
	Message struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}
type rawBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

func (n *Normalizer) next() int64 { n.seq++; return n.seq }

func (n *Normalizer) emit(k Kind) Event {
	return Event{ID: n.next(), Kind: k, Session: n.session, TurnID: n.turnID}
}

// Line normalizes one transcript JSONL line into zero or more Events.
func (n *Normalizer) Line(b []byte) []Event {
	var rl rawLine
	if json.Unmarshal(b, &rl) != nil {
		return nil
	}
	switch rl.Type {
	case "assistant", "user":
	default:
		return nil // meta lines (mode, permission-mode, last-prompt, ...)
	}
	var blocks []rawBlock
	// content may be a string or an array of blocks
	if json.Unmarshal(rl.Message.Content, &blocks) != nil {
		return nil
	}
	var out []Event
	for _, bl := range blocks {
		switch bl.Type {
		case "text":
			e := n.emit(KindText)
			e.Body = bl.Text
			out = append(out, e)
		case "tool_use":
			e := n.emit(KindToolUse)
			e.Tool, e.ToolID = bl.Name, bl.ID
			e.Body = string(bl.Content)
			out = append(out, e)
		case "tool_result":
			e := n.emit(KindToolResult)
			e.ToolID, e.IsError = bl.ToolUseID, bl.IsError
			e.Body = decodeToolResult(bl.Content)
			out = append(out, e)
		}
	}
	return out
}

// decodeToolResult accepts either a JSON string or an array of {type:text,text}.
func decodeToolResult(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []rawBlock
	if json.Unmarshal(raw, &blocks) == nil {
		for _, b := range blocks {
			if b.Type == "text" {
				return b.Text
			}
		}
	}
	return string(raw)
}
```

- [ ] **Step 4: Run to verify it passes** — `go test ./... -run TestNormalize -v` → PASS.

- [ ] **Step 5: Commit** — `git add session-events/normalize.go session-events/normalize_test.go && git commit -m "feat(session-events): transcript JSONL normalizer with tool pairing"`

---

## Task 3: Resumable tailer

**Files:** Create `session-events/tail.go`, `session-events/tail_test.go`

- [ ] **Step 1: Write the failing test**

```go
package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTailerResumesFromOffset(t *testing.T) {
	p := filepath.Join(t.TempDir(), "t.jsonl")
	os.WriteFile(p, []byte("line1\nline2\n"), 0o644)

	lines, off, err := ReadFrom(p, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 || lines[0] != "line1" || lines[1] != "line2" {
		t.Fatalf("got %v", lines)
	}
	// append, then resume from the returned offset — only the new line comes back.
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0o644)
	f.WriteString("line3\n")
	f.Close()
	lines2, _, _ := ReadFrom(p, off)
	if len(lines2) != 1 || lines2[0] != "line3" {
		t.Fatalf("resume got %v", lines2)
	}
}
```

- [ ] **Step 2: Run to verify it fails** — `go test ./... -run TestTailer -v` → FAIL.

- [ ] **Step 3: Write minimal implementation** (`tail.go`)

```go
package main

import (
	"bufio"
	"io"
	"os"
)

// ReadFrom reads complete newline-terminated lines starting at byte offset off,
// returning the lines (without newline) and the new offset past the last full line.
func ReadFrom(path string, off int64) ([]string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, off, err
	}
	defer f.Close()
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		return nil, off, err
	}
	var lines []string
	r := bufio.NewReader(f)
	cur := off
	for {
		b, err := r.ReadBytes('\n')
		if len(b) > 0 && b[len(b)-1] == '\n' {
			lines = append(lines, string(b[:len(b)-1]))
			cur += int64(len(b))
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return lines, cur, err
		}
	}
	return lines, cur, nil
}
```

- [ ] **Step 4: Run to verify it passes** — `go test ./... -run TestTailer -v` → PASS.

- [ ] **Step 5: Commit** — `git add session-events/tail.go session-events/tail_test.go && git commit -m "feat(session-events): resumable byte-offset transcript tailer"`

---

## Task 4: Auth middleware (port from tmux-api)

**Files:** Create `session-events/authuser.go`, `session-events/authuser_test.go`

- [ ] **Step 1: Write the failing test** — table test: `mapUser("alice")=="wizard"`, unknown → error, `"alice@meta.com"` strips at `@`. (Mirror `tmux-api`'s existing map parser; read `tmux-api/main.go` for the exact format `<auth_local>=<os_user>[:<cwd>]`.)

- [ ] **Step 2–5:** implement `LoadUserMap(path)` + `Middleware` that reads `X-Authentik-Username`, resolves the OS user, 401 on missing / 403 on unmapped, stashes the OS user in the request context. Run tests → PASS. Commit `feat(session-events): auth middleware (Authentik→OS user)`.

*(Full code omitted here only because it is a line-for-line port of `tmux-api/main.go`'s user-map logic — the executing agent MUST open that file and reproduce it exactly, including the `@` strip and the `:cwd` split.)*

---

## Task 5: SSE endpoint with Last-Event-ID resume + heartbeat

**Files:** Create `session-events/sse.go`, `session-events/sse_test.go`

- [ ] **Step 1: Write the failing test** — use `httptest` + a fake source returning a fixed `[]Event`; assert: response `Content-Type: text/event-stream`; each event framed as `id: <n>\ndata: <json>\n\n`; a request with header `Last-Event-ID: 2` replays only events with ID>2; a heartbeat `:` comment line is written on the idle tick (inject a controllable clock).

- [ ] **Step 2–5:** implement `handleEvents(w, r)`: set SSE headers, flush; resolve `from` = `Last-Event-ID` (or `?snapshot` when the gap exceeds `snapshotThreshold`); write replay then subscribe to the live source; `:hb` heartbeat every `heartbeatInterval` (default 20s); stop on `r.Context().Done()`. Run → PASS. Commit `feat(session-events): SSE stream with Last-Event-ID resume + heartbeat`.

**Design notes for the executor:** the "source" is an interface `Source interface { Replay(from int64) []Event; Subscribe() (<-chan Event, func()) }` so the HTTP layer is tested without files. The file-backed implementation (tail+normalize) is wired in Task 7.

---

## Task 6: Hook receiver + permission control plane

**Files:** Create `session-events/hooks.go`, `session-events/hookstore.go`, `session-events/permission.go` (+ tests)

- [ ] **Step 1 (SessionStart): failing test** — `POST /hooks/session-start` with `{"session_id":"s1","cwd":"/home/wizard/x","tmux_session":"demo"}` populates the session map so `Lookup("demo")` returns the transcript path `~/.claude/projects/<slug(cwd)>/s1.jsonl` (slug = cwd with `/`→`-`). Implement + PASS + commit.

- [ ] **Step 2 (PermissionRequest long-poll): failing test** — `POST /hooks/permission-request` `{"session":"demo","tool_name":"Bash","tool_input":{...}}` (a) appends a `permission_request` event to the hook store (visible on SSE), (b) BLOCKS; a concurrent `POST /permission/<id>` `{"decision":"deny"}` makes the hook return `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}`; (c) with **no resolver and no SSE subscriber**, it returns `{"...":{"permissionDecision":"ask"}}` (fall through to the terminal prompt); (d) on its own deadline with a subscriber but no answer, returns `deny` (fail-closed). Implement with a `map[requestID]chan decision` + context timeout. PASS + commit.

**This is the security-critical task** — the executing agent MUST cover cases (b/c/d) with tests before implementation is accepted.

---

## Task 7: File-backed Source + `main.go` wiring

**Files:** Create `session-events/source_file.go`, `session-events/main.go` (+ integration test)

- [ ] **Step 1: integration failing test** (`integration_test.go`, build tag `//go:build integration`) — start the mux on a random port; simulate a session: write transcript lines to a temp file + register via the SessionStart hook; connect to `/events/<s>`; assert the normalized events arrive in order with monotonic IDs; append a line → assert it streams live.

- [ ] **Step 2–5:** implement `fileSource` (Tailer+Normalizer+hookstore merged under one monotonic ID space), wire `main.go` (flags: `-addr :7685`, `-usermap /etc/ttyd-user-map`; routes: `/health`, `/events/{s}`, `/prompt/{s}`, `/cancel/{s}`, `/permission/{id}`, `/hooks/{event}`; auth middleware on all but `/hooks/*` which is localhost-only). Run `go test -tags integration ./...` → PASS. Commit `feat(session-events): file-backed source + service wiring`.

---

## Task 8: Injection (prompt/cancel) — integration against scratch tmux

**Files:** Create `session-events/inject.go` (+ `integration_test.go` cases)

- [ ] **Step 1: failing test** (integration) — start a scratch `tmux -L se-test new-session -d -s demo`, run a shell that echoes stdin; `POST /prompt/demo {"text":"echo hi"}` injects bracketed-paste + `\r`; assert (via `capture-pane`) the line appears; `POST /cancel/demo` sends the interrupt. Gate: `POST /prompt` returns 409 when turn-state == running (stub the state source).

- [ ] **Step 2–5:** implement using `sudo -u <user> tmux -L <sock> send-keys` (paste-buffer for bracketed paste); turn-state from the existing `@claude_state`. PASS + commit `feat(session-events): tmux prompt/cancel injection with turn-state gate`.

---

## Task 9: Deploy artifacts (behind the gate)

**Files:** Create `devvm/session-events.service`, hook wrapper scripts under `devvm/`, extend `scripts/deploy.sh` and the `session-events` cross-build.

- [ ] systemd unit (`User=wizard`, `Restart=always`, `:7685`), the Claude-Code hook config additions (SessionStart + PermissionRequest → `curl` localhost:7685), `deploy.sh` cross-build + scp + smoke-test `/health`. **Deploy to the canary devvm target only**; live promotion waits for soak. Commit `feat(session-events): devvm service unit + deploy wiring`.

---

## Self-review checklist (run before handing to execution)

- **Spec coverage:** read path (Tasks 2,3,5,7) · drive path (Task 8) · permissions (Task 6) · auth (Task 4) · resume/cursor (Tasks 3,5) · deploy (Task 9). Hook-store-in-cursor-space caveat covered by Task 6+7. ✓
- **Types consistent:** `Event`/`Kind` (Task 1) used unchanged in 2,5,7; `Source` interface (Task 5) implemented in 7. ✓
- **No placeholders:** Task 4 references a real file to port (tmux-api); Tasks 6/8/9 give precise specs + the security cases that gate acceptance. Executor writes the omitted line-for-line port + integration bodies from the given assertions.
- **Out of scope (later pillars):** the SSE *client*, snapshot compaction tuning (#4), the frontend renderer (#2). This plan delivers a testable, deployable backend.
