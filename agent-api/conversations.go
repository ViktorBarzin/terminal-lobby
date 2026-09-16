package main

// The conversation endpoints.
//
// A conversation IS a tmux session. That is not an implementation detail
// leaking through the API — it is the design decision the whole service rests
// on: Terminal Lobby already keeps every Claude conversation alive in tmux,
// resident and addressable, and agent-api is the machine-facing door onto the
// same sessions a person sees in the browser. So the id a caller holds is the
// tmux session name, every verb below is a sessionio call, and a conversation
// Muse opens is one Viktor can attach to from the lobby.

import (
	"errors"
	"regexp"
	"strings"

	"terminal-lobby/sessionio"
)

// conversationNameRe is the charset a tmux session name may use, matched to
// tmux-api's own sessionNameRe so a conversation created here is one the lobby
// can address. The value reaches `tmux new-session -s` argv.
var conversationNameRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,32}$`)

// argValueRe bounds the model and effort a caller may ask for. Both reach the
// harness's argv through a shell line, so the charset is what keeps them
// inert; the values themselves are the harness's business and change with
// every Claude release, which is why the model is not enumerated here.
var argValueRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// permissionModes is claude's own set. Enumerated rather than charset-bounded
// because an unrecognised value does not fail at the API — it fails inside
// tmux, where claude exits at startup and the caller is left holding a
// conversation id for a session that died two seconds later.
var permissionModes = map[string]bool{
	"default":           true,
	"acceptEdits":       true,
	"bypassPermissions": true,
	"plan":              true,
}

// efforts is claude's reasoning ladder.
var efforts = map[string]bool{"low": true, "medium": true, "high": true}

// Conversation is what the API reports about one session.
type Conversation struct {
	ID string `json:"conversation_id"`
	// Name is the display title a person gave it in the lobby, or the id when
	// nobody has.
	Name string `json:"name"`
	CWD  string `json:"cwd"`
	// State mirrors @claude_state, with one value of this service's own:
	// "no_agent" for a session no Claude has ever run in. sessionio is firm
	// that an unstamped session is a different answer from a finished one,
	// and collapsing the two would report a plain shell as an idle agent.
	State string `json:"state"`
	// CreatedBy is the credential that created this conversation through
	// agent-api, absent for one a person started from the lobby.
	CreatedBy string `json:"created_by,omitempty"`
	// Writable says whether THIS caller may send it messages.
	Writable bool `json:"writable"`
	// QueuedTurns is how many turns in this conversation have not finished,
	// counting the one in flight.
	QueuedTurns int `json:"queued_turns"`
}

// stateName maps @claude_state onto the API's vocabulary.
func stateName(raw string) string {
	switch strings.TrimSpace(raw) {
	case sessionio.StateRunning:
		return "running"
	case sessionio.StateAwaiting:
		return "awaiting"
	case sessionio.StateDone:
		return "done"
	default:
		return "no_agent"
	}
}

// conversationFrom renders one live session for one caller.
func (s *Server) conversationFrom(live LiveSession, actor string) Conversation {
	name := strings.TrimSpace(live.Title)
	if name == "" {
		name = live.Name
	}
	return Conversation{
		ID:          live.ID(),
		Name:        name,
		CWD:         live.Dir,
		State:       stateName(live.State),
		CreatedBy:   live.Owner,
		Writable:    live.Owner != "" && live.Owner == actor,
		QueuedTurns: s.Runner.Ahead(live.ID()),
	}
}

// find looks one conversation up among the caller's live sessions.
//
// It matches the id against the name the session was BORN with as well as the
// one it has now, because those differ in the ordinary case: tmux-api renames
// a session from the content of its first turn, seconds after that turn
// starts. The born name is preferred, so a rename cannot make one caller's id
// collide with another session's current name.
//
// The LiveSession it returns carries the CURRENT name, which is what every
// tmux call has to use. Nothing downstream should keep that name: resolve
// again rather than caching it, because the rename can land mid-turn.
func (s *Server) find(osUser, id string) (LiveSession, error) {
	live, err := s.Sessions.List(osUser)
	if err != nil {
		return LiveSession{}, serverError("listing sessions: %v", err)
	}
	for _, l := range live {
		if l.BornAs == id {
			return l, nil
		}
	}
	for _, l := range live {
		if l.BornAs == "" && l.Name == id {
			return l, nil
		}
	}
	return LiveSession{}, notFound("no conversation %q", id)
}

// listConversations serves GET /v1/conversations.
//
// Every session the caller's OS user has, not only the ones agent-api created.
// The design doc accepts that deliberately: Muse can see and read Viktor's own
// conversations, and the containment is that Terminal Lobby scopes the list to
// one OS user, so emo's and ancamilea's are not in it.
func (s *Server) listConversations(c *call) (any, error) {
	live, err := s.Sessions.List(c.id.OSUser)
	if err != nil {
		return nil, serverError("listing sessions: %v", err)
	}
	out := make([]Conversation, 0, len(live))
	for _, l := range live {
		out = append(out, s.conversationFrom(l, c.id.Header))
	}
	// A count rather than the list: this is polled, and a hundred
	// conversations per poll would make the trace file unreadable for the
	// thing it exists to show, which is what a caller ASKED for.
	c.traceResponse = map[string]int{"conversations": len(out)}
	return map[string]any{"conversations": out}, nil
}

// getConversation serves GET /v1/conversations/{id}.
func (s *Server) getConversation(c *call) (any, error) {
	id := c.r.PathValue("id")
	c.conversationID = id
	live, err := s.find(c.id.OSUser, id)
	if err != nil {
		return nil, err
	}
	return s.conversationFrom(live, c.id.Header), nil
}

// createRequest is the POST /v1/conversations body.
type createRequest struct {
	CWD            string `json:"cwd"`
	Model          string `json:"model"`
	Effort         string `json:"effort"`
	PermissionMode string `json:"permission_mode"`
	Name           string `json:"name"`
}

// createConversation serves POST /v1/conversations.
func (s *Server) createConversation(c *call) (any, error) {
	var req createRequest
	if err := c.decode(&req); err != nil {
		return nil, err
	}

	cwd, err := resolveCWD(s.HomeBase, c.id.OSUser, req.CWD)
	if err != nil {
		return nil, badRequest("%v", err)
	}
	if req.Model != "" && !argValueRe.MatchString(req.Model) {
		return nil, badRequest("model %q is not a model name", req.Model)
	}
	if req.Effort != "" && !efforts[req.Effort] {
		return nil, badRequest("effort %q is not one of low, medium, high", req.Effort)
	}
	if req.PermissionMode != "" && !permissionModes[req.PermissionMode] {
		return nil, badRequest("permission_mode %q is not one of default, acceptEdits, bypassPermissions, plan", req.PermissionMode)
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		// 6 + 26 = 32, exactly the tmux name budget, and sortable by creation
		// so a list of generated conversations reads chronologically.
		name = "agent-" + s.IDs.New()
	}
	if !conversationNameRe.MatchString(name) {
		return nil, badRequest("name %q must be 1-32 characters of letters, digits, underscore or dash", name)
	}
	c.conversationID = name

	if err := s.Sessions.Create(CreateSpec{
		OSUser:  c.id.OSUser,
		Name:    name,
		Dir:     cwd,
		Command: []string{claudeCommandLine(s.ClaudeBin, req)},
	}); err != nil {
		// The commonest failure by far is a name already taken, which
		// sessionio refuses rather than attaching to — attaching would hand
		// this caller somebody else's live conversation.
		return nil, conflict("creating the conversation: %v", err)
	}

	// Stamp the name this conversation is addressed by, BEFORE the owner, so
	// the id is stable from the first moment the session exists. tmux-api
	// writes this option on the first rename that moves a session, and the
	// measurement that prompted this found it EMPTY on three renamed sessions
	// — so it is written here rather than waited for. The value is the name
	// the session was created with, which is exactly what tmux-api would
	// write, so stamping it first changes nothing about what that rename does.
	if err := s.Sessions.SetOption(c.id.OSUser, name, sessionio.OptionBornAs, name); err != nil {
		return nil, serverError("conversation %s was created but its id could not be pinned (%v); "+
			"it will stop answering to that id when it is renamed", name, err)
	}

	// Stamp the owner. A failure here leaves a session nobody can write to
	// through this API, which is the safe direction but not a state to leave
	// silent: it is reported as a server error with the id in it, so the
	// caller knows the session exists and which one to look at.
	if err := s.Sessions.SetOption(c.id.OSUser, name, OptionOwner, c.id.Header); err != nil {
		return nil, serverError("conversation %s was created but could not be stamped as yours "+
			"(%v); it is live and readable, and messages to it will be refused", name, err)
	}

	c.status = 201
	return Conversation{
		ID:        name,
		Name:      name,
		CWD:       cwd,
		State:     "no_agent",
		CreatedBy: c.id.Header,
		Writable:  true,
	}, nil
}

// claudeCommandLine builds the shell line tmux runs in the new session.
//
// ONE already-quoted string rather than an argv, for the reason t3-bridge's
// resurrectCommandLine documents: tmux's new-session joins several arguments
// with spaces and hands the result to /bin/sh, so anything carrying a space or
// a quote arrives split. Quoting here and passing a single element makes both
// paths identical.
func claudeCommandLine(bin string, req createRequest) string {
	args := []string{bin}
	if req.Model != "" {
		args = append(args, "--model", req.Model)
	}
	if req.Effort != "" {
		args = append(args, "--effort", req.Effort)
	}
	if req.PermissionMode != "" {
		args = append(args, "--permission-mode", req.PermissionMode)
	}
	quoted := make([]string, 0, len(args))
	for _, a := range args {
		quoted = append(quoted, shellQuote(a))
	}
	return strings.Join(quoted, " ")
}

// shellQuote makes one argument safe for /bin/sh. Single quotes, because
// inside them the shell interprets nothing at all; the only escape needed is
// for a single quote, which ends the run, is backslash-escaped outside it, and
// starts a new one.
func shellQuote(arg string) string {
	if arg != "" && !strings.ContainsFunc(arg, func(r rune) bool { return !shellSafe(r) }) {
		return arg
	}
	return "'" + strings.ReplaceAll(arg, "'", `'\''`) + "'"
}

// shellSafe reports whether a rune needs no quoting. Deliberately
// conservative: anything not obviously inert gets quotes.
func shellSafe(r rune) bool {
	switch {
	case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		return true
	}
	return strings.ContainsRune("-_./:=@,+", r)
}

// messageRequest is the POST /v1/conversations/{id}/messages body.
type messageRequest struct {
	Text string `json:"text"`
}

// postMessage serves POST /v1/conversations/{id}/messages.
//
// It answers before the turn runs. The caller polls the task id, which is what
// the design doc settled on: Muse runs cron jobs and persists while closed, so
// polling is native to it and no inbound path into Meta's VM is needed.
func (s *Server) postMessage(c *call) (any, error) {
	id := c.r.PathValue("id")
	c.conversationID = id

	var req messageRequest
	if err := c.decode(&req); err != nil {
		return nil, err
	}
	text := strings.TrimSpace(req.Text)
	if text == "" {
		return nil, badRequest("text is required")
	}

	live, err := s.find(c.id.OSUser, id)
	if err != nil {
		return nil, err
	}
	if err := s.mayWrite(live, c.id.Header); err != nil {
		return nil, err
	}

	task := &Task{
		ID:             s.IDs.New(),
		ConversationID: live.ID(),
		Actor:          c.id.Header,
		OSUser:         c.id.OSUser,
		Text:           text,
	}
	c.taskID = task.ID
	s.Tasks.Add(task)
	// Read BEFORE the submit, so the answer is how many turns this message
	// waits for rather than a count that includes itself.
	ahead := s.Runner.Ahead(task.ConversationID)
	s.Runner.Submit(task)

	c.status = 202
	return map[string]any{
		"task_id": task.ID,
		"status":  StatusAccepted,
		// How many turns are ahead of this one, the one in flight included.
		// Zero means it starts now; anything else means the conversation is
		// busy and this message waits, which is the serialisation the API
		// promises rather than a delay the caller should retry around.
		"queued_behind": ahead,
	}, nil
}

// mayWrite decides whether a caller may send messages to a conversation.
//
// The rule the design doc set: a conversation this caller created is readable
// and writable; one a person started is readable and NOT writable. Ownership
// is read from the tmux session option rather than from any state this process
// holds, so a restart of agent-api does not change who owns what, and a tmux
// name reused after a session dies starts unowned.
func (s *Server) mayWrite(live LiveSession, actor string) error {
	switch {
	case live.Owner == "":
		return forbidden("conversation %q was not created through this API, so it is readable but not writable "+
			"(it belongs to whoever started it in the terminal)", live.Name)
	case live.Owner != actor:
		return forbidden("conversation %q belongs to %q, so it is readable but not writable by %q",
			live.Name, live.Owner, actor)
	}
	return nil
}

// getTranscript serves GET /v1/conversations/{id}/transcript.
func (s *Server) getTranscript(c *call) (any, error) {
	id := c.r.PathValue("id")
	c.conversationID = id
	live, err := s.find(c.id.OSUser, id)
	if err != nil {
		return nil, err
	}
	lines, err := s.Sessions.TranscriptLines(c.id.OSUser, live.Name)
	if err != nil {
		if errors.Is(err, errNoTranscript) {
			return nil, notFound("conversation %q has no Claude transcript "+
				"(no Claude has run in it, or it has not started writing one yet)", id)
		}
		return nil, serverError("reading the transcript: %v", err)
	}
	msgs := decodeTranscript(lines)
	// The full history can be megabytes. The trace records that it was asked
	// for and how much came back, never the content — which is on disk in the
	// transcript anyway, addressable from this same line.
	c.traceResponse = map[string]int{"messages": len(msgs)}
	return map[string]any{"conversation_id": id, "messages": msgs}, nil
}
