package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Codex is the half of the spend panel that needs nothing installed. The CLI
// writes ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl as it works,
// and every completed turn appends a token_count event carrying the
// conversation's running token totals and the account's rate-limit windows.
// This reads that back.
//
// Two properties of those files shape the code. They are large — 27 MB across
// 55 files on this box on 2026-09-06 — so the reader tails a bounded number of
// bytes from the end rather than loading a file. And their shape drifts between
// CLI versions: an August rollout (0.144.3) had secondary null, the weekly
// window in the primary slot, no cache_write_input_tokens and no
// spend_control_reached, where a September one (0.153.4) has all of them. So
// every field is optional, window labels come from window_minutes rather than
// from which slot the window arrived in, and a line that will not parse is
// skipped rather than failing the read.
//
// ATTRIBUTION, and what was achieved. Per-session rows are attributed only for
// LIVE conversations, by finding which rollout file a codex process under the
// pane holds open in /proc/<pid>/fd. Nothing inside a rollout names a tmux
// session: session_meta carries session_id, cwd, originator and cli_version and
// nothing else that could identify one, so a conversation that has exited
// cannot be tied back to the session it ran in. Matching on cwd was rejected
// because several sessions routinely share a directory. A pane belonging to
// another OS user is also out of reach, since tmux-api runs as one user and
// /proc/<pid>/fd is readable only by the process owner. Whenever attribution
// yields nothing the account-wide reading still stands on its own, which is the
// case the Settings page has to render anyway.
//
// Design: docs/plans/2026-09-06-agent-spend-panel-design.md.

const (
	// codexTailChunk is how much is read per step, backwards from the end.
	codexTailChunk = 128 << 10

	// codexTailBudget caps how far back one file is read. A turn's worth of
	// lines is a few kilobytes, so two megabytes covers many turns; a
	// token_count further back than that belongs to a conversation that has
	// since written megabytes without completing a turn, and reading 26 MB to
	// find it would cost more than the answer is worth.
	codexTailBudget = 2 << 20

	// codexModelGrace is how many more lines are read after the token_count in
	// the hope of finding the turn_context that names the model. The model
	// changes rarely and a turn_context is written per turn, so it is normally
	// within a handful of lines.
	codexModelGrace = 500

	// codexCandidates is how many rollouts are tried for the account-wide
	// reading before giving up. More than one is needed because the newest file
	// is often a conversation that has not completed a turn yet and so has no
	// token_count in it at all.
	codexCandidates = 5

	// codexMaxRollouts bounds the directory walk. A user who has run Codex
	// daily for years has thousands of files; the newest is always among the
	// first few thousand.
	codexMaxRollouts = 5000

	// codexMaxProcsPerPane bounds the descendant walk done per pane when
	// looking for an open rollout.
	codexMaxProcsPerPane = 256
)

// codexTokens is total_token_usage as the rollout reports it. CachedInput is
// the part of Input that was served from cache rather than an addition to it,
// which is how Codex's own display treats it, so summing the fields would count
// the cache twice.
type codexTokens struct {
	Input           int64
	CachedInput     int64
	CacheWriteInput int64
	Output          int64
	ReasoningOutput int64
	Total           int64
}

// codexWindow is one rate-limit window. Label is in Codex's own words for the
// two windows it ships with, derived from WindowMinutes so a window of some
// other length still gets a sensible name.
type codexWindow struct {
	Label         string
	WindowMinutes int
	UsedPercent   float64
	ResetsAtSec   int64
}

// codexCredits is the credits block. Balance is a string in the rollout and is
// kept as one: it is a display figure, and parsing it into a number would
// invent precision the source does not promise.
type codexCredits struct {
	HasCredits bool
	Unlimited  bool
	Balance    string
}

// codexRollout is one conversation's reading. TmuxSession is empty unless the
// conversation is live and its process was found holding the file open.
type codexRollout struct {
	Path          string
	SessionID     string
	TmuxSession   string
	Model         string
	Tokens        codexTokens
	ContextWindow int64
	At            time.Time
}

// codexReading is one OS user's whole Codex picture.
//
// Found says a rollout was read back and yielded a token_count. It is false for
// a box that has never run Codex, which is the common case and not an error.
// Windows, Plan and Credits are account-wide facts: they describe the ChatGPT
// account rather than the conversation they were read from. There is no dollar
// figure anywhere, because ChatGPT plans report none.
type codexReading struct {
	Found    bool
	Plan     string
	Windows  []codexWindow
	Credits  codexCredits
	Newest   codexRollout
	Sessions []codexRollout
}

// codexPane is a pane whose tmux session the caller already knows. The caller
// has this from the session list; the reader has no business running tmux.
type codexPane struct {
	Session string
	PID     int
}

