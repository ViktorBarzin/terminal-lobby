package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"terminal-lobby/slug"
	"terminal-lobby/telemetry"
)

func handleSessionByName(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/sessions/")
	path = strings.TrimSuffix(path, "/")
	parts := strings.Split(path, "/")
	name := parts[0]
	if !sessionNameRe.MatchString(name) {
		http.Error(w, "invalid session name", http.StatusBadRequest)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}

	if len(parts) == 1 {
		if r.Method != http.MethodDelete {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		killSession(w, osUser, name)
		return
	}
	if len(parts) == 2 && parts[1] == "rename" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		renameSession(w, r, osUser, name)
		return
	}
	if len(parts) == 2 && parts[1] == "title" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		setSessionTitle(w, r, osUser, name)
		return
	}
	if len(parts) == 2 && parts[1] == "origin" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		setSessionOrigin(w, r, osUser, name)
		return
	}
	if len(parts) == 2 && parts[1] == "copy-mode" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		copyModeSession(w, r, osUser, name)
		return
	}
	if len(parts) == 2 && parts[1] == "grid" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		sizeSessionGrid(w, r, osUser, name)
		return
	}
	if len(parts) == 2 && parts[1] == "capture" {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		captureSession(w, osUser, name)
		return
	}
	http.Error(w, "not found", http.StatusNotFound)
}

