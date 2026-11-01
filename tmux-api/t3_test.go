package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"terminal-lobby/t3client"
)

// fakeT3 is the t3API seam: what the poller and the T3 routes ask of a
// user's T3, answered from fields a test sets.
type fakeT3 struct {
	mu        sync.Mutex
	has       map[string]bool
	loc       t3client.Location
	threads   []t3client.Thread
	projects  []t3client.Project
	listErr   error
	listDelay time.Duration
	lists     int
	projLists int

	forDir    []string
	project   t3client.Project
	forDirErr error
	launched  []t3client.LaunchRequest
	launch    t3client.Launched
	launchErr error
	renamed   []string // "<threadId>=<title>"
	renameErr error
	archived  []string
	archErr   error
}

func newFakeT3() *fakeT3 {
	return &fakeT3{
		has: map[string]bool{"wizard": true},
		loc: t3client.Location{User: "wizard", EnvironmentID: "env-1", Host: "t3.example.test"},
	}
}

func (f *fakeT3) HasT3(user string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.has[user]
}

func (f *fakeT3) Locate(context.Context, string) (t3client.Location, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.loc, nil
}

func (f *fakeT3) ListThreads(ctx context.Context, _ string) ([]t3client.Thread, error) {
	f.mu.Lock()
	f.lists++
	delay, err, out := f.listDelay, f.listErr, append([]t3client.Thread(nil), f.threads...)
	f.mu.Unlock()
	if delay > 0 {
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return nil, fmt.Errorf("t3client: post: %w", ctx.Err())
		}
	}
	return out, err
}

func (f *fakeT3) ListProjects(context.Context, string) ([]t3client.Project, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.projLists++
	return append([]t3client.Project(nil), f.projects...), nil
}

func (f *fakeT3) ProjectForDir(_ context.Context, _, dir string) (t3client.Project, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.forDir = append(f.forDir, dir)
	return f.project, f.forDirErr
}

func (f *fakeT3) Launch(_ context.Context, _ string, r t3client.LaunchRequest) (t3client.Launched, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.launched = append(f.launched, r)
	return f.launch, f.launchErr
}

func (f *fakeT3) Rename(_ context.Context, _, threadID, title string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.renamed = append(f.renamed, threadID+"="+title)
	return f.renameErr
}

func (f *fakeT3) Archive(_ context.Context, _, threadID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.archived = append(f.archived, threadID)
	return f.archErr
}

func (f *fakeT3) set(fn func(f *fakeT3)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

func (f *fakeT3) listCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lists
}

// clock is a settable now() for the poller.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// logSink collects the poller's log lines.
type logSink struct {
	mu    sync.Mutex
	lines []string
}

func (l *logSink) logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func (l *logSink) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.lines)
}

func testPoller(f *fakeT3) (*t3Poller, *clock, *logSink) {
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	logs := &logSink{}
	p := newT3Poller(f)
	p.now = c.now
	p.logf = logs.logf
	p.interval = time.Millisecond
	p.timeout = 50 * time.Millisecond
	return p, c, logs
}

func thread(id, title, status string) t3client.Thread {
	return t3client.Thread{
		ThreadID: id, ProjectID: "p1", Title: title, Status: status,
		CreatedAt: "2026-10-30T10:00:00.000Z", UpdatedAt: "2026-10-31T09:30:00.500Z",
	}
}

func waitForT3(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestT3PollerPollsOnlyWhileSomeoneAsks(t *testing.T) {
	f := newFakeT3()
	f.threads = []t3client.Thread{thread("mcp:a", "A", "idle")}
	p, c, _ := testPoller(f)

	// A user with no T3 server is never polled, and nobody is polled before
	// they ask.
	p.touch("emo")
	time.Sleep(20 * time.Millisecond)
	if n := f.listCount(); n != 0 {
		t.Fatalf("polled %d times with nobody asking for a user with a T3", n)
	}

	p.touch("wizard")
	waitForT3(t, "repeat polls", func() bool { return f.listCount() >= 3 })
	if !p.polling("wizard") {
		t.Fatal("the poll stopped while the user was still asking")
	}

	// Two minutes without a session-list request ends the poll.
	c.advance(t3AskWindow + time.Second)
	waitForT3(t, "the poll to stop", func() bool { return !p.polling("wizard") })
	n := f.listCount()
	time.Sleep(20 * time.Millisecond)
	if got := f.listCount(); got != n {
		t.Fatalf("polled %d more times after the window closed", got-n)
	}
	// The last good result outlives the poll.
	if rows := p.rows("wizard", nil); len(rows) != 1 {
		t.Fatalf("rows after the poll stopped = %d, want 1", len(rows))
	}

	// Asking again starts it again.
	p.touch("wizard")
	waitForT3(t, "the poll to restart", func() bool { return f.listCount() > n })
}

func TestT3PollerTimeoutKeepsTheLastGoodResult(t *testing.T) {
	f := newFakeT3()
	f.threads = []t3client.Thread{thread("mcp:a", "A", "running")}
	p, c, logs := testPoller(f)

	p.poll("wizard")
	if rows := p.rows("wizard", nil); len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}

	// T3 is slow: the 5 s bound (here 50 ms) cuts the call, and the rows
	// stay as they were.
	f.set(func(f *fakeT3) { f.listDelay = time.Second })
	start := time.Now()
	p.poll("wizard")
	if took := time.Since(start); took > 500*time.Millisecond {
		t.Fatalf("a slow T3 held the poll for %v", took)
	}
	p.poll("wizard")
	if rows := p.rows("wizard", nil); len(rows) != 1 || rows[0].Title != "A" {
		t.Fatalf("rows after a timeout = %+v, want the last good one", rows)
	}
	if _, ok := p.threadFor("wizard", t3client.Alias("mcp:a")); !ok {
		t.Fatal("the alias was forgotten on a timeout")
	}
	if logs.count() != 1 {
		t.Fatalf("logged %d lines over two timeouts, want 1: %q", logs.count(), logs.lines)
	}

	// A T3 that keeps timing out for longer than t3StaleAfter loses its rows.
	c.advance(t3StaleAfter + time.Second)
	p.poll("wizard")
	if rows := p.rows("wizard", nil); len(rows) != 0 {
		t.Fatalf("rows a minute into timeouts = %d, want 0", len(rows))
	}
}

