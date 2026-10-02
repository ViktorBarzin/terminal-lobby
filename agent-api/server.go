package main

// The HTTP surface, and the two things every route on it shares: the gate, and
// the trace.
//
// Both are structural rather than per-handler. Auth is applied to the whole
// /v1 subtree in Routes, so a route added later is authenticated whether or
// not its author remembered; and the trace is written by the wrapper around
// every handler, from a record the handler fills in, so a handler cannot
// forget to be recorded either. Only /health and /openapi.json sit outside,
// and they sit outside in ONE place that is easy to read.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"terminal-lobby/authuser"
)

// maxBodyBytes bounds a request body. Every body here is a short JSON object;
// the cap exists so a caller cannot make the service buffer a stream, and it
// is generous enough that a long prompt — the one field that can legitimately
// be big — is never the thing that hits it.
const maxBodyBytes = 1 << 20 // 1 MiB

// Defaults for the turn watcher. Overridable on the Server so a test drives
// them at microsecond scale rather than waiting out a real turn.
const (
	// defaultPollInterval is how often a running turn's state is re-read. One
	// read is a `sudo -u <user> tmux display-message`, so this is a fork per
	// second per live turn — cheap next to the turn itself, and fast enough
	// that a caller polling at Muse's pace never sees a stale answer.
	defaultPollInterval = time.Second
	// defaultStartGrace is how long a prompt has to visibly start a turn
	// before the task is failed. The hooks stamp @claude_state within about a
	// second of the paste landing (ADR-0001); fifteen means a conversation
	// with no Claude in it is reported as broken rather than left running
	// forever.
	defaultStartGrace = 15 * time.Second
	// defaultReadyTimeout is how long a conversation has to become ready for
	// a prompt: its transcript stamped and its harness drawn. Generous,
	// because the wait it covers is a cold `claude` start on a loaded
	// workstation, and the cost of being wrong is a caller told its
	// conversation is broken when it was merely starting.
	defaultReadyTimeout = 60 * time.Second
	// defaultTurnTimeout bounds a single turn. A real turn here runs for
	// minutes and occasionally hours, so this is not a latency budget — it is
	// the ceiling that stops one wedged conversation leaking a goroutine and
	// a task for the life of the process.
	defaultTurnTimeout = 6 * time.Hour
)

// Server is the whole service.
type Server struct {
	Gate     *authuser.Gate
	Sessions Sessions
	Tasks    *TaskStore
	Runner   *Runner
	Trace    *Trace
	IDs      *idGen

	// HomeBase is the parent of every user's home; "/home" in production, a
	// temp dir in tests.
	HomeBase string
	// ClaudeBin is the harness a new conversation runs.
	ClaudeBin string
	// Models is the slug list this box offers, read from Claude Code's managed
	// settings at startup. An empty list means accept anything; see models.
	Models models

	PollInterval time.Duration
	StartGrace   time.Duration
	ReadyTimeout time.Duration
	TurnTimeout  time.Duration
	// WaitUnit is how long one second of a caller's ?wait= lasts. A second in
	// production; a test shrinks it so a wait that cannot finish still ends
	// in milliseconds.
	WaitUnit time.Duration
	Now      func() time.Time

	// StoreRoot is the clipboard store a message's files are written to;
	// clipstore.DefaultRoot in production, a temp dir in tests.
	StoreRoot string
	// Limits bounds a multipart message; zero fields take
	// defaultUploadLimits. A test shrinks them so it moves kilobytes.
	Limits UploadLimits
	// UploadTimeout is how long an authenticated upload may take to arrive;
	// defaultUploadTimeout when zero. See attach.go.
	UploadTimeout time.Duration

	// Delegations is the store behind /v1/delegations (delegation.go).
	Delegations *DelegationStore
	// DelegationCreators names the Callers that may create a delegation, from
	// TL_DELEGATION_CREATORS. Empty, nobody can, and the feature is off.
	DelegationCreators map[string]bool
	// PublicURL is the base the callback in a delegation's message names,
	// from TL_AGENT_PUBLIC_URL; defaultPublicURL when empty.
	PublicURL string
	// DelegationCaps overrides defaultDelegationCaps field by field; a test
	// shrinks it so a cap is reached in three requests rather than twenty.
	DelegationCaps delegationCaps
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Server) pollInterval() time.Duration {
	if s.PollInterval > 0 {
		return s.PollInterval
	}
	return defaultPollInterval
}

func (s *Server) startGrace() time.Duration {
	if s.StartGrace > 0 {
		return s.StartGrace
	}
	return defaultStartGrace
}

func (s *Server) readyTimeout() time.Duration {
	if s.ReadyTimeout > 0 {
		return s.ReadyTimeout
	}
	return defaultReadyTimeout
}

