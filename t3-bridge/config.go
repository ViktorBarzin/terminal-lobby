package main

import (
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
)

// Config is the argv T3 spawned this bridge with, reduced to what the bridge
// acts on. Unrecognised flags are kept in Rest rather than rejected: T3
// upgrades nightly and a new flag must not stop a thread from opening.
type Config struct {
	// SessionID is --session-id: T3 has assigned an id for a NEW thread, and
	// the tmux session does not exist yet.
	SessionID string
	// Resume is --resume: an EXISTING thread, whose id is the Claude session
	// uuid the transcript is written under.
	Resume string

	// Probe is set when the argv identifies no conversation at all. That is what
	// T3's own capability probe looks like, so it is answered as a handshake and
	// nothing is attached — see ProbeEnv for why the mode exists.
	Probe bool

	Model                  string // --model
	Effort                 string // --effort
	PermissionMode         string // --permission-mode
	MCPConfig              string // --mcp-config, passed straight through to a session we launch
	SettingSources         string // --setting-sources=...
	AddDirs                []string
	IncludePartialMessages bool
	SkipPermissions        bool

	// CWD is the process's working directory, which T3 sets to the thread's
	// workspace root. It is where a resurrected session gets created.
	CWD string
	// Argv is the original argument list, for delegation and for logging a
	// spawn we did not understand.
	Argv []string
	// Rest is every argument not recognised above. It is DIAGNOSTIC: an unknown
	// flag's arity is unknowable, so a value that followed one is in here as a
	// bare token. Log it; do not hand it to claude.
	Rest []string
}

// ClaudeID is the Claude session uuid this invocation is about — the shared
// identity between the thread, the tmux session and the transcript.
func (c Config) ClaudeID() string {
	if c.Resume != "" {
		return c.Resume
	}
	return c.SessionID
}

// NewThread reports whether T3 is opening a thread that has never run: it
// assigned the session id itself, so the bridge creates the tmux session and
// starts claude with that id rather than looking for an existing one.
func (c Config) NewThread() bool { return c.Resume == "" && c.SessionID != "" }

// protoValueFlags are the flags whose next argument is their value.
//
// The last three are understood but not acted on. They are listed anyway so
// their values are consumed rather than landing in Rest as orphaned tokens —
// Rest is meant to hold the flags a T3 upgrade introduced, and `stream-json`
// sitting in it on its own would say nothing.
var protoValueFlags = map[string]bool{
	"--session-id":             true,
	"--resume":                 true,
	"--model":                  true,
	"--effort":                 true,
	"--permission-mode":        true,
	"--mcp-config":             true,
	"--setting-sources":        true,
	"--add-dir":                true,
	"--output-format":          true,
	"--input-format":           true,
	"--permission-prompt-tool": true,
}

// ParseArgs reduces T3's argv to a Config. Both `--flag value` and
// `--flag=value` appear in one T3 command line, so both are accepted for every
// flag.
func ParseArgs(argv []string) (Config, error) {
	cfg := Config{Argv: append([]string(nil), argv...)}
	// T3 sets cwd to the thread's workspace root, so the process's own working
	// directory is the answer — there is no flag carrying it.
	if wd, err := os.Getwd(); err == nil {
		cfg.CWD = wd
	}

	for i := 0; i < len(argv); i++ {
		name, inline, joined := strings.Cut(argv[i], "=")

		if !protoValueFlags[name] {
			switch name {
			case "--include-partial-messages":
				cfg.IncludePartialMessages = protoFlagBool(inline, joined)
			case "--allow-dangerously-skip-permissions", "--dangerously-skip-permissions":
				cfg.SkipPermissions = protoFlagBool(inline, joined)
			case "--verbose":
				// Understood: the bridge's diagnostics go to stderr regardless.
			default:
				cfg.Rest = append(cfg.Rest, argv[i])
			}
			continue
		}

		value := inline
		if !joined {
			if i+1 >= len(argv) {
				return Config{}, fmt.Errorf("%s: expected a value", name)
			}
			i++
			value = argv[i]
		}
		switch name {
		case "--session-id":
			cfg.SessionID = value
		case "--resume":
			cfg.Resume = value
		case "--model":
			cfg.Model = value
		case "--effort":
			cfg.Effort = value
		case "--permission-mode":
			cfg.PermissionMode = value
		case "--mcp-config":
			cfg.MCPConfig = value
		case "--setting-sources":
			cfg.SettingSources = value
		case "--add-dir":
			cfg.AddDirs = append(cfg.AddDirs, value)
		}
	}

	if cfg.SessionID == "" && cfg.Resume == "" {
		// Nothing identifies a conversation. This USED to be fatal, and being
		// fatal is what crash-looped T3: it spawns a provider session-lessly to
		// read its capabilities, and a provider that exits mid-handshake leaves
		// T3 writing to a closed stdin, where the unhandled EPIPE takes the
		// whole server down (wizard's instance, every six seconds, 2026-08-20
		// to 2026-08-28). Answering the handshake is both what T3 wants and
		// safer than exiting.
		cfg.Probe = true
	}
	if cfg.SessionID != "" && cfg.Resume != "" {
		log.Printf("both --session-id %s and --resume %s; treating this as a resume", cfg.SessionID, cfg.Resume)
	}
	return cfg, nil
}

// protoFlagBool reads a boolean flag written either bare (--flag) or joined
// (--flag=false). A value that will not parse counts as set: the flag being
// there at all is the stronger signal.
func protoFlagBool(inline string, joined bool) bool {
	if !joined {
		return true
	}
	v, err := strconv.ParseBool(inline)
	if err != nil {
		return true
	}
	return v
}
