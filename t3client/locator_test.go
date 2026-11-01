package t3client

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestPortFromFiles(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("wizard.env", "# managed\nT3_PORT=3773\n")
	write("dispatch.json", `{"emil.barzin":{"os_user":"emo","port":3774},"vbarzin":{"os_user":"wizard","port":3999}}`)
	write("bad.env", "T3_PORT=nope\n")

	ports := PortFromFiles(dir)
	cases := []struct {
		user string
		want int
		ok   bool
	}{
		{"wizard", 3773, true}, // the env file wins over dispatch.json
		{"emo", 3774, true},    // no env file: dispatch.json
		{"bad", 0, false},
		{"nobody", 0, false},
		{"../etc", 0, false},
	}
	for _, c := range cases {
		got, err := ports(c.user)
		if (err == nil) != c.ok || got != c.want {
			t.Errorf("port(%q) = %d, %v; want %d ok=%v", c.user, got, err, c.want, c.ok)
		}
	}
}

// The env files are root-only on the devvm (0600 root), so a lobby service
// cannot read them; dispatch.json is world-readable and names the same port.
func TestPortFromFilesUnreadableEnvFallsBack(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads everything")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "emo.env"), []byte("T3_PORT=1\n"), 0o000); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "dispatch.json"), []byte(`{"e":{"os_user":"emo","port":3774}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := PortFromFiles(dir)("emo")
	if err != nil || got != 3774 {
		t.Fatalf("port = %d, %v; want 3774", got, err)
	}
}

func TestLocatorCachesEnvironmentID(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/t3/environment" {
			http.NotFound(w, r)
			return
		}
		hits.Add(1)
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"environmentId":"env-123","label":"devvm","serverVersion":"0.1.5"}`))
	}))
	defer srv.Close()

	hosts, _ := ParseHosts("wizard=t3.example.org", "example.org")
	l := &Locator{Ports: fixedPort(t, srv.URL), Hosts: hosts}
	for i := 0; i < 3; i++ {
		loc, err := l.Locate(context.Background(), "wizard")
		if err != nil {
			t.Fatal(err)
		}
		if loc.EnvironmentID != "env-123" || loc.Host != "t3.example.org" || loc.BaseURL != srv.URL {
			t.Fatalf("Locate = %+v", loc)
		}
	}
	if hits.Load() != 1 {
		t.Fatalf("environment fetched %d times, want 1", hits.Load())
	}
	l.Forget("wizard")
	if _, err := l.Locate(context.Background(), "wizard"); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 2 {
		t.Fatalf("Forget did not drop the cache: %d fetches", hits.Load())
	}
}

func TestLocatorEnvironmentErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"label":"no id"}`))
	}))
	defer srv.Close()
	l := &Locator{Ports: fixedPort(t, srv.URL)}
	if _, err := l.Locate(context.Background(), "wizard"); err == nil {
		t.Fatal("a missing environmentId was accepted")
	}
	if _, err := l.Locate(context.Background(), "Bad/User"); err == nil {
		t.Fatal("an invalid user name was accepted")
	}
}
