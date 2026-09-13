package main

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// The registry is the half of a size claim the HTTP request cannot carry: which
// tmux client the caller is. These are pure units — a temp directory standing
// in for the runtime dir, and a hand-written client list standing in for tmux.

// writeRecord puts one connection's record where the resolver will look for it.
func writeRecord(t *testing.T, dir, id, tty string, pid int) {
	t.Helper()
	t.Setenv("XDG_RUNTIME_DIR", dir)
	clients := filepath.Join(dir, "terminal-lobby", "clients")
	if err := os.MkdirAll(clients, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	body := tty + "\t" + strconv.Itoa(pid) + "\n"
	if err := os.WriteFile(filepath.Join(clients, id), []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
}

const goodID = "0123456789abcdef0123456789abcdef"

// The happy path, and the one that covers every user the ttyd account is: the
// attach recorded its own pty and that pty is in the session's client list.
func TestTheRecordedTtyNamesTheCallingClient(t *testing.T) {
	writeRecord(t, t.TempDir(), goodID, "/dev/pts/7", 4242)

	clients := parseClients([]byte(
		"work\tattached,UTF-8\t1\t1\t/dev/pts/3\t900\n" +
			"work\tattached,focused,UTF-8\t1\t1\t/dev/pts/7\t4242\n"))
	if got := claimingClient(goodID, "work", clients); got != "/dev/pts/7" {
		t.Errorf("claimingClient = %q, want /dev/pts/7", got)
	}
}

// The sudo hop, which is every user the ttyd account is NOT. `Defaults use_pty`
// (/etc/sudoers:12) gives the sudo'd attach its own pty, so the tty this script
// could read is not the one the tmux client runs on. Measured on this box
// 2026-09-13: from /dev/pts/62, a sudo'd command answered /dev/pts/66. The pid
// still matches, because `exec sudo` keeps the script's pid and the client is
// its descendant.
func TestThePidFindsTheClientWhenSudoMovedThePty(t *testing.T) {
	writeRecord(t, t.TempDir(), goodID, "/dev/pts/62", 333064)

	// sudo's pty monitor sits between the recorded pid and the tmux client.
	old := parentPID
	t.Cleanup(func() { parentPID = old })
	parentPID = func(pid int) int {
		switch pid {
		case 333071:
			return 333070
		case 333070:
			return 333064
		}
		return 1
	}

	clients := parseClients([]byte(
		"work\tattached,UTF-8\t1\t1\t/dev/pts/3\t900\n" +
			"work\tattached,focused,UTF-8\t1\t1\t/dev/pts/66\t333071\n"))
	if got := claimingClient(goodID, "work", clients); got != "/dev/pts/66" {
		t.Errorf("claimingClient = %q, want /dev/pts/66 (the pid ancestry)", got)
	}
}

// A record whose client has gone resolves to nothing rather than to whoever
// holds that pty now. The script execs, so nothing ever deletes a record; the
// list-clients check is the whole of what keeps a dead one harmless.
func TestARecordNoClientHoldsResolvesToNothing(t *testing.T) {
	writeRecord(t, t.TempDir(), goodID, "/dev/pts/99", 4242)

	old := parentPID
	t.Cleanup(func() { parentPID = old })
	parentPID = func(int) int { return 1 }

	clients := parseClients([]byte("work\tattached,UTF-8\t1\t1\t/dev/pts/3\t900\n"))
	if got := claimingClient(goodID, "work", clients); got != "" {
		t.Errorf("claimingClient = %q, want \"\" for a client that is gone", got)
	}
}

// A watcher is never named, whatever it presents. A read-only client claiming
// its own size is the thing PinGrid exists to refuse, and promoting one would
// clear the ignore-size flag that makes Watch mode's promise true.
func TestAReadOnlyClientIsNeverTheClaimingClient(t *testing.T) {
	writeRecord(t, t.TempDir(), goodID, "/dev/pts/9", 4242)

	clients := parseClients([]byte(
		"work\tattached,ignore-size,read-only,UTF-8\t1\t1\t/dev/pts/9\t4242\n"))
	if got := claimingClient(goodID, "work", clients); got != "" {
		t.Errorf("claimingClient = %q, want \"\" for a read-only client", got)
	}
}

// The id is a FILE NAME, so the charset gate is also the path gate. Nothing
// that is not 32 lowercase hex characters is looked up at all.
func TestAnIdOutsideTheCharsetIsNeverLookedUp(t *testing.T) {
	dir := t.TempDir()
	writeRecord(t, dir, goodID, "/dev/pts/7", 4242)
	// A file one directory up, which a traversal would reach.
	if err := os.WriteFile(filepath.Join(dir, "escaped"), []byte("/dev/pts/7\t4242\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	clients := parseClients([]byte("work\tattached,UTF-8\t1\t1\t/dev/pts/7\t4242\n"))
	for _, bad := range []string{
		"", "../escaped", "../../escaped", "0123456789abcdef0123456789abcde",
		"0123456789abcdef0123456789abcdeff", "0123456789ABCDEF0123456789ABCDEF",
		"0123456789abcdef0123456789abcde/", "0123456789abcdef0123456789abcd..",
		"nothex89abcdef0123456789abcdefgh", ".", "..",
	} {
		if got := claimingClient(bad, "work", clients); got != "" {
			t.Errorf("claimingClient(%q) = %q, want \"\"", bad, got)
		}
	}
}

// A record whose tty is not shaped like a tty must not reach a tmux argv, and
// must not match by accident either.
func TestARecordWithAnUnshapelyTtyIsIgnored(t *testing.T) {
	writeRecord(t, t.TempDir(), goodID, "/dev/pts/7; kill-server", 0)

	clients := parseClients([]byte("work\tattached,UTF-8\t1\t1\t/dev/pts/7; kill-server\t900\n"))
	if got := claimingClient(goodID, "work", clients); got != "" {
		t.Errorf("claimingClient = %q, want \"\" for a tty that is not a tty", got)
	}
}

// No record at all is decision 7's fallback: a socket opened before this
// shipped, or a swept file. It resolves to nothing and the handler behaves as
// it did before per-client resolution existed.
func TestAMissingRecordResolvesToNothing(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	clients := parseClients([]byte("work\tattached,UTF-8\t1\t1\t/dev/pts/3\t900\n"))
	if got := claimingClient(goodID, "work", clients); got != "" {
		t.Errorf("claimingClient = %q, want \"\"", got)
	}
}

// The sweep keeps the directory from growing for the life of the box. Nothing
// deletes a record when its connection ends — the attach script execs — so the
// only chance to tidy up is a start where the live client list can be read.
func TestSweepDropsRecordsNoLiveClientHolds(t *testing.T) {
	dir := t.TempDir()
	writeRecord(t, dir, goodID, "/dev/pts/7", 4242)
	const deadID = "ffffffffffffffffffffffffffffffff"
	writeRecord(t, dir, deadID, "/dev/pts/99", 5555)
	// Something that is not a record at all, left by nobody: not ours to
	// delete, since the name cannot be one this service wrote.
	stray := filepath.Join(dir, "terminal-lobby", "clients", "README")
	if err := os.WriteFile(stray, nil, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	oldClients, oldParent := allClients, parentPID
	t.Cleanup(func() { allClients, parentPID = oldClients, oldParent })
	parentPID = func(int) int { return 1 }
	allClients = func(osUser string) ([]client, bool) {
		return parseClients([]byte("work\tattached,UTF-8\t1\t1\t/dev/pts/7\t4242\n")), true
	}

	if got := sweepClientRegistry([]string{"wizard"}); got != 1 {
		t.Errorf("swept %d record(s), want 1", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "terminal-lobby", "clients", goodID)); err != nil {
		t.Errorf("the live client's record was swept: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "terminal-lobby", "clients", deadID)); err == nil {
		t.Error("the dead client's record survived the sweep")
	}
	if _, err := os.Stat(stray); err != nil {
		t.Errorf("the sweep deleted a file it did not write: %v", err)
	}
}

// A tmux it cannot read is not evidence that nobody is attached. Deleting every
// record because one fork failed would turn a tmux hiccup into a box-wide loss
// of per-client resolution, and the records are cheap.
func TestSweepKeepsEverythingWhenAClientListCannotBeRead(t *testing.T) {
	dir := t.TempDir()
	writeRecord(t, dir, goodID, "/dev/pts/7", 4242)

	oldClients := allClients
	t.Cleanup(func() { allClients = oldClients })
	allClients = func(string) ([]client, bool) { return nil, false }

	if got := sweepClientRegistry([]string{"wizard"}); got != 0 {
		t.Errorf("swept %d record(s), want 0", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "terminal-lobby", "clients", goodID)); err != nil {
		t.Errorf("a record was swept on an unreadable client list: %v", err)
	}
}

// The reader and the writer have to agree on one directory. tmux-attach.sh
// (the writer) and this service (the reader) run as the same account, so it is
// the SERVICE's runtime dir, never the session owner's — another user's
// /run/user/<uid> is 0700 and this process is not them.
func TestTheRegistryDirIsTheServicesOwnRuntimeDir(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "/run/terminal-lobby")
	if got, want := clientRegistryDir(), "/run/terminal-lobby/terminal-lobby/clients"; got != want {
		t.Errorf("clientRegistryDir = %q, want %q", got, want)
	}
	// No XDG_RUNTIME_DIR is the devvm: a system unit gets none, and the
	// fallback has to land on this process's own uid.
	t.Setenv("XDG_RUNTIME_DIR", "")
	if got := clientRegistryDir(); got != "/run/user/"+strconv.Itoa(os.Getuid())+"/terminal-lobby/clients" {
		t.Errorf("clientRegistryDir = %q, want the service's own /run/user tree", got)
	}
}

// The pid walk against the real /proc: this process is a descendant of its own
// parent, and is not a descendant of pid 1's parent (there is none).
func TestDescendantOfReadsTheRealProcessTree(t *testing.T) {
	self := os.Getpid()
	if !descendantOf(self, self) {
		t.Error("a pid is not its own ancestor, so an unsudoed attach would never match")
	}
	if parent := os.Getppid(); !descendantOf(parent, self) {
		t.Errorf("pid %d is not seen as a descendant of its parent %d", self, parent)
	}
	if descendantOf(self, 1) {
		t.Error("pid 1 came back as a descendant of this test")
	}
	if descendantOf(0, self) || descendantOf(self, 0) {
		t.Error("a zero pid matched something")
	}
}

// A watcher's record belongs to a live connection. It may never claim — the
// lookup refuses it — but sweeping it would delete a file the writer cannot
// write again without reconnecting.
func TestSweepKeepsAWatchersRecord(t *testing.T) {
	dir := t.TempDir()
	writeRecord(t, dir, goodID, "/dev/pts/9", 4242)

	oldClients, oldParent := allClients, parentPID
	t.Cleanup(func() { allClients, parentPID = oldClients, oldParent })
	parentPID = func(int) int { return 1 }
	allClients = func(string) ([]client, bool) {
		return parseClients([]byte(
			"work\tattached,ignore-size,read-only,UTF-8\t1\t1\t/dev/pts/9\t4242\n")), true
	}

	if got := sweepClientRegistry([]string{"wizard"}); got != 0 {
		t.Errorf("swept %d record(s), want 0", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "terminal-lobby", "clients", goodID)); err != nil {
		t.Errorf("a live watcher's record was swept: %v", err)
	}
}

// A record that resolves to a client sitting on ANOTHER session is never named.
// `switch-client -c X -t =work:` moves X onto work (measured on tmux 3.4,
// 2026-09-13), so naming a client that is somewhere else would drag a person's
// terminal to a session they never opened. The caller's fork is already scoped
// to the session; this is the same check made a second time, where the cost of
// being wrong is highest.
func TestAClientOnAnotherSessionIsNeverTheClaimingClient(t *testing.T) {
	writeRecord(t, t.TempDir(), goodID, "/dev/pts/11", 4242)

	clients := parseClients([]byte("elsewhere\tattached,focused,UTF-8\t1\t1\t/dev/pts/11\t4242\n"))
	if got := claimingClient(goodID, "work", clients); got != "" {
		t.Errorf("claimingClient = %q, want \"\" for a client attached elsewhere", got)
	}
	// The same client, claiming its own session, is fine.
	if got := claimingClient(goodID, "elsewhere", clients); got != "/dev/pts/11" {
		t.Errorf("claimingClient = %q, want /dev/pts/11 on its own session", got)
	}
}
