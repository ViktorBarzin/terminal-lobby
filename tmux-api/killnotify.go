package main

// The kill-notify: telling a user's T3 syncer that a session was destroyed on
// purpose.
//
// killSession is the only place on this box that knows the difference. Every
// other way a session can vanish — earlyoom, a crashed tmux server, a reboot,
// a claude that exited — looks identical from the outside: the name is simply
// no longer in `list-sessions`. The T3 bridge's rule is "kill crosses, exit
// does not" (design decision 3: a lobby kill archives the mirrored thread; an
// OOM crosses nothing and the next prompt resurrects the session), and this
// notify is the entire basis for that distinction. Without it the syncer would
// have to guess, and guessing wrong archives threads a reboot merely
// interrupted.
//
// Everything here is best-effort by construction. The kill already happened
// and the user already has their answer; a syncer that is stopped, wedged,
// mid-restart or simply not installed is an ordinary state, not an error the
// caller should ever see. The cost of a lost notice is bounded and benign: the
// thread stays unarchived in T3 until someone archives it there.
//
// Wire shape and the syncer's obligations: t3-bridge/CONTRACT.md §8.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	// killNotifyPath is the syncer's route. Namespaced under /notify/ so a
	// later signal (there is none today) does not have to re-litigate the URL.
	killNotifyPath = "/notify/kill"
	// killNotifyPortKey is the key in the per-user systemd EnvironmentFile that
	// carries the syncer's loopback listen port. Its ABSENCE is the feature
	// gate: a user with no tl-t3-sync has no file, no key, and gets no notify.
	killNotifyPortKey = "TL_T3_SYNC_NOTIFY_PORT"
	// killNotifySource names us in the payload. The syncer logs it; a second
	// producer (there is none today) would be distinguishable in its journal.
	killNotifySource = "tmux-api"
	// killNotifyTimeout bounds one whole POST — dial, request, response. The
	// target is always loopback, so a healthy syncer answers in microseconds
	// and this budget only ever gets spent on a wedged one. It runs off the
	// response path, so the number trades nothing away from the user.
	killNotifyTimeout = 2 * time.Second
)

// syncEnvDir holds one systemd EnvironmentFile per user, `<user>.env`, read by
// tl-t3-sync@<user>.service (devvm/tl-t3-sync@.service). tmux-api reads the
// same file rather than keeping its own registry: two sources for one port is
// two chances to disagree.
//
// A var, not a const, for the same reason as mapPath and tmuxBinary — a test
// seam. Production never reassigns it.
var syncEnvDir = "/etc/tl-t3-sync"

// syncEnvUserRe guards the one path this file composes. osUser arrives from
// resolveOSUser, which has already done a user.Lookup, but a path join two
// files away from its validation deserves its own check.
var syncEnvUserRe = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,32}$`)

// killNotifyClient is shared: one keep-alive pool for a POST that happens a few
// times a day, with the timeout applied to the whole exchange.
var killNotifyClient = &http.Client{Timeout: killNotifyTimeout}

// killNotice is the body of POST /notify/kill (CONTRACT.md §8).
//
// OSUser is redundant with the syncer's own uid and deliberately sent anyway:
// it lets the syncer drop a notice meant for somebody else — the failure mode
// of two users' env files naming the same port — instead of archiving a thread
// on a stranger's behalf.
type killNotice struct {
	OSUser   string    `json:"osUser"`
	Session  string    `json:"session"`
	KilledAt time.Time `json:"killedAt"`
	Source   string    `json:"source"`
}

// syncNotifyURL resolves the notify endpoint of osUser's syncer, or reports
// that there is nothing to notify.
//
// Deliberately unmemoised. Kills are rare and this is one small read from a
// page-cached file on local disk, whereas a cache would mean a stale port for
// as long as it lived — and the syncer's port changes exactly when an operator
// edits that file, which is the moment a cache would be wrong.
func syncNotifyURL(osUser string) (string, bool) {
	if !syncEnvUserRe.MatchString(osUser) {
		return "", false
	}
	raw, ok := envFileValue(syncEnvDir+"/"+osUser+".env", killNotifyPortKey)
	if !ok {
		return "", false
	}
	port, err := strconv.Atoi(raw)
	if err != nil || port < 1 || port > 65535 {
		return "", false
	}
	// Loopback, always. The syncer binds 127.0.0.1 and the notice never leaves
	// the box — tmux-api and the syncer are the same machine by construction
	// (the syncer drives that user's own tmux server).
	return "http://127.0.0.1:" + strconv.Itoa(port) + killNotifyPath, true
}

// envFileValue reads one key out of a systemd EnvironmentFile.
//
// The subset systemd actually applies to these files: `KEY=value` lines, `#`
// comments, blank lines, optional surrounding quotes, and a later assignment
// overriding an earlier one. Line continuations and `$VAR` interpolation are
// not implemented — the syncer env files are five flat keys, and a parser that
// quietly half-supports a syntax is worse than one that does not.
func envFileValue(path, key string) (string, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		// A missing file is the normal state for every user who has not
		// enabled the syncer, so it is not worth a log line.
		return "", false
	}
	value := ""
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(k) != key {
			continue
		}
		// No break: a later assignment overrides an earlier one, as systemd
		// reads it. Agreeing with the unit matters more than stopping early.
		value = unquote(strings.TrimSpace(v))
	}
	// An empty assignment is systemd's way of unsetting a key, and it lands here
	// indistinguishable from an absent one — which is the right answer for both:
	// no port means no syncer to notify, not an http://127.0.0.1:/… target.
	return value, value != ""
}

// unquote strips one layer of matching quotes, the way systemd does when it
// reads an EnvironmentFile.
func unquote(s string) string {
	if len(s) >= 2 {
		if (s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'') {
			return s[1 : len(s)-1]
		}
	}
	return s
}

// postKillNotice delivers one notice and reports whether it landed. It blocks
// for up to killNotifyTimeout, so callers on a request path run it on their own
// goroutine; the error is for a log line, never for the HTTP response.
func postKillNotice(url string, n killNotice) error {
	body, err := json.Marshal(n)
	if err != nil {
		return fmt.Errorf("encode notice: %w", err)
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := killNotifyClient.Do(req)
	if err != nil {
		return fmt.Errorf("post: %w", err)
	}
	// Drain a bounded amount so the connection can be reused; the syncer
	// answers 204 with no body, and a chatty one must not be able to make us
	// read forever.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("post: %s", resp.Status)
	}
	return nil
}
