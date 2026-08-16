// Command tl-t3-sync keeps one user's T3 threads in step with their tmux
// sessions.
//
// It runs as that user (unit tl-t3-sync@<user>), holds only its own T3 bearer —
// minted in memory, never written to disk — and talks to t3-serve over the
// documented HTTP dispatch API. It adopts new sessions, follows renames, and
// carries deliberate destruction across in both directions
// (docs/plans/2026-08-15-t3-code-bridge-design.md).
//
// What it is NOT: it never puts content into a thread. Only a process T3 spawns
// can do that (verified fact 7 — thread.activity.append is not dispatchable),
// which is exactly why adoption ends with a warm-up turn that makes T3 spawn
// the bridge.
//
// This file is flags, wiring and the loop. Reconciliation is reconcile.go,
// adoption adopt.go, the HTTP client t3client.go, the provider-instance merge
// settings.go, and the bearer bearer.go.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"terminal-lobby/sessionio"
)

// Defaults for the paths and values the unit does not pass. Every one of them
// is where the deploy script puts things (t3-bridge/DEPLOY.md).
const (
	defaultBridgePath = "/usr/local/bin/tl-t3-bridge"
	// defaultModel is what a thread is stamped with when the session's own
	// transcript does not say. T3 requires a model on thread.create and the
	// bridge cannot change the pane's; this is the fallback, not a choice made
	// on the operator's behalf (see adoptModel).
	defaultModel = "claude-opus-5"
	// defaultRuntimeMode is T3's own DEFAULT_RUNTIME_MODE. A bridged session's
	// permissions are whatever the pane's claude was started with — the bridge
	// cannot change them — so this is the value that stops T3 from expecting
	// approvals it will never be asked for.
	defaultRuntimeMode = "full-access"
	// defaultInteractionMode is T3's own DEFAULT_PROVIDER_INTERACTION_MODE. The
	// only other value is "plan".
	defaultInteractionMode = "default"
	// homeBase is where user home directories live on this box; it is a
	// constant only so sessionio.ProjectsRoot has something to join.
	homeBase = "/home"
)

