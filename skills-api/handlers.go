package main

import (
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"time"

	"terminal-lobby/skillscan"
	"terminal-lobby/telemetry"
)

// maxBody caps a request body. The largest legitimate one is an install, and
// that carries no skill content — the blobs are read server-side from the
// owner's home, never uploaded — so a few hundred bytes is the whole story.
const maxBody = 64 << 10

// now is the clock, a var so tests can pin it. Timestamps are decided here, in
// the parent, and passed to the privileged child: the child never invents a time
// that ends up recorded as provenance.
var now = func() time.Time { return time.Now().UTC() }

// pluginIDRe matches "<name>@<marketplace>", the id Claude Code uses in
// enabledPlugins for both a marketplace plugin and a loose skill
// ("<name>@skills-dir").
var pluginIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}@[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`)

// --- wire shapes -------------------------------------------------------------

// skillRow is one of the caller's own skills.
type skillRow struct {
	skillscan.Skill
	// UpdateAvailable reports that the user this skill was installed from has
	// since changed their copy. Computed here rather than in the child, because
	// it takes both users' inventories to see it.
	UpdateAvailable bool `json:"updateAvailable,omitempty"`
}

// peerSkill is one of another user's skills, with how it stands against the
// caller's own of that name.
type peerSkill struct {
	skillscan.Skill
	Verdict string `json:"verdict"` // absent | same | differs
}

type peerBlock struct {
	User   string      `json:"user"`
	Skills []peerSkill `json:"skills"`
	// Unreachable means that account's skills could not be read this time. One
	// account in that state must not cost the panel the rest of the list.
	Unreachable bool `json:"unreachable,omitempty"`
}

type inventory struct {
	User    string             `json:"user"`
	Skills  []skillRow         `json:"skills"`
	Plugins []skillscan.Plugin `json:"plugins"`
	Peers   []peerBlock        `json:"peers"`
}

// --- GET /skills -------------------------------------------------------------

// handleInventory answers the whole panel in one round trip: the caller's skills
// and plugins, then every other terminal account's skills with a verdict against
// the caller's own.
func handleInventory(w http.ResponseWriter, r *http.Request) {
	me := resolveOSUser(w, r)
	if me == "" {
		return
	}
	mine := run(me, opInventory, request{})
	if mine.Status != 200 {
		http.Error(w, mine.Error, mine.Status)
		return
	}
	byName := make(map[string]skillscan.Skill, len(mine.Skills))
	for _, s := range mine.Skills {
		byName[s.Name] = s
	}

	inv := inventory{User: me, Plugins: mine.Plugins, Skills: make([]skillRow, 0, len(mine.Skills))}
	updates := map[string]bool{}
	for _, peer := range peers(me) {
		block := peerBlock{User: peer}
		res := run(peer, opInventory, request{})
		if res.Status != 200 {
			block.Unreachable = true
			inv.Peers = append(inv.Peers, block)
			continue
		}
		for _, s := range res.Skills {
			ps := peerSkill{Skill: s, Verdict: string(skillscan.Absent)}
			if m, ok := byName[s.Name]; ok {
				ps.Verdict = string(skillscan.Differs)
				if m.Hash == s.Hash {
					ps.Verdict = string(skillscan.Same)
				}
				// An update is the owner having moved on from what was installed,
				// which is a different question from the two copies differing: a
				// skill edited locally differs without there being anything to pull.
				if m.From == peer && m.SourceHash != "" && m.SourceHash != s.Hash {
					updates[m.Name] = true
				}
			}
			block.Skills = append(block.Skills, ps)
		}
		inv.Peers = append(inv.Peers, block)
	}
	for _, s := range mine.Skills {
		inv.Skills = append(inv.Skills, skillRow{Skill: s, UpdateAvailable: updates[s.Name]})
	}
	writeJSON(w, inv)
}

// --- GET /skills/view --------------------------------------------------------

// handleView reads one skill: its SKILL.md, its file list, and how many of those
// files are executable. Reading a peer's skill before taking it is the point —
// a skill can carry scripts, and those run in your sessions.
func handleView(w http.ResponseWriter, r *http.Request) {
	me := resolveOSUser(w, r)
	if me == "" {
		return
	}
	owner, name, ok := ownerAndName(w, r, me)
	if !ok {
		return
	}
	res := run(owner, opRead, request{Name: name})
	if res.Status != 200 {
		http.Error(w, res.Error, res.Status)
		return
	}
	writeJSON(w, map[string]any{
		"owner":   owner,
		"name":    name,
		"skillmd": res.SkillMd,
		"files":   res.Files,
		"stat":    res.Stat,
	})
}

// --- GET /skills/diff --------------------------------------------------------

// handleDiff compares a peer's SKILL.md against the caller's own of that name.
// Empty diff with verdict "absent" when the caller has no such skill.
func handleDiff(w http.ResponseWriter, r *http.Request) {
	me := resolveOSUser(w, r)
	if me == "" {
		return
	}
	owner, name, ok := ownerAndName(w, r, me)
	if !ok {
		return
	}
	theirs := run(owner, opRead, request{Name: name})
	if theirs.Status != 200 {
		http.Error(w, theirs.Error, theirs.Status)
		return
	}
	mine := run(me, opRead, request{Name: name})
	verdict := skillscan.Absent
	diff := ""
	if mine.Status == 200 {
		verdict = skillscan.Same
		if mine.Hash != theirs.Hash {
			verdict = skillscan.Differs
		}
		diff = skillscan.DiffText(mine.SkillMd, theirs.SkillMd)
	}
	writeJSON(w, map[string]any{
		"owner":   owner,
		"name":    name,
		"verdict": string(verdict),
		"diff":    diff,
	})
}

// --- POST /skills/install ----------------------------------------------------

// handleInstall copies a peer's skill into the caller's account.
//
// Two ops under two identities: pack as the owner, unpack as the caller. A name
// already in use comes back 409 unless replace was asked for, in which case the
// caller's copy is backed up first and the backup path returned.
func handleInstall(w http.ResponseWriter, r *http.Request) {
	me := resolveOSUser(w, r)
	if me == "" {
		return
	}
	var body struct {
		Owner   string `json:"owner"`
		Name    string `json:"name"`
		Replace bool   `json:"replace"`
	}
	if !decode(w, r, &body) {
		return
	}
	owner, ok := validOwner(w, body.Owner, me)
	if !ok {
		return
	}
	if owner == me {
		http.Error(w, "that skill is already yours", http.StatusBadRequest)
		return
	}
	if err := skillscan.ValidName(body.Name); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	packed := run(owner, opPack, request{Name: body.Name})
	if packed.Status != 200 {
		http.Error(w, packed.Error, packed.Status)
		return
	}
	res := run(me, opUnpack, request{
		Name:    body.Name,
		From:    owner,
		Hash:    packed.Hash,
		Replace: body.Replace,
		At:      now().Format(time.RFC3339),
		Blobs:   packed.Blobs,
	})
	if res.Status != 200 {
		http.Error(w, res.Error, res.Status)
		return
	}
	kind := "new"
	if res.Backup != "" {
		kind = "replace"
	}
	events.Emit("skill.installed", me, telemetry.Attrs{
		"tl.key":  body.Name,
		"tl.from": owner,
		"tl.kind": kind,
	})
	log.Printf("install: %s took %s from %s (backup=%q)", me, body.Name, owner, res.Backup)
	writeJSON(w, map[string]any{"name": body.Name, "from": owner, "backup": res.Backup})
}

// --- POST /skills/toggle -----------------------------------------------------

// handleToggle switches one skill or plugin on or off, by writing Claude Code's
// own enabledPlugins key. Nothing is deleted, and the change reaches new
// sessions only.
func handleToggle(w http.ResponseWriter, r *http.Request) {
	me := resolveOSUser(w, r)
	if me == "" {
		return
	}
	var body struct {
		ID      string `json:"id"`
		Enabled bool   `json:"enabled"`
	}
	if !decode(w, r, &body) {
		return
	}
	if !pluginIDRe.MatchString(body.ID) {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	res := run(me, opToggle, request{ID: body.ID, Enabled: body.Enabled})
	if res.Status != 200 {
		http.Error(w, res.Error, res.Status)
		return
	}
	kind := "off"
	if body.Enabled {
		kind = "on"
	}
	events.Emit("skill.toggled", me, telemetry.Attrs{"tl.key": body.ID, "tl.kind": kind})
	writeJSON(w, map[string]any{"id": body.ID, "enabled": body.Enabled})
}

// --- POST /skills/remove -----------------------------------------------------

// handleRemove backs a skill up and drops it. The row goes; the bytes stay under
// .backup/.
func handleRemove(w http.ResponseWriter, r *http.Request) {
	me := resolveOSUser(w, r)
	if me == "" {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &body) {
		return
	}
	if err := skillscan.ValidName(body.Name); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	res := run(me, opRemove, request{Name: body.Name, At: now().Format(time.RFC3339)})
	if res.Status != 200 {
		http.Error(w, res.Error, res.Status)
		return
	}
	events.Emit("skill.removed", me, telemetry.Attrs{"tl.key": body.Name})
	log.Printf("remove: %s dropped %s (backup=%q)", me, body.Name, res.Backup)
	writeJSON(w, map[string]any{"name": body.Name, "backup": res.Backup})
}

// --- POST /skills/delete -----------------------------------------------------

// handleDelete removes a skill for good: the directory, every backup of it, its
// enabled state and its provenance.
//
// Distinct from /skills/remove, which keeps a backup. This is the one that means
// it, so the panel asks a harder question before calling it.
func handleDelete(w http.ResponseWriter, r *http.Request) {
	me := resolveOSUser(w, r)
	if me == "" {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &body) {
		return
	}
	if err := skillscan.ValidName(body.Name); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	res := run(me, opDelete, request{Name: body.Name})
	if res.Status != 200 {
		http.Error(w, res.Error, res.Status)
		return
	}
	events.Emit("skill.deleted", me, telemetry.Attrs{"tl.key": body.Name})
	log.Printf("delete: %s deleted %s permanently (%+v)", me, body.Name, res.Deleted)
	writeJSON(w, map[string]any{"name": body.Name, "deleted": res.Deleted})
}

// --- POST /skills/plugin-uninstall -------------------------------------------

// handlePluginUninstall uninstalls a marketplace plugin through the caller's own
// claude CLI, then reclaims what it leaves behind.
func handlePluginUninstall(w http.ResponseWriter, r *http.Request) {
	me := resolveOSUser(w, r)
	if me == "" {
		return
	}
	var body struct {
		Plugin string `json:"plugin"`
	}
	if !decode(w, r, &body) {
		return
	}
	if !pluginIDRe.MatchString(body.Plugin) {
		http.Error(w, "invalid plugin id", http.StatusBadRequest)
		return
	}
	res := run(me, opUninstall, request{Plugin: body.Plugin})
	if res.Status != 200 {
		writeStatusJSON(w, res.Status, map[string]any{"plugin": body.Plugin, "error": res.Error, "output": res.Output})
		return
	}
	events.Emit("plugin.uninstalled", me, telemetry.Attrs{"tl.key": body.Plugin})
	log.Printf("uninstall: %s removed plugin %s (%d bytes reclaimed)", me, body.Plugin, res.Freed)
	writeJSON(w, map[string]any{"plugin": body.Plugin, "freed": res.Freed, "output": res.Output})
}

// --- POST /skills/plugin-update ----------------------------------------------

// handlePluginUpdate updates one marketplace plugin by running the caller's own
// claude CLI as them. No privilege is gained: the privileged child is already
// that user, and this is the same command they could type in a terminal.
func handlePluginUpdate(w http.ResponseWriter, r *http.Request) {
	me := resolveOSUser(w, r)
	if me == "" {
		return
	}
	var body struct {
		Plugin string `json:"plugin"`
	}
	if !decode(w, r, &body) {
		return
	}
	if !pluginIDRe.MatchString(body.Plugin) {
		http.Error(w, "invalid plugin id", http.StatusBadRequest)
		return
	}
	res := run(me, opPlugin, request{Plugin: body.Plugin})
	if res.Status != 200 {
		writeStatusJSON(w, res.Status, map[string]any{"plugin": body.Plugin, "error": res.Error, "output": res.Output})
		return
	}
	events.Emit("plugin.updated", me, telemetry.Attrs{"tl.key": body.Plugin})
	writeJSON(w, map[string]any{"plugin": body.Plugin, "output": res.Output})
}

// --- helpers -----------------------------------------------------------------

// ownerAndName reads the owner and name query parameters of a read-only request.
func ownerAndName(w http.ResponseWriter, r *http.Request, me string) (string, string, bool) {
	owner, ok := validOwner(w, r.URL.Query().Get("owner"), me)
	if !ok {
		return "", "", false
	}
	name := r.URL.Query().Get("name")
	if err := skillscan.ValidName(name); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return "", "", false
	}
	return owner, name, true
}

// validOwner accepts the caller themselves or another terminal account, and
// nothing else: a Unix account that is not in the identity map is not a peer,
// so the service will not read out of its home.
func validOwner(w http.ResponseWriter, owner, me string) (string, bool) {
	if owner == "" || owner == me {
		return me, true
	}
	if !isMappedOSUser(owner) {
		http.Error(w, "no terminal account by that name", http.StatusForbidden)
		return "", false
	}
	return owner, true
}

func decode(w http.ResponseWriter, r *http.Request, into any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		http.Error(w, "bad request body", http.StatusBadRequest)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, body any) { writeStatusJSON(w, http.StatusOK, body) }

func writeStatusJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	// The panel must never render a stale inventory as current.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("write response: %v", err)
	}
}