func killSession(w http.ResponseWriter, osUser, name string) {
	out, err := tmuxCmd(osUser, "kill-session", "-t", exactSession(name)).CombinedOutput()
	if err != nil {
		msg := string(out)
		if strings.Contains(msg, "can't find session") || strings.Contains(msg, "no server running") {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		log.Printf("kill-session %s as %s failed: %v: %s", name, osUser, err, msg)
		http.Error(w, "kill-session failed", http.StatusInternalServerError)
		return
	}
	// Tell this user's T3 syncer, if they have one. Reaching here is the only
	// proof anywhere on the box that a session was destroyed on PURPOSE — an
	// OOM, a crashed tmux server or a reboot never does — and "kill crosses,
	// exit does not" is built on exactly that (killnotify.go).
	//
	// Only the lookup is synchronous, and it is one read of a small local file.
	// The POST goes on its own goroutine: the kill has already succeeded, so the
	// answer the user gets must not depend on a syncer that is stopped, wedged
	// or not installed.
	if url, ok := syncNotifyURL(osUser); ok {
		notice := killNotice{OSUser: osUser, Session: name, KilledAt: time.Now().UTC(), Source: killNotifySource}
		go func() {
			if err := postKillNotice(url, notice); err != nil {
				log.Printf("kill-notify for %s/%s: %v", osUser, name, err)
			}
		}()
	}
	// A UI kill is deliberate — drop the session's project assignment.
	// (Deaths outside the API keep theirs so a restore regroups them.)
	// Remember it first: the picker can restore this session from an older
	// snapshot long after the layout has forgotten where it went, and landing
	// in Ungrouped is where a recovered session is hardest to find again.
	rememberKilledAssignment(osUser, name)
	// The title STAYS, unlike the layout entry and the manifest row. Those two
	// describe a session that is running; a title describes one that existed,
	// and the picker restores a killed session from an older snapshot long
	// after both are gone. Since ADR-0019 a name is a minted id, so the reuse
	// this used to guard against cannot happen, and dropping the title only
	// left the picker showing that id. pruneLocked still bounds the file.
	if err := layoutStoreInstance.removeSession(osUser, name); err != nil {
		log.Printf("layout cleanup after killing %s for %s failed: %v", name, osUser, err)
	}
	// …and drop it from the tmux-persist manifest, for the same reason. POST
	// /restore recreates every manifest row that is not currently live, and the
	// manifest is only rewritten every 5 min by tmux-persist-save.timer — so
	// without this the Restore button resurrects a session the user just chose
	// to kill, relaunching `claude --resume <uuid>` when the row carries one.
	// Only a kill THROUGH this handler forgets: an OOM or a crashed tmux server
	// never reaches here, so the recovery restore exists for still works.
	// Best-effort — tmux is already gone, so a failed forget is a log line, not
	// a 500 the UI would render as "kill failed".
	forget := exec.Command(sudoBinary, "-n", persistForgetWrapper, osUser, name)
	if out, err := forget.CombinedOutput(); err != nil {
		log.Printf("persist-forget after killing %s for %s failed: %v: %s", name, osUser, err, strings.TrimSpace(string(out)))
	}
	sessionsCacheInstance.invalidate(osUser)
	events.Emit("session.killed", osUser, telemetry.Attrs{"tl.session": name, "tl.client": "api"})
	w.WriteHeader(http.StatusNoContent)
}

func renameSession(w http.ResponseWriter, r *http.Request, osUser, oldName string) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	newName := strings.TrimSpace(body.Name)
	if !sessionNameRe.MatchString(newName) {
		http.Error(w, "invalid new name", http.StatusBadRequest)
		return
	}
	if newName == oldName {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !renameTmuxSession(w, osUser, oldName, newName) {
		return
	}
	carryRenameAcrossStores(osUser, oldName, newName)
	sessionsCacheInstance.invalidate(osUser)
	events.Emit("session.renamed", osUser, telemetry.Attrs{
		"tl.from": oldName, "tl.to": newName, "tl.client": "api",
	})
	w.WriteHeader(http.StatusNoContent)
}

// setSessionTitle is POST /sessions/{name}/title — every retitle there is.
//
// The title is what everyone reads, and since ADR-0022 the tmux NAME follows
// it, so the surfaces the lobby does not draw (`tmux ls`, the status bar, the
// window title) read as words again. name_from_title.go holds that rule and
// the six stores a rename has to carry. PATCH /sessions/{name} used to carry a
// rename alongside the stamp; the rename is derived now, so a caller has
// nothing to supply.
//
// Three callers: the lobby stamping a title onto a session it has just created
// (creation reaches no server, so this is the first the API hears of it),
// editing one from a card, and clearing a title back to nothing. Clearing
// leaves the name where it is: an empty title derives nothing, and inventing a
// name for a running session would be worse than keeping a stale one.
func setSessionTitle(w http.ResponseWriter, r *http.Request, osUser, name string) {
	var body struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	title := slug.CleanTitle(body.Title)
	if !stampTitle(w, osUser, name, title) {
		return
	}
	// After the stamp, never before: a rename that landed first would leave a
	// session named for a title it does not carry if the stamp then failed.
	name = renameToDerivedName(osUser, name, title, "api")
	sessionsCacheInstance.invalidate(osUser)
	events.Emit("session.retitled", osUser, telemetry.Attrs{
		"tl.session": name, "tl.client": "api",
	})
	w.WriteHeader(http.StatusNoContent)
}

// setSessionOrigin is POST /sessions/{name}/origin — the rescue
// (docs/plans/2026-09-06-test-session-origin-design.md).
//
// One caller: dropping a card out of the System group. The drop already writes
// the layout, and this is how it says the same thing on the SERVER, so the
// session stops being a system session for the push sender and the telemetry
// rule too rather than only in the browser that moved it. Without it, a
// rescued session would sit in a project in the sidebar and still be silent.
//
// Only `user` and `test` are accepted. Those are the only two values anything
// writes (origin.go); the third state is the ABSENCE of the option, and no
// caller has a reason to ask for it, because a session with no origin already
// reads as system and that is exactly what the drag is undoing.
//
// The shape is setSessionTitle's, and so are the reasons behind each part of
// it: the pane target form so a name cannot resolve by prefix onto a sibling,
// tmuxTargetMissing so all four spellings of "it is gone" become a 404 the
// lobby reads as gone instead of broken, and the cache invalidated so the very
// next poll carries the new value rather than a body built before the stamp.
//
// No event is emitted. The catalog has no name for this yet, and an event
// about a session the record was told to start keeping is the one event the
// drop rule would most likely still refuse (telemetry.go).
func setSessionOrigin(w http.ResponseWriter, r *http.Request, osUser, name string) {
	var body struct {
		Origin string `json:"origin"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	origin := strings.TrimSpace(body.Origin)
	if origin != originUser && origin != originTest {
		http.Error(w, "invalid origin", http.StatusBadRequest)
		return
	}
	if msg, err := setOriginOption(osUser, name, origin); err != nil {
		if tmuxTargetMissing(msg) {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		log.Printf("set %s on %s as %s failed: %v: %s", originOption, name, osUser, err, msg)
		http.Error(w, "set-option failed", http.StatusInternalServerError)
		return
	}
	sessionsCacheInstance.invalidate(osUser)
	w.WriteHeader(http.StatusNoContent)
}

// stampTitle writes @title onto a live session and mirrors it into the titles
// store, which is what carries it across a restore. An empty title UNSETS the
// option rather than setting it to "", so a session goes back to showing its
// name. Writes the response and returns false when it could not.
//
// The title reaches tmux as one argv element, never a shell word, so no
// escaping question arises for the arbitrary text it carries.
func stampTitle(w http.ResponseWriter, osUser, name, title string) bool {
	args := []string{"set-option", "-t", exactPane(name), sessionTitleOption, title}
	if title == "" {
		// Measured on 3.4: unsetting an option that was never set exits 0
		// silently, so clearing a title needs no "was it set" check.
		args = []string{"set-option", "-u", "-t", exactPane(name), sessionTitleOption}
	}
	if out, err := tmuxCmd(osUser, args...).CombinedOutput(); err != nil {
		msg := string(out)
		if tmuxTargetMissing(msg) {
			http.Error(w, "session not found", http.StatusNotFound)
			return false
		}
		log.Printf("set %s on %s as %s failed: %v: %s", sessionTitleOption, name, osUser, err, msg)
		http.Error(w, "set-option failed", http.StatusInternalServerError)
		return false
	}
	if err := titleStoreInstance.set(osUser, name, title); err != nil {
		// The option landed, so the title is live; only its survival across a
		// restore is at risk. Not worth failing a request the user watched
		// succeed.
		log.Printf("title memory: remembering %s/%s failed: %v", osUser, name, err)
	}
	return true
}

// renameTmuxSession performs the tmux half of a rename and maps its failures
// onto statuses. Writes the response and returns false when it did.
func renameTmuxSession(w http.ResponseWriter, osUser, oldName, newName string) bool {
	out, err := tmuxCmd(osUser, "rename-session", "-t", exactSession(oldName), newName).CombinedOutput()
	if err == nil {
		return true
	}
	msg := string(out)
	if tmuxTargetMissing(msg) {
		http.Error(w, "session not found", http.StatusNotFound)
		return false
	}
	if strings.Contains(msg, "duplicate session") || strings.Contains(msg, "session already exists") {
		http.Error(w, "target name already exists", http.StatusConflict)
		return false
	}
	log.Printf("rename-session %s→%s as %s failed: %v: %s", oldName, newName, osUser, err, msg)
	http.Error(w, "rename-session failed", http.StatusInternalServerError)
	return false
}

// tmuxTargetMissing recognises "the thing you named is not there" across the
// verbs this service runs. The spelling differs by verb and by how the server
// is missing — measured on 3.4: kill/rename say "can't find session",
// set-option says "no such session", a stopped server says "no server
// running", and a socket whose directory is gone says "error connecting to".
// All four mean the same thing to a caller: 404.
func tmuxTargetMissing(msg string) bool {
	for _, s := range []string{
		"can't find session", "no such session",
		"no server running", "error connecting to",
	} {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}

// carryRenameAcrossStores lives in rename_cascade.go — every store that keys
// on a session's name, moved together.