// codexSpendReader reads one OS user's rollouts. procDir is normally "/proc";
// empty turns live attribution off, which is what the account-wide-only path
// looks like.
type codexSpendReader struct {
	home    string
	procDir string
}

// read returns what the user's rollouts say right now. A missing ~/.codex is
// not an error: it is a box that has never run Codex.
func (r codexSpendReader) read(panes []codexPane, now time.Time) (codexReading, error) {
	var out codexReading
	if r.home == "" {
		return out, nil
	}
	root := filepath.Join(r.home, ".codex", "sessions")
	files, err := codexRolloutFiles(root)
	if err != nil {
		return out, err
	}
	owners := r.liveRollouts(panes)

	// The live conversation whose rollout was written last is usually also the
	// newest file, so the two passes below would otherwise tail the same file
	// twice. Reading it once is worth the four lines.
	type tailResult struct {
		tail codexTail
		ok   bool
	}
	read := map[string]tailResult{}
	tailOf := func(path string) (codexTail, bool) {
		if r, done := read[path]; done {
			return r.tail, r.ok
		}
		tail, ok := readCodexTail(path)
		read[path] = tailResult{tail: tail, ok: ok}
		return tail, ok
	}

	for i, path := range files {
		if i >= codexCandidates {
			break
		}
		tail, ok := tailOf(path)
		if !ok {
			continue
		}
		out.Found = true
		out.Newest = tail.rollout
		out.Newest.TmuxSession = owners[path]
		if tail.limits != nil {
			out.Plan = tail.limits.PlanType
			out.Windows = tail.limits.windows(now)
			out.Credits = tail.limits.credits()
		}
		break
	}

	for path, session := range owners {
		tail, ok := tailOf(path)
		if !ok {
			continue
		}
		row := tail.rollout
		row.TmuxSession = session
		out.Sessions = append(out.Sessions, row)
	}
	sort.Slice(out.Sessions, func(i, j int) bool {
		if !out.Sessions[i].At.Equal(out.Sessions[j].At) {
			return out.Sessions[i].At.After(out.Sessions[j].At)
		}
		return out.Sessions[i].TmuxSession < out.Sessions[j].TmuxSession
	})
	return out, nil
}

// codexRolloutFiles lists every rollout under root, newest write first. mtime
// rather than the filename decides: a resumed conversation keeps the name it
// was created with and goes on being appended to for days.
//
// Directories that cannot be read are skipped rather than failing the walk, so
// one unreadable day does not blank the panel.
func codexRolloutFiles(root string) ([]string, error) {
	type candidate struct {
		path string
		mod  time.Time
	}
	var found []candidate
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// The whole tree missing lands here too, with path == root.
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		name := d.Name()
		if !strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, ".jsonl") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		found = append(found, candidate{path: path, mod: info.ModTime()})
		if len(found) >= codexMaxRollouts {
			return fs.SkipAll
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(found, func(i, j int) bool {
		if !found[i].mod.Equal(found[j].mod) {
			return found[i].mod.After(found[j].mod)
		}
		return found[i].path > found[j].path
	})
	paths := make([]string, 0, len(found))
	for _, c := range found {
		paths = append(paths, c.path)
	}
	return paths, nil
}

// codexSessionIDFromPath pulls the conversation uuid out of
// rollout-<timestamp>-<uuid>.jsonl. The uuid is the trailing 36 characters;
// anything shorter is handed back whole rather than guessed at.
func codexSessionIDFromPath(path string) string {
	name := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	name = strings.TrimPrefix(name, "rollout-")
	if len(name) >= 36 {
		return name[len(name)-36:]
	}
	return name
}

// --- reading one file --------------------------------------------------------

// codexTail is what one rollout's last lines said. limits is nil when the tail
// named no rate limits, which is every rollout written by a build that predates
// them and every one whose account reports none.
type codexTail struct {
	rollout codexRollout
	limits  *codexRateLimits
}

