package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// liveSnapshotJSON is a GET /api/orchestration/snapshot body captured from a
// throwaway t3 v0.0.34-nightly.20260815.1098 (own port, own base dir). It is
// the decoder's fixture on purpose: the field names here are measured, not
// assumed, and three of them differ from what a reader would guess —
// projects carry `workspaceRoot` (not rootPath), archive and delete are
// NULLABLE TIMESTAMPS (not booleans), and there is no Claude session uuid
// anywhere in the document.
const liveSnapshotJSON = `{
  "snapshotSequence": 17,
  "projects": [
    {
      "id": "825f4d76-c1b5-4d2b-8d5c-30d84cfdfd13",
      "title": "repo",
      "workspaceRoot": "/home/wizard/code/terminal-lobby",
      "defaultModelSelection": null,
      "defaultThreadEnvMode": null,
      "faviconPath": null,
      "scripts": [],
      "createdAt": "2026-08-15T23:48:48.745Z",
      "updatedAt": "2026-08-15T23:48:48.745Z",
      "deletedAt": null
    }
  ],
  "threads": [
    {
      "id": "bdda0840-4c18-4454-b219-7b419fe2ecd1",
      "projectId": "825f4d76-c1b5-4d2b-8d5c-30d84cfdfd13",
      "title": "feat-header",
      "modelSelection": {"instanceId": "claudeAgent", "model": "claude-opus-5"},
      "runtimeMode": "full-access",
      "interactionMode": "default",
      "branch": null,
      "worktreePath": null,
      "latestTurn": null,
      "createdAt": "2026-08-15T23:49:17.153Z",
      "updatedAt": "2026-08-15T23:49:17.153Z",
      "archivedAt": null,
      "settledOverride": null,
      "settledAt": null,
      "snoozedUntil": null,
      "snoozedAt": null,
      "pinnedAt": null,
      "pinOrderKey": null,
      "titleRegeneration": null,
      "deletedAt": null,
      "messages": [],
      "proposedPlans": [],
      "activities": [],
      "checkpoints": [],
      "session": {
        "threadId": "bdda0840-4c18-4454-b219-7b419fe2ecd1",
        "status": "ready",
        "providerName": "claudeAgent",
        "providerInstanceId": "claudeAgent",
        "runtimeMode": "full-access",
        "activeTurnId": null,
        "lastError": null,
        "updatedAt": "2026-08-15T23:50:25.119Z"
      }
    },
    {
      "id": "1e12167e-0000-0000-0000-000000000000",
      "projectId": "825f4d76-c1b5-4d2b-8d5c-30d84cfdfd13",
      "title": "gone",
      "modelSelection": {"instanceId": "claudeAgent", "model": "claude-opus-5"},
      "runtimeMode": "full-access",
      "interactionMode": "default",
      "branch": null,
      "worktreePath": null,
      "latestTurn": null,
      "createdAt": "2026-08-15T23:51:00.000Z",
      "updatedAt": "2026-08-15T23:51:03.838Z",
      "archivedAt": null,
      "deletedAt": "2026-08-15T23:51:03.838Z",
      "messages": [],
      "activities": [],
      "checkpoints": [],
      "session": null
    }
  ],
  "updatedAt": "2026-08-15T23:51:03.838Z"
}`

// dispatchRejectedJSON is the body a rejected command actually comes back with.
// Note what is NOT in it: the invariant's own detail ("already exists…") stays
// server-side, which is why the syncer confirms intent against a fresh
// snapshot rather than matching on an error string.
const dispatchRejectedJSON = `{"_tag":"EnvironmentInternalError","code":"internal_error","reason":"orchestration_dispatch_failed","traceId":"5e8662cc12d52208a10713a231a94ea6"}`

const authInvalidJSON = `{"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid","reason":"invalid_credential","traceId":"d61007aba595766022d7ca542d115b18"}`

// recordedRequest is one call the fake T3 saw.
type recordedRequest struct {
	Method string
	Path   string
	Auth   string
	Body   map[string]json.RawMessage
}

// fakeT3Server is an httptest stand-in for t3-serve: it records every request
// and answers from handlers the test controls.
//
// Every field a handler reads is guarded by the same mutex that guards the
// request log. The handlers run on the server's own goroutines, so a plain
// field assignment from the test goroutine would be an unsynchronised write
// under -race even when the ordering is obviously safe.
type fakeT3Server struct {
	*httptest.Server
	mu       sync.Mutex
	requests []recordedRequest
	// dispatchFn answers POST /api/orchestration/dispatch. nil = 200 {"sequence":1}.
	dispatchFn func(w http.ResponseWriter, body map[string]json.RawMessage, calls int)
	// snapshotFn answers GET /api/orchestration/snapshot. nil = 200 snapshot.
	snapshotFn func(w http.ResponseWriter, calls int)
	// snapshot is the body served when snapshotFn is nil.
	snapshot string
}