func (s *Server) waitUnit() time.Duration {
	if s.WaitUnit > 0 {
		return s.WaitUnit
	}
	return time.Second
}

func (s *Server) turnTimeout() time.Duration {
	if s.TurnTimeout > 0 {
		return s.TurnTimeout
	}
	return defaultTurnTimeout
}

// apiError is a refusal with a status. Handlers return one instead of writing
// to the ResponseWriter, so the wrapper can record what was refused and why in
// the same line it records everything else.
type apiError struct {
	Status int
	Msg    string
	// RetryAfter, when set, is sent as a Retry-After header: the one refusal
	// that comes with a time it stops applying.
	RetryAfter time.Duration
}

func (e *apiError) Error() string { return e.Msg }

func badRequest(format string, args ...any) error {
	return &apiError{Status: http.StatusBadRequest, Msg: fmt.Sprintf(format, args...)}
}

func notFound(format string, args ...any) error {
	return &apiError{Status: http.StatusNotFound, Msg: fmt.Sprintf(format, args...)}
}

func forbidden(format string, args ...any) error {
	return &apiError{Status: http.StatusForbidden, Msg: fmt.Sprintf(format, args...)}
}

func conflict(format string, args ...any) error {
	return &apiError{Status: http.StatusConflict, Msg: fmt.Sprintf(format, args...)}
}

// unprocessable is a well-formed request this service will not carry out
// because of what the thing it names is: a question kind it has no safe way to
// answer. Kept apart from 409, which says the state is wrong NOW and may be
// right later, because a caller retrying this one would be retrying forever.
func unprocessable(format string, args ...any) error {
	return &apiError{Status: http.StatusUnprocessableEntity, Msg: fmt.Sprintf(format, args...)}
}

// gone is a request about something that has ended for good: a delegation
// result posted after its expiry. Kept apart from 409 because the caller's
// right move differs: a conflict may be retried after a read, this may not.
func gone(format string, args ...any) error {
	return &apiError{Status: http.StatusGone, Msg: fmt.Sprintf(format, args...)}
}

// tooManyRequests is a refusal by a rate cap, with when it lifts.
func tooManyRequests(retryAfter time.Duration, format string, args ...any) error {
	return &apiError{Status: http.StatusTooManyRequests, Msg: fmt.Sprintf(format, args...), RetryAfter: retryAfter}
}

func serverError(format string, args ...any) error {
	return &apiError{Status: http.StatusInternalServerError, Msg: fmt.Sprintf(format, args...)}
}

// call is one authenticated request, plus the half-built trace line it will
// produce. A handler reads id and body and fills the trace fields it knows
// about; everything else the wrapper does.
type call struct {
	r *http.Request
	// w is here for the one handler that streams: an upload needs it for
	// http.MaxBytesReader and to lift the connection's deadlines. Every
	// handler still answers by returning, never by writing to it.
	w  http.ResponseWriter
	id authuser.Identity
	// body is the raw request body, verbatim, for a write route. The trace
	// carries these exact bytes, which is what makes a replay a replay.
	body []byte
	// multipart is set when a route that takes uploads was sent
	// multipart/form-data. The body is then left unread for the handler to
	// stream, and body is nil.
	multipart bool

	// The fields a handler contributes to the trace.
	conversationID string
	taskID         string
	delegationID   string
	// event names what a write did, for a log query to match without parsing
	// verbs and statuses: "delegation.undelivered" is the one infra alerts on.
	event string
	// reason travels with an undelivered event, so the alert can say why.
	reason string
	// traceResponse overrides what the trace records as the response. Set it
	// where the response body is unbounded — a transcript, a session list —
	// so one request cannot write a megabyte into trace.jsonl. Left nil, the
	// response body itself is recorded, which is right for everything small.
	traceResponse any
	// traceRequest overrides what the trace records as the request, for the
	// same reason in the other direction: a multipart body can be 200 MB, so
	// an upload records its text and the files' names and stored paths
	// instead of the bytes.
	traceRequest any
	// status is the success status; 200 unless a handler says otherwise.
	status int
}

