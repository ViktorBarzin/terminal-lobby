package main

// The session routes for T3 rows (docs/plans/2026-10-31-t3-hosts-claude-design.md,
// "New, rename, archive").
//
//   - POST /sessions/t3 starts a thread in the caller's T3 and returns the
//     row's alias and links.
//   - POST /sessions/{alias}/title renames the thread.
//   - DELETE /sessions/{alias} archives it. MCP has no delete, so closing a
//     T3 row means archiving it.
//
// Every other per-session verb is for tmux sessions, and a T3 alias is
// refused before tmux is asked anything. sessionAccess refuses one too, so a
// stray terminal attach cannot create a tmux session under a T3 row's name.

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"terminal-lobby/slug"
	"terminal-lobby/t3client"
)

// t3CallTimeout bounds one route's T3 work. A launch is a project lookup,
// perhaps a project create, and the launch itself.
const t3CallTimeout = 30 * time.Second

// maxT3CreateBody bounds POST /sessions/t3. The prompt is the large part,
// and a pasted log can be long.
const maxT3CreateBody = 256 << 10

// t3DefaultUsers are the users whose New starts Claude in T3 unless their
// own setting says otherwise (TL_T3_DEFAULT_USERS).
var t3DefaultUsers = map[string]bool{}

// parseT3DefaultUsers reads TL_T3_DEFAULT_USERS: user names separated by
// commas or whitespace. A word that is not a user name is skipped.
func parseT3DefaultUsers(spec string) map[string]bool {
	out := map[string]bool{}
	for _, u := range strings.FieldsFunc(spec, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' || r == '\n' }) {
		if sessionNameRe.MatchString(u) {
			out[u] = true
		}
	}
	return out
}

// claudeBackendFor is where a user's New starts Claude when their own
// setting is unset: "t3" for a default user who has a T3, else "tmux".
func claudeBackendFor(osUser string) string {
	if t3DefaultUsers[osUser] && t3PollerInstance.has(osUser) {
		return backendT3
	}
	return "tmux"
}

// handleT3Session serves /sessions/{alias}[/verb] for a T3 row. rest is the
// path after the alias.
func handleT3Session(w http.ResponseWriter, r *http.Request, osUser, alias string, rest []string) {
	// T3 rows are never shared, so a guest's ?owner= finds nothing.
	if owner := r.URL.Query().Get("owner"); owner != "" && owner != osUser {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	switch {
	case len(rest) == 0:
		if r.Method != http.MethodDelete {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		archiveT3Session(w, osUser, alias)
	case len(rest) == 1 && rest[0] == "title":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		retitleT3Session(w, r, osUser, alias)
	default:
		http.Error(w, "a T3 session can be renamed and archived here; open it in T3 for the rest", http.StatusBadRequest)
	}
}

func archiveT3Session(w http.ResponseWriter, osUser, alias string) {
	threadID, ok := t3PollerInstance.threadFor(osUser, alias)
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), t3CallTimeout)
	defer cancel()
	if err := t3PollerInstance.api.Archive(ctx, osUser, threadID); err != nil {
		t3Failed(w, "archive", osUser, err)
		return
	}
	t3PollerInstance.forget(osUser, threadID)
	// An alias never comes back, so its layout place goes with it.
	if err := layoutStoreInstance.removeSession(osUser, alias); err != nil {
		log.Printf("t3: dropping archived %s from %s's layout: %v", alias, osUser, err)
	}
	t3Changed(osUser)
	w.WriteHeader(http.StatusNoContent)
}

func retitleT3Session(w http.ResponseWriter, r *http.Request, osUser, alias string) {
	var body struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	title := slug.CleanTitle(body.Title)
	if title == "" {
		http.Error(w, "a T3 thread needs a title", http.StatusBadRequest)
		return
	}
	threadID, ok := t3PollerInstance.threadFor(osUser, alias)
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), t3CallTimeout)
	defer cancel()
	if err := t3PollerInstance.api.Rename(ctx, osUser, threadID, title); err != nil {
		t3Failed(w, "rename", osUser, err)
		return
	}
	t3PollerInstance.retitle(osUser, threadID, title)
	t3Changed(osUser)
	w.WriteHeader(http.StatusNoContent)
}

// t3CreateRequest is POST /sessions/t3's body. Dir defaults to the user's
// home, Model to the box's default, Title to the prompt's first line.
// Project places the new row in that layout project, as a claim does.
type t3CreateRequest struct {
	Dir     string `json:"dir"`
	Prompt  string `json:"prompt"`
	Model   string `json:"model"`
	Effort  string `json:"effort"`
	Title   string `json:"title"`
	Project string `json:"project"`
}

// t3CreateResponse is what the lobby opens.
type t3CreateResponse struct {
	Name     string `json:"name"`
	URL      string `json:"url"`
	AppURL   string `json:"appUrl"`
	ThreadID string `json:"threadId"`
}

