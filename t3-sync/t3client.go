package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// The T3 HTTP surface the syncer uses: POST /api/orchestration/dispatch to
// change things, GET /api/orchestration/snapshot to read them. Both take the
// minted bearer.
//
// The dispatchable verb list below is what was measured on
// t3 v0.0.34-nightly.20260815.1098 (verified fact 7). The one that is NOT
// dispatchable is the one that shapes the whole design: thread.activity.append.
// Nothing outside a process T3 spawns can put content into a thread, which is
// why adoption needs a warm-up turn and why live mirroring runs through the
// bridge rather than through this client.

// Dispatchable orchestration verbs.
const (
	VerbProjectCreate     = "project.create"
	VerbProjectMetaUpdate = "project.meta.update"
	VerbProjectDelete     = "project.delete"

	VerbThreadCreate     = "thread.create"
	VerbThreadDelete     = "thread.delete"
	VerbThreadArchive    = "thread.archive"
	VerbThreadUnarchive  = "thread.unarchive"
	VerbThreadMetaUpdate = "thread.meta.update"

	VerbTurnStart     = "thread.turn.start"
	VerbTurnInterrupt = "thread.turn.interrupt"
	VerbSessionStop   = "thread.session.stop"
)

// isoDateTimeLayout is the timestamp format T3 emits and re-stamps commands
// with (millisecond precision, UTC, trailing Z). Matching it exactly keeps a
// command's createdAt indistinguishable from one the UI sent.
const isoDateTimeLayout = "2006-01-02T15:04:05.000Z"

// verbsWithCreatedAt are the commands whose schema declares a createdAt.
//
// It is a whitelist because the field is NOT universal: thread.archive,
// thread.delete and thread.meta.update have no such key, and a command carries
// only what its own schema names. Transcribed from
// packages/contracts/src/orchestration.ts in the t3 build this talks to.
var verbsWithCreatedAt = map[string]bool{
	VerbProjectCreate: true,
	VerbThreadCreate:  true,
	VerbTurnStart:     true,
	VerbTurnInterrupt: true,
	VerbSessionStop:   true,
}

// requestTimeout bounds one HTTP call to a loopback server. Generous enough for
// a dispatch that has to start a provider session, short enough that a wedged
// t3-serve costs one tick rather than the run.
const requestTimeout = 30 * time.Second

// defaultSelfTestTimeout bounds the handshake probe. The bridge answers
// initialize before it touches tmux, so a healthy one replies in milliseconds.
const defaultSelfTestTimeout = 15 * time.Second

// Client talks to one user's t3-serve.
type Client struct {
	// BridgePath is the binary SelfTest exercises. Set by the caller after
	// construction; an empty path makes SelfTest fail rather than pass vacuously.
	BridgePath string
	// SelfTestTimeout overrides defaultSelfTestTimeout (tests use a short one).
	SelfTestTimeout time.Duration

	endpoint string
	bearer   *Bearer
	http     *http.Client
}

// NewClient builds a client against a t3-serve base URL.
func NewClient(endpoint string, bearer *Bearer) *Client {
	return &Client{
		endpoint: strings.TrimSuffix(endpoint, "/"),
		bearer:   bearer,
		http:     &http.Client{Timeout: requestTimeout},
	}
}

// APIError is a non-2xx answer from t3-serve, decoded far enough to act on.
//
// The distinction that matters is Status 401 (the bearer is stale — re-mint and
// retry, handled inside this file) versus a 500 carrying
// orchestration_dispatch_failed, which is what EVERY rejected command looks
// like: a duplicate project, an already-archived thread, and a genuine internal
// fault are one status with one reason. The invariant's own explanation is
// logged server-side and never reaches the client, so a caller that wants
// "already exists means success" has to confirm the intended state against a
// fresh snapshot. See Adopter.ensureProject.
type APIError struct {
	Verb    string
	Status  int
	Code    string
	Reason  string
	TraceID string
	Body    string
}

func (e *APIError) Error() string {
	what := e.Verb
	if what == "" {
		what = "request"
	}
	if e.Reason != "" {
		return fmt.Sprintf("t3 %s: HTTP %d %s (trace %s)", what, e.Status, e.Reason, e.TraceID)
	}
	return fmt.Sprintf("t3 %s: HTTP %d: %s", what, e.Status, strings.TrimSpace(e.Body))
}