// decode reads the JSON body into v, refusing anything that is not one
// well-formed object.
func (c *call) decode(v any) error {
	if len(c.body) == 0 {
		return badRequest("a JSON request body is required")
	}
	dec := json.NewDecoder(strings.NewReader(string(c.body)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return badRequest("request body: %v", err)
	}
	if dec.More() {
		return badRequest("request body: expected exactly one JSON object")
	}
	return nil
}

// apiHandler is the shape of every v1 handler: answer, or refuse with a
// status. Returning the body rather than writing it is what lets the wrapper
// own the encoding, the status and the trace in one place.
type apiHandler func(*call) (any, error)

// Routes builds the mux.
//
// /v1 is a nested mux behind one auth wrapper. That is the load-bearing detail
// in this function: a route registered inside it is authenticated by
// construction, so "every route except /health and /openapi.json requires
// auth" is a property of the wiring rather than a convention each handler has
// to honour.
func (s *Server) Routes() http.Handler {
	v1 := http.NewServeMux()
	v1.Handle("GET /v1/conversations", s.handle("GET /v1/conversations", s.listConversations))
	v1.Handle("POST /v1/conversations", s.handle("POST /v1/conversations", s.createConversation))
	v1.Handle("GET /v1/conversations/{id}", s.handle("GET /v1/conversations/{id}", s.getConversation))
	v1.Handle("DELETE /v1/conversations/{id}", s.handle("DELETE /v1/conversations/{id}", s.deleteConversation))
	v1.Handle("GET /v1/conversations/{id}/transcript", s.handle("GET /v1/conversations/{id}/transcript", s.getTranscript))
	v1.Handle("POST /v1/conversations/{id}/messages", s.handleUploads("POST /v1/conversations/{id}/messages", s.postMessage))
	v1.Handle("GET /v1/tasks/{id}", s.handle("GET /v1/tasks/{id}", s.getTask))
	v1.Handle("POST /v1/tasks/{id}/cancel", s.handle("POST /v1/tasks/{id}/cancel", s.cancelTask))
	v1.Handle("POST /v1/tasks/{id}/answer", s.handle("POST /v1/tasks/{id}/answer", s.answerTask))
	v1.Handle("GET /v1/delegations", s.handle("GET /v1/delegations", s.listDelegations))
	v1.Handle("POST /v1/delegations", s.handle("POST /v1/delegations", s.createDelegation))
	v1.Handle("GET /v1/delegations/{id}", s.handle("GET /v1/delegations/{id}", s.getDelegation))
	v1.Handle("POST /v1/delegations/{id}/sent", s.handle("POST /v1/delegations/{id}/sent", s.markDelegationSent))
	v1.Handle("POST /v1/delegations/{id}/undelivered", s.handle("POST /v1/delegations/{id}/undelivered", s.markDelegationUndelivered))
	v1.Handle("POST /v1/delegations/{id}/result", s.handle("POST /v1/delegations/{id}/result", s.postDelegationResult))

	root := http.NewServeMux()
	root.Handle("/v1/", s.requireAuth(v1))

	// The two open routes. /health is what tl-apply probes after an install
	// and what a monitor polls, so it authenticates nothing and allocates
	// nothing. /openapi.json is open because a caller has to READ it before
	// it can hold a credential — it is the document a client is generated
	// from, and it describes routes rather than revealing anything about
	// them. Neither is traced: health is polled every few seconds and would
	// drown the file the trace exists to keep readable.
	root.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.WriteString(w, "ok")
	})
	root.HandleFunc("GET /openapi.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write(openAPIWithModels(s.Models))
	})
	return root
}

// requireAuth is the gate in front of every v1 route.
//
// It is narrower than the other lobby services' gate, deliberately. They serve
// a browser behind forward-auth, so an identity header the proxy set plus the
// shared TL_PROXY_SECRET is the right credential for them. It is the wrong one
// here: a program can set a header, and one shared secret cannot be withdrawn
// from one caller without withdrawing it from every caller. So this service
// takes a per-caller bearer and NOTHING else.
//
// Two lines make that structural rather than configured. A request with no
// bearer is refused before the gate sees it, and the browser path's two
// headers are STRIPPED from the request before it is resolved — so the header
// path cannot answer here whatever the box is configured with, including a box
// whose credentials file is missing, where authuser deliberately leaves that
// path available.
//
// Everything after that is authuser's: it writes the refusal itself, with the
// right one of 401/403/500 and a log line naming the route.
func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !bearerPresented(r) {
			logf("agent-api: no bearer credential (%s %s)", r.Method, r.URL.Path)
			http.Error(w, "this service requires a per-caller credential: "+
				"send Authorization: Bearer <token>", http.StatusUnauthorized)
			return
		}
		scoped := r.Clone(r.Context())
		scoped.Header.Del(s.Gate.AuthHeader())
		scoped.Header.Del(authuser.SecretHeader)

		id, ok := s.Gate.Authorize(w, scoped)
		if !ok {
			return
		}
		next.ServeHTTP(w, scoped.WithContext(withIdentity(scoped.Context(), id)))
	})
}

// bearerPresented reports whether the request offers a bearer credential at
// all. authuser applies the same rule and keeps it unexported; the three lines
// are repeated rather than widening that package's surface for one caller, and
// the two agree on what RFC 7235 says: the scheme is case-insensitive.
func bearerPresented(r *http.Request) bool {
	h := strings.TrimSpace(r.Header.Get("Authorization"))
	if h == "" {
		return false
	}
	scheme, _, _ := strings.Cut(h, " ")
	return strings.EqualFold(scheme, "Bearer")
}

