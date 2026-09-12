package main

// Which sessions belong on screen together.
//
// A Workspace is several sessions shown at once as Tiles, arranged as a tree of
// rows and columns. ADR-0027 splits that object across two stores, and this file
// is the server half: the workspace's id and its ordered members, one JSON
// document per OS user under workspacesDir, beside layout/<user>.json and
// assignments/<user>.json. The tree and the tile sizes are NOT here — they live
// in the browser under one tl:workspaces:v1 key, because a four-column
// arrangement describes a 32-inch monitor and is meaningless on a laptop.
//
// Membership is on the server for three reasons the design names. The sidebar is
// already server-driven through Layout, and members are marked in it, so a
// device-local overlay would make one sidebar behave differently from another
// for the same user with nothing on screen to explain why. Two tabs on one
// machine must agree about the exclusivity rule below, and per-browser copies of
// it produce conflicting writes with nothing to reconcile them. And a kill must
// not silently drop membership — see "A kill keeps membership" further down,
// which is the behaviour assignments/<user>.json already gives project
// placement, and for the same reason.
//
// Shape, mutation and validation follow layout.go closely: whole-document
// PUT/GET, last-writer-wins, mutex-guarded, atomic (tmp+rename), 0600. A store
// that behaves differently from the one next to it is a store whose behaviour
// has to be rediscovered.
//
// Handlers are GET/PUT /workspaces, registered in main.go beside /layout. A
// browser reaches them at /api/sessions/workspaces: the prod ingress routes
// PathPrefix /api/sessions/ here and strips the whole prefix, so this service
// serves /whoami, /sessions, /layout and /workspaces at its root. frontend-v2's
// lib/config.ts holds the same fact from the other side, as TMUX_API_PREFIX.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"terminal-lobby/telemetry"
)

// Workspaces is one user's set of workspaces. Unnamed by design: a workspace is
// created implicitly by the first split and is identified by its members, so
// there is no name field and nothing to prompt anyone for.
type Workspaces struct {
	Version    int         `json:"version"`
	Workspaces []Workspace `json:"workspaces"`
}

// Workspace is one group: an id the client mints, and the sessions in it in the
// order the user arranged them. The order is load-bearing rather than
// decorative — a device that has never seen this workspace has no geometry for
// it and auto-arranges evenly in THIS order (ADR-0027), so a fresh phone and a
// fresh laptop lay the same workspace out the same way.
//
// Members may name sessions that are not currently alive, exactly as a Layout
// project's member list may: a death keeps its tile's place so a restore puts
// the tile back. The frontend renders live sessions only.
//
// A field the client sends that is not declared here is SILENTLY DROPPED on the
// way in and absent on the way out — no error, nothing in a log. That is how
// the Ctrl+J dock used to vanish four seconds after it was opened, before
// DockState became a real struct field (layout.go). So per-workspace state the
// client expects the server to keep — a name, a focused tile, anything about
// the tree — needs a field here before it will survive a round trip, and the
// tree deliberately never gets one. The same is true one level down, inside a
// member: WorkspaceMember has two fields and everything else a client tucks
// into a member is gone by the time it reads the document back.
type Workspace struct {
	ID      string            `json:"id"`
	Members []WorkspaceMember `json:"members"`
}