// DispatchRejected reports whether the command was refused by the orchestration
// engine rather than by transport or auth. It is a CLASS, not a cause: confirm
// what you wanted against a snapshot before treating it as success.
func (e *APIError) DispatchRejected() bool {
	return e.Status == http.StatusInternalServerError && e.Reason == "orchestration_dispatch_failed"
}

// Unauthorized reports a rejected bearer.
func (e *APIError) Unauthorized() bool { return e.Status == http.StatusUnauthorized }

// Dispatch performs one orchestration verb.
//
// payload carries the verb's own fields; this adds the envelope every command
// shares — `type`, a uuid `commandId`, and `createdAt` for the verbs whose
// schema declares one. Anything the caller already set is left alone, so an
// adopter that needs to know the thread id it is creating can supply it.
//
// Two behaviours the reconciler depends on, both from the design:
//   - thread.turn.start requires the thread to ALREADY exist (verified fact 8);
//     bootstrap.createThread does not create it over HTTP. Create, then start.
//   - Only one active T3 project per workspace root is allowed, so a
//     project.create for a root that already has one is refused (decision 8).
//     That refusal arrives as an opaque 500 — see APIError.
func (c *Client) Dispatch(ctx context.Context, verb string, payload json.RawMessage) (json.RawMessage, error) {
	body, err := commandEnvelope(verb, payload)
	if err != nil {
		return nil, err
	}
	return c.do(ctx, http.MethodPost, "/api/orchestration/dispatch", verb, body)
}

// commandEnvelope merges the shared command fields into a caller's payload.
func commandEnvelope(verb string, payload json.RawMessage) ([]byte, error) {
	fields := map[string]json.RawMessage{}
	if len(bytes.TrimSpace(payload)) > 0 {
		if err := json.Unmarshal(payload, &fields); err != nil {
			return nil, fmt.Errorf("dispatch %s: payload is not a JSON object: %w", verb, err)
		}
	}
	fields["type"] = mustMarshal(verb)
	if _, ok := fields["commandId"]; !ok {
		id, err := newUUID()
		if err != nil {
			return nil, fmt.Errorf("dispatch %s: %w", verb, err)
		}
		fields["commandId"] = mustMarshal(id)
	}
	if verbsWithCreatedAt[verb] {
		if _, ok := fields["createdAt"]; !ok {
			fields["createdAt"] = mustMarshal(time.Now().UTC().Format(isoDateTimeLayout))
		}
	}
	return json.Marshal(fields)
}

// Snapshot is T3's current state as the syncer needs to see it: the projects
// and threads it has to reconcile against the user's tmux sessions.
//
// This is a subset of GET /api/orchestration/snapshot, holding the fields the
// reconciler reads. The route serves the "command read model" — thread bodies
// deliberately empty — so the messages and activities arrays it also carries
// are not worth decoding here.
type Snapshot struct {
	Sequence  int64     `json:"snapshotSequence"`
	Projects  []Project `json:"projects"`
	Threads   []Thread  `json:"threads"`
	UpdatedAt string    `json:"updatedAt"`
}

// Project is one T3 workspace: a title and one absolute workspace root. Not a
// lobby Project — no members, no attach mode, no co-ownership (CONTEXT.md).
type Project struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// WorkspaceRoot is the absolute directory the project files. T3 normalises
	// it on the way in, so what comes back may not be byte-identical to what
	// was sent.
	WorkspaceRoot string `json:"workspaceRoot"`
	// DeletedAt is a soft delete: a deleted project stays in the snapshot with
	// this stamped, which is how one is told from an absent one.
	DeletedAt string `json:"deletedAt"`
}

// Deleted reports whether the project has been soft-deleted. Only a live
// project can hold a workspace root — the "one active project per root"
// invariant ignores deleted ones.
func (p Project) Deleted() bool { return p.DeletedAt != "" }

