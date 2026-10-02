package sessionio

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Measured live on 2026-10-02 through agent-api: six conversations created
// and sent a message at the same moment, and four of them answered about
// files sent to a DIFFERENT conversation. A paste was two tmux commands on
// the user's one server, load-buffer then paste-buffer, both on the server's
// unnamed buffer stack, so two sends to two sessions at once could each paste
// the other's text. Each paste now goes through a buffer of its own.
func TestConcurrentPastesToTwoSessionsNeverCross(t *testing.T) {
	in, osUser, sock := scratchSession(t)
	dir := t.TempDir()
	panes := []string{"alpha", "bravo"}
	for _, p := range panes {
		if err := exec.Command("tmux", "-L", sock, "new-session", "-d", "-s", p,
			"sh", "-c", `stty raw -echo; exec cat > `+filepath.Join(dir, p)).Run(); err != nil {
			t.Fatalf("new-session %s: %v", p, err)
		}
	}
	time.Sleep(200 * time.Millisecond)

	const rounds = 40
	var wg sync.WaitGroup
	errs := make(chan error, 2*rounds)
	for _, p := range panes {
		wg.Add(1)
		go func(p string) {
			defer wg.Done()
			for i := 0; i < rounds; i++ {
				if err := in.paste(osUser, p, fmt.Sprintf("<%s-%d>", p, i)); err != nil {
					errs <- fmt.Errorf("paste to %s: %w", p, err)
				}
			}
		}(p)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}

	for _, p := range panes {
		other := panes[0]
		if p == other {
			other = panes[1]
		}
		var got string
		deadline := time.Now().Add(3 * time.Second)
		for {
			b, _ := os.ReadFile(filepath.Join(dir, p))
			got = string(b)
			if strings.Count(got, "<"+p+"-") >= rounds || time.Now().After(deadline) {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		if strings.Contains(got, "<"+other+"-") {
			t.Fatalf("%s received text sent to %s: %q", p, other, got)
		}
		if n := strings.Count(got, "<"+p+"-"); n != rounds {
			t.Fatalf("%s received %d of its %d pastes: %q", p, n, rounds, got)
		}
	}
}