func newFakeT3(t *testing.T) *fakeT3Server {
	t.Helper()
	f := &fakeT3Server{snapshot: liveSnapshotJSON}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/orchestration/dispatch", func(w http.ResponseWriter, r *http.Request) {
		body := map[string]json.RawMessage{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		calls := f.record(r, body)
		f.mu.Lock()
		fn := f.dispatchFn
		f.mu.Unlock()
		if fn != nil {
			fn(w, body, calls)
			return
		}
		writeJSON(w, http.StatusOK, `{"sequence":1}`)
	})
	mux.HandleFunc("/api/orchestration/snapshot", func(w http.ResponseWriter, r *http.Request) {
		calls := f.record(r, nil)
		f.mu.Lock()
		fn, body := f.snapshotFn, f.snapshot
		f.mu.Unlock()
		if fn != nil {
			fn(w, calls)
			return
		}
		writeJSON(w, http.StatusOK, body)
	})
	f.Server = httptest.NewServer(mux)
	t.Cleanup(f.Close)
	return f
}

// setDispatch installs the dispatch handler under the lock the handlers read it
// with.
func (f *fakeT3Server) setDispatch(fn func(w http.ResponseWriter, body map[string]json.RawMessage, calls int)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.dispatchFn = fn
}

func (f *fakeT3Server) setSnapshotFn(fn func(w http.ResponseWriter, calls int)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.snapshotFn = fn
}

// setSnapshot replaces the served snapshot body — how a test moves T3's state
// between two reconcile passes.
func (f *fakeT3Server) setSnapshot(body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.snapshot = body
}

func (f *fakeT3Server) record(r *http.Request, body map[string]json.RawMessage) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, recordedRequest{
		Method: r.Method, Path: r.URL.Path,
		Auth: r.Header.Get("Authorization"), Body: body,
	})
	n := 0
	for _, req := range f.requests {
		if req.Path == r.URL.Path {
			n++
		}
	}
	return n
}

func (f *fakeT3Server) seen() []recordedRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]recordedRequest, len(f.requests))
	copy(out, f.requests)
	return out
}

// dispatched returns the bodies of every dispatch whose "type" matches verb.
func (f *fakeT3Server) dispatched(verb string) []map[string]json.RawMessage {
	var out []map[string]json.RawMessage
	for _, r := range f.seen() {
		if r.Path != "/api/orchestration/dispatch" || r.Body == nil {
			continue
		}
		if jsonString(r.Body["type"]) == verb {
			out = append(out, r.Body)
		}
	}
	return out
}

func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

func jsonString(raw json.RawMessage) string {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return ""
	}
	return s
}

// newTestClient wires a Client to a fake T3 and a bearer backed by a fake t3
// CLI, which together are the whole outside world this client has.
func newTestClient(t *testing.T, f *fakeT3Server) (*Client, string) {
	t.Helper()
	bin, argvLog := fakeT3(t)
	b := NewBearer("/base/dir", time.Hour)
	b.T3Bin = bin
	return NewClient(f.URL, b), argvLog
}

func TestDispatchBuildsTheCommandEnvelope(t *testing.T) {
	f := newFakeT3(t)
	c, _ := newTestClient(t, f)

	payload := json.RawMessage(`{"threadId":"thread-1","title":"feat-header"}`)
	if _, err := c.Dispatch(context.Background(), VerbThreadMetaUpdate, payload); err != nil {
		t.Fatalf("Dispatch: %v", err)
	}

	sent := f.dispatched(VerbThreadMetaUpdate)
	if len(sent) != 1 {
		t.Fatalf("dispatched %d thread.meta.update commands, want 1", len(sent))
	}
	body := sent[0]
	if got := jsonString(body["threadId"]); got != "thread-1" {
		t.Errorf("threadId = %q, want thread-1", got)
	}
	if got := jsonString(body["title"]); got != "feat-header" {
		t.Errorf("title = %q, want feat-header", got)
	}
	if got := jsonString(body["commandId"]); !isUUID(got) {
		t.Errorf("commandId = %q, want a uuid", got)
	}
	// thread.meta.update's schema has no createdAt field; sending one would be
	// a key T3 never asked for.
	if _, ok := body["createdAt"]; ok {
		t.Errorf("createdAt was sent on a verb whose schema has no such field: %v", body)
	}
	if got := f.seen()[0].Auth; got != "Bearer token-1" {
		t.Errorf("Authorization = %q, want the minted bearer", got)
	}
}