// Thread is one T3 conversation.
//
// Both lifecycle ends are NULLABLE TIMESTAMPS rather than booleans, and they
// mean very different things to this syncer (decision 3): archivedAt is T3's
// routine "done" gesture and crosses nothing, while deletedAt is deliberate
// destruction and kills the tmux session.
//
// What is NOT here is worth stating: the snapshot carries no Claude session
// uuid. T3 keeps the thread's resume cursor internally and does not project it
// into this read model (checked against a live server, threads with and without
// a running session). The uuid ↔ thread binding therefore lives entirely in our
// own two places — the @t3_thread tmux option and the durable index.
type Thread struct {
	ID         string `json:"id"`
	ProjectID  string `json:"projectId"`
	Title      string `json:"title"`
	ArchivedAt string `json:"archivedAt"`
	DeletedAt  string `json:"deletedAt"`
	// ModelSelection routes the thread to a provider instance. It is present on
	// every thread, including one that has never run.
	ModelSelection ModelSelection `json:"modelSelection"`
	// Session is null until a provider session has existed for the thread.
	Session *ThreadSession `json:"session"`
}

// ModelSelection is T3's provider routing key plus the model it picked.
type ModelSelection struct {
	InstanceID string `json:"instanceId"`
	Model      string `json:"model"`
}

// ThreadSession is the provider session's current state, when there is one.
type ThreadSession struct {
	Status             string `json:"status"`
	ProviderInstanceID string `json:"providerInstanceId"`
	ActiveTurnID       string `json:"activeTurnId"`
	LastError          string `json:"lastError"`
}

// Archived reports T3's routine "done" gesture. It does not cross to tmux.
func (t Thread) Archived() bool { return t.ArchivedAt != "" }

// Deleted reports deliberate destruction, which DOES cross to tmux.
func (t Thread) Deleted() bool { return t.DeletedAt != "" }

// InstanceID says whether this thread is ours to reconcile: "claudeAgent" is
// the bridged instance, "claudeStock" is the escape hatch, and a Codex, Cursor
// or Grok thread is neither and stays T3-only (decision 5).
//
// The live session's instance wins when there is one, because a thread can be
// switched between instances after it was created; modelSelection is the
// answer for a thread that has never run.
func (t Thread) InstanceID() string {
	if t.Session != nil && t.Session.ProviderInstanceID != "" {
		return t.Session.ProviderInstanceID
	}
	return t.ModelSelection.InstanceID
}

// Thread finds a thread by id.
func (s Snapshot) Thread(id string) (Thread, bool) {
	for _, t := range s.Threads {
		if t.ID == id {
			return t, true
		}
	}
	return Thread{}, false
}

// Project finds a project by id.
func (s Snapshot) Project(id string) (Project, bool) {
	for _, p := range s.Projects {
		if p.ID == id {
			return p, true
		}
	}
	return Project{}, false
}

// Snapshot reads T3's current state.
func (c *Client) Snapshot(ctx context.Context) (Snapshot, error) {
	raw, err := c.do(ctx, http.MethodGet, "/api/orchestration/snapshot", "snapshot", nil)
	if err != nil {
		return Snapshot{}, err
	}
	var snap Snapshot
	if err := json.Unmarshal(raw, &snap); err != nil {
		return Snapshot{}, fmt.Errorf("decode snapshot: %w", err)
	}
	return snap, nil
}

// do performs one authenticated request, re-minting the bearer once on 401.
//
// One retry, not a loop. A 401 after a fresh mint is a broken configuration —
// a base dir that is not this server's, a revoked session — and retrying it
// every tick would only double the noise.
func (c *Client) do(ctx context.Context, method, path, verb string, body []byte) (json.RawMessage, error) {
	for attempt := 0; attempt < 2; attempt++ {
		token, err := c.bearer.Token()
		if err != nil {
			return nil, err
		}
		raw, apiErr, err := c.roundTrip(ctx, method, path, verb, body, token)
		if err != nil {
			return nil, err
		}
		if apiErr == nil {
			return raw, nil
		}
		if apiErr.Unauthorized() && attempt == 0 {
			// The token we believed in was rejected. Drop exactly that one —
			// another goroutine may already have replaced it.
			c.bearer.Invalidate(token)
			continue
		}
		return nil, apiErr
	}
	return nil, fmt.Errorf("t3 %s: unreachable", verb)
}

