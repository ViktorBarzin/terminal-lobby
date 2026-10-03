package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"terminal-lobby/sessionio"
)

// A session's birth name, as tmux-user-attach writes and reads it.
//
// The lobby knows a session by the minted id it was created with, so the
// title rename seconds later (ADR-0022) changes a label rather than which
// terminal is which. That only works if the id is on the session from the
// first moment, and if an attach that arrives holding the id after the rename
// finds the renamed session instead of creating an empty one under the old
// name (the phantom-session trap).
//
// These run the REAL script against a REAL tmux on a private socket. The stub
// on PATH forwards every tmux call to that server except the final
// `new-session -A`, which would need a terminal to attach to; that one is
// printed instead, so a test sees the session the script would have attached
// and the commands it would have chained onto it.

type bornHarness struct {
	t      *testing.T
	sock   string
	script string
	bin    string
	home   string
	tmux   string
}

func newBornHarness(t *testing.T) *bornHarness {
	t.Helper()
	script, err := filepath.Abs(filepath.Join("..", "devvm", "tmux-user-attach"))
	if err != nil || !fileExists(script) {
		t.Skip("tmux-user-attach not present")
	}
	real, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux not available")
	}
	h := &bornHarness{t: t, script: script, bin: t.TempDir(), home: t.TempDir(), tmux: real}
	// A short path: a tmux socket path is capped near 108 bytes, and a nested
	// t.TempDir() can run past it.
	dir, err := os.MkdirTemp("", "tlborn")
	if err != nil {
		t.Fatal(err)
	}
	h.sock = filepath.Join(dir, "s")
	t.Cleanup(func() {
		_ = exec.Command(real, "-S", h.sock, "kill-server").Run()
		_ = os.RemoveAll(dir)
	})

	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(h.bin, name), []byte(body), 0o755); err != nil {
			t.Fatalf("stub %s: %v", name, err)
		}
	}
	write("tmux", `#!/usr/bin/env bash
attach=0 new=0
for a in "$@"; do
  [[ "$a" == new-session ]] && new=1
  [[ "$a" == -A ]] && attach=1
done
if [[ $new == 1 && $attach == 1 ]]; then printf 'ATTACH %s\n' "$*"; exit 0; fi
exec `+shellQuote(real)+` -S `+shellQuote(h.sock)+` "$@"
`)
	write("systemd-run", "#!/usr/bin/env bash\nwhile [[ \"$1\" == -* ]]; do shift; done\nexec \"$@\"\n")
	// No user bus: the scope branch and the slot refill are skipped, which is
	// not what is under test here.
	write("systemctl", "#!/usr/bin/env bash\nexit 1\n")
	write("logger", "#!/usr/bin/env bash\nexit 0\n")
	write("getent", "#!/usr/bin/env bash\nprintf 'tl:x:1000:1000::%s:/bin/bash\\n' "+
		shellQuote(h.home)+"\nexit 0\n")
	return h
}