// Verbs whose schema declares createdAt get one, in the format T3 itself
// emits. thread.create and thread.turn.start both reject without it.
func TestDispatchStampsCreatedAtWhereTheSchemaWantsIt(t *testing.T) {
	f := newFakeT3(t)
	c, _ := newTestClient(t, f)

	for _, verb := range []string{VerbProjectCreate, VerbThreadCreate, VerbTurnStart, VerbTurnInterrupt, VerbSessionStop} {
		if _, err := c.Dispatch(context.Background(), verb, json.RawMessage(`{}`)); err != nil {
			t.Fatalf("Dispatch(%s): %v", verb, err)
		}
		sent := f.dispatched(verb)
		got := jsonString(sent[len(sent)-1]["createdAt"])
		if got == "" {
			t.Errorf("%s: createdAt missing", verb)
			continue
		}
		if _, err := time.Parse(isoDateTimeLayout, got); err != nil {
			t.Errorf("%s: createdAt %q does not parse as %s: %v", verb, got, isoDateTimeLayout, err)
		}
	}

	for _, verb := range []string{VerbThreadArchive, VerbThreadDelete, VerbThreadUnarchive, VerbProjectDelete, VerbProjectMetaUpdate} {
		if _, err := c.Dispatch(context.Background(), verb, json.RawMessage(`{}`)); err != nil {
			t.Fatalf("Dispatch(%s): %v", verb, err)
		}
		sent := f.dispatched(verb)
		if _, ok := sent[len(sent)-1]["createdAt"]; ok {
			t.Errorf("%s: createdAt was sent but the schema has no such field", verb)
		}
	}
}

// A caller that supplies its own ids keeps them: adoption needs to know the
// thread id it is about to create before the answer comes back.
func TestDispatchKeepsCallerSuppliedFields(t *testing.T) {
	f := newFakeT3(t)
	c, _ := newTestClient(t, f)

	payload := json.RawMessage(`{"commandId":"cmd-fixed","createdAt":"2026-01-01T00:00:00.000Z","threadId":"t"}`)
	if _, err := c.Dispatch(context.Background(), VerbTurnStart, payload); err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	body := f.dispatched(VerbTurnStart)[0]
	if got := jsonString(body["commandId"]); got != "cmd-fixed" {
		t.Errorf("commandId = %q, want the caller's", got)
	}
	if got := jsonString(body["createdAt"]); got != "2026-01-01T00:00:00.000Z" {
		t.Errorf("createdAt = %q, want the caller's", got)
	}
}

func TestDispatchRemintsOn401(t *testing.T) {
	f := newFakeT3(t)
	f.setDispatch(func(w http.ResponseWriter, body map[string]json.RawMessage, calls int) {
		if calls == 1 {
			writeJSON(w, http.StatusUnauthorized, authInvalidJSON)
			return
		}
		writeJSON(w, http.StatusOK, `{"sequence":9}`)
	})
	c, argvLog := newTestClient(t, f)

	if _, err := c.Dispatch(context.Background(), VerbThreadArchive, json.RawMessage(`{"threadId":"t"}`)); err != nil {
		t.Fatalf("Dispatch: %v", err)
	}

	seen := f.seen()
	if len(seen) != 2 {
		t.Fatalf("made %d requests, want 2 (the rejected one and the retry)", len(seen))
	}
	if seen[0].Auth == seen[1].Auth {
		t.Errorf("retried with the same rejected bearer %q", seen[0].Auth)
	}
	if got := mintCount(t, argvLog); got != 2 {
		t.Errorf("minted %d times, want 2 (initial + re-mint)", got)
	}
}

// One retry, not a loop: a bearer the server keeps rejecting is a broken
// configuration, and hammering it would turn every tick into two 401s.
func TestDispatchGivesUpAfterOneRemint(t *testing.T) {
	f := newFakeT3(t)
	f.setDispatch(func(w http.ResponseWriter, body map[string]json.RawMessage, calls int) {
		writeJSON(w, http.StatusUnauthorized, authInvalidJSON)
	})
	c, _ := newTestClient(t, f)

	_, err := c.Dispatch(context.Background(), VerbThreadArchive, json.RawMessage(`{"threadId":"t"}`))
	if err == nil {
		t.Fatal("Dispatch returned nil for a permanently rejected bearer")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error %v is not an *APIError", err)
	}
	if apiErr.Status != http.StatusUnauthorized {
		t.Errorf("Status = %d, want 401", apiErr.Status)
	}
	if apiErr.Reason != "invalid_credential" {
		t.Errorf("Reason = %q, want invalid_credential", apiErr.Reason)
	}
	if len(f.seen()) != 2 {
		t.Errorf("made %d requests, want exactly 2", len(f.seen()))
	}
}

