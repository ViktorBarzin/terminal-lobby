package main

import (
	"encoding/json"
	"errors"
	"net/http"

	"terminal-lobby/authuser"
)

// accessVia names what authorized an access decision, for the audit line and
// for the client, which words a guest's session differently from its own.
type accessVia string

const (
	accessSelf    accessVia = "self"
	accessAdmin   accessVia = "admin"
	accessShare   accessVia = "share"
	accessProject accessVia = "project"
)

// sessionAccessResult is how far a caller may reach into one session. Mode is
// "rw" (drive, as the owner), "ro" (watch), or "" (no access at all).
type sessionAccessResult struct {
	Mode string    `json:"mode"`
	Via  accessVia `json:"via,omitempty"`
}

var errBadAccessRef = errors.New("invalid owner, session or caller")

// sessionAccess is the one answer to "may caller reach owner's session name,
// and how far" (ADR-0043). The terminal attach, the session routes here, and
// session-events' Text view and composer all ask it, so the surfaces cannot
// disagree about who is a guest.
//
//   - Your own session: rw.
//   - An administrator: rw, which a Lens then declines by always watching.
//   - A share row for this caller, pinned to the session holding the name now.
//   - Membership of a project listing the session, which only ever watches
//     (projectAccessMode).
//
// A share and a project can both apply; the wider one wins, as it does in the
// sidebar's foreignRefsFor.
func sessionAccess(owner, name, caller string) (sessionAccessResult, error) {
	if !sessionNameRe.MatchString(owner) || !sessionNameRe.MatchString(name) || !sessionNameRe.MatchString(caller) {
		return sessionAccessResult{}, errBadAccessRef
	}
	if owner == caller {
		return sessionAccessResult{Mode: shareModeRW, Via: accessSelf}, nil
	}
	if actAsGate.IsAdmin(caller) && isMappedOSUser(owner) {
		return sessionAccessResult{Mode: shareModeRW, Via: accessAdmin}, nil
	}
	best := sessionAccessResult{}
	widen := func(mode string, via accessVia) {
		if mode == shareModeRW && best.Mode != shareModeRW || mode == shareModeRO && best.Mode == "" {
			best = sessionAccessResult{Mode: mode, Via: via}
		}
	}
	mode, err := liveShareMode(owner, name, caller)
	if err != nil {
		return sessionAccessResult{}, err
	}
	widen(mode, accessShare)
	mode, err = projectAccessMode(owner, name, caller)
	if err != nil {
		return sessionAccessResult{}, err
	}
	widen(mode, accessProject)
	return best, nil
}

// liveShareMode is the mode of caller's share of owner's session, or "" when
// there is none or it was made for an earlier session that held this name.
func liveShareMode(owner, name, caller string) (string, error) {
	ss, err := shareStoreInstance.load()
	if err != nil {
		return "", err
	}
	for _, sh := range ss.Shares {
		if sh.Owner != owner || sh.Name != name || sh.Guest != caller {
			continue
		}
		// Read only once a row matches: it forks tmux. A row for an earlier
		// session of this name can sit beside the live one until the sweep
		// prunes it (a rename can leave both), so a mismatch moves on.
		current, live, lerr := liveByName(owner, name)
		if lerr != nil || !live {
			return "", nil
		}
		if sh.SessionID != current.ID || sh.SessionCreated != current.Created {
			continue
		}
		return sh.Mode, nil
	}
	return "", nil
}

// projectAccessMode is what project membership gives caller over owner's
// session: "ro" when caller and owner are both members of a project listing
// it, "" otherwise.
//
// Watching only, whatever the project's attach mode (Viktor, 2026-10-11).
// Projects are co-equal, so any member may set the mode or add a member, and
// a project-wide rw would let one member drive another's session as them
// without that owner agreeing. Driving takes a Share the owner made.
func projectAccessMode(owner, name, caller string) (string, error) {
	ps, err := projectStoreInstance.load()
	if err != nil {
		return "", err
	}
	for _, p := range ps.Projects {
		if !projectMember(p, caller) {
			continue
		}
		for _, s := range p.Sessions {
			if s.Owner == owner && s.Name == name {
				return projectAttachRO, nil
			}
		}
	}
	return "", nil
}

// handleInternalAccess answers sessionAccess for session-events, which runs on
// this box as the same account and reads the token file. The same two gates as
// /internal/attach: loopback, and the token. Caller is what session-events
// resolved from the identity header; the gates bound who may assert it.
//
// No access is a 200 with an empty mode, so the asker never has to tell a
// refusal from a broken route by status alone.
func handleInternalAccess(w http.ResponseWriter, r *http.Request) {
	if !authuser.IsLoopback(r) || internalToken == "" || r.Header.Get("X-Internal-Token") != internalToken {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Owner  string `json:"owner"`
		Name   string `json:"name"`
		Caller string `json:"caller"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	got, err := sessionAccess(body.Owner, body.Name, body.Caller)
	if errors.Is(err, errBadAccessRef) {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err != nil {
		logAndFail(w, "access check %s/%s for %s failed: %v", body.Owner, body.Name, body.Caller, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(got)
}

// guestTarget decides whose tmux server a /sessions/{name}/… request acts on.
// With no ?owner=, or the caller's own name, it is the caller's (target ==
// caller, guest ""). With another owner it is that owner's, for a caller
// sessionAccess lets in: a read for any access, anything else only for rw.
// guest is then the caller, so a kill can tell the owner who did it.
//
// status is non-zero when the request must be refused with it.
func guestTarget(r *http.Request, caller, name string) (target, guest string, status int) {
	owner := r.URL.Query().Get("owner")
	if owner == "" || owner == caller {
		return caller, "", 0
	}
	acc, err := sessionAccess(owner, name, caller)
	if errors.Is(err, errBadAccessRef) {
		return "", "", http.StatusBadRequest
	}
	if err != nil {
		return "", "", http.StatusInternalServerError
	}
	switch {
	case acc.Mode == "":
		return "", "", http.StatusForbidden
	case r.Method != http.MethodGet && acc.Mode != shareModeRW:
		return "", "", http.StatusForbidden
	}
	return owner, caller, 0
}