func main() {
	log.SetFlags(0)
	log.SetPrefix("tl-t3-sync: ")

	baseDir := flag.String("base-dir", "", "t3 base dir (default: the user's own ~/.t3)")
	endpoint := flag.String("endpoint", "http://127.0.0.1:3773", "t3-serve base URL")
	interval := flag.Duration("interval", 5*time.Second, "snapshot poll interval")
	ttl := flag.Duration("bearer-ttl", 24*time.Hour, "lifetime of a minted bearer")
	dryRun := flag.Bool("dry-run", false, "log what would change; dispatch nothing")
	mergeSettings := flag.Bool("merge-settings", true, "keep the provider instances in settings.json current")
	ignore := flag.String("ignore", "", "comma-separated session-name prefixes to skip; empty = the default list, \"none\" = skip nothing")
	notifyAddr := flag.String("notify-addr", DefaultNotifyListen(), "where to listen for lobby kill notices; empty = do not listen")
	bridge := flag.String("bridge", defaultBridgePath, "path to tl-t3-bridge")
	claudeBin := flag.String("claude", "", "path to the real claude (default: the first on PATH)")
	model := flag.String("model", defaultModel, "model recorded on threads this syncer creates")
	runtimeMode := flag.String("runtime-mode", defaultRuntimeMode, "T3 runtime mode for threads this syncer creates")
	interactionMode := flag.String("interaction-mode", defaultInteractionMode, "T3 interaction mode for turns this syncer starts (default|plan)")
	tmuxAPI := flag.String("tmux-api", defaultTmuxAPIEndpoint, "tmux-api base URL, used to kill a session whose thread was deleted")
	flag.Parse()

	self, err := user.Current()
	if err != nil {
		log.Fatalf("cannot determine current user: %v", err)
	}
	if *baseDir == "" {
		*baseDir = defaultBaseDir(self.HomeDir)
	}
	if *claudeBin == "" {
		*claudeBin = findClaude()
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cfg := Config{
		OSUser:          self.Username,
		HomeDir:         self.HomeDir,
		BaseDir:         *baseDir,
		Endpoint:        *endpoint,
		Interval:        *interval,
		BearerTTL:       *ttl,
		DryRun:          *dryRun,
		MergeSettings:   *mergeSettings,
		IgnorePrefixes:  ParseIgnore(*ignore),
		NotifyAddr:      *notifyAddr,
		BridgePath:      *bridge,
		ClaudePath:      *claudeBin,
		Model:           *model,
		RuntimeMode:     *runtimeMode,
		InteractionMode: *interactionMode,
		TmuxAPI:         *tmuxAPI,
		ProjectsRoot:    sessionio.ProjectsRoot(homeBase, self.Username),
	}
	if err := run(ctx, cfg); err != nil {
		log.Printf("%v", err)
		os.Exit(1)
	}
}

// Config is one syncer's whole configuration.
type Config struct {
	// OSUser is who this syncer speaks for. It only ever touches that user's
	// sessions and that user's T3 — identity follows the uid, and crossing it
	// is a deliberate later design (decision 13).
	OSUser  string
	HomeDir string
	// BaseDir is the t3 state directory the bearer is minted against.
	BaseDir string
	// Endpoint is the user's own t3-serve.
	Endpoint  string
	Interval  time.Duration
	BearerTTL time.Duration
	// DryRun logs every intended dispatch and sends none. The first run against
	// a user with live threads should always be a dry run.
	DryRun bool
	// MergeSettings keeps providerInstances current (see settings.go).
	MergeSettings bool
	// IgnorePrefixes are session names that are machine-made and not worth a
	// thread: QA harness sessions and agent worktrees (decision 4).
	IgnorePrefixes []string
	// NotifyAddr is where the kill-notify listener binds; "" means do not
	// listen, and then a lobby kill never crosses (CONTRACT.md §8).
	NotifyAddr string
	// BridgePath is tl-t3-bridge: what settings.json points the default
	// provider instance at, and what the handshake self-test exercises.
	BridgePath string
	// ClaudePath is the real claude, which the claudeStock escape-hatch
	// instance points at (decision 5).
	ClaudePath string
	// Model and RuntimeMode are stamped on threads this syncer creates. Model
	// is a FALLBACK: the syncer reads the model out of the session's own
	// transcript where it can, because stamping one value on every thread makes
	// a Sonnet session read as an Opus one in T3's list and route on that.
	Model       string
	RuntimeMode string
	// InteractionMode is T3's default/plan switch. thread.turn.start declares it
	// required over HTTP, with no decoding default, so it is sent on every turn.
	InteractionMode string
	// TmuxAPI is the lobby's own API, which owns every mutation of a session.
	TmuxAPI string
	// ProjectsRoot is this user's ~/.claude/projects, the only place a
	// transcript this syncer will read may live.
	ProjectsRoot string
}

// DefaultIgnorePrefixes is the ignore list from decision 4 — every live-Claude
// session is mirrored automatically EXCEPT the ones a machine made for itself.
var DefaultIgnorePrefixes = []string{"qa-", "t3e2e-", "tlp-t"}

// IgnoreNone is the literal that turns the ignore list off.
//
// It exists because the unit ALWAYS passes -ignore, and systemd expands an
// unset variable to an empty argument: empty therefore has to mean "the
// default list" (a half-filled env file must not silently start mirroring the
// QA harness's sessions), which leaves no way to say "mirror everything"
// without a word for it.
const IgnoreNone = "none"

// ParseIgnore turns the -ignore flag into the prefix list.
func ParseIgnore(csv string) []string {
	trimmed := strings.TrimSpace(csv)
	if trimmed == "" {
		return DefaultIgnorePrefixes
	}
	if trimmed == IgnoreNone {
		return nil
	}
	var out []string
	for _, part := range strings.Split(trimmed, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return DefaultIgnorePrefixes
	}
	return out
}

// run mints a bearer, self-tests the handshake, then reconciles on a ticker
// until ctx is cancelled.
//
// The self-test is not optional decoration. The bridge implements a subset of a
// protocol we do not own, under a T3 that upgrades nightly, and the design's
// stated mitigation is that the syncer verifies the handshake at start and
// reports failure rather than degrading quietly. Failing here is what makes the
// unit's restart loop visible in the journal instead of leaving every thread
// mysteriously silent.
func run(ctx context.Context, cfg Config) error {
	if err := cfg.check(); err != nil {
		return err
	}

	tmux := sessionio.NewInjector(cfg.OSUser)
	indexPath, err := sessionio.DefaultIndexPath()
	if err != nil {
		return fmt.Errorf("binding index: %w", err)
	}
	bindings := sessionio.NewIndex(indexPath)
	bearer := NewBearer(cfg.BaseDir, cfg.BearerTTL)
	client := NewClient(cfg.Endpoint, bearer)
	client.BridgePath = cfg.BridgePath
	notices := NewKillNotices(cfg.OSUser)

	adopter := &Adopter{Cfg: cfg, Client: client, Tmux: tmux, Bindings: bindings}
	reconciler := &Reconciler{
		Cfg:      cfg,
		Client:   client,
		Adopter:  adopter,
		Tmux:     tmux,
		Lobby:    NewTmuxAPI(cfg.TmuxAPI, lobbyAuthUser(cfg.OSUser)),
		Bindings: bindings,
		Notices:  notices,
	}

	if cfg.MergeSettings {
		merge := SettingsMerge{
			Path:       SettingsPath(cfg.BaseDir),
			BridgePath: cfg.BridgePath,
			ClaudePath: cfg.ClaudePath,
		}
		changed, err := merge.Apply()
		if err != nil {
			return fmt.Errorf("provider instances: %w", err)
		}
		if changed {
			log.Printf("settings.json: provider instances updated (%s → %s)", InstanceBridged, cfg.BridgePath)
		}
	}

	t3Version := T3Version(ctx)
	if err := client.SelfTest(ctx); err != nil {
		return fmt.Errorf("%w — threads would stall; switch them to %s while this is fixed",
			selfTestError(err), InstanceStock)
	}
	log.Printf("handshake self-test passed against t3 %s", versionOrUnknown(t3Version))

	if cfg.NotifyAddr != "" {
		stopNotify, err := serveNotices(cfg.NotifyAddr, notices)
		if err != nil {
			return err
		}
		defer stopNotify()
	}

	if cfg.DryRun {
		log.Printf("dry run: every pass is logged and nothing is dispatched")
	}
	log.Printf("reconciling %s every %s against %s", cfg.OSUser, cfg.Interval, cfg.Endpoint)

	ticker := time.NewTicker(cfg.Interval)
	defer ticker.Stop()
	versionCheck := time.NewTicker(versionCheckInterval)
	defer versionCheck.Stop()
	for {
		select {
		case <-versionCheck.C:
			// t3 upgrades nightly under a syncer that may have been up for days,
			// and the handshake is the thing an upgrade can quietly change. A
			// re-test on the version moving is the second half of the design's
			// drift mitigation; without it the failure is silent on both sides.
			if next := T3Version(ctx); next != t3Version && next != "" {
				log.Printf("t3 changed from %s to %s; re-running the handshake self-test",
					versionOrUnknown(t3Version), next)
				t3Version = next
				if err := client.SelfTest(ctx); err != nil {
					log.Printf("%v — every bridged thread will stall; switch them to %s while this is fixed",
						selfTestError(err), InstanceStock)
				} else {
					log.Printf("handshake self-test still passes against t3 %s", next)
				}
			}
		default:
		}

		if err := reconcileOnce(ctx, reconciler, client); err != nil && !errors.Is(err, context.Canceled) {
			// One bad pass is not a bad syncer: t3-serve restarts, the box gets
			// busy, a dispatch races another writer. The next tick retries.
			log.Printf("pass: %v", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

// versionCheckInterval is how often the t3 build is re-read. Minutes, because
// the thing it watches for is a nightly package upgrade and the check costs a
// subprocess.
const versionCheckInterval = 5 * time.Minute

// selfTestError wraps a failed handshake probe in the words an operator needs.
func selfTestError(err error) error { return fmt.Errorf("handshake self-test: %w", err) }

// versionOrUnknown keeps a log line legible when `t3 --version` said nothing.
func versionOrUnknown(v string) string {
	if v == "" {
		return "(version unknown)"
	}
	return v
}

// reconcileOnce is one pass: read T3, work out the difference, close it.
func reconcileOnce(ctx context.Context, r *Reconciler, client *Client) error {
	snap, err := client.Snapshot(ctx)
	if err != nil {
		return err
	}
	plan, err := r.Plan(ctx, snap)
	if err != nil {
		return err
	}
	if plan.Empty() {
		return nil
	}
	return r.Apply(ctx, plan)
}

// serveNotices starts the kill-notify listener and returns a stop function.
//
// The listener is the ONLY evidence a session's disappearance was deliberate
// (CONTRACT.md §8), so a failure to bind is fatal rather than logged: a syncer
// that silently never hears about kills looks healthy and is not.
func serveNotices(addr string, notices *KillNotices) (func(), error) {
	ln, err := ListenSpec(addr)
	if err != nil {
		return nil, fmt.Errorf("kill-notify listener: %w", err)
	}
	srv := &http.Server{
		Handler: notices.Handler(),
		// The notice is one small POST from loopback. Anything slower than this
		// is not a notice.
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("kill-notify listener: %v", err)
		}
	}()
	log.Printf("kill-notify listening on %s%s", ln.Addr(), NotifyKilledPath)
	return func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}, nil
}

// check rejects a configuration that would run on values nobody chose.
//
// systemd expands an unset variable to an EMPTY ARGUMENT rather than dropping
// it, so a half-filled env file reaches the binary as `-interval ""` and Go's
// flag package turns that into a parse error — but `-base-dir ""` and
// `-endpoint ""` parse fine and would send this syncer somewhere meaningless.
// Failing at start is what makes that visible in the journal.
func (c Config) check() error {
	switch {
	case c.OSUser == "":
		return errors.New("no OS user: the syncer takes its identity from user.Current and found nothing")
	case c.BaseDir == "":
		return errors.New("-base-dir is empty: is T3_BASE_DIR set in the unit's environment file?")
	case c.Endpoint == "":
		return errors.New("-endpoint is empty: is T3_PORT set in the unit's environment file?")
	case c.Interval <= 0:
		return fmt.Errorf("-interval %s: must be positive", c.Interval)
	case c.BridgePath == "":
		return errors.New("-bridge is empty: there is nothing to point the provider instance at")
	case c.ProjectsRoot == "":
		return errors.New("no projects root: nothing would ever qualify as a candidate")
	}
	return nil
}

// SettingsPath is where T3 keeps a base dir's settings.
//
// T3's own deriveServerPaths joins "userdata" under the base dir, so the file
// this merges is <base-dir>/userdata/settings.json and never ~/.t3/settings.json.
func SettingsPath(baseDir string) string {
	return filepath.Join(baseDir, "userdata", "settings.json")
}

// defaultBaseDir is the user's own t3 state directory.
//
// A syncer must only ever be pointed at ITS OWN user's base dir. Another user's
// ~/.t3 is their live state; the design's identity boundary is the uid and this
// is where it is enforced in practice.
func defaultBaseDir(homeDir string) string { return homeDir + "/.t3" }

// findClaude locates the real claude for the claudeStock instance.
//
// PATH first, then the home install, matching the bridge's own search. An empty
// answer is workable: the merge simply leaves claudeStock's binaryPath unset and
// says so, rather than writing a path that does not exist.
func findClaude() string {
	if path, err := exec.LookPath("claude"); err == nil {
		return path
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidate := filepath.Join(home, ".local", "bin", "claude")
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	log.Printf("no claude binary found: the %s escape hatch will have no binaryPath", InstanceStock)
	return ""
}

// lobbyAuthUser is the identity tmux-api sees.
//
// tmux-api authenticates by the Authentik username the reverse proxy hands it,
// and maps that to an OS user through /etc/ttyd-user-map. The syncer is behind
// no proxy, so it presents the mapped name itself; an unmapped OS user falls
// back to its own name, which is what tmux-api assumes when the map has no
// entry.
func lobbyAuthUser(osUser string) string {
	if authUser, ok := AuthUserForOSUser(DefaultUserMapPath, osUser); ok {
		return authUser
	}
	return osUser
}
