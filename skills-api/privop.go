package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"time"

	"terminal-lobby/skillscan"
)

// Acting as another OS user.
//
// skills-api runs as one service user (wizard). Other users' homes are 0700, so
// it can neither read nor write inside them directly — and an install has to do
// both, in opposite homes. Every operation therefore runs as the user it belongs
// to: same-user requests run inline, and anything else re-execs this binary
// under `sudo -n -u <user> skills-api -privop <op>`, the pattern file-api and
// session-events already use.
//
// The child is deliberately incurious. It takes one op name in argv, one JSON
// request on stdin, and reads its own home out of the password database rather
// than from $HOME, which sudo's environment handling makes unreliable. It never
// takes a home, a path, or a user from the caller, so the sudoers grant — one
// binary, one target user — cannot be talked into touching a third party's
// files. Every name it does take is re-validated by skillscan.

// selfUser is the OS user this service runs as; requests for it skip sudo.
var selfUser string

// sudoBinary is a test seam, as in tmux-api: tests swap it for a stub that
// records its argv. Production never reassigns it.
var sudoBinary = "/usr/bin/sudo"

// op names. One string per privileged behaviour, so the child's dispatch is a
// closed set rather than anything derived from a request field.
const (
	opInventory = "inventory"
	opPack      = "pack"
	opRead      = "read"
	opUnpack    = "unpack"
	opToggle    = "toggle"
	opRemove    = "remove"
	opPlugin    = "plugin-update"
)

// request is everything any op can be asked for. One shape keeps the child's
// stdin contract single, and each op reads only the fields it needs.
type request struct {
	Name    string           `json:"name,omitempty"`
	From    string           `json:"from,omitempty"`
	Hash    string           `json:"hash,omitempty"`
	ID      string           `json:"id,omitempty"`
	Plugin  string           `json:"plugin,omitempty"`
	Enabled bool             `json:"enabled,omitempty"`
	Replace bool             `json:"replace,omitempty"`
	At      string           `json:"at,omitempty"` // RFC3339; the parent decides "now"
	Blobs   []skillscan.Blob `json:"blobs,omitempty"`
}

// result is the child's envelope. Status carries the HTTP status the parent
// should answer with, so a refusal decided inside the user's own context does
// not have to be re-derived from an error string.
type result struct {
	Status  int                `json:"status"`
	Error   string             `json:"error,omitempty"`
	Skills  []skillscan.Skill  `json:"skills,omitempty"`
	Plugins []skillscan.Plugin `json:"plugins,omitempty"`
	Blobs   []skillscan.Blob   `json:"blobs,omitempty"`
	Files   []fileRow          `json:"files,omitempty"`
	SkillMd string             `json:"skillmd,omitempty"`
	Hash    string             `json:"hash,omitempty"`
	Backup  string             `json:"backup,omitempty"`
	Output  string             `json:"output,omitempty"`
	Stat    *statRow           `json:"stat,omitempty"`
}

// fileRow is one file of a skill, for the View panel.
type fileRow struct {
	Rel   string `json:"rel"`
	Exec  bool   `json:"exec,omitempty"`
	Bytes int    `json:"bytes"`
}

// statRow is Inspect's answer on the wire.
type statRow struct {
	Files       int    `json:"files"`
	Executable  int    `json:"executable"`
	Bytes       int64  `json:"bytes"`
	Hash        string `json:"hash"`
	Description string `json:"description,omitempty"`
}

// run performs one op as osUser: inline when that is this service's own user,
// through sudo otherwise.
func run(osUser, op string, req request) result {
	if osUser == selfUser || selfUser == "" {
		return perform(op, userHome(osUser), req)
	}
	body, err := json.Marshal(req)
	if err != nil {
		return result{Status: 500, Error: "internal error"}
	}
	cmd := exec.Command(sudoBinary, "-n", "-u", osUser, exeSelf(), "-privop", op)
	cmd.Stdin = bytes.NewReader(body)
	cmd.Stderr = os.Stderr // a sudo refusal belongs in the service's journal
	out, err := cmd.Output()
	if err != nil {
		log.Printf("privop %s as %s: %v", op, osUser, err)
		return result{Status: 500, Error: "internal error"}
	}
	var res result
	if json.Unmarshal(out, &res) != nil || res.Status == 0 {
		log.Printf("privop %s as %s: bad envelope", op, osUser)
		return result{Status: 500, Error: "internal error"}
	}
	return res
}

// exeSelf resolves this binary for the sudo re-exec. The sudoers grant is keyed
// on /usr/local/bin/skills-api, which is where production resolves; the fallback
// keeps a dev build self-consistent.
func exeSelf() string {
	if p, err := os.Executable(); err == nil {
		return p
	}
	return "/usr/local/bin/skills-api"
}