// roundTrip performs one request. A non-2xx answer comes back as *APIError in
// the second return, leaving err for transport failures alone — the two need
// different handling and collapsing them loses that.
func (c *Client) roundTrip(ctx context.Context, method, path, verb string, body []byte, token string) (json.RawMessage, *APIError, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.endpoint+path, reader)
	if err != nil {
		return nil, nil, fmt.Errorf("t3 %s: %w", verb, err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("t3 %s: %w", verb, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return nil, nil, fmt.Errorf("t3 %s: reading the response: %w", verb, err)
	}
	if resp.StatusCode/100 != 2 {
		return nil, decodeAPIError(verb, resp.StatusCode, raw), nil
	}
	return raw, nil, nil
}

// maxResponseBytes caps a snapshot read. The command read model serves empty
// thread bodies, so a real one is kilobytes; this is a guard against a wedged
// server streaming forever, not a tuning knob.
const maxResponseBytes = 32 << 20

// decodeAPIError pulls the tagged-error fields out of a body that may not have
// them; the raw text is kept either way so a surprising status is still legible
// in a log.
func decodeAPIError(verb string, status int, raw []byte) *APIError {
	e := &APIError{Verb: verb, Status: status, Body: string(raw)}
	var tagged struct {
		Code    string `json:"code"`
		Reason  string `json:"reason"`
		TraceID string `json:"traceId"`
	}
	if err := json.Unmarshal(raw, &tagged); err == nil {
		e.Code, e.Reason, e.TraceID = tagged.Code, tagged.Reason, tagged.TraceID
	}
	return e
}

// bridgeProbeEnv is t3-bridge's ProbeEnv: it turns a spawn into a handshake
// probe that never touches tmux. The two constants must agree, and
// TestSelfTestUsesProbeMode pins this one to the bridge's own source.
const bridgeProbeEnv = "TL_T3_BRIDGE_PROBE"

// SelfTest verifies that the bridge still completes the SDK handshake, and is
// run at start and after any t3 version change.
//
// It is the design's answer to protocol drift: the bridge implements a subset
// of a protocol we do not own, under software that upgrades nightly, so the
// syncer reports a broken handshake rather than letting threads degrade
// quietly. The escape hatch it points at is decision 5 — switch the thread to
// the stock claudeAgent instance.
//
// The probe is local on purpose. Asking T3 to do it would mean creating a
// throwaway thread in the user's own list and then cleaning it up, and a
// half-cleaned probe thread is worse than no probe. Spawning the bridge with
// the argv T3 uses and driving one initialize over its stdio exercises the same
// code path with nothing left behind.
//
// It lives on Client because that is the seam CONTRACT.md names, and because
// the thing being tested is the far end of the same integration.
func (c *Client) SelfTest(ctx context.Context) error {
	if c.BridgePath == "" {
		return fmt.Errorf("self-test: no bridge path configured")
	}
	timeout := c.SelfTestTimeout
	if timeout <= 0 {
		timeout = defaultSelfTestTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	sessionID, err := newUUID()
	if err != nil {
		return fmt.Errorf("self-test: %w", err)
	}
	requestID, err := newUUID()
	if err != nil {
		return fmt.Errorf("self-test: %w", err)
	}

	// The argv T3 spawns a NEW thread's provider with, trimmed to the flags
	// that decide behaviour. Unknown flags are kept by the bridge, so a probe
	// that is a subset stays valid as T3's command line grows.
	cmd := exec.CommandContext(ctx, c.BridgePath,
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--verbose",
		"--session-id", sessionID,
	)
	// PROBE mode. The argv above is the argv T3 uses, which is the point — but
	// the session id is one T3 never issued, and to an ordinary spawn that is
	// simply a conversation with no tmux session yet: the bridge would create
	// one and start a claude in it, once per syncer restart. The env var tells
	// it to answer the handshake and stop (t3-bridge's ProbeEnv).
	cmd.Env = append(os.Environ(), bridgeProbeEnv+"=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("self-test: stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("self-test: stdout: %w", err)
	}
	var stderr lockedBuffer
	cmd.Stderr = &stderr
	// WaitDelay bounds the cleanup below: killing the probe closes its stdio,
	// but a grandchild that inherited the pipe can hold it open, and Wait would
	// otherwise block on that fd forever.
	cmd.WaitDelay = time.Second
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("self-test: starting %s: %w", c.BridgePath, err)
	}
	// Killing the probe is not optional: a bridge that answered the handshake
	// would otherwise sit attached to a tmux session for as long as this
	// process lives.
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	initialize := fmt.Sprintf(
		`{"type":"control_request","request_id":%q,"request":{"subtype":"initialize"}}`+"\n", requestID)
	if _, err := io.WriteString(stdin, initialize); err != nil {
		return fmt.Errorf("self-test: writing initialize: %w (stderr: %s)", err, stderr.String())
	}

	// The read runs on its own goroutine and the timeout is taken from ctx,
	// not from the process dying. A bridge that hangs may have handed its
	// stdout to a child, so killing it does not necessarily end the read — and
	// the self-test is on the startup path, where hanging is the one outcome
	// that must be impossible.
	done := make(chan error, 1)
	go func() { done <- awaitHandshake(stdout, requestID) }()

	var handshakeErr error
	select {
	case handshakeErr = <-done:
	case <-ctx.Done():
		handshakeErr = fmt.Errorf("self-test: bridge did not complete the handshake within %s", timeout)
	}
	if handshakeErr != nil {
		if se := stderr.String(); se != "" {
			return fmt.Errorf("%w (bridge stderr: %s)", handshakeErr, se)
		}
		return handshakeErr
	}
	return nil
}

// lockedBuffer collects a child's stderr for an error message. os/exec writes
// to it from its own goroutine, which outlives a timed-out SelfTest, so the
// reads here need the lock even though the logical ordering looks safe.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return strings.TrimSpace(b.buf.String())
}

