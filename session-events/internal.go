package main

import (
	"encoding/json"
	"net"
	"net/http"
	"os/user"
	"slices"

	"terminal-lobby/sessionio"
)

// The internal routes let agent-api read the dialog a Claude session is
// waiting on and answer it through the session's mod, the path the Text view
// already takes (ADR-0037). Before them agent-api read the pane and pressed
// keys.
//
// They sit on the root mux, outside the web gate, because agent-api holds no
// proxy secret and takes no identity header. A request passes four checks:
//
//   - it comes from loopback;
//   - the socket that sent it belongs to this service's own OS account, the
//     account agent-api runs as;
//   - its Host is this box's loopback address and it carries X-TL-Internal,
//     which a web page cannot add without a CORS preflight this service never
//     grants, so a browser running as the same account cannot reach them,
//     DNS rebinding included;
//   - the user it names is one the lobby serves.
//
// That account already holds `sudo -u <user> tmux` for every user the lobby
// serves, which can type into any of their panes, so the routes add no power
// it lacks. The roster check is what keeps that true: the mod connects for any
// account that runs Claude, and the grant covers only the roster.

const internalHeader = "X-TL-Internal"

type internalGate struct {
	users func() []string
	self  func(*http.Request) (bool, error)
}

func (g internalGate) wrap(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
			http.Error(w, "localhost only", http.StatusForbidden)
			return
		}
		if h, _, err := net.SplitHostPort(r.Host); err != nil || (h != "127.0.0.1" && h != "localhost") {
			http.Error(w, "loopback host only", http.StatusForbidden)
			return
		}
		if r.Header.Get(internalHeader) != "1" {
			http.Error(w, "missing "+internalHeader, http.StatusForbidden)
			return
		}
		if ok, err := g.self(r); err != nil || !ok {
			http.Error(w, "this service's own account only", http.StatusForbidden)
			return
		}
		osUser, session := r.PathValue("user"), r.PathValue("session")
		if !modSessionRe.MatchString(session) || !slices.Contains(g.users(), osUser) {
			http.Error(w, "no such user or session", http.StatusNotFound)
			return
		}
		next(w, r)
	}
}

// peerIsSelf reports whether the connection r arrived on was opened by this
// process's own OS account.
func peerIsSelf(r *http.Request) (bool, error) {
	me, err := user.Current()
	if err != nil {
		return false, err
	}
	who, err := peerUser(r)
	if err != nil {
		return false, err
	}
	return who == me.Username, nil
}

// internalDialog is what GET /internal/v1/dialog answers: the oldest open
// dialog, with the fields its kind has.
type internalDialog struct {
	Kind         string             `json:"kind"`
	ToolID       string             `json:"toolId"`
	Questions    []internalQuestion `json:"questions,omitempty"`
	Plan         string             `json:"plan,omitempty"`
	PlanFilePath string             `json:"planFilePath,omitempty"`
	Tool         string             `json:"tool,omitempty"`
	Title        string             `json:"title,omitempty"`
	Detail       []string           `json:"detail,omitempty"`
	Reason       string             `json:"reason,omitempty"`
}

type internalQuestion struct {
	Question    string           `json:"question"`
	Header      string           `json:"header,omitempty"`
	MultiSelect bool             `json:"multiSelect,omitempty"`
	Options     []internalOption `json:"options"`
}

type internalOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

func (d *modDialog) internal() internalDialog {
	out := internalDialog{Kind: d.kind, ToolID: d.toolID, Plan: d.plan, PlanFilePath: d.planFilePath,
		Tool: d.tool, Title: d.title, Detail: d.detail, Reason: d.reason}
	if d.kind == "ask" {
		_ = json.Unmarshal(d.raw, &out.Questions)
	}
	return out
}

// handleInternalDialog serves GET /internal/v1/dialog/{user}/{session}: 200
// with the oldest open dialog, 204 when nothing is open, 404 with no mod.
//
// Both routes find the mod through connFollow, because the agent API asks by
// the name the session has now and autotitle renames a session a few seconds
// into its first turn, often while a dialog that turn opened is waiting.
func (rg *registry) handleInternalDialog() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c := rg.mods.connFollow(r.Context(), r.PathValue("user"), r.PathValue("session"))
		if c == nil {
			http.Error(w, "no mod for that session", http.StatusNotFound)
			return
		}
		d := c.dialogNow()
		if d == nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeJSON(w, d.internal())
	}
}

// handleInternalAnswer serves POST /internal/v1/answer/{user}/{session}. The
// answer must name its dialog; 409 when that dialog is no longer open.
func (rg *registry) handleInternalAnswer() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		osUser, session := r.PathValue("user"), r.PathValue("session")
		var req sessionio.AnswerRequest
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, answerBodyLimit)).Decode(&req) != nil || req.ToolID == "" {
			http.Error(w, "bad body (an AnswerRequest naming its toolId)", http.StatusBadRequest)
			return
		}
		c := rg.mods.connFollow(r.Context(), osUser, session)
		if c == nil {
			http.Error(w, "no mod for that session", http.StatusNotFound)
			return
		}
		var known []sessionio.DialogQuestion
		open := false
		c.mu.Lock()
		for _, d := range c.dialogs {
			if d.toolID != req.ToolID {
				continue
			}
			open = true
			for _, q := range d.questions {
				known = append(known, sessionio.DialogQuestion{Question: q.Question, MultiSelect: q.MultiSelect})
			}
		}
		c.mu.Unlock()
		if !open {
			http.Error(w, "that dialog is no longer open", http.StatusConflict)
			return
		}
		resp := c.answer(r.Context(), req)
		resp.Action = sessionio.AnswerAction(req)
		emitAnswer(osUser, session, known, resp, resp.Action, "agent-api")
		if resp.Applied {
			emitAnswered(osUser, session, req)
		}
		writeJSON(w, resp)
	}
}