// An invariant rejection and a genuine server fault arrive as the same 500
// with the same opaque reason. The client's job is to say which class it is;
// deciding whether it MEANT success is the caller's, against a fresh snapshot.
func TestDispatchClassifiesRejection(t *testing.T) {
	f := newFakeT3(t)
	f.setDispatch(func(w http.ResponseWriter, body map[string]json.RawMessage, calls int) {
		writeJSON(w, http.StatusInternalServerError, dispatchRejectedJSON)
	})
	c, _ := newTestClient(t, f)

	_, err := c.Dispatch(context.Background(), VerbProjectCreate, json.RawMessage(`{}`))
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error %v is not an *APIError", err)
	}
	if !apiErr.DispatchRejected() {
		t.Errorf("DispatchRejected() = false for %v", apiErr)
	}
	if apiErr.TraceID != "5e8662cc12d52208a10713a231a94ea6" {
		t.Errorf("TraceID = %q, want the id from the body — it is the only handle on the cause", apiErr.TraceID)
	}
	if !strings.Contains(apiErr.Error(), VerbProjectCreate) {
		t.Errorf("error %q does not name the verb", apiErr.Error())
	}
}

func TestSnapshotDecodesTheLivePayload(t *testing.T) {
	f := newFakeT3(t)
	c, _ := newTestClient(t, f)

	snap, err := c.Snapshot(context.Background())
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if len(snap.Projects) != 1 {
		t.Fatalf("decoded %d projects, want 1", len(snap.Projects))
	}
	p := snap.Projects[0]
	if p.WorkspaceRoot != "/home/wizard/code/terminal-lobby" {
		t.Errorf("WorkspaceRoot = %q", p.WorkspaceRoot)
	}
	if p.Deleted() {
		t.Error("live project decoded as deleted")
	}

	if len(snap.Threads) != 2 {
		t.Fatalf("decoded %d threads, want 2", len(snap.Threads))
	}
	live, ok := snap.Thread("bdda0840-4c18-4454-b219-7b419fe2ecd1")
	if !ok {
		t.Fatal("Thread() did not find the live thread")
	}
	if live.Title != "feat-header" {
		t.Errorf("Title = %q", live.Title)
	}
	if live.Archived() || live.Deleted() {
		t.Errorf("live thread reported archived=%v deleted=%v", live.Archived(), live.Deleted())
	}
	if got := live.InstanceID(); got != InstanceBridged {
		t.Errorf("InstanceID() = %q, want %q", got, InstanceBridged)
	}

	gone, ok := snap.Thread("1e12167e-0000-0000-0000-000000000000")
	if !ok {
		t.Fatal("a deleted thread must stay visible — it is how a T3 delete reaches tmux")
	}
	if !gone.Deleted() {
		t.Error("thread with deletedAt set did not report Deleted()")
	}
	// A thread that never ran has session:null; the instance still has to be
	// readable, because that is what says the thread is ours to reconcile.
	if got := gone.InstanceID(); got != InstanceBridged {
		t.Errorf("InstanceID() with session:null = %q, want %q from modelSelection", got, InstanceBridged)
	}
}

func TestSnapshotRemintsOn401(t *testing.T) {
	f := newFakeT3(t)
	f.setSnapshotFn(func(w http.ResponseWriter, calls int) {
		if calls == 1 {
			writeJSON(w, http.StatusUnauthorized, authInvalidJSON)
			return
		}
		writeJSON(w, http.StatusOK, liveSnapshotJSON)
	})
	c, argvLog := newTestClient(t, f)

	if _, err := c.Snapshot(context.Background()); err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if got := len(f.seen()); got != 2 {
		t.Errorf("snapshot called %d times, want 2", got)
	}
	if got := mintCount(t, argvLog); got != 2 {
		t.Errorf("minted %d times, want 2", got)
	}
}

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func isUUID(s string) bool { return uuidRe.MatchString(s) }

func TestNewUUIDIsAVersion4UUID(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		id, err := newUUID()
		if err != nil {
			t.Fatalf("newUUID: %v", err)
		}
		if !isUUID(id) {
			t.Fatalf("newUUID() = %q, which is not a v4 uuid", id)
		}
		if seen[id] {
			t.Fatalf("newUUID() repeated %q", id)
		}
		seen[id] = true
	}
}