// handleT3Create is POST /sessions/t3. The path also names a tmux session
// called "t3", as /sessions/claim names one called "claim", so every other
// method goes on to the per-session handler.
func handleT3Create(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		handleSessionByName(w, r)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	if !t3PollerInstance.has(osUser) {
		http.Error(w, "no T3 server for "+osUser, http.StatusNotFound)
		return
	}
	var body t3CreateRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxT3CreateBody)).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	dir := strings.TrimSpace(body.Dir)
	if dir == "" {
		dir = homeOfUser(osUser)
	}
	if !filepath.IsAbs(dir) || len(dir) > maxDirLen {
		http.Error(w, "dir must be an absolute path", http.StatusBadRequest)
		return
	}
	dir = filepath.Clean(dir)
	model, effort := strings.TrimSpace(body.Model), strings.TrimSpace(body.Effort)
	if !validSlotFlags(model, effort) {
		http.Error(w, "invalid model or effort", http.StatusBadRequest)
		return
	}
	if model == "" {
		model = boxDefaultModel()
		if model == "" {
			http.Error(w, "no model given and the box names no default", http.StatusBadRequest)
			return
		}
	}
	title := slug.CleanTitle(body.Title)
	if title == "" {
		title = firstLineTitle(body.Prompt)
	}

	ctx, cancel := context.WithTimeout(context.Background(), t3CallTimeout)
	defer cancel()
	api := t3PollerInstance.api
	project, err := api.ProjectForDir(ctx, osUser, dir)
	if err != nil {
		t3Failed(w, "project", osUser, err)
		return
	}
	launched, err := api.Launch(ctx, osUser, t3client.LaunchRequest{
		ProjectID: project.ID,
		Title:     title,
		Prompt:    body.Prompt,
		Model:     model,
		Effort:    effort,
		// Every lobby Claude runs with --dangerously-skip-permissions
		// (tmux-user-attach), and full-access is T3's name for that.
		RuntimeMode: "full-access",
	})
	if err != nil {
		t3Failed(w, "launch", osUser, err)
		return
	}
	loc, err := api.Locate(ctx, osUser)
	if err != nil {
		t3Failed(w, "locate", osUser, err)
		return
	}
	alias := t3client.Alias(launched.ThreadID)
	t3PollerInstance.remember(osUser, launched.ThreadID)
	if p := strings.TrimSpace(body.Project); p != "" {
		if _, err := layoutStoreInstance.placeSession(osUser, alias, p); err != nil {
			log.Printf("t3: placing %s in %q for %s: %v", alias, p, osUser, err)
		}
	}
	t3Changed(osUser)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(t3CreateResponse{
		Name:     alias,
		URL:      loc.WebURL(launched.ThreadID),
		AppURL:   loc.AppURL(launched.ThreadID),
		ThreadID: launched.ThreadID,
	})
}

// firstLineTitle is a prompt's first non-blank line as a title.
func firstLineTitle(prompt string) string {
	for _, line := range strings.Split(prompt, "\n") {
		if t := slug.CleanTitle(line); t != "" {
			return t
		}
	}
	return ""
}

// t3Changed drops the user's cached session list and asks the poller to read
// T3 now, so the change shows on the next request and stays after the poll.
func t3Changed(osUser string) {
	sessionsCacheInstance.invalidate(osUser)
	t3PollerInstance.kick(osUser)
}

// t3Failed answers a failed T3 call with 502: the lobby is fine, the user's
// T3 is not.
func t3Failed(w http.ResponseWriter, what, osUser string, err error) {
	log.Printf("t3: %s for %s failed: %v", what, osUser, err)
	http.Error(w, "T3 did not answer: "+err.Error(), http.StatusBadGateway)
}

// managedSettingsPath is Claude Code's managed settings, which name the box's
// default model. A var as a test seam.
var managedSettingsPath = "/etc/claude-code/managed-settings.json"

// boxDefaultModel is the managed settings' model, "" when unreadable. A T3
// launch has to name a model, since a fresh T3 has no default of its own,
// and this is the one a tmux Claude starts on.
func boxDefaultModel() string {
	b, err := os.ReadFile(managedSettingsPath)
	if err != nil {
		return ""
	}
	var s struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(b, &s) != nil || !slotModelRe.MatchString(s.Model) {
		return ""
	}
	return s.Model
}

// t3Toplevel resolves a directory to the workspace root ProjectForDir looks
// up. For this service's own user it is git's answer. For anyone else, git
// would run here as this service's user inside their repository, reading a
// config they control, so the root is found by looking for a .git entry
// instead, which runs nothing; a directory this service cannot read is its own
// root.
func t3Toplevel(ctx context.Context, user, dir string) (string, error) {
	if user == selfUser {
		return t3client.GitToplevel(ctx, user, dir)
	}
	return dotGitToplevel(dir), nil
}

// dotGitToplevel is the nearest directory at or above dir holding a .git
// entry (a directory, or the file a worktree or submodule has), else dir.
func dotGitToplevel(dir string) string {
	dir = filepath.Clean(dir)
	for d := dir; ; {
		if _, err := os.Lstat(filepath.Join(d, ".git")); err == nil {
			return d
		}
		parent := filepath.Dir(d)
		if parent == d {
			return dir
		}
		d = parent
	}
}