// tmuxDo runs a command against the private server.
func (h *bornHarness) tmuxDo(args ...string) string {
	h.t.Helper()
	out, err := exec.Command(h.tmux, append([]string{"-S", h.sock}, args...)...).CombinedOutput()
	if err != nil {
		h.t.Fatalf("tmux %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func (h *bornHarness) session(name string) {
	h.t.Helper()
	h.tmuxDo("new-session", "-d", "-s", name, "sleep 600")
}

func (h *bornHarness) bornOf(name string) string {
	h.t.Helper()
	return h.tmuxDo("display", "-p", "-t", "="+name+":", "#{"+sessionio.OptionBornAs+"}")
}

func (h *bornHarness) names() []string {
	h.t.Helper()
	out, err := exec.Command(h.tmux, "-S", h.sock, "list-sessions", "-F", "#{session_name}").Output()
	if err != nil {
		return nil
	}
	return strings.Fields(string(out))
}

// attach runs the script and returns the line it would have exec'd.
func (h *bornHarness) attach(args ...string) string {
	h.t.Helper()
	cmd := exec.Command("bash", append([]string{h.script}, args...)...)
	cmd.Env = append(os.Environ(), "PATH="+h.bin+":"+os.Getenv("PATH"),
		"TL_MOD_ID_FILE="+filepath.Join(h.home, "no-mod-id"))
	out, err := cmd.CombinedOutput()
	if err != nil {
		h.t.Fatalf("attach %v failed: %v\n%s", args, err, out)
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "ATTACH ") {
			return line
		}
	}
	h.t.Fatalf("attach %v exec'd no new-session -A:\n%s", args, out)
	return ""
}

// slotName asks the script itself, so the test cannot drift from it.
func (h *bornHarness) slotName(dir string) string {
	h.t.Helper()
	out, err := exec.Command("bash", "-c",
		`eval "$(sed -n '/^POOL_PREFIX=/,/^}/p' "$1")"; pool_slot_name "$2"`,
		"_", h.script, dir).Output()
	if err != nil {
		h.t.Fatalf("slot name: %v", err)
	}
	return strings.TrimSpace(string(out))
}

const bornID = "bw8k5gt9v314"

func TestAttachStampsTheBirthNameOnAClaim(t *testing.T) {
	h := newBornHarness(t)
	dir := t.TempDir()
	h.session(h.slotName(dir))

	h.attach(bornID, dir, "claude", "", "")

	if got := h.bornOf(bornID); got != bornID {
		t.Errorf("claimed session's birth name = %q, want %q", got, bornID)
	}
}

func TestAttachStampsTheBirthNameOnAColdCreate(t *testing.T) {
	h := newBornHarness(t)
	line := h.attach(bornID, t.TempDir(), "claude", "opus", "")

	want := "set-option -t =" + bornID + ": " + sessionio.OptionBornAs + " " + bornID
	if !strings.Contains(line, want) {
		t.Errorf("a cold create did not chain %q:\n%s", want, line)
	}
}

// A hand-picked name is not a birth name: it can be reused after a rename,
// and two sessions answering to one birth name would be one session twice.
func TestAttachLeavesAHandNamedSessionWithoutABirthName(t *testing.T) {
	h := newBornHarness(t)
	line := h.attach("beads", t.TempDir(), "", "", "")
	if strings.Contains(line, sessionio.OptionBornAs) {
		t.Errorf("a hand-named create was given a birth name:\n%s", line)
	}
}

// The phantom-session trap: a tab holding the id reconnects after the title
// rename. It must land on the renamed session, not create an empty one.
func TestAttachFindsARenamedSessionByItsBirthName(t *testing.T) {
	h := newBornHarness(t)
	dir := t.TempDir()
	h.session("deploy-the-thing")
	h.tmuxDo("set-option", "-t", "=deploy-the-thing:", sessionio.OptionBornAs, bornID)
	// A warm slot standing by must not be claimed by a reconnect.
	slot := h.slotName(dir)
	h.session(slot)

	line := h.attach(bornID, dir, "claude", "", "")

	if !strings.Contains(line, "-s deploy-the-thing ") {
		t.Errorf("reconnect did not attach the renamed session:\n%s", line)
	}
	if strings.Contains(line, "@tl_origin") || strings.Contains(line, sessionio.OptionBornAs) {
		t.Errorf("reconnect re-stamped a session that already existed:\n%s", line)
	}
	for _, n := range h.names() {
		if n == bornID {
			t.Errorf("reconnect created a session under the old id")
		}
	}
	if !strings.Contains(strings.Join(h.names(), " "), slot) {
		t.Errorf("reconnect claimed the warm slot; sessions now %v", h.names())
	}
}

// A session that really is called the id wins over a birth-name match.
func TestAttachPrefersASessionThatHasTheName(t *testing.T) {
	h := newBornHarness(t)
	h.session(bornID)
	h.session("other")
	h.tmuxDo("set-option", "-t", "=other:", sessionio.OptionBornAs, bornID)

	line := h.attach(bornID, t.TempDir(), "", "", "")
	if !strings.Contains(line, "-s "+bornID+" ") {
		t.Errorf("attach left the session that has the name:\n%s", line)
	}
}

// The script recognises a minted id with its own regex. It has to be the one
// mintedNameRe is, or a session the browser minted would go unstamped.
func TestAttachMintedIDRegexMatchesGo(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "devvm", "tmux-user-attach"))
	if err != nil {
		t.Skipf("tmux-user-attach not readable: %v", err)
	}
	m := regexp.MustCompile(`(?m)^MINTED_RE='([^']*)'$`).FindSubmatch(b)
	if m == nil {
		t.Fatal("tmux-user-attach has no MINTED_RE line")
	}
	if string(m[1]) != mintedNameRe.String() {
		t.Errorf("MINTED_RE = %q, mintedNameRe = %q", m[1], mintedNameRe.String())
	}
}