// fakeBridge writes a stand-in for tl-t3-bridge that answers the handshake the
// way the real one must: a control_response echoing the request_id, then a
// system/init frame carrying the session id.
func fakeBridge(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tl-t3-bridge")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o700); err != nil {
		t.Fatalf("write fake bridge: %v", err)
	}
	return path
}

const goodBridgeScript = `read line
rid=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{}}}\n' "$rid"
printf '{"type":"system","subtype":"init","session_id":"11111111-2222-4333-8444-555555555555"}\n'
`

func TestSelfTestAcceptsAWorkingBridge(t *testing.T) {
	f := newFakeT3(t)
	c, _ := newTestClient(t, f)
	c.BridgePath = fakeBridge(t, goodBridgeScript)

	if err := c.SelfTest(context.Background()); err != nil {
		t.Fatalf("SelfTest against a working bridge: %v", err)
	}
}

func TestSelfTestRejectsABrokenBridge(t *testing.T) {
	cases := []struct {
		name, script, want string
		// orWant is a second acceptable substring, for a case whose failure has
		// two spellings depending on which side of a race won.
		orWant string
	}{
		{
			name:   "exits without answering",
			script: "exit 0\n",
			want:   "control_response",
			// The bridge exits immediately, so SelfTest either finishes writing
			// the initialize request and then waits for an answer that never
			// comes ("no control_response"), or loses the race and has the write
			// itself fail on the closed pipe. Both say the bridge did not answer;
			// which one appears depends on machine load, so the test passed alone
			// and failed inside the full suite, where it blocked every release.
			orWant: "broken pipe",
		},
		{
			name: "answers a different request",
			script: `read line
printf '{"type":"control_response","response":{"subtype":"success","request_id":"someone-else","response":{}}}\n'
printf '{"type":"system","subtype":"init","session_id":"x"}\n'
`,
			want: "request_id",
		},
		{
			name: "acknowledges but never initialises",
			script: `read line
rid=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{}}}\n' "$rid"
`,
			want: "system/init",
		},
		{
			name: "reports an error instead",
			script: `read line
rid=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"error","request_id":"%s","error":"nope"}}\n' "$rid"
`,
			want: "error",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeT3(t)
			cl, _ := newTestClient(t, f)
			cl.BridgePath = fakeBridge(t, c.script)

			err := cl.SelfTest(context.Background())
			if err == nil {
				t.Fatal("SelfTest passed a broken bridge")
			}
			if !strings.Contains(err.Error(), c.want) &&
				(c.orWant == "" || !strings.Contains(err.Error(), c.orWant)) {
				t.Errorf("error %q mentions neither %q nor %q", err, c.want, c.orWant)
			}
		})
	}
}

// A bridge that hangs must not hang the syncer: the self-test is on the
// startup path and after every t3 upgrade.
func TestSelfTestTimesOut(t *testing.T) {
	f := newFakeT3(t)
	c, _ := newTestClient(t, f)
	c.BridgePath = fakeBridge(t, "sleep 30\n")
	c.SelfTestTimeout = 300 * time.Millisecond

	start := time.Now()
	err := c.SelfTest(context.Background())
	if err == nil {
		t.Fatal("SelfTest passed a bridge that never answered")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("SelfTest took %v; the timeout did not fire", elapsed)
	}
}

func TestSelfTestNeedsABridgePath(t *testing.T) {
	f := newFakeT3(t)
	c, _ := newTestClient(t, f)
	if err := c.SelfTest(context.Background()); err == nil {
		t.Fatal("SelfTest with no bridge path returned nil")
	}
}

// The probe spawns the bridge with a session id T3 never issued. Without the
// env var below that is an ordinary spawn, and the bridge answers it the way it
// answers any unknown conversation: by creating a tmux session and starting a
// claude in it. Pinned to the bridge's own constant, because the two binaries
// ship separately.
func TestSelfTestUsesProbeMode(t *testing.T) {
	raw, err := os.ReadFile("../t3-bridge/main.go")
	if err != nil {
		t.Fatalf("read the bridge: %v", err)
	}
	if want := "ProbeEnv = " + strconv.Quote(bridgeProbeEnv); !strings.Contains(string(raw), want) {
		t.Errorf("t3-bridge/main.go does not declare\n\t%s", want)
	}

	f := newFakeT3(t)
	c, _ := newTestClient(t, f)
	// A bridge that only answers when it is told it is a probe.
	c.BridgePath = fakeBridge(t, `if [ -z "$TL_T3_BRIDGE_PROBE" ]; then exit 3; fi
`+goodBridgeScript)

	if err := c.SelfTest(context.Background()); err != nil {
		t.Fatalf("SelfTest did not run the bridge in probe mode: %v", err)
	}
}