func TestT3PollerUnreachableOmitsRowsAndLogsOnChange(t *testing.T) {
	f := newFakeT3()
	f.threads = []t3client.Thread{thread("mcp:a", "A", "running")}
	p, _, logs := testPoller(f)
	var changed []string
	p.changed = func(u string) { changed = append(changed, u) }

	p.poll("wizard")
	if len(changed) != 1 {
		t.Fatalf("changed called %d times for the first rows, want 1", len(changed))
	}
	p.poll("wizard")
	if len(changed) != 1 {
		t.Fatal("an unchanged poll invalidated the session list")
	}

	down := &t3client.AuthError{Err: errors.New("t3-mint: exit status 1")}
	f.set(func(f *fakeT3) { f.listErr = down })
	for i := 0; i < 3; i++ {
		p.poll("wizard")
	}
	if rows := p.rows("wizard", nil); len(rows) != 0 {
		t.Fatalf("rows while T3 is down = %d, want 0", len(rows))
	}
	if _, ok := p.threadFor("wizard", t3client.Alias("mcp:a")); ok {
		t.Fatal("an alias outlived its T3 going down")
	}
	if logs.count() != 1 || !strings.Contains(logs.lines[0], "wizard") {
		t.Fatalf("log lines over three failures = %q, want one naming the user", logs.lines)
	}
	if len(changed) != 2 {
		t.Fatalf("changed called %d times, want 2 (rows appeared, rows went)", len(changed))
	}

	f.set(func(f *fakeT3) { f.listErr = nil })
	p.poll("wizard")
	p.poll("wizard")
	if rows := p.rows("wizard", nil); len(rows) != 1 {
		t.Fatalf("rows after recovery = %d, want 1", len(rows))
	}
	if logs.count() != 2 {
		t.Fatalf("log lines after recovery = %q, want one more", logs.lines)
	}
}

func TestT3PollerAliasMap(t *testing.T) {
	f := newFakeT3()
	f.threads = []t3client.Thread{thread("mcp:a", "A", "idle"), thread("mcp:b", "B", "idle")}
	p, _, _ := testPoller(f)
	p.poll("wizard")

	for _, id := range []string{"mcp:a", "mcp:b"} {
		if got, ok := p.threadFor("wizard", t3client.Alias(id)); !ok || got != id {
			t.Errorf("threadFor(%s) = %q, %v", t3client.Alias(id), got, ok)
		}
	}
	if _, ok := p.threadFor("wizard", t3client.Alias("mcp:zzz")); ok {
		t.Error("an unknown alias resolved")
	}
	if _, ok := p.threadFor("emo", t3client.Alias("mcp:a")); ok {
		t.Error("another user's alias resolved")
	}

	// A thread launched since the last poll resolves before the poll sees it.
	p.remember("wizard", "mcp:new")
	if got, ok := p.threadFor("wizard", t3client.Alias("mcp:new")); !ok || got != "mcp:new" {
		t.Fatalf("a just-launched thread = %q, %v", got, ok)
	}

	// Rename and archive apply to the snapshot at once.
	p.retitle("wizard", "mcp:a", "A2")
	p.forget("wizard", "mcp:b")
	rows := p.rows("wizard", nil)
	if len(rows) != 1 || rows[0].Title != "A2" {
		t.Fatalf("rows after rename+archive = %+v", rows)
	}
	if _, ok := p.threadFor("wizard", t3client.Alias("mcp:b")); ok {
		t.Fatal("an archived thread still resolves")
	}
}

