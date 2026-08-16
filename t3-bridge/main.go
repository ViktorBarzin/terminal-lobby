// Command tl-t3-bridge is the binary T3 Code spawns in place of `claude`.
//
// Upward it speaks the Agent SDK's stream-json protocol over stdio; downward it
// attaches to a tmux session — pasting prompts in, tailing the transcript out.
// It starts no Claude of its own unless the session does not exist, in which
// case it resurrects one (docs/plans/2026-08-15-t3-code-bridge-design.md).
//
// T3 spawns it with the thread's workspace root as cwd and an argv of the shape
// (measured against t3 v0.0.34-nightly.20260815.1098):
//
//	--output-format stream-json --input-format stream-json --verbose
//	[--model M] [--effort E] [--permission-prompt-tool stdio]
//	[--mcp-config <json>] --setting-sources=user,project,local
//	[--permission-mode bypassPermissions] [--allow-dangerously-skip-permissions]
//	[--include-partial-messages] [--add-dir D]...
//	( --session-id <uuid> | --resume <uuid> )
//
// This file is argv triage and wiring only. The protocol is protocol.go, the
// tmux attachment attach.go, session recreation resurrect.go, and the durable
// binding index.go.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"terminal-lobby/sessionio"
)

func main() {
	log.SetFlags(0)
	log.SetPrefix("tl-t3-bridge: ")
	// stdout is the protocol; every diagnostic goes to stderr, which T3 keeps
	// out of the thread.
	log.SetOutput(os.Stderr)

	argv := os.Args[1:]

	// T3 probes provider health with `<binary> --version` and parses the
	// output, and runs `<binary> auth ...` for sign-in (verified fact 3). The
	// bridge has no opinion on either: it hands them to the real claude so the
	// answers stay true as claude changes.
	if delegatesToClaude(argv) {
		os.Exit(execClaude(argv))
	}

	cfg, err := ParseArgs(argv)
	if err != nil {
		log.Fatalf("argv: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, cfg); err != nil {
		log.Fatalf("%v", err)
	}
}

// protoSide is the downward half of the bridge — the tmux session — as run
// needs it. *Attacher satisfies it.
type protoSide interface {
	protoHandler
	Replay(ctx context.Context) (int64, error)
	Follow(ctx context.Context) error
}

// protoSideDeps are the collaborators the downward half is built from. They are
// a struct rather than globals so the whole resolve → resurrect → attach path
// can be exercised against a fake tmux and a temp state directory, with no
// tmux server, no claude and no T3 anywhere near the test.
type protoSideDeps struct {
	// OSUser owns the session. t3-serve@%i runs User=%i, so the bridge always
	// runs as them and this is the process's own user.
	OSUser string
	Tmux   TmuxDriver
	// Bindings is the durable index. A nil index is workable — resolution then
	// sees only live sessions — which is why an unopenable one does not stop a
	// thread from attaching.
	Bindings *Bindings
	// Cursors is where replay positions are kept; nil takes the per-user default.
	Cursors *CursorStore
	// Claude is the real binary a resurrected session runs.
	Claude string
	// Wait and Poll bound the wait for @claude_transcript after a resurrection.
	// Zero takes resurrect.go's defaults.
	Wait, Poll time.Duration
}

// protoTmuxSide builds the downward half for this invocation: resolve the
// Claude session uuid to a live tmux session, or bring one back.
//
// It stays a variable so run() can be tested against a side that fails, and so
// the environment lookups below — the process's own user, the state directory,
// the real claude — happen once, here, rather than inside the logic they feed.
var protoTmuxSide = func(ctx context.Context, cfg Config, out *Encoder) (protoSide, error) {
	self, err := user.Current()
	if err != nil {
		return nil, fmt.Errorf("cannot determine the current user: %w", err)
	}
	deps := protoSideDeps{
		OSUser: self.Username,
		Tmux:   sessionio.NewInjector(self.Username),
	}
	// A missing index costs resurrection, not attachment: a live session is
	// still found by walking tmux. Both failures are worth a line and neither
	// is worth failing the thread over.
	bindings, err := OpenBindings()
	if err != nil {
		log.Printf("no binding index (%v): a session that has died cannot be brought back", err)
	} else {
		deps.Bindings = bindings
	}
	if claude, err := RealClaudePath(); err != nil {
		log.Printf("no claude binary (%v): a session that has died cannot be brought back", err)
	} else {
		deps.Claude = claude
	}
	return protoOpenSide(cfg, out, deps)
}

// protoOpenSide resolves the conversation to a tmux session — creating one if
// there is none — and returns the attacher bound to it.
//
// The order is the design's: attach to what is already running (one Claude, two
// windows), and only then consider starting one. A resurrection uses the name
// and cwd the index remembered, because those are exactly the two facts tmux no
// longer has once the session is gone.
func protoOpenSide(cfg Config, out *Encoder, deps protoSideDeps) (protoSide, error) {
	resolver := NewSessionResolver(deps.OSUser, deps.Tmux, deps.Bindings)
	target, live, found, err := resolver.Resolve(cfg.ClaudeID())
	if err != nil {
		return nil, err
	}

	if !live {
		name, dir := target.TmuxName, target.CWD
		if name == "" {
			// Nothing remembers this conversation, so it is a thread born in T3.
			// The workspace root's own name is the closest thing to a title the
			// bridge is given — T3 sends the directory, never the thread's title.
			name = Slug(filepath.Base(cfg.CWD))
		}
		if dir == "" {
			dir = cfg.CWD
		}
		r := &Resurrector{
			OSUser:    deps.OSUser,
			Tmux:      deps.Tmux,
			ClaudeBin: deps.Claude,
			Bindings:  deps.Bindings,
			wait:      deps.Wait,
			poll:      deps.Poll,
		}
		target, err = r.Resurrect(ResurrectSpec{
			ClaudeID: cfg.ClaudeID(),
			// A conversation something already knows about is resumed; only one
			// T3 has just invented is started fresh. Resuming a uuid with no
			// transcript behind it would fail on the spot.
			Resume:    cfg.Resume != "" || found,
			TmuxName:  name,
			CWD:       dir,
			MCPConfig: cfg.MCPConfig,
			ExtraArgs: protoClaudeArgs(cfg),
		})
		if err != nil {
			return nil, err
		}
	}

	return NewAttacher(target, AttacherDeps{
		OSUser:  deps.OSUser,
		Tmux:    deps.Tmux,
		Out:     out,
		Cursors: deps.Cursors,
	}), nil
}

// protoClaudeArgs are the flags from T3's argv that a session the bridge
// launches should carry.
//
// Only the ones claude 2.1.233 declares are passed on. An unknown flag is not a
// harmless extra here: claude exits on it, and the session would come up empty
// and die — so Config.Rest, which is exactly the flags a T3 upgrade introduced,
// is deliberately not forwarded.
func protoClaudeArgs(cfg Config) []string {
	var args []string
	if cfg.Model != "" {
		args = append(args, "--model", cfg.Model)
	}
	if cfg.Effort != "" {
		args = append(args, "--effort", cfg.Effort)
	}
	if cfg.PermissionMode != "" {
		args = append(args, "--permission-mode", cfg.PermissionMode)
	}
	if cfg.SkipPermissions {
		args = append(args, "--dangerously-skip-permissions")
	}
	for _, dir := range cfg.AddDirs {
		args = append(args, "--add-dir", dir)
	}
	return args
}

// ProbeEnv makes this invocation a HANDSHAKE PROBE: answer initialize, emit
// system/init, exit. Nothing touches tmux.
//
// The syncer runs one at start and after any t3 version change, because the
// bridge implements a subset of a protocol we do not own under software that
// upgrades nightly (Client.SelfTest). Without a mode of its own that probe is
// an ordinary spawn with a session id T3 never issued, and the bridge would do
// what it does for any unknown conversation: create a tmux session and start a
// claude in it. One stray session per syncer restart, on a box where memory is
// the binding constraint.
//
// An environment variable rather than a flag, so the probe's argv stays exactly
// the argv T3 uses — which is the thing being tested.
const ProbeEnv = "TL_T3_BRIDGE_PROBE"

// probing reports whether this is a handshake probe.
func probing() bool { return os.Getenv(ProbeEnv) != "" }

// run wires the bridge together and serves T3 until the pipe closes.
//
// The order is fixed by the handshake (verified fact 2): read the initialize
// control_request, answer it, THEN emit system/init — the session id in that
// init becomes the thread's resume cursor, so it must be the tmux session's
// Claude id and nothing else. Resolving that session comes after, because T3
// holds a timeout on the initialize reply and bringing a dead session back can
// take seconds.
func run(ctx context.Context, cfg Config) error {
	out := NewEncoder(os.Stdout)
	loop := &protoLoop{In: NewDecoder(os.Stdin), Out: out, SessionID: cfg.ClaudeID()}

	pending, err := loop.Handshake(protoSystemInit(cfg, protoClaudeVersion()))
	if err != nil {
		return err
	}

	if probing() {
		// The caller has what it came for. Anything past this point would bind a
		// real tmux session to a conversation nobody asked about.
		log.Printf("handshake probe: answered initialize and system/init; not attaching")
		return nil
	}

	side, err := protoTmuxSide(ctx, cfg, out)
	if err != nil {
		// T3 is waiting on the turn that spawned us. Saying so in the thread is
		// worth more than the same line in the journal, where nobody is looking.
		if emitErr := out.Emit(protoResultError(cfg.ClaudeID(), err.Error())); emitErr != nil {
			log.Printf("could not report %q to t3: %v", err, emitErr)
		}
		return err
	}
	loop.Handler = side

	// A replay that failed is a thread missing its history, not a bridge that
	// cannot work — the live tail is the half that matters.
	if _, err := side.Replay(ctx); err != nil {
		log.Printf("replay: %v", err)
	}

	served := make(chan error, 1)
	go func() { served <- loop.Serve(pending) }()
	followed := make(chan error, 1)
	go func() { followed <- side.Follow(ctx) }()

	// Neither goroutine can observe ctx while blocked on a read, so this select
	// is what actually ends the process; the reads die with it.
	for {
		select {
		case err := <-served:
			return err
		case err := <-followed:
			// The mirror stopping is not the bridge stopping: prompts still
			// reach the pane, and the thread catches up on next touch.
			if err != nil && !errors.Is(err, context.Canceled) {
				log.Printf("follow: %v", err)
			}
			followed = nil
		case <-ctx.Done():
			return nil
		}
	}
}

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
		return Config{}, fmt.Errorf("no --session-id and no --resume: nothing identifies the conversation (argv %q)", argv)
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

// delegatesToClaude reports whether this invocation is one the bridge must hand
// to the real claude binary untouched: the `--version` health probe and the
// `auth` subcommands (verified fact 3).
//
// `auth` counts only in the LEADING position. Matching it anywhere would let a
// flag value — `--model auth` — divert a whole stream-json spawn to claude,
// which would then start a second Claude on a box that is already OOM-tight.
func delegatesToClaude(argv []string) bool {
	if len(argv) > 0 && argv[0] == "auth" {
		return true
	}
	for _, a := range argv {
		if a == "--version" || a == "-v" {
			return true
		}
	}
	return false
}

// execClaude runs the real claude with this argv and returns its exit code,
// passing stdio straight through.
//
// A claude that ran and failed reports its own code. Anything else — no such
// binary, not executable — is 127, the shell's "could not run it at all", so
// T3's provider health probe reads a missing claude as a missing claude rather
// than as a claude that failed.
func execClaude(argv []string) int {
	bin, err := RealClaudePath()
	if err != nil {
		log.Printf("cannot locate the real claude binary: %v", err)
		return 127
	}
	cmd := exec.Command(bin, argv...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode()
		}
		log.Printf("claude %v: %v", argv, err)
		return 127
	}
	return 0
}