// WorkspaceMember names one session in a workspace: the (owner, name) pair this
// service already identifies a session by, because a tmux name is unique only
// inside one user's server (projects.go, SessionRef). A workspace may hold a
// session somebody shared with you — any session you can open is tileable — and
// a bare name cannot say whose session it is. Two people each having one called
// `auth` is ordinary rather than contrived, and they are different terminals.
//
// The owner being OPTIONAL is the one reason this is not SessionRef itself,
// where it is mandatory. This document belongs to one OS user, so an omitted
// owner means that user, and a workspace of your own sessions is the common
// case by a wide margin — spelling the owner out on every entry would say
// nothing and cost the document its readability. `ref` is where the two shapes
// meet: it resolves a member to the same SessionRef projects.go keys by, so
// exclusivity below is decided on the identity the rest of this service uses.
//
// Nothing here checks that the caller may attach a foreign session. This
// document records which sessions belong on screen together and nothing else;
// shares.go and a project's attach mode are what authorize a connection, and a
// second copy of that decision here would drift from them. A member naming a
// session the caller cannot open renders as no tile, the same way a member
// naming a dead session does.
type WorkspaceMember struct {
	Name string `json:"name"`
	// Owner is the session's OS user. Omitted means the caller's own session,
	// and it is omitted rather than sent as "" because both sides compare
	// members for equality: absent and empty would be two spellings of one
	// session, and the client that sent the empty one would see its tile move.
	Owner string `json:"owner,omitempty"`
}

// ref resolves a member to the globally-unique session identity, filling an
// omitted owner in with the user whose document this is. Two members that
// resolve to one ref are one session however they are spelled, which is what
// keeps the exclusivity rule from being talked round by a document that names
// the caller's own session bare in one workspace and in full in the next.
func (m WorkspaceMember) ref(osUser string) SessionRef {
	if m.Owner == "" {
		return SessionRef{Owner: osUser, Name: m.Name}
	}
	return SessionRef{Owner: m.Owner, Name: m.Name}
}

// ownedBy reports whether the member names a session of osUser's own, by either
// spelling. A tmux rename only ever lands in one user's server, so this is the
// question renameSession asks before it rewrites a member's name: emo's `auth`
// keeps its name when alice renames hers.
func (m WorkspaceMember) ownedBy(osUser string) bool {
	return m.Owner == "" || m.Owner == osUser
}

const (
	workspacesDir     = "/var/lib/tmux-api/workspaces"
	workspacesVersion = 1
	// minWorkspaceMembers: one tile is not a workspace. Closing a workspace
	// down to a single tile ends it and shows that session on its own, so a
	// document holding a one-member group describes a state the UI cannot be
	// in — it is a client that failed to finish a removal.
	minWorkspaceMembers = 2
	// maxWorkspaces bounds a hostile or garbage document without bounding
	// anything reachable: every workspace needs two members, so 50 of them
	// means 100 sessions grouped at once, well past what one person's tmux
	// server holds.
	maxWorkspaces = 50
	// maxWorkspacesBody matches /layout's cap. There is deliberately no cap on
	// members per workspace — the design declines one ("no cap on the number
	// of tiles; a bigger screen holds more") and the 240px minimum tile is
	// enforced in the browser, where the screen is. This cap is what bounds the
	// document: a member is at most 75 bytes on the wire (two 32-byte names and
	// their keys), so 64KB is roughly 850 members however they are grouped, and
	// nearer 1,500 for the ordinary member that carries no owner.
	maxWorkspacesBody = 64 * 1024
)

// workspaceStore persists one document per OS user, mirroring layoutStore.
type workspaceStore struct {
	mu  sync.Mutex
	dir string
}

func newWorkspaceStore(dir string) *workspaceStore { return &workspaceStore{dir: dir} }

var workspaceStoreInstance = newWorkspaceStore(workspacesDir)

func (s *workspaceStore) path(osUser string) string {
	return filepath.Join(s.dir, osUser+".json")
}

func emptyWorkspaces() Workspaces {
	return Workspaces{Version: workspacesVersion, Workspaces: []Workspace{}}
}

// load returns the user's workspaces, or an empty default when none was ever
// saved — every user is in that state until their first split, and closing back
// to one tile returns them to it. A corrupt file is an error, not an empty
// document: better a 500 than silently wiping the grouping on the next
// whole-document PUT.
func (s *workspaceStore) load(osUser string) (Workspaces, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked(osUser)
}