func TestT3PollerReadsProjectsOnlyWhenNeeded(t *testing.T) {
	f := newFakeT3()
	f.threads = []t3client.Thread{thread("mcp:a", "A", "idle")}
	f.projects = []t3client.Project{{ID: "p1", WorkspaceRoot: "/home/wizard/code/lobby"}}
	p, c, _ := testPoller(f)
	p.poll("wizard")
	p.poll("wizard")
	if f.projLists != 1 {
		t.Fatalf("project lists = %d over two polls of known projects, want 1", f.projLists)
	}
	f.set(func(f *fakeT3) {
		f.threads = append(f.threads, t3client.Thread{ThreadID: "mcp:b", ProjectID: "p2"})
		f.projects = append(f.projects, t3client.Project{ID: "p2", WorkspaceRoot: "/srv/x"})
	})
	p.poll("wizard")
	if f.projLists != 2 {
		t.Fatalf("project lists = %d after an unknown project appeared, want 2", f.projLists)
	}
	c.advance(t3ProjectsTTL + time.Second)
	p.poll("wizard")
	if f.projLists != 3 {
		t.Fatalf("project lists = %d after the TTL, want 3", f.projLists)
	}
	rows := p.rows("wizard", nil)
	if rows[1].Cwd != "/srv/x" {
		t.Fatalf("row cwd = %q, want the project's workspace root", rows[1].Cwd)
	}
}

func TestT3RowMapping(t *testing.T) {
	snap := &t3Snapshot{
		loc: t3client.Location{EnvironmentID: "env-1", Host: "t3.example.test"},
		threads: []t3client.Thread{
			thread("mcp:run", "Fix the build", "running"),
			thread("mcp:wait", "Asks a question", "waiting"),
			thread("mcp:idle", "Finished", "idle"),
			{ThreadID: "mcp:noproj", Title: "", Status: "queued", CreatedAt: "garbage"},
		},
		roots: map[string]string{"p1": "/home/wizard/code/lobby"},
	}
	rows := t3Rows("wizard", snap, []Project{{Name: "lobby", Dir: "/home/wizard/code/lobby/"}})
	if len(rows) != 4 {
		t.Fatalf("rows = %d, want 4", len(rows))
	}
	r := rows[0]
	want := Session{
		Name: t3client.Alias("mcp:run"), Title: "Fix the build", State: "running", Tool: "claude",
		Owner: "wizard", Origin: originUser, Project: "lobby", Cwd: "/home/wizard/code/lobby",
		Created:      time.Date(2026, 10, 30, 10, 0, 0, 0, time.UTC).Unix(),
		LastActivity: time.Date(2026, 10, 31, 9, 30, 0, 0, time.UTC).Unix(),
		LastDrive:    time.Date(2026, 10, 31, 9, 30, 0, 0, time.UTC).Unix(),
		Backend:      "t3", T3ThreadID: "mcp:run",
		URL:    "https://t3.example.test/env-1/mcp%3Arun",
		AppURL: "t3code://threads/env-1/mcp:run",
	}
	if fmt.Sprintf("%+v", r) != fmt.Sprintf("%+v", want) {
		t.Fatalf("row\n got %+v\nwant %+v", r, want)
	}
	if !sessionNameRe.MatchString(r.Name) {
		t.Fatalf("alias %q fails the session-name rule", r.Name)
	}
	for i, st := range []string{"running", "awaiting", "done", "running"} {
		if rows[i].State != st {
			t.Errorf("row %d state = %q, want %q", i, rows[i].State, st)
		}
	}
	// No project and an unreadable time: ungrouped, and times of zero rather
	// than a parse failure dropping the row.
	if rows[3].Project != "" || rows[3].Created != 0 || rows[3].Cwd != "" {
		t.Fatalf("row without a project = %+v", rows[3])
	}
}

func TestLayoutProjectFor(t *testing.T) {
	projects := []Project{
		{Name: "home", Dir: "/home/wizard"},
		{Name: "code", Dir: "/home/wizard/code"},
		{Name: "lobby", Dir: "/home/wizard/code/lobby"},
		{Name: "nodir"},
	}
	cases := []struct{ root, want string }{
		{"/home/wizard/code/lobby", "lobby"},
		{"/home/wizard/code/lobby/", "lobby"},
		{"/home/wizard/code/infra", "code"},  // the deepest project above it
		{"/home/wizard/notes", "home"},       // likewise
		{"/home/wizard/code/lobby2", "code"}, // a sibling with a shared prefix is not inside
		{"/srv/elsewhere", ""},               // outside every project
		{"", ""},                             // no workspace root known
	}
	for _, c := range cases {
		if got := layoutProjectFor(c.root, projects); got != c.want {
			t.Errorf("layoutProjectFor(%q) = %q, want %q", c.root, got, c.want)
		}
	}
}

func TestT3PollerNilIsInert(t *testing.T) {
	var p *t3Poller
	p.touch("wizard")
	p.kick("wizard")
	if rows := p.rows("wizard", nil); rows != nil {
		t.Fatal("a nil poller produced rows")
	}
	if _, ok := p.threadFor("wizard", "t3_aaaaaaaaaaaa"); ok {
		t.Fatal("a nil poller resolved an alias")
	}
	if p.has("wizard") {
		t.Fatal("a nil poller claims a T3")
	}
}
