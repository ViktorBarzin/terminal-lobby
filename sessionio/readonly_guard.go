package sessionio

import (
	"fmt"
	"regexp"
	"strings"
)

// GuardReadOnly stops a read-only client leaving the session it was attached
// to, or detaching anyone else's client (ADR-0043).
//
// tmux applies read-only to the client, not the session. A read-only client
// may still run a binding whose every command is one tmux marks as safe for
// it, and switch-client and detach-client are two of them. With tmux's
// defaults a guest watching one session can press prefix ( or ) and land in
// the owner's other sessions, and an account's own config can add more: on
// this box oh-my-tmux binds prefix BTab to switch-client -l.
//
// A binding whose command is if-shell is refused for a read-only client and
// runs normally for a read-write one. So every binding, in every key table,
// that runs switch-client, or detach-client with any flag (-a would detach the
// owner's own clients), is rewrapped as `if-shell -F 1 { … }`: drivers keep
// the key, watchers lose it. Plain detach-client, which only leaves, is left
// alone. Measured on tmux 3.4 (readonly_guard_test.go).
//
// The rewrapped bindings go back through `source-file -` rather than one
// bind-key per key, so tmux's own escaping of keys and arguments, as list-keys
// prints it, is read by the parser that wrote it. Called on every guest's
// read-only attach; a binding already wrapped is not wrapped again.
func (in *Injector) GuardReadOnly(osUser string) error {
	out, err := in.Command(osUser, "list-keys").Output()
	if err != nil {
		return fmt.Errorf("guard read-only: list-keys: %w", err)
	}
	var conf strings.Builder
	for _, line := range strings.Split(string(out), "\n") {
		if w := wrapForReadOnly(line); w != "" {
			conf.WriteString(w)
			conf.WriteByte('\n')
		}
	}
	if conf.Len() == 0 {
		return nil
	}
	cmd := in.Command(osUser, "source-file", "-")
	cmd.Stdin = strings.NewReader(conf.String())
	if o, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("guard read-only: source-file: %v: %s", err, strings.TrimSpace(string(o)))
	}
	return nil
}

// bindLineRe splits a list-keys line into everything up to the key, and the
// command. The key and the table never hold a space as list-keys prints them.
var bindLineRe = regexp.MustCompile(`^(bind-key(?:\s+-r)?(?:\s+-N\s+"(?:[^"\\]|\\.)*")?\s+-T\s+\S+\s+\S+)\s+(.*)$`)

// wrapForReadOnly is the config line that rebinds one list-keys line with its
// command wrapped in if-shell, or "" when the line needs nothing.
//
// list-keys separates the commands of one binding with ` \; `; inside braces
// the separator is ` ; ` (the `\;` form is a parse error there, measured).
func wrapForReadOnly(line string) string {
	m := bindLineRe.FindStringSubmatch(strings.TrimRight(line, " \t"))
	if m == nil {
		return ""
	}
	cmds := strings.Split(m[2], ` \; `)
	hit := false
	for _, c := range cmds {
		f := strings.Fields(c)
		if len(f) == 0 {
			continue
		}
		if f[0] == "switch-client" || (f[0] == "detach-client" && len(f) > 1) {
			hit = true
		}
	}
	if !hit {
		return ""
	}
	return m[1] + " if-shell -F 1 { " + strings.Join(cmds, " ; ") + " }"
}