// RealClaudePath locates the genuine claude binary.
//
// TL_REAL_CLAUDE names it outright — that is what the deployment sets, and how
// a test points this at a stub. TL_T3_BRIDGE_CLAUDE is accepted as the same
// thing under CONTRACT.md's spelling. Neither is trusted blindly: a unit file
// that pointed either at the bridge would fork-bomb the box, so an environment
// naming this binary is ignored rather than obeyed.
func RealClaudePath() (string, error) {
	self, err := os.Executable()
	if err != nil {
		// The search still runs, but without knowing our own path the
		// recursion guard cannot fire — worth a line in the journal.
		log.Printf("cannot determine this binary's own path: %v", err)
	}
	for _, name := range []string{"TL_REAL_CLAUDE", "TL_T3_BRIDGE_CLAUDE"} {
		p := os.Getenv(name)
		if p == "" {
			continue
		}
		if protoSameBinary(p, self) {
			log.Printf("%s=%s is this binary; ignoring it rather than recursing", name, p)
			continue
		}
		return p, nil
	}
	home := ""
	if u, err := user.Current(); err == nil {
		home = u.HomeDir
	}
	return protoClaudeOnPath(os.Getenv("PATH"), self, home)
}

// protoClaudeOnPath finds a claude that is not `self`, then falls back to the
// home install.
//
// The guard is the point of this function. T3's provider instance points at the
// bridge, so a deployment that installs the bridge under the name `claude`
// anywhere on PATH would have the bridge find ITSELF: every --version probe
// would fork a bridge, which would fork a bridge, until the box fell over.
// Identity is device+inode (os.SameFile), because the shape this takes in
// practice is a symlink or a hard link, and neither is caught by comparing
// path strings.
//
// ~/.local/bin/claude is last rather than first: it is where claude installs
// itself on this box, but a systemd unit's PATH is not a login shell's, so the
// explicit PATH scan gets the first say.
func protoClaudeOnPath(pathList, self, home string) (string, error) {
	var shims []string
	consider := func(candidate string) (string, bool) {
		if !protoExecutable(candidate) {
			return "", false
		}
		if protoSameBinary(candidate, self) {
			shims = append(shims, candidate)
			return "", false
		}
		return candidate, true
	}

	for _, dir := range filepath.SplitList(pathList) {
		if dir == "" {
			dir = "." // POSIX: an empty PATH element means the working directory
		}
		if found, ok := consider(filepath.Join(dir, "claude")); ok {
			return found, nil
		}
	}
	if home != "" {
		if found, ok := consider(filepath.Join(home, ".local", "bin", "claude")); ok {
			return found, nil
		}
	}

	if len(shims) > 0 {
		return "", fmt.Errorf("every claude found is this binary (%s); running it would recurse", strings.Join(shims, ", "))
	}
	return "", fmt.Errorf("no claude on PATH and none at ~/.local/bin/claude")
}

// protoExecutable reports whether path is a file anyone can execute. os.Stat
// follows symlinks deliberately: a PATH shim is judged by what it points at.
func protoExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return info.Mode().Perm()&0o111 != 0
}

// protoSameBinary reports whether two paths are the same file on disk.
func protoSameBinary(a, b string) bool {
	if b == "" {
		return false
	}
	ai, err := os.Stat(a)
	if err != nil {
		return false
	}
	bi, err := os.Stat(b)
	if err != nil {
		return false
	}
	return os.SameFile(ai, bi)
}
