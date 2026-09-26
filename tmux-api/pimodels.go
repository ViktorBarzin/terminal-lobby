package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// GET /pi-models answers "which models can this user's pi run", for the pi
// picker in the new-session composer (docs/adr/0032-pi-lists-its-own-models-per-user.md).
//
// The Claude and Codex pickers read lists written into the frontend. Pi prints
// its own before a session exists, and pi is where people sign into different
// providers, so the answer is asked of pi, per OS user. The asking happens in
// tmux-user-attach --pi-models, as the user and inside their login shell, for
// the reasons --probe gives (newcommands.go): a sign-in lives in the user's own
// ~/.pi, which this service cannot read, and PATH lives in their shell.
//
// Every answer is a 200. A pi that is not installed, not signed in, slow or
// unreadable leaves the picker on its default choice, which starts pi on its
// own default model; the short reason in `error` says why there was nothing to
// pick from.

// piModel is one row the picker offers. Ref is what the composer sends back to
// the launch path as the model, and what the pi extension resolves at startup.
type piModel struct {
	Ref      string `json:"ref"`
	Provider string `json:"provider"`
	ID       string `json:"id"`
	Thinking bool   `json:"thinking"`
}

// piModelsBody is the whole answer. Models is never null.
type piModelsBody struct {
	SignedIn bool      `json:"signedIn"`
	Models   []piModel `json:"models"`
	Error    string    `json:"error,omitempty"`
}

// piListingResult is what one --pi-models call said: the listing and the
// user's enabledModels patterns, before the patterns are applied.
type piListingResult struct {
	SignedIn bool
	Models   []piModel
	Enabled  []string
}

// The frame tmux-user-attach --pi-models prints around each section. A login
// shell's stdout also carries whatever an rc file prints before the snippet and
// a logout file prints after it, so only what sits between these lines is read.
const (
	piMarkerMissing  = "@@terminal-lobby:pi-missing@@"
	piMarkerModels   = "@@terminal-lobby:pi-models@@"
	piMarkerSettings = "@@terminal-lobby:pi-settings@@"
	piMarkerEnd      = "@@terminal-lobby:pi-end@@"
)

// piModelsTTL is the agreed two minutes. A sign-in changes when somebody runs
// /login, not on every open of the composer, and each miss costs a login shell
// and a node start.
const piModelsTTL = 2 * time.Minute

var piModelsCacheInstance = newSessionsCache(piModelsTTL)

// piModelsTimeout bounds the call. A cold login shell measured 3.9 s here
// (newcommands.go), `pi --list-models` 0.8 s, and the script cuts pi itself off
// at 12 s; this is the ceiling on all of it. A var so the test can shorten it.
var piModelsTimeout = 20 * time.Second