func (s *workspaceStore) loadLocked(osUser string) (Workspaces, error) {
	raw, err := os.ReadFile(s.path(osUser))
	if errors.Is(err, os.ErrNotExist) {
		return emptyWorkspaces(), nil
	}
	if err != nil {
		return Workspaces{}, err
	}
	var ws Workspaces
	if err := json.Unmarshal(raw, &ws); err != nil {
		return Workspaces{}, fmt.Errorf("corrupt workspaces for %s: %w", osUser, err)
	}
	if ws.Workspaces == nil {
		ws.Workspaces = []Workspace{}
	}
	healWorkspaces(&ws, osUser)
	return ws, nil
}

// healWorkspaces repairs on READ what validateWorkspaces refuses on write: a
// session listed in two workspaces (or twice in one), a repeated id, and a
// workspace left below two members.
//
// The repair exists because of the shape of the store rather than because we
// expect bad documents. The client PUTs the WHOLE document on every change, so
// one file on disk that fails validation fails not just the write that made it
// but every write afterwards — each drag, each close, each divider settle,
// every one reporting a save failure the user cannot act on, until someone
// edits the file by hand. layoutStore hit exactly that on 2026-09-06 and
// dropDuplicateSessions is the same answer.
//
// First mention wins, matching the layout precedent, and a workspace is only
// allowed to claim its members once it is known to survive — otherwise a
// one-member group being dropped would take that session's name with it and
// strip it from the real workspace further down the list.
//
// A dropped entry costs a dead session its remembered tile. The live sessions
// named by the surviving entries are untouched.
//
// "The same session" is the resolved (owner, name) pair, not the name, so one
// name under two owners is two members and survives: they are two terminals.
// osUser is what an omitted owner resolves to, which is why this takes the user
// whose document it is rather than working on the document alone.
func healWorkspaces(ws *Workspaces, osUser string) {
	seenID := map[string]bool{}
	seenMember := map[SessionRef]bool{}
	out := make([]Workspace, 0, len(ws.Workspaces))
	for _, w := range ws.Workspaces {
		if seenID[w.ID] {
			continue
		}
		local := map[SessionRef]bool{}
		members := make([]WorkspaceMember, 0, len(w.Members))
		for _, m := range w.Members {
			ref := m.ref(osUser)
			if seenMember[ref] || local[ref] {
				continue
			}
			local[ref] = true
			members = append(members, m)
		}
		if len(members) < minWorkspaceMembers {
			continue
		}
		for _, m := range members {
			seenMember[m.ref(osUser)] = true
		}
		seenID[w.ID] = true
		w.Members = members
		out = append(out, w)
	}
	ws.Workspaces = out
}

func (s *workspaceStore) save(osUser string, ws Workspaces) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked(osUser, ws)
}

// saveLocked writes atomically (tmp + rename) so a crash mid-write can't leave
// a truncated document behind.
func (s *workspaceStore) saveLocked(osUser string, ws Workspaces) error {
	return writeAtomicJSON(s.dir, osUser+".*.tmp", s.path(osUser), ws)
}

// A KILL KEEPS MEMBERSHIP, which is why there is no removeSession here.
//
// The absence is the feature, and it is the one thing in this file that will
// read as an oversight later. layoutStore.removeSession exists and killSession
// calls it: a UI kill deliberately drops the session's SIDEBAR placement, and
// assignments.go exists precisely to remember what that drop threw away so a
// point-in-time restore can put the session back in its project.
//
// A workspace needs neither half. Membership is not an arrangement of live rows
// — it is durable intent about which sessions belong together — so the kill path
// leaves this document alone and the killed member keeps its slot in the member
// order. The browser dims the tile, strikes it through and counts the Grace
// window down; when the window closes the tile closes and the siblings reflow,
// and none of that is a write here. Restore the session later and its tile comes
// back where it was, with no memory needed to reconstruct it.
//
// So: do NOT add a workspaceStoreInstance.removeSession call beside the
// layoutStoreInstance.removeSession call in killSession. Only a deliberate
// close or a drag-out removes a session from a workspace, and both of those are
// gestures in the browser that arrive here as an ordinary whole-document PUT.

