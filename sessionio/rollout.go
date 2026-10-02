package sessionio

import (
	"errors"
	"os/exec"
	"regexp"
	"strings"
)

// What restarting a Claude that predates the lobby's mod needs (ADR-0036).
//
// A Claude started before the mod existed has no event stream, and the only
// way to give it one is to start it again on the same conversation. That is
// done only once it is safe: Claude idle, no background work, no dialog, and
// nothing typed on its input line. These are the readings that decide it, and
// the command that restarts it.

// PoolSlotPrefix names the lobby's prewarmed sessions: a Claude started ahead
// of need with no conversation yet, so it restarts as it was started.
const PoolSlotPrefix = "__terminal_lobby_prewarmed_pool_slot__"

// RolloutSession is one tmux session as the restart reads it.
type RolloutSession struct {
	Name       string
	State      string // @claude_state
	Background string // @claude_bg
	Ask        string // @claude_ask
	Transcript string // @claude_transcript
	Suspended  string // @tl_suspended
	Start      string // #{pane_start_command}
	Cwd        string // #{pane_current_path}
}

// rolloutFields is the list-sessions format, one tab-separated field each.
var rolloutFields = []string{
	"#{session_name}", "#{" + OptionState + "}", "#{" + OptionBackground + "}", "#{" + OptionAsk + "}",
	"#{" + OptionTranscript + "}", "#{" + OptionSuspended + "}", "#{pane_start_command}", "#{pane_current_path}",
}

// RolloutSessions lists the user's sessions with what the restart reads. No
// tmux server is an empty list.
func (in *Injector) RolloutSessions(osUser string) ([]RolloutSession, error) {
	out, err := in.Command(osUser, "list-sessions", "-F", strings.Join(rolloutFields, "\t")).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && noServer(string(ee.Stderr)) {
			return nil, nil
		}
		return nil, err
	}
	return parseRolloutSessions(string(out)), nil
}

func parseRolloutSessions(out string) []RolloutSession {
	var list []RolloutSession
	for _, line := range strings.Split(strings.TrimSuffix(out, "\n"), "\n") {
		f := strings.Split(line, "\t")
		if len(f) != len(rolloutFields) || f[0] == "" {
			continue
		}
		list = append(list, RolloutSession{Name: f[0], State: f[1], Background: f[2], Ask: f[3],
			Transcript: f[4], Suspended: f[5], Start: f[6], Cwd: f[7]})
	}
	return list
}

// CapturePaneStyled is CapturePane with the escape sequences kept, which is
// how a placeholder in the input box is told from words somebody typed.
func (in *Injector) CapturePaneStyled(osUser, session string) (string, error) {
	out, err := in.Command(osUser, "capture-pane", "-e", "-p", "-t", exactPane(session)).Output()
	return string(out), err
}

var sgrRe = regexp.MustCompile("\x1b\\[[0-9;]*m")

// BoxDraft reads a styled capture's input box: whether it holds words somebody
// typed, and whether there is a box at all. Claude draws a suggestion in an
// empty box dimmed (SGR 2, measured on CLI 2.1.287 on 2026-10-02:
// "❯ \x1b[2mhow do I declare it online\x1b[0m"), so dimmed text is not a
// draft.
func BoxDraft(styled string) (draft, ok bool) {
	lines := strings.Split(styled, "\n")
	for i := len(lines) - 1; i > 0; i-- {
		line := strings.TrimPrefix(lines[i], "\x1b[39m")
		rest, found := strings.CutPrefix(line, promptMark)
		if !found || !isBoxRule(sgrRe.ReplaceAllString(lines[i-1], "")) {
			continue
		}
		rest = strings.TrimLeft(rest, "  ")
		if strings.HasPrefix(rest, "\x1b[2m") {
			return false, true
		}
		return strings.TrimSpace(sgrRe.ReplaceAllString(rest, "")) != "", true
	}
	return false, false
}

// startRe is the shape the lobby starts Claude in: a login shell running one
// quoted command (`/bin/zsh -lic "claude --dangerously-skip-permissions"`).
var startRe = regexp.MustCompile(`^(\S*(?:zsh|bash)) -lic "(claude(?: [^"]*)?)"$`)

// flagsWithValue are the Claude flags that take the next argument, for the
// ones a lobby start command carries that also name a conversation.
var conversationFlags = map[string]bool{"--resume": true, "-r": true, "--session-id": true}

// ResumeCommand is the pane command that starts the session's Claude again on
// conversation sid, with the flags it was started with: the start command with
// any conversation flags replaced by --resume. ok=false for a start command
// that is not the shape the lobby writes, which is left alone.
func ResumeCommand(start, sid string) (string, bool) {
	m := startRe.FindStringSubmatch(start)
	if m == nil || !uuidRe.MatchString(sid) {
		return "", false
	}
	args := strings.Fields(m[2])[1:]
	kept := []string{"claude"}
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case conversationFlags[a]:
			i++ // and its value
		case a == "--continue" || a == "-c":
		case strings.HasPrefix(a, "--resume=") || strings.HasPrefix(a, "--session-id="):
		default:
			kept = append(kept, a)
		}
	}
	kept = append(kept, "--resume", sid)
	return m[1] + ` -lic "` + strings.Join(kept, " ") + `"`, true
}

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// Respawn replaces the session's pane process with cmd, in dir.
func (in *Injector) Respawn(osUser, session, dir, cmd string) error {
	args := []string{"respawn-pane", "-k", "-t", exactPane(session)}
	if dir != "" {
		args = append(args, "-c", dir)
	}
	return in.Command(osUser, append(args, cmd)...).Run()
}
