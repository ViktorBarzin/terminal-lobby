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
	"sync"
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
	// AttachPoll and StatePoll are the attacher's own cadences; zero takes
	// attach.go's defaults. Only tests set them.
	AttachPoll, StatePoll time.Duration
	// Ctx bounds the one part of opening that waits: a resurrection polling for
	// @claude_transcript. Cancelling it is how a Stop pressed during those
	// seconds is answered instead of ignored. Nil means "no deadline but the
	// resurrector's own".
	Ctx context.Context
}

// protoRealDeps assembles the collaborators the downward half is built from,
// from the real environment: the process's own user, the state directory, the
// real claude.
//
// It stays a variable so run() can be tested against a side that fails.
var protoRealDeps = func() (protoSideDeps, error) {
	self, err := user.Current()
	if err != nil {
		return protoSideDeps{}, fmt.Errorf("cannot determine the current user: %w", err)
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
	return deps, nil
}

// protoOpenSide resolves the conversation to a tmux session — creating one if
// there is none — and returns the attacher bound to it.
//
// The order is the design's: attach to what is already running (one Claude, two
// windows), and only then consider starting one. A resurrection uses the name
// and cwd the index remembered, because those are exactly the two facts tmux no
// longer has once the session is gone.
//
// adopting is the conversation a warm-up turn named, "" for every other spawn.
// When it is set the bridge is opening a thread the syncer created for a
// session that never stopped running, and the uuid in T3's argv is one T3
// invented for itself — so the target is that conversation, and the invented id
// is filed as an alias pointing at it.
func protoOpenSide(cfg Config, out *Encoder, deps protoSideDeps, adopting string) (*Attacher, error) {
	resolver := NewSessionResolver(deps.OSUser, deps.Tmux, deps.Bindings)

	wanted := cfg.ClaudeID()
	if adopting != "" && adopting != wanted {
		target, live, found, err := resolver.Resolve(adopting)
		if err != nil {
			return nil, err
		}
		if !live || !found {
			return nil, fmt.Errorf(
				"warm-up names conversation %s, which is not running here: nothing to adopt", adopting)
		}
		target.AliasOf = adopting
		// The alias is what makes the SECOND spawn work. T3 keeps its invented
		// id as the thread's resume cursor for as long as no provider session
		// has reported another, so without this the next turn resolves nothing
		// and resurrects a duplicate of a live conversation.
		if deps.Bindings != nil {
			alias := target
			alias.ClaudeID = wanted
			if err := deps.Bindings.Record(alias); err != nil {
				log.Printf("adopting %s: recording the alias for %s failed: %v", adopting, wanted, err)
			}
		}
		return protoAttacher(target, out, deps), nil
	}

	target, live, found, err := resolver.Resolve(wanted)
	if err != nil {
		return nil, err
	}

	if !live {
		name, dir := target.TmuxName, target.CWD
		origin := target.Origin
		if name == "" {
			// Nothing remembers this conversation, so it is a thread born in T3.
			// The workspace root's own name is the closest thing to a title the
			// bridge is given — T3 sends the directory, never the thread's title.
			name = Slug(filepath.Base(cfg.CWD))
			origin = sessionio.OriginT3
		}
		if dir == "" {
			dir = cfg.CWD
		}
		r := &Resurrector{
			OSUser:    deps.OSUser,
			Tmux:      deps.Tmux,
			ClaudeBin: deps.Claude,
			Bindings:  deps.Bindings,
			ctx:       deps.Ctx,
			wait:      deps.Wait,
			poll:      deps.Poll,
		}
		target, err = r.Resurrect(ResurrectSpec{
			ClaudeID: wanted,
			// A conversation something already knows about is resumed; only one
			// T3 has just invented is started fresh. Resuming a uuid with no
			// transcript behind it would fail on the spot.
			Resume:    cfg.Resume != "" || found,
			TmuxName:  name,
			CWD:       dir,
			Origin:    origin,
			MCPConfig: cfg.MCPConfig,
			ExtraArgs: protoClaudeArgs(cfg),
		})
		if err != nil {
			return nil, err
		}
	}

	return protoAttacher(target, out, deps), nil
}

func protoAttacher(target Target, out *Encoder, deps protoSideDeps) *Attacher {
	return NewAttacher(target, AttacherDeps{
		OSUser:    deps.OSUser,
		Tmux:      deps.Tmux,
		Out:       out,
		Cursors:   deps.Cursors,
		Poll:      deps.AttachPoll,
		StatePoll: deps.StatePoll,
	})
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

// probing reports whether the ENVIRONMENT asked for a handshake probe. A
// session-less argv also means probe; that is carried on Config.Probe, because
// it is a property of the invocation rather than of the environment.
func probing() bool { return os.Getenv(ProbeEnv) != "" }

// run wires the bridge together and serves T3 until the pipe closes.
//
// The order is fixed by the handshake (verified fact 2): read the initialize
// control_request, answer it, THEN emit system/init — the session id in that
// init becomes the thread's resume cursor, so it must be the tmux session's
// Claude id and nothing else.
//
// Everything downward happens behind protoDeferredSide. Resolving a session
// costs a walk of tmux; bringing a dead one back costs up to 45 seconds, and
// before that work moved off this goroutine nothing read the pipe while it ran
// — an operator pressing Stop got no answer at all. The deferred side also
// covers the case the design has no other seam for: a spawn whose session id T3
// invented for a thread it created over a conversation that is already running.
// Only the warm-up turn says which conversation that is, so the bridge waits
// for the first prompt rather than guessing and starting a second Claude.
func run(ctx context.Context, cfg Config) error {
	out := NewEncoder(os.Stdout)
	loop := &protoLoop{In: NewDecoder(os.Stdin), Out: out, SessionID: cfg.ClaudeID()}

	pending, err := loop.Handshake(protoSystemInit(cfg, protoClaudeVersion()))
	if err != nil {
		return err
	}

	if cfg.Probe || probing() {
		// The caller has what it came for. Anything past this point would bind a
		// real tmux session to a conversation nobody asked about.
		log.Printf("handshake probe: answered initialize and system/init; not attaching")
		return nil
	}

	deps, err := protoRealDeps()
	if err != nil {
		return err
	}
	side := newDeferredSide(ctx, cfg, out, deps)
	defer side.Close()
	loop.Handler = side

	served := make(chan error, 1)
	go func() { served <- loop.Serve(pending) }()
	followed := make(chan error, 1)
	go func() { followed <- side.Follow(ctx) }()
	// Opening eagerly, off the reading goroutine, so a thread nobody prompts
	// still mirrors its session live. A conversation nothing on the box knows
	// about is the one case this leaves alone; see protoDeferredSide.open.
	go side.Warm()

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

// protoDeferredSide is the downward half, opened on demand.
//
// It exists for two reasons that turn out to be the same reason: the bridge
// does not always know at start-up which tmux session it is for, and finding
// out must not block the protocol.
//
//   - A spawn carrying --resume, or one whose id the index knows, can be opened
//     immediately, and Warm does that on its own goroutine.
//   - A spawn carrying a --session-id nothing on the box has heard of is
//     AMBIGUOUS. It is either a thread born in T3 (create a session) or a thread
//     the syncer created over a session that is already running (attach to it,
//     and never create anything). T3 tells the bridge neither the thread id nor
//     the conversation, so the warm-up turn is the only thing that
//     distinguishes them — and it arrives as a prompt. Guessing "born in T3"
//     was what started a second Claude for a live conversation.
type protoDeferredSide struct {
	ctx  context.Context
	cfg  Config
	out  *Encoder
	deps protoSideDeps

	// openMu serialises the open itself, so a Warm and a first prompt racing
	// cannot both resolve — and, more importantly, the loser waits for the
	// winner's answer rather than reading a half-set one.
	openMu sync.Mutex

	mu   sync.Mutex
	att  *Attacher
	err  error
	done bool
	// cancelOpen abandons an open that is waiting on a resurrection's stamp, so
	// a Stop pressed during those 45 seconds is not simply ignored.
	cancelOpen context.CancelFunc
	// cancelFollow ends the mirror on the attacher Follow is currently running,
	// so a replacement is picked up rather than ignored.
	cancelFollow context.CancelFunc

	// installs hands Follow the current attacher. Capacity one, latest wins: a
	// mirror that has not started yet should start on the newest target rather
	// than work through a queue of dead ones.
	installs chan *Attacher
}

var _ protoSide = (*protoDeferredSide)(nil)

func newDeferredSide(ctx context.Context, cfg Config, out *Encoder, deps protoSideDeps) *protoDeferredSide {
	return &protoDeferredSide{ctx: ctx, cfg: cfg, out: out, deps: deps, installs: make(chan *Attacher, 1)}
}

// Warm opens the side when the conversation can be identified without a prompt.
// A conversation nothing knows about is left for the first prompt to resolve.
func (s *protoDeferredSide) Warm() {
	if s.cfg.Resume == "" && !s.known() {
		return
	}
	if _, err := s.open(""); err != nil {
		log.Printf("opening the session for %s: %v", s.cfg.ClaudeID(), err)
	}
}

// known reports whether the durable index has ever heard of this conversation.
func (s *protoDeferredSide) known() bool {
	if s.deps.Bindings == nil {
		return false
	}
	_, ok, err := s.deps.Bindings.Lookup(s.cfg.ClaudeID())
	if err != nil {
		log.Printf("reading the binding index: %v", err)
	}
	return ok
}

// open resolves the target once and builds the attacher. Later calls return the
// same one, so an eager Warm and a first prompt cannot open two sessions.
func (s *protoDeferredSide) open(adopting string) (*Attacher, error) {
	s.openMu.Lock()
	defer s.openMu.Unlock()

	s.mu.Lock()
	if s.done {
		att, err := s.att, s.err
		s.mu.Unlock()
		return att, err
	}
	openCtx, cancel := context.WithCancel(s.ctx)
	s.cancelOpen = cancel
	s.mu.Unlock()
	defer cancel()

	deps := s.deps
	deps.Ctx = openCtx
	att, err := protoOpenSide(s.cfg, s.out, deps, adopting)

	s.mu.Lock()
	// A FAILED open does not latch. The reasons it fails are mostly transient —
	// tmux busy, session-events not up yet to stamp the transcript — and a
	// bridge that answered every later prompt with the first failure would need
	// T3 to reap it before the thread could work again.
	s.att, s.err, s.done, s.cancelOpen = att, err, err == nil, nil
	cancelFollow := s.cancelFollow
	s.mu.Unlock()

	if err != nil {
		return nil, err
	}
	// Latest wins: drop a target Follow has not picked up yet.
	select {
	case <-s.installs:
	default:
	}
	s.installs <- att
	if cancelFollow != nil {
		cancelFollow() // stop mirroring the session this one replaces
	}
	return att, nil
}

// Close abandons an open still in flight when the process is going away.
func (s *protoDeferredSide) Close() {
	s.mu.Lock()
	cancel := s.cancelOpen
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// attacher returns the open one, or nil when nothing has opened yet.
func (s *protoDeferredSide) attacher() *Attacher {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.att
}

// Send opens the side if it is not open yet, then pastes.
//
// A paste that fails because the session is GONE re-opens once and retries.
// Resurrection used to live only in the start-up path, so a session that died
// under a bridge T3 still had — and T3 does keep the process, it routes the
// next turn to it — turned every later prompt into an error in the thread with
// nothing brought back. The retry is a create, never a destroy: the "the bridge
// never destroys a session" rule is untouched.
func (s *protoDeferredSide) Send(text string) error {
	att, err := s.open(SentinelConversation(text))
	if err != nil {
		return err
	}
	sendErr := att.Send(text)
	if sendErr == nil || !s.sessionGone(att) {
		return sendErr
	}
	log.Printf("session %s is gone; bringing it back and retrying the prompt", att.Target().TmuxName)
	again, err := s.reopen()
	if err != nil {
		return fmt.Errorf("%v; and bringing the session back failed: %w", sendErr, err)
	}
	return again.Send(text)
}

// Interrupt stops the turn. With nothing open there is nothing to Ctrl-C, but
// an open in flight is abandoned — a Stop pressed while a resurrection waits
// for its stamp must not sit unanswered for 45 seconds.
func (s *protoDeferredSide) Interrupt() error {
	if att := s.attacher(); att != nil {
		return att.Interrupt()
	}
	s.Close()
	return nil
}

// Replay is part of protoSide; the deferred side replays inside Follow, as soon
// as it has a target, so this only covers a side that is already open.
func (s *protoDeferredSide) Replay(ctx context.Context) (int64, error) {
	att := s.attacher()
	if att == nil {
		return 0, nil
	}
	return att.Replay(ctx)
}

// Follow mirrors whichever session the side currently points at, and follows a
// replacement when a resurrection installs one.
func (s *protoDeferredSide) Follow(ctx context.Context) error {
	for {
		var att *Attacher
		select {
		case <-ctx.Done():
			return nil
		case att = <-s.installs:
		}

		sub, cancel := context.WithCancel(ctx)
		s.mu.Lock()
		s.cancelFollow = cancel
		s.mu.Unlock()

		// A replay that failed is a thread missing its history, not a bridge
		// that cannot work — the live tail is the half that matters.
		if _, err := att.Replay(sub); err != nil {
			log.Printf("replay: %v", err)
		}
		err := att.Follow(sub)
		cancel()

		s.mu.Lock()
		s.cancelFollow = nil
		s.mu.Unlock()

		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return nil
		}
		// sub was cancelled by an install: loop and mirror the new session.
	}
}

// sessionGone reports whether the attacher's tmux session has disappeared,
// which is the one send failure worth retrying.
func (s *protoDeferredSide) sessionGone(att *Attacher) bool {
	return !s.deps.Tmux.HasSession(s.deps.OSUser, att.Target().TmuxName)
}

// reopen resolves and resurrects again, replacing the attacher.
func (s *protoDeferredSide) reopen() (*Attacher, error) {
	s.mu.Lock()
	s.done, s.att, s.err = false, nil, nil
	s.mu.Unlock()
	return s.open("")
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
