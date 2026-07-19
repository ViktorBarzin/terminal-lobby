package main

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
)

type sessionInfo struct {
	TmuxSession string
	CWD         string
	ClaudeID    string
	Transcript  string
}

// sessionMap resolves a tmux session name to its Claude transcript, populated by
// the SessionStart hook. Per-process, per OS user (the service runs per user).
type sessionMap struct {
	mu           sync.RWMutex
	m            map[string]sessionInfo
	projectsRoot string // ~/.claude/projects (overridable for tests)
}

func newSessionMap(projectsRoot string) *sessionMap {
	return &sessionMap{m: map[string]sessionInfo{}, projectsRoot: projectsRoot}
}

// transcriptPath mirrors Claude Code's layout: <root>/<cwd-with-slashes-as-dashes>/<session-id>.jsonl
// e.g. /home/wizard/code/terminal-lobby -> -home-wizard-code-terminal-lobby.
func transcriptPath(root, cwd, claudeID string) string {
	slug := strings.ReplaceAll(cwd, "/", "-")
	return filepath.Join(root, slug, claudeID+".jsonl")
}

func (s *sessionMap) put(info sessionInfo) {
	info.Transcript = transcriptPath(s.projectsRoot, info.CWD, info.ClaudeID)
	s.mu.Lock()
	s.m[info.TmuxSession] = info
	s.mu.Unlock()
}

func (s *sessionMap) get(tmux string) (sessionInfo, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	i, ok := s.m[tmux]
	return i, ok
}

type sessionStartBody struct {
	SessionID   string `json:"session_id"`
	CWD         string `json:"cwd"`
	TmuxSession string `json:"tmux_session"`
}

// sessionStartHandler receives the SessionStart hook and records the mapping.
func sessionStartHandler(s *sessionMap) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b sessionStartBody
		if json.NewDecoder(r.Body).Decode(&b) != nil || b.SessionID == "" || b.TmuxSession == "" {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		s.put(sessionInfo{TmuxSession: b.TmuxSession, CWD: b.CWD, ClaudeID: b.SessionID})
		w.WriteHeader(http.StatusNoContent)
	}
}