// runPrivopChild is the -privop entrypoint: read the request, perform the op in
// this user's own home, write the envelope.
func runPrivopChild(op string) {
	var req request
	if err := json.NewDecoder(os.Stdin).Decode(&req); err != nil {
		json.NewEncoder(os.Stdout).Encode(result{Status: 400, Error: "bad request"})
		return
	}
	home, err := ownHome()
	if err != nil {
		json.NewEncoder(os.Stdout).Encode(result{Status: 500, Error: err.Error()})
		return
	}
	json.NewEncoder(os.Stdout).Encode(perform(op, home, req))
}

// ownHome reads this process's home from the password database. Not $HOME: sudo
// may or may not reset it, and a wrong answer here would mean touching the
// wrong user's skills.
func ownHome() (string, error) {
	u, err := user.LookupId(strconv.Itoa(os.Getuid()))
	if err != nil {
		return "", fmt.Errorf("cannot resolve uid %d: %w", os.Getuid(), err)
	}
	if u.HomeDir == "" {
		return "", fmt.Errorf("user %s has no home directory", u.Username)
	}
	return u.HomeDir, nil
}

// perform is the whole privileged surface, running in whichever user's context
// the process is already in. Shared by the inline path and the sudo child so
// each op has exactly one implementation.
func perform(op, home string, req request) result {
	switch op {
	case opInventory:
		skills, err := skillscan.Scan(home)
		if err != nil {
			return fail(err)
		}
		plugins, err := skillscan.Plugins(home)
		if err != nil {
			return fail(err)
		}
		return result{Status: 200, Skills: skills, Plugins: plugins}

	case opPack:
		if err := skillscan.ValidName(req.Name); err != nil {
			return result{Status: 400, Error: err.Error()}
		}
		blobs, st, err := skillscan.Pack(filepath.Join(skillscan.Root(home), req.Name))
		if err != nil {
			return notFoundOr(err)
		}
		return result{Status: 200, Blobs: blobs, Hash: st.Hash, Stat: wireStat(st)}

	case opRead:
		if err := skillscan.ValidName(req.Name); err != nil {
			return result{Status: 400, Error: err.Error()}
		}
		blobs, st, err := skillscan.Pack(filepath.Join(skillscan.Root(home), req.Name))
		if err != nil {
			return notFoundOr(err)
		}
		res := result{Status: 200, Hash: st.Hash, Stat: wireStat(st)}
		for _, b := range blobs {
			res.Files = append(res.Files, fileRow{Rel: b.Rel, Exec: b.Exec, Bytes: len(b.Body)})
			if b.Rel == "SKILL.md" {
				res.SkillMd = string(b.Body)
			}
		}
		return res

	case opUnpack:
		at, err := time.Parse(time.RFC3339, req.At)
		if err != nil {
			return result{Status: 400, Error: "bad timestamp"}
		}
		backup, err := skillscan.Unpack(home, req.Name, req.From, req.Blobs, req.Hash, req.Replace, at)
		if err != nil {
			if err == skillscan.ErrExists {
				return result{Status: 409, Error: err.Error()}
			}
			return result{Status: 400, Error: err.Error()}
		}
		return result{Status: 200, Backup: backup}

	case opToggle:
		if err := skillscan.SetEnabled(home, req.ID, req.Enabled); err != nil {
			return fail(err)
		}
		return result{Status: 200}

	case opRemove:
		at, err := time.Parse(time.RFC3339, req.At)
		if err != nil {
			return result{Status: 400, Error: "bad timestamp"}
		}
		backup, err := skillscan.Remove(home, req.Name, at)
		if err != nil {
			return notFoundOr(err)
		}
		return result{Status: 200, Backup: backup}

	case opPlugin:
		out, err := updatePlugin(home, req.Plugin)
		if err != nil {
			return result{Status: 502, Error: err.Error(), Output: out}
		}
		return result{Status: 200, Output: out}
	}
	return result{Status: 500, Error: "unknown op"}
}

func wireStat(st skillscan.Stat) *statRow {
	return &statRow{
		Files:       st.Files,
		Executable:  st.Executable,
		Bytes:       st.Bytes,
		Hash:        st.Hash,
		Description: st.Description,
	}
}

func fail(err error) result {
	return result{Status: 500, Error: err.Error()}
}

// notFoundOr maps a missing skill to 404 and everything else to 400: the client
// asked for something specific, and which of the two it was changes what the
// panel should say.
func notFoundOr(err error) result {
	if os.IsNotExist(err) {
		return result{Status: 404, Error: "no such skill"}
	}
	return result{Status: 400, Error: err.Error()}
}