// handle wraps one handler: body capture, dispatch, JSON encoding, and the
// trace line.
func (s *Server) handle(verb string, h apiHandler) http.Handler {
	return s.wrap(verb, h, false)
}

// handleUploads is handle for a route that also takes multipart/form-data.
// Such a body is not read here: it can be 200 MB, so the handler streams it
// to disk itself (attach.go). Any other body is read exactly as handle reads
// it, so the JSON form of the route is unchanged.
func (s *Server) handleUploads(verb string, h apiHandler) http.Handler {
	return s.wrap(verb, h, true)
}

func (s *Server) wrap(verb string, h apiHandler, uploads bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := s.now()
		id, _ := identityFrom(r.Context())

		c := &call{r: r, w: w, id: id, status: http.StatusOK}
		entry := TraceEntry{
			TraceID: s.IDs.New(),
			// The credential's NAME. authuser puts the token nowhere on the
			// Identity, so there is no field here that could carry one.
			Actor: id.Header,
			Verb:  verb,
		}

		if uploads && isMultipart(r) {
			c.multipart = true
			// Replaced by the handler once it has read the parts; this is
			// what a refusal before that point records.
			entry.Request = marshalOrNote(map[string]string{"multipart": "not read"})
		} else {
			body, err := readBody(r)
			if err != nil {
				s.reply(w, c, entry, start, nil, err)
				return
			}
			c.body = body
			entry.Request = requestRecord(r, body)
		}

		out, herr := h(c)
		if c.traceRequest != nil {
			entry.Request = marshalOrNote(c.traceRequest)
		}
		s.reply(w, c, entry, start, out, herr)
	})
}

// reply writes the answer and the trace line.
func (s *Server) reply(w http.ResponseWriter, c *call, entry TraceEntry, start time.Time, out any, herr error) {
	status := c.status
	var payload any
	if herr != nil {
		var ae *apiError
		if errors.As(herr, &ae) {
			status = ae.Status
			if ae.RetryAfter > 0 {
				w.Header().Set("Retry-After", retryAfterSeconds(ae.RetryAfter))
			}
		} else {
			status = http.StatusInternalServerError
		}
		payload = map[string]string{"error": herr.Error()}
	} else {
		payload = out
	}

	entry.TS = traceTime(start)
	entry.TaskID = c.taskID
	entry.ConversationID = c.conversationID
	entry.DelegationID = c.delegationID
	// An event names a change that happened, so a refused write has none.
	if herr == nil {
		entry.Event = c.event
		entry.Reason = c.reason
	}
	entry.Status = status
	entry.Duration = float64(s.now().Sub(start)) / float64(time.Millisecond)
	recorded := payload
	if herr == nil && c.traceResponse != nil {
		recorded = c.traceResponse
	}
	entry.Response = marshalOrNote(recorded)
	s.Trace.Write(entry)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if payload == nil {
		return
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(payload); err != nil {
		// The status and headers are already out; there is nothing to do for
		// the caller but there is something to say to the operator.
		logf("agent-api: %s: writing the response failed: %v", entry.Verb, err)
	}
}

// readBody reads at most maxBodyBytes. An empty body is not an error here —
// the handler decides whether it needed one.
func readBody(r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return nil, nil
	}
	b, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, maxBodyBytes))
	if err != nil {
		return nil, badRequest("reading the request body: %v", err)
	}
	return b, nil
}

// requestRecord is what the trace stores as the caller's request.
//
// For a body-carrying route it is the body EXACTLY as it arrived, so a replay
// reads the caller's own words rather than a re-encoding of a struct that
// dropped whatever field this version does not know about. For a read route
// it is the query string as an object. Headers are not consulted, which is
// how the bearer token stays out of the file.
func requestRecord(r *http.Request, body []byte) json.RawMessage {
	if len(body) > 0 && json.Valid(body) {
		return json.RawMessage(body)
	}
	if len(body) > 0 {
		// Not JSON. Keep it verbatim anyway, as a string, because the point of
		// the trace is what was sent rather than what was well-formed.
		return marshalOrNote(map[string]string{"raw": string(body)})
	}
	q := map[string]string{}
	for k, v := range r.URL.Query() {
		if len(v) > 0 {
			q[k] = v[0]
		}
	}
	return marshalOrNote(q)
}

// marshalOrNote encodes a value, or a note saying why it could not be. The
// trace must not lose a line because one field would not marshal.
func marshalOrNote(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(fmt.Sprintf(`{"unencodable":%q}`, err.Error()))
	}
	return b
}