// handshakeFrame is the little of an outbound frame the probe reads. The full
// shapes belong to the bridge; this only has to recognise two answers.
type handshakeFrame struct {
	Type     string `json:"type"`
	Subtype  string `json:"subtype"`
	Response struct {
		Subtype   string `json:"subtype"`
		RequestID string `json:"request_id"`
		Error     string `json:"error"`
	} `json:"response"`
	SessionID string `json:"session_id"`
}

// awaitHandshake reads until both halves of the handshake have arrived: a
// success control_response echoing our request_id, then a system/init.
//
// request_id is a STRING on the INNER object — the one detail of this protocol
// that is easiest to get subtly wrong, and the reason the probe checks it
// rather than accepting any control_response.
func awaitHandshake(stdout io.Reader, requestID string) error {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	var acked bool
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var frame handshakeFrame
		if err := json.Unmarshal(line, &frame); err != nil {
			continue // a bridge is free to print things we do not model
		}
		switch {
		case frame.Type == "control_response":
			if frame.Response.RequestID != requestID {
				return fmt.Errorf("self-test: bridge answered request_id %q, want %q",
					frame.Response.RequestID, requestID)
			}
			if frame.Response.Subtype != "success" {
				return fmt.Errorf("self-test: bridge replied %s to initialize: %s",
					frame.Response.Subtype, frame.Response.Error)
			}
			acked = true
		case frame.Type == "system" && frame.Subtype == "init":
			if !acked {
				return fmt.Errorf("self-test: bridge sent system/init before a control_response")
			}
			if frame.SessionID == "" {
				return fmt.Errorf("self-test: system/init carried no session_id, so T3 would have no resume cursor")
			}
			return nil
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("self-test: reading the bridge: %w", err)
	}
	if !acked {
		return fmt.Errorf("self-test: bridge produced no control_response to initialize")
	}
	return fmt.Errorf("self-test: bridge acknowledged initialize but sent no system/init")
}

// newUUID returns a random version-4 uuid.
//
// Hand-rolled because the module is stdlib-only and every id here is a
// TrimmedNonEmptyString to T3 — the format is our discipline, not its
// requirement. crypto/rand rather than math/rand: a commandId collision would
// silently drop a command.
func newUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("generating a uuid: %w", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