// readCodexTail reads back the last token_count that carries rate limits,
// which is the reading that describes the account, plus the model from the
// nearest turn_context. A tail whose token_count events name no rate limits at
// all falls back to the newest of them, so a rollout written by a build that
// predates the block still reports its tokens.
//
// The bool is false when the file could not be read, or when its tail holds no
// completed turn.
func readCodexTail(path string) (codexTail, bool) {
	out := codexTail{rollout: codexRollout{
		Path:      path,
		SessionID: codexSessionIDFromPath(path),
	}}
	haveTokens, haveLimits := false, false
	grace := 0

	err := scanLinesBackwards(path, codexTailBudget, func(raw []byte) bool {
		var line codexLineJSON
		if err := json.Unmarshal(raw, &line); err != nil {
			// A half-written final line, or a shape we do not know. Neither is
			// worth failing a read over.
			return true
		}
		switch line.Type {
		case "event_msg":
			var ev codexEventJSON
			if err := json.Unmarshal(line.Payload, &ev); err != nil || ev.Type != "token_count" {
				break
			}
			if haveLimits || ev.Info == nil || ev.Info.TotalTokenUsage == nil {
				break
			}
			if haveTokens && ev.RateLimits == nil {
				break
			}
			out.rollout.Tokens = ev.Info.TotalTokenUsage.tokens()
			out.rollout.ContextWindow = ev.Info.ModelContextWindow
			out.rollout.At = parseCodexTime(line.Timestamp)
			out.limits = ev.RateLimits
			haveTokens = true
			haveLimits = ev.RateLimits != nil
		case "turn_context":
			if out.rollout.Model != "" {
				break
			}
			var ctx codexTurnContextJSON
			if err := json.Unmarshal(line.Payload, &ctx); err == nil {
				out.rollout.Model = ctx.Model
			}
		}
		if haveLimits && out.rollout.Model != "" {
			return false
		}
		// Past the first token_count, keep going a bounded way for whatever is
		// still missing: the turn_context that names the model, or a turn that
		// named the rate limits.
		if haveTokens {
			grace++
			return grace <= codexModelGrace
		}
		return true
	})

	// A read that failed part way back still counts when the last turn was
	// already collected; only a failure that left nothing is a miss.
	if err != nil && !haveTokens {
		return codexTail{}, false
	}
	if !haveTokens {
		return codexTail{}, false
	}
	return out, true
}

// scanLinesBackwards hands fn each complete line of path, newest first, until
// fn returns false or budget bytes have been read. Reading backwards in chunks
// is what keeps a 26 MB rollout from being loaded to answer a question about
// its last turn.
func scanLinesBackwards(path string, budget int64, fn func(line []byte) bool) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}

	pos := info.Size()
	var read int64
	// pending is the head of the chunk just examined: a line that started in
	// the chunk before it, which cannot be handed over until that chunk is read.
	var pending []byte
	for pos > 0 && read < budget {
		n := int64(codexTailChunk)
		if n > pos {
			n = pos
		}
		pos -= n
		read += n
		buf := make([]byte, n)
		if _, err := f.ReadAt(buf, pos); err != nil {
			return err
		}
		buf = append(buf, pending...)
		pending = nil

		seg := buf
		if pos > 0 {
			// The first line here may have started before this chunk.
			i := bytes.IndexByte(buf, '\n')
			if i < 0 {
				pending = buf
				continue
			}
			pending = append([]byte(nil), buf[:i]...)
			seg = buf[i+1:]
		}
		if !emitLinesBackwards(seg, fn) {
			return nil
		}
	}
	return nil
}

// emitLinesBackwards walks seg from its end, handing whole lines to fn. It
// returns false when fn asked to stop.
func emitLinesBackwards(seg []byte, fn func(line []byte) bool) bool {
	for len(seg) > 0 {
		end := len(seg)
		if seg[end-1] == '\n' {
			end--
		}
		i := bytes.LastIndexByte(seg[:end], '\n')
		line := seg[i+1 : end]
		if len(bytes.TrimSpace(line)) > 0 && !fn(line) {
			return false
		}
		if i < 0 {
			return true
		}
		seg = seg[:i]
	}
	return true
}

func parseCodexTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}
	}
	return t.UTC()
}

// --- the JSON shapes ---------------------------------------------------------

type codexLineJSON struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

type codexEventJSON struct {
	Type       string           `json:"type"`
	Info       *codexInfoJSON   `json:"info"`
	RateLimits *codexRateLimits `json:"rate_limits"`
}

type codexInfoJSON struct {
	TotalTokenUsage    *codexUsageJSON `json:"total_token_usage"`
	ModelContextWindow int64           `json:"model_context_window"`
}

type codexUsageJSON struct {
	InputTokens           int64 `json:"input_tokens"`
	CachedInputTokens     int64 `json:"cached_input_tokens"`
	CacheWriteInputTokens int64 `json:"cache_write_input_tokens"`
	OutputTokens          int64 `json:"output_tokens"`
	ReasoningOutputTokens int64 `json:"reasoning_output_tokens"`
	TotalTokens           int64 `json:"total_tokens"`
}

func (u codexUsageJSON) tokens() codexTokens {
	return codexTokens{
		Input:           u.InputTokens,
		CachedInput:     u.CachedInputTokens,
		CacheWriteInput: u.CacheWriteInputTokens,
		Output:          u.OutputTokens,
		ReasoningOutput: u.ReasoningOutputTokens,
		Total:           u.TotalTokens,
	}
}

type codexTurnContextJSON struct {
	Model string `json:"model"`
}