// renameSession follows a tmux rename so a member keeps its tile. Two callers
// need it, and neither is a kill:
//
//   - carryRenameAcrossStores (rename_cascade.go), which carries a rename into
//     every store keyed by a session's name. Since ADR-0022 a title carries the
//     tmux name with it, so this is the ordinary path rather than a rare one,
//     and a member that did not follow would strand a tile pointing at a name
//     nothing answers to.
//   - a restore that had to rename (placeRestoredSessions in assignments.go).
//     This is the single case where surviving the kill is not enough: the
//     session comes back as `<name>-<HHMM>` because a different session took its
//     name, so the member listed names a stranger and the restored conversation
//     is in no workspace at all. Renaming hands the tile to the name it actually
//     came back under.
//
// The rename is in place, so the tile keeps its slot in the member order rather
// than reappearing at the end of the arrangement.
//
// An entry already sitting under newName is dropped, and only when the rename
// actually lands. tmux refuses to rename a session onto a live one, so a
// collision here always means the sitting entry belongs to a session that is
// already dead — and this document keeps dead members on purpose, which makes
// collisions likelier here than anywhere else. The renamed session is the live
// one, so it keeps its own place and the stale entry goes. Keeping both would
// write a document validateWorkspaces rejects, which would then fail EVERY later
// workspace write (see healWorkspaces). Dropping it can leave a workspace with
// one tile, and one tile is not a workspace, so the heal that follows ends it.
func (s *workspaceStore) renameSession(osUser, oldName, newName string) error {
	if oldName == newName {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ws, err := s.loadLocked(osUser)
	if err != nil {
		return err
	}
	// The common case by a wide margin: most sessions are in no workspace, and
	// every retitle reaches here. Returning before the write keeps a retitle
	// from churning the store, and from creating a document for a user who has
	// never made a workspace at all.
	if _, ok := workspaceOfSession(ws, osUser, SessionRef{Owner: osUser, Name: oldName}); !ok {
		return nil
	}
	for i := range ws.Workspaces {
		members := make([]WorkspaceMember, 0, len(ws.Workspaces[i].Members))
		for _, m := range ws.Workspaces[i].Members {
			// A tmux rename lands in ONE user's server, so a member of
			// somebody else's session keeps its name whatever this one is
			// called now. Without the test, alice retitling her `auth` would
			// rename the tile showing emo's `auth` to a session emo has never
			// heard of.
			if !m.ownedBy(osUser) {
				members = append(members, m)
				continue
			}
			switch m.Name {
			case oldName:
				m.Name = newName
				members = append(members, m)
			case newName:
				// The stale entry. Dropped, per the docblock above.
			default:
				members = append(members, m)
			}
		}
		ws.Workspaces[i].Members = members
	}
	healWorkspaces(&ws, osUser)
	return s.saveLocked(osUser, ws)
}

// workspaceOfSession reports which workspace holds a session, by id. The bool is
// "this session is in a workspace at all", which is the question the sidebar
// asks of every row: a member's card is marked and clicking it enters the
// workspace, while a non-member's click leaves it.
//
// The session is a resolved (owner, name) pair, so asking about your own `auth`
// does not find a tile showing emo's. osUser is the document's owner, which is
// what a member with no owner means.
func workspaceOfSession(ws Workspaces, osUser string, sess SessionRef) (string, bool) {
	for _, w := range ws.Workspaces {
		for _, m := range w.Members {
			if m.ref(osUser) == sess {
				return w.ID, true
			}
		}
	}
	return "", false
}

// validateWorkspaces enforces the document invariants: known version, a bounded
// number of workspaces, ids, member names and member owners in the same charset
// as tmux session names, unique ids, at least two members per workspace, and the
// exclusivity rule. osUser is the user whose document it is, which is what a
// member with no owner means.
//
// EXCLUSIVITY — one session in more than one workspace is rejected — is the
// rule the whole design rests on, and it is enforced here because the server is
// the only place two tabs can be made to agree about it. keepalive mounts
// exactly one live view per session, keyed owner+name, so a session in two
// workspaces cannot be drawn twice however hard the client tries; and two tiles
// of one session would contend for its Grid continuously, each claiming a
// different column count at the other, which is the failure the grid pinning
// exists to prevent. Dragging a session from workspace A into workspace B is
// therefore a MOVE: A loses that tile and reflows, and the client sends both
// halves in the one document.
//
// The rule is about a SESSION, and a session is the (owner, name) pair, so the
// same name under two owners is two members and passes: emo's `auth` and yours
// are different terminals and may sit side by side. The pair also decides what
// counts as a repeat, so a document naming your own `auth` bare in one place
// and as `<you>/auth` in another is caught rather than stored as two tiles of
// one session.
func validateWorkspaces(ws Workspaces, osUser string) error {
	if ws.Version != workspacesVersion {
		return fmt.Errorf("unsupported workspaces version %d", ws.Version)
	}
	if len(ws.Workspaces) > maxWorkspaces {
		return fmt.Errorf("too many workspaces (%d > %d)", len(ws.Workspaces), maxWorkspaces)
	}
	ids := map[string]bool{}
	seenSession := map[SessionRef]bool{}
	for _, w := range ws.Workspaces {
		if !sessionNameRe.MatchString(w.ID) {
			return fmt.Errorf("invalid workspace id %q", w.ID)
		}
		if ids[w.ID] {
			return fmt.Errorf("duplicate workspace %q", w.ID)
		}
		ids[w.ID] = true
		if len(w.Members) < minWorkspaceMembers {
			return fmt.Errorf("workspace %q has %d members; a workspace needs at least %d",
				w.ID, len(w.Members), minWorkspaceMembers)
		}
		for _, m := range w.Members {
			if !sessionNameRe.MatchString(m.Name) {
				return fmt.Errorf("invalid session name %q", m.Name)
			}
			// An owner is optional and means the caller when absent. When it
			// is there it names an OS user, which lives in the same charset —
			// the check projects.go applies to both halves of a SessionRef.
			if m.Owner != "" && !sessionNameRe.MatchString(m.Owner) {
				return fmt.Errorf("invalid session owner %q", m.Owner)
			}
			ref := m.ref(osUser)
			if seenSession[ref] {
				return fmt.Errorf("session %s/%s listed more than once: a session belongs to at most one workspace",
					ref.Owner, ref.Name)
			}
			seenSession[ref] = true
		}
	}
	return nil
}

// handleWorkspaces serves GET/PUT /workspaces for the calling user's workspace
// membership. Same no-store rationale as /sessions and /layout: the browser must
// not cache what it just changed.
//
// Nothing invalidates the sessions cache here, unlike /layout. A /sessions row
// embeds the session's project, so a layout write makes the cached body stale;
// no row carries its workspace, because the client already holds the whole
// membership document and derives the session-to-workspace lookup from it.
func handleWorkspaces(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPut {
		http.Error(w, "GET or PUT only", http.StatusMethodNotAllowed)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}

	if r.Method == http.MethodGet {
		ws, err := workspaceStoreInstance.load(osUser)
		if err != nil {
			logAndFail(w, "workspaces load for %s failed: %v", osUser, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ws)
		return
	}

	var ws Workspaces
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxWorkspacesBody))
	if err := dec.Decode(&ws); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if err := validateWorkspaces(ws, osUser); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := workspaceStoreInstance.save(osUser, ws); err != nil {
		logAndFail(w, "workspaces save for %s failed: %v", osUser, err)
		return
	}
	// tl.count is how many workspaces the user has, not how many tiles: the
	// question this answers is whether anyone groups sessions at all, which is
	// what decides whether the feature earned its keep. The name must be in
	// telemetry/events.go's catalog or Emit drops it silently.
	events.Emit("workspace.arranged", osUser, telemetry.Attrs{
		"tl.count": len(ws.Workspaces), "tl.client": "api",
	})
	w.WriteHeader(http.StatusNoContent)
}
