package sessionio

import (
	"fmt"
	"strings"
)

// readOnlyGuardKeys are tmux's default bindings that switch the client to
// another session, with the command each one runs.
var readOnlyGuardKeys = map[string]string{
	"(": "switch-client -p",
	")": "switch-client -n",
	"L": "switch-client -l",
}

// GuardReadOnly stops a read-only client leaving the session it was attached
// to (ADR-0043).
//
// tmux applies read-only to the client, not the session, and lets a read-only
// client run any binding whose command is switch-client or detach-client. With
// the defaults, a guest watching one session can press prefix ( or ) and land
// in the owner's other sessions. A binding whose command is if-shell is refused
// for a read-only client and runs normally for a read-write one, so wrapping
// the three defaults keeps them for drivers and takes them from watchers.
// Measured on tmux 3.4 (readonly_guard_test.go).
//
// /etc/tmux.conf carries the same bindings for servers started after it was
// installed. This covers the servers already running, and is called on every
// read-only attach. Only a key still bound to its default is rewrapped, so an
// account's own binding for one of these keys is left as it is, and a second
// call changes nothing.
func (in *Injector) GuardReadOnly(osUser string) error {
	out, err := in.Command(osUser, "list-keys", "-T", "prefix").Output()
	if err != nil {
		return fmt.Errorf("guard read-only: list-keys: %w", err)
	}
	for _, line := range strings.Split(string(out), "\n") {
		key := defaultSwitchKey(line)
		if key == "" {
			continue
		}
		if o, err := in.Command(osUser, "bind-key", "-T", "prefix", key,
			"if-shell", "-F", "1", readOnlyGuardKeys[key]).CombinedOutput(); err != nil {
			return fmt.Errorf("guard read-only: bind %s: %v: %s", key, err, strings.TrimSpace(string(o)))
		}
	}
	return nil
}

// defaultSwitchKey is the key a list-keys line binds when that line is one of
// readOnlyGuardKeys at its default command, and "" for any other line.
func defaultSwitchKey(line string) string {
	f := strings.Fields(line)
	for i := 0; i+2 < len(f); i++ {
		if f[i] != "-T" || f[i+1] != "prefix" {
			continue
		}
		key, cmd := f[i+2], strings.Join(f[i+3:], " ")
		if want, ok := readOnlyGuardKeys[key]; ok && cmd == want {
			return key
		}
		return ""
	}
	return ""
}
