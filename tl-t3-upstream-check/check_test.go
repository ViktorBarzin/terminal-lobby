package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const pinV010 = "tag=v0.1.0\ncommit=81493efb71e8e8244f95d3e9f71d8369654ab151\nrepo=https://github.com/pingdotgg/t3code\n"

func TestReadPinTakesTheTagAndTheReleasesURL(t *testing.T) {
	cases := map[string]struct {
		pin, tag, url string
	}{
		"as shipped": {pinV010, "v0.1.0", "https://api.github.com/repos/pingdotgg/t3code/releases/latest"},
		"a .git suffix and no final newline": {
			"tag=v0.2.0\ncommit=abc\nrepo=https://github.com/pingdotgg/t3code.git",
			"v0.2.0", "https://api.github.com/repos/pingdotgg/t3code/releases/latest",
		},
		"CRLF": {
			"tag=v0.1.0\r\ncommit=abc\r\nrepo=https://github.com/a/b\r\n",
			"v0.1.0", "https://api.github.com/repos/a/b/releases/latest",
		},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			p, err := ReadPin(c.pin)
			if err != nil {
				t.Fatal(err)
			}
			if p.Tag != c.tag {
				t.Errorf("tag %q, want %q", p.Tag, c.tag)
			}
			if got := p.LatestReleaseURL(); got != c.url {
				t.Errorf("url %q, want %q", got, c.url)
			}
		})
	}
}

func TestReadPinRefusesWhatItCannotCompare(t *testing.T) {
	for name, pin := range map[string]string{
		"empty":              "",
		"no tag":             "commit=abc\nrepo=https://github.com/a/b\n",
		"no repo":            "tag=v0.1.0\ncommit=abc\n",
		"not GitHub":         "tag=v0.1.0\nrepo=https://gitlab.com/a/b\n",
		"no repository name": "tag=v0.1.0\nrepo=https://github.com/a\n",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ReadPin(pin); err == nil {
				t.Errorf("ReadPin(%q) accepted it", pin)
			}
		})
	}
}

func TestParseReleaseReadsTheTagAndPublishTime(t *testing.T) {
	r, err := ParseRelease([]byte(`{"tag_name":"v0.2.0","published_at":"2026-10-15T23:18:08Z","draft":false,"name":"v0.2.0"}`))
	if err != nil {
		t.Fatal(err)
	}
	if r.Tag != "v0.2.0" {
		t.Errorf("tag %q", r.Tag)
	}
	if want := time.Date(2026, 10, 15, 23, 18, 8, 0, time.UTC); !r.Published.Equal(want) {
		t.Errorf("published %v, want %v", r.Published, want)
	}
}

func TestParseReleaseRefusesAnAnswerWithoutTheTwoFields(t *testing.T) {
	for name, body := range map[string]string{
		"not json":         `<html>rate limited</html>`,
		"an error body":    `{"message":"Not Found"}`,
		"no publish time":  `{"tag_name":"v0.2.0"}`,
		"bad publish time": `{"tag_name":"v0.2.0","published_at":"yesterday"}`,
		"no tag":           `{"published_at":"2026-10-15T23:18:08Z"}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseRelease([]byte(body)); err == nil {
				t.Errorf("ParseRelease(%s) accepted it", body)
			}
		})
	}
}

func TestRenderIsZeroWhenThePinIsTheLatest(t *testing.T) {
	got := Render(Release{Tag: "v0.1.0", Published: time.Unix(1792106288, 0)}, "v0.1.0")
	want := "# HELP tl_t3_upstream_unadopted_since_seconds " + helpText + "\n" +
		"# TYPE tl_t3_upstream_unadopted_since_seconds gauge\n" +
		`tl_t3_upstream_unadopted_since_seconds{latest="v0.1.0",pinned="v0.1.0"} 0` + "\n"
	if got != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
}

func TestRenderIsThePublishTimeWhenALaterReleaseIsNotInstalled(t *testing.T) {
	got := Render(Release{Tag: "v0.2.0", Published: time.Unix(1792106288, 0)}, "v0.1.0")
	if !strings.Contains(got, `tl_t3_upstream_unadopted_since_seconds{latest="v0.2.0",pinned="v0.1.0"} 1792106288`+"\n") {
		t.Errorf("got\n%s", got)
	}
}

// A quote in a label value makes node_exporter reject the whole file.
func TestRenderEscapesLabelValues(t *testing.T) {
	got := Render(Release{Tag: `v"1\` + "\n", Published: time.Unix(1, 0)}, "v0")
	if !strings.Contains(got, `latest="v\"1\\\n"`) {
		t.Errorf("label not escaped:\n%s", got)
	}
}

func TestFetchLatestSendsAUserAgentAndReadsTheRelease(t *testing.T) {
	var ua string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ua = r.Header.Get("User-Agent")
		_, _ = w.Write([]byte(`{"tag_name":"v0.2.0","published_at":"2026-10-15T23:18:08Z"}`))
	}))
	defer srv.Close()
	r, err := FetchLatest(context.Background(), srv.Client(), srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if r.Tag != "v0.2.0" {
		t.Errorf("tag %q", r.Tag)
	}
	if !strings.HasPrefix(ua, "terminal-lobby-tl-t3-upstream-check/") {
		t.Errorf("User-Agent %q; GitHub refuses requests without one", ua)
	}
}

func TestFetchLatestFailsOnANon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"tag_name":"v9","published_at":"2026-10-15T23:18:08Z"}`))
	}))
	defer srv.Close()
	if _, err := FetchLatest(context.Background(), srv.Client(), srv.URL); err == nil {
		t.Error("a 403 was read as a release")
	}
}

func TestFetchLatestGivesUpAtTheDeadline(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-block
	}))
	defer srv.Close()
	defer close(block)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := FetchLatest(ctx, srv.Client(), srv.URL); err == nil {
		t.Error("a request that never answered returned no error")
	}
}

func TestWriteAtomicReplacesTheFileAndLeavesNoTemporary(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tl-t3-upstream.prom")
	if err := os.WriteFile(path, []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := WriteAtomic(path, "new\n"); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "new\n" {
		t.Errorf("content %q", b)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o644 {
		t.Errorf("mode %v; node_exporter reads it as another user", fi.Mode().Perm())
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Errorf("want only the metric file, have %d entries", len(entries))
	}
}

// The whole run: a fetch that fails writes nothing, so the file keeps its
// old mtime and the staleness alert is what fires.
func TestRunWritesNothingWhenTheFetchFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	dir := t.TempDir()
	pin := filepath.Join(dir, "T3_PIN")
	if err := os.WriteFile(pin, []byte(pinV010), 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "out.prom")
	if err := run(context.Background(), srv.Client(), pin, srv.URL, out); err == nil {
		t.Fatal("run succeeded on a 500")
	}
	if _, err := os.Stat(out); !os.IsNotExist(err) {
		t.Errorf("run wrote %s after a failed fetch", out)
	}
}

func TestRunWritesTheMetric(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"tag_name":"v0.2.0","published_at":"2026-10-15T23:18:08Z"}`))
	}))
	defer srv.Close()
	dir := t.TempDir()
	pin := filepath.Join(dir, "T3_PIN")
	if err := os.WriteFile(pin, []byte(pinV010), 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "out.prom")
	if err := run(context.Background(), srv.Client(), pin, srv.URL, out); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `{latest="v0.2.0",pinned="v0.1.0"} 1792106288`) {
		t.Errorf("wrote\n%s", b)
	}
}