// piRefRe is the launch gate's pattern for a pi model reference
// (PI_MODEL_RE in devvm/tmux-user-attach). A row the gate would refuse is not
// offered: picking it could only ever start pi on its default.
var piRefRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@/~-]{0,95}$`)

// piRowRe is one row of `pi --list-models` (pi 0.87.1, cli/list-models.js):
// provider, model id, context, max output, thinking, images, padded with runs
// of spaces. The header fails it on its own words, which is what keeps it out.
var piRowRe = regexp.MustCompile(`^(\S+)\s+(\S+)\s+([0-9][0-9.]*[KM]?)\s+([0-9][0-9.]*[KM]?)\s+(yes|no)\s+(yes|no)\s*$`)

// piNotSignedIn opens what pi prints when no provider has usable credentials
// (formatNoModelsAvailableMessage). It is an answer, not a failure.
const piNotSignedIn = "No models available"

// piThinkingLevels are the suffixes a pattern may carry (`claude-opus-5:high`),
// which scope the level and not the model.
var piThinkingLevels = map[string]bool{
	"off": true, "minimal": true, "low": true, "medium": true, "high": true, "xhigh": true, "max": true,
}

// runPiModels runs tmux-user-attach --pi-models as the given OS user, with the
// same self/sudo split and the same -H as runProbe: the settings file is read
// from the target user's home, so sudo has to hand that home over.
var runPiModels = func(osUser string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), piModelsTimeout)
	defer cancel()
	var c *exec.Cmd
	if osUser == selfUser {
		c = exec.CommandContext(ctx, attachScript, "--pi-models")
	} else {
		c = exec.CommandContext(ctx, sudoBinary, "-n", "-H", "-u", osUser, attachScript, "--pi-models")
	}
	// For the reason runProbe gives: the deadline kills the shell, but anything
	// it started can hold stdout open after it, and the read would wait with it.
	c.WaitDelay = time.Second
	out, err := c.Output()
	if ctx.Err() != nil {
		return out, errPiModelsTimeout
	}
	return out, err
}

var errPiModelsTimeout = errors.New("pi took too long to list its models")

// stubPiModels swaps the runner for a test and returns the undo, taking the
// cache with it for the reason stubProbe gives.
func stubPiModels(fn func(string) ([]byte, error)) func() {
	prevFn, prevCache := runPiModels, piModelsCacheInstance
	runPiModels, piModelsCacheInstance = fn, newSessionsCache(piModelsTTL)
	return func() { runPiModels, piModelsCacheInstance = prevFn, prevCache }
}

// parsePiModels reads one --pi-models call. An error means the call did not
// answer the question at all; "not signed in" is an answer and is not one.
func parsePiModels(out []byte) (piListingResult, error) {
	lines := strings.Split(strings.ReplaceAll(string(out), "\r\n", "\n"), "\n")
	start, settings, end := -1, -1, -1
	for i, line := range lines {
		switch line {
		case piMarkerMissing:
			return piListingResult{}, errors.New("pi is not installed")
		case piMarkerModels:
			if start < 0 {
				start = i
			}
		case piMarkerSettings:
			if start >= 0 && settings < 0 {
				settings = i
			}
		case piMarkerEnd:
			// The LAST one: a settings file is the user's to write, and one that
			// happened to contain the marker must not cut the frame short.
			end = i
		}
	}
	if start < 0 {
		return piListingResult{}, errors.New("pi printed no model list")
	}
	listingEnd := len(lines)
	if settings >= 0 {
		listingEnd = settings
	} else if end > start {
		listingEnd = end
	}

	res := piListingResult{Models: []piModel{}}
	answered := false
	for _, line := range lines[start+1 : listingEnd] {
		if strings.HasPrefix(line, piNotSignedIn) {
			answered = true
			continue
		}
		m := piRowRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		answered = true
		ref := m[1] + "/" + m[2]
		if !piRefRe.MatchString(ref) {
			continue
		}
		res.Models = append(res.Models, piModel{Ref: ref, Provider: m[1], ID: m[2], Thinking: m[5] == "yes"})
	}
	if !answered {
		return piListingResult{}, errors.New("pi's model list was not in the expected shape")
	}
	res.SignedIn = len(res.Models) > 0

	if settings >= 0 && end > settings {
		res.Enabled = parsePiEnabledModels(strings.Join(lines[settings+1:end], "\n"))
	}
	return res, nil
}

// parsePiEnabledModels takes enabledModels out of pi's settings.json. A file
// that is missing, empty or not JSON is no setting at all, and an entry that is
// not a string is skipped rather than taken as a reason to drop the others.
func parsePiEnabledModels(doc string) []string {
	raw := bytes.TrimSpace(bytes.TrimPrefix([]byte(doc), []byte("\xef\xbb\xbf")))
	if len(raw) == 0 {
		return nil
	}
	var settings struct {
		EnabledModels []any `json:"enabledModels"`
	}
	if json.Unmarshal(raw, &settings) != nil {
		return nil
	}
	var out []string
	for _, e := range settings.EnabledModels {
		if s, ok := e.(string); ok && strings.TrimSpace(s) != "" {
			out = append(out, strings.TrimSpace(s))
		}
	}
	return out
}

// filterPiModels applies enabledModels the way the ADR records: a row stays
// when a pattern names it by exact id or exact provider/id, or matches it as a
// glob of * and ?, once any :thinking suffix is off the pattern. No pattern, or
// patterns that match nothing, keep every row. Matching ignores case, as pi's
// does, and the rows keep pi's order.
//
// It is an approximation of pi's own scoping. Pi also takes a bare word as a
// fuzzy match; that is not reproduced, so such a pattern matches nothing here
// and, alone, leaves the whole list offered.
func filterPiModels(models []piModel, patterns []string) []piModel {
	if len(patterns) == 0 {
		return models
	}
	var matchers []func(piModel) bool
	for _, p := range patterns {
		p = strings.ToLower(strings.TrimSpace(p))
		if i := strings.LastIndex(p, ":"); i >= 0 && piThinkingLevels[p[i+1:]] {
			p = p[:i]
		}
		if p == "" {
			continue
		}
		if strings.ContainsAny(p, "*?") {
			re := piGlob(p)
			matchers = append(matchers, func(m piModel) bool {
				return re.MatchString(strings.ToLower(m.Ref)) || re.MatchString(strings.ToLower(m.ID))
			})
			continue
		}
		exact := p
		matchers = append(matchers, func(m piModel) bool {
			return strings.ToLower(m.Ref) == exact || strings.ToLower(m.ID) == exact
		})
	}
	var kept []piModel
	for _, m := range models {
		for _, match := range matchers {
			if match(m) {
				kept = append(kept, m)
				break
			}
		}
	}
	if len(kept) == 0 {
		return models
	}
	return kept
}

// piGlob compiles a pattern the way minimatch, which pi matches with, reads the
// simple cases: * is any run of characters short of a slash, ** crosses
// slashes, ? is one character short of a slash, and everything else is
// literal.
func piGlob(pattern string) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(pattern); i++ {
		switch c := pattern[i]; {
		case c == '*' && i+1 < len(pattern) && pattern[i+1] == '*':
			b.WriteString(".*")
			i++
		case c == '*':
			b.WriteString("[^/]*")
		case c == '?':
			b.WriteString("[^/]")
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	b.WriteString("$")
	return regexp.MustCompile(b.String())
}

// piModelsFor asks and answers for one user, uncached.
func piModelsFor(osUser string) piModelsBody {
	out, err := runPiModels(osUser)
	if err != nil {
		log.Printf("pi-models for %s failed: %v", osUser, err)
		reason := "could not list pi's models"
		if errors.Is(err, errPiModelsTimeout) {
			reason = errPiModelsTimeout.Error()
		}
		return piModelsBody{Models: []piModel{}, Error: reason}
	}
	listing, err := parsePiModels(out)
	if err != nil {
		log.Printf("pi-models for %s: %v", osUser, err)
		return piModelsBody{Models: []piModel{}, Error: err.Error()}
	}
	models := filterPiModels(listing.Models, listing.Enabled)
	if models == nil {
		models = []piModel{}
	}
	return piModelsBody{SignedIn: listing.SignedIn, Models: models}
}

// handlePiModels answers GET /pi-models behind the same gate and cache shape as
// GET /new-commands: act-as resolves whose pi is asked, and the answer is kept
// per OS user for piModelsTTL, failures included, so a slow shell is paid for
// once and not on every open of the picker.
func handlePiModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	id, ok := actAsGate.Authorize(w, r)
	if !ok {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")

	if body, hit := piModelsCacheInstance.get(id.OSUser); hit {
		w.Write(body)
		return
	}
	body, err := json.Marshal(piModelsFor(id.OSUser))
	if err != nil { // a struct of strings and bools cannot fail to marshal
		body = []byte(`{"signedIn":false,"models":[],"error":"internal error"}`)
	}
	piModelsCacheInstance.put(id.OSUser, body)
	w.Write(body)
}