// codexRateLimits is the rate_limits block. Primary and Secondary are pointers
// because secondary is explicitly null on older builds. Credits stays raw and
// is parsed on its own, so a drift in that sub-object costs the credit balance
// rather than the windows, which are the part the page needs.
type codexRateLimits struct {
	Primary   *codexLimitJSON `json:"primary"`
	Secondary *codexLimitJSON `json:"secondary"`
	Credits   json.RawMessage `json:"credits"`
	PlanType  string          `json:"plan_type"`
}

type codexLimitJSON struct {
	UsedPercent   float64 `json:"used_percent"`
	WindowMinutes int     `json:"window_minutes"`
	ResetsAt      int64   `json:"resets_at"`
}

type codexCreditsJSON struct {
	HasCredits bool   `json:"has_credits"`
	Unlimited  bool   `json:"unlimited"`
	Balance    string `json:"balance"`
}

// windows turns the two slots into labelled windows, dropping any whose reset
// has already passed: that reading describes a window that no longer exists,
// and showing it as current would be wrong rather than merely stale. A window
// that named no reset at all cannot be judged, so it is kept.
func (l *codexRateLimits) windows(now time.Time) []codexWindow {
	var out []codexWindow
	for _, lim := range []*codexLimitJSON{l.Primary, l.Secondary} {
		if lim == nil {
			continue
		}
		if lim.ResetsAt > 0 && lim.ResetsAt <= now.Unix() {
			continue
		}
		out = append(out, codexWindow{
			Label:         codexWindowLabel(lim.WindowMinutes),
			WindowMinutes: lim.WindowMinutes,
			UsedPercent:   lim.UsedPercent,
			ResetsAtSec:   lim.ResetsAt,
		})
	}
	return out
}

func (l *codexRateLimits) credits() codexCredits {
	if len(l.Credits) == 0 {
		return codexCredits{}
	}
	var c codexCreditsJSON
	if err := json.Unmarshal(l.Credits, &c); err != nil {
		return codexCredits{}
	}
	return codexCredits{HasCredits: c.HasCredits, Unlimited: c.Unlimited, Balance: c.Balance}
}

// codexWindowLabel names a window from its length. Codex calls its two windows
// the "5-hour limit" and the "weekly limit", and 300 minutes reads back as the
// first of those on its own; 10080 is spelled out because "168-hour limit" is
// not what anyone would recognise.
func codexWindowLabel(minutes int) string {
	switch {
	case minutes <= 0:
		return "limit"
	case minutes == 10080:
		return "weekly limit"
	case minutes%(60*24) == 0:
		return fmt.Sprintf("%d-day limit", minutes/(60*24))
	case minutes%60 == 0:
		return fmt.Sprintf("%d-hour limit", minutes/60)
	default:
		return fmt.Sprintf("%d-minute limit", minutes)
	}
}

// --- live attribution --------------------------------------------------------

// liveRollouts maps a rollout path to the tmux session running it, for the
// panes the caller named. Only live conversations appear: this reads which file
// a process still holds open. Anything unreadable is skipped silently, which
// covers the ordinary case of a pane owned by another OS user.
func (r codexSpendReader) liveRollouts(panes []codexPane) map[string]string {
	if r.procDir == "" || len(panes) == 0 {
		return nil
	}
	tree, err := procTreeFrom(r.procDir)
	if err != nil {
		return nil
	}
	prefix := filepath.Join(r.home, ".codex", "sessions") + string(filepath.Separator)
	out := map[string]string{}
	for _, pane := range panes {
		if pane.Session == "" || pane.PID <= 0 {
			continue
		}
		for _, pid := range codexDescendants(tree, pane.PID) {
			path, ok := r.openRollout(pid, prefix)
			if !ok {
				continue
			}
			if _, taken := out[path]; !taken {
				out[path] = pane.Session
			}
			break
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// codexDescendants is pid and everything under it, breadth first and bounded.
func codexDescendants(t procTree, pid int) []int {
	out := []int{}
	queue := []int{pid}
	for len(queue) > 0 && len(out) < codexMaxProcsPerPane {
		p := queue[0]
		queue = queue[1:]
		out = append(out, p)
		queue = append(queue, t.children[p]...)
	}
	return out
}

// openRollout is the rollout file this process has open, if any. /proc/<pid>/fd
// is readable only by the process owner, so a miss here is as likely to be a
// permission as an absence, and both mean the same thing to the caller.
func (r codexSpendReader) openRollout(pid int, prefix string) (string, bool) {
	dir := filepath.Join(r.procDir, strconv.Itoa(pid), "fd")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", false
	}
	for _, e := range entries {
		target, err := os.Readlink(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		// A rollout whose file was replaced under the process is of no use.
		target = strings.TrimSuffix(target, " (deleted)")
		if !strings.HasPrefix(target, prefix) || !strings.HasSuffix(target, ".jsonl") {
			continue
		}
		if !strings.HasPrefix(filepath.Base(target), "rollout-") {
			continue
		}
		return target, true
	}
	return "", false
}
