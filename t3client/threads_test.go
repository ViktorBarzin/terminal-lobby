package t3client

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func thread(id string, extra map[string]any) map[string]any {
	t := map[string]any{"threadId": id, "projectId": "p1", "title": "t " + id, "status": "running",
		"settled": false, "snoozed": false, "relationshipToParent": nil, "itemCount": 3,
		"createdAt": "2026-11-01T00:00:00.000Z", "updatedAt": "2026-11-01T00:01:00.000Z"}
	for k, v := range extra {
		t[k] = v
	}
	return t
}

func TestListThreadsPagesAndDropsSubagents(t *testing.T) {
	f := newFakeT3(t)
	pages := map[string]map[string]any{
		"": {"threads": []any{thread("mcp:a", nil), thread("mcp:sub", map[string]any{"relationshipToParent": "subagent", "parentThreadId": "mcp:a"})},
			"nextCursor": "c1", "total": 4},
		"c1": {"threads": []any{thread("import:claudeAgent:b", map[string]any{"status": "waiting"}), thread("c", map[string]any{"relationshipToParent": "fork"})},
			"nextCursor": nil, "total": 4},
	}
	f.tool = func(name string, args map[string]any) (any, *fakeToolErr) {
		cur, _ := args["cursor"].(string)
		return pages[cur], nil
	}
	c, _, _ := newTestClient(t, f)
	got, err := c.ListThreads(context.Background(), "wizard")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, th := range got {
		ids = append(ids, th.ThreadID)
	}
	if want := []string{"mcp:a", "import:claudeAgent:b", "c"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("threads %q, want %q", ids, want)
	}
	if got[1].LobbyState() != StateAwaiting || got[0].LobbyState() != StateRunning || got[0].ItemCount != 3 {
		t.Fatalf("decoded %+v", got)
	}
	calls := f.toolCalls()
	if len(calls) != 2 {
		t.Fatalf("%d calls, want 2", len(calls))
	}
	a := calls[0].Args
	if a["allProjects"] != true || a["settled"] != false || a["includeSubagents"] != false || a["limit"] != float64(100) {
		t.Fatalf("list args %v", a)
	}
	if _, ok := a["cursor"]; ok {
		t.Fatal("first page sent a cursor")
	}
	if calls[1].Args["cursor"] != "c1" {
		t.Fatalf("second page args %v", calls[1].Args)
	}
}

func TestListThreadsStopsOnRepeatedCursor(t *testing.T) {
	f := newFakeT3(t)
	f.tool = func(string, map[string]any) (any, *fakeToolErr) {
		return map[string]any{"threads": []any{}, "nextCursor": "same"}, nil
	}
	c, _, _ := newTestClient(t, f)
	if _, err := c.ListThreads(context.Background(), "wizard"); err == nil {
		t.Fatal("a cursor that never advances was followed forever")
	}
}

func lastCall(t *testing.T, f *fakeT3) fakeCall {
	t.Helper()
	calls := f.toolCalls()
	if len(calls) == 0 {
		t.Fatal("no tool call")
	}
	return calls[len(calls)-1]
}

func TestLaunchArguments(t *testing.T) {
	f := newFakeT3(t)
	f.tool = func(name string, args map[string]any) (any, *fakeToolErr) {
		return map[string]any{"threadId": "mcp:launch:abc", "link": "x", "projectId": args["projectId"], "runId": nil, "status": nil}, nil
	}
	c, _, _ := newTestClient(t, f)
	ctx := context.Background()

	got, err := c.Launch(ctx, "wizard", LaunchRequest{ProjectID: "p1", Title: "fix it", Model: "claude-opus-5-5", Prompt: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if got.ThreadID != "mcp:launch:abc" || got.RunID != "" || got.Status != "" || got.ProjectID != "p1" {
		t.Fatalf("Launched %+v", got)
	}
	a := lastCall(t, f).Args
	if a["projectId"] != "p1" || a["title"] != "fix it" || a["message"] != "hello" || a["runtimeMode"] != "full-access" {
		t.Fatalf("launch args %v", a)
	}
	if ms := a["modelSelection"].(map[string]any); ms["instanceId"] != "claudeAgent" || ms["model"] != "claude-opus-5-5" {
		t.Fatalf("modelSelection %v", ms)
	}
	if ws := a["workspaceStrategy"].(map[string]any); ws["type"] != "root" {
		t.Fatalf("workspaceStrategy %v", ws)
	}
	id1, _ := a["clientRequestId"].(string)
	if id1 == "" {
		t.Fatal("no clientRequestId")
	}

	// No prompt: no message, so no turn runs. A second launch gets a fresh
	// request id; a caller-supplied one is kept.
	if _, err := c.Launch(ctx, "wizard", LaunchRequest{ProjectID: "p1", Model: "m", RuntimeMode: "auto-accept-edits", InstanceID: "claudeOther"}); err != nil {
		t.Fatal(err)
	}
	a = lastCall(t, f).Args
	if _, ok := a["message"]; ok {
		t.Fatal("an empty prompt was sent as a message")
	}
	if a["clientRequestId"] == id1 || a["runtimeMode"] != "auto-accept-edits" || a["modelSelection"].(map[string]any)["instanceId"] != "claudeOther" {
		t.Fatalf("second launch args %v", a)
	}
	if _, err := c.Launch(ctx, "wizard", LaunchRequest{ProjectID: "p1", Model: "m", ClientRequestID: "req-7"}); err != nil {
		t.Fatal(err)
	}
	if lastCall(t, f).Args["clientRequestId"] != "req-7" {
		t.Fatal("the caller's clientRequestId was replaced")
	}

	if _, err := c.Launch(ctx, "wizard", LaunchRequest{Model: "m"}); err == nil {
		t.Fatal("a launch without a project was sent")
	}
}

func TestThreadActions(t *testing.T) {
	f := newFakeT3(t)
	f.tool = func(name string, args map[string]any) (any, *fakeToolErr) {
		if name == "t3_thread_send" {
			return map[string]any{"runId": "run-9", "threadId": args["threadId"]}, nil
		}
		return map[string]any{"ok": true}, nil
	}
	c, _, _ := newTestClient(t, f)
	ctx := context.Background()
	steps := []struct {
		do   func() error
		tool string
		args map[string]any
	}{
		{func() error { return c.Rename(ctx, "wizard", "mcp:a", "new name") }, "t3_thread_update",
			map[string]any{"threadId": "mcp:a", "action": "rename", "title": "new name"}},
		{func() error { return c.Archive(ctx, "wizard", "mcp:a") }, "t3_thread_organize",
			map[string]any{"threadId": "mcp:a", "action": "archive"}},
		{func() error {
			r, err := c.Send(ctx, "wizard", "mcp:a", "go on", "")
			if err == nil && r.RunID != "run-9" {
				err = fmt.Errorf("RunID %q", r.RunID)
			}
			return err
		}, "t3_thread_send", map[string]any{"threadId": "mcp:a", "message": "go on"}},
		{func() error { _, err := c.Send(ctx, "wizard", "mcp:a", "now", "steer"); return err }, "t3_thread_send",
			map[string]any{"threadId": "mcp:a", "message": "now", "mode": "steer"}},
		{func() error { _, err := c.Wait(ctx, "wizard", "mcp:a", "run-9", 2*time.Second); return err }, "t3_thread_wait",
			map[string]any{"threadId": "mcp:a", "runId": "run-9", "timeoutMs": float64(2000)}},
		{func() error {
			_, err := c.Read(ctx, "wizard", "mcp:a", ReadOptions{View: "messages", Limit: 20})
			return err
		}, "t3_thread_read",
			map[string]any{"threadId": "mcp:a", "view": "messages", "limit": float64(20)}},
		{func() error { return c.Interrupt(ctx, "wizard", "mcp:a", "run-9") }, "t3_thread_interrupt",
			map[string]any{"threadId": "mcp:a", "runId": "run-9"}},
		{func() error { _, err := c.PendingList(ctx, "wizard", "mcp:a"); return err }, "t3_pending_request",
			map[string]any{"action": "list", "threadId": "mcp:a"}},
		{func() error { _, err := c.PendingRead(ctx, "wizard", "mcp:a", "req-1"); return err }, "t3_pending_request",
			map[string]any{"action": "read", "threadId": "mcp:a", "requestId": "req-1"}},
		{func() error {
			_, err := c.PendingRespond(ctx, "wizard", "mcp:a", "req-1", map[string]any{"q1": "yes"})
			return err
		}, "t3_pending_request",
			map[string]any{"action": "respond", "threadId": "mcp:a", "requestId": "req-1", "answers": map[string]any{"q1": "yes"}}},
	}
	for i, s := range steps {
		if err := s.do(); err != nil {
			t.Fatalf("step %d (%s): %v", i, s.tool, err)
		}
		got := lastCall(t, f)
		if got.Name != s.tool || !reflect.DeepEqual(got.Args, s.args) {
			t.Errorf("step %d: called %s %v, want %s %v", i, got.Name, got.Args, s.tool, s.args)
		}
	}
}

func TestWaitRequiresRunID(t *testing.T) {
	f := newFakeT3(t)
	f.tool = echoTool
	c, _, _ := newTestClient(t, f)
	if _, err := c.Wait(context.Background(), "wizard", "mcp:a", "", time.Second); err == nil {
		t.Fatal("Wait without a runId was sent")
	}
	if len(f.toolCalls()) != 0 {
		t.Fatal("Wait without a runId reached T3")
	}
}

func TestProjectForDir(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	sub := filepath.Join(repo, "pkg", "x")
	os.MkdirAll(sub, 0o755)
	plain := filepath.Join(root, "plain")
	os.MkdirAll(plain, 0o755)

	projects := []map[string]any{
		{"id": "p-near", "title": "near", "workspaceRoot": repo + "-other"},
		{"id": "p-repo", "title": "repo", "workspaceRoot": repo},
	}
	created := 0
	f := newFakeT3(t)
	f.tool = func(name string, args map[string]any) (any, *fakeToolErr) {
		switch name {
		case "t3_project_list":
			if args["cursor"] == nil {
				return map[string]any{"projects": projects[:1], "nextCursor": "n"}, nil
			}
			return map[string]any{"projects": projects[1:], "nextCursor": nil}, nil
		case "t3_project_create":
			created++
			p := map[string]any{"id": fmt.Sprintf("p-new-%d", created), "title": args["title"], "workspaceRoot": args["workspaceRoot"]}
			projects = append(projects, p)
			return p, nil
		}
		return nil, &fakeToolErr{"bad", name}
	}
	c, _, _ := newTestClient(t, f)
	c.cfg.Toplevel = func(ctx context.Context, user, dir string) (string, error) {
		if strings.HasPrefix(dir, repo) {
			return repo, nil
		}
		return dir, nil
	}
	ctx := context.Background()

	p, err := c.ProjectForDir(ctx, "wizard", sub)
	if err != nil || p.ID != "p-repo" {
		t.Fatalf("ProjectForDir(sub) = %+v, %v; want p-repo", p, err)
	}
	p, err = c.ProjectForDir(ctx, "wizard", plain)
	if err != nil || p.ID != "p-new-1" || p.Title != "plain" || p.WorkspaceRoot != plain {
		t.Fatalf("ProjectForDir(plain) = %+v, %v", p, err)
	}
	p, err = c.ProjectForDir(ctx, "wizard", plain+"/")
	if err != nil || p.ID != "p-new-1" || created != 1 {
		t.Fatalf("second ProjectForDir(plain) = %+v, %v, created %d", p, err, created)
	}
	if _, err := c.ProjectForDir(ctx, "wizard", "relative/dir"); err == nil {
		t.Fatal("a relative dir was accepted")
	}
}

// Two lobbies creating the same project at once: T3 refuses the second with
// invalid_request, and the loser picks up the winner's project.
func TestProjectForDirCreateRace(t *testing.T) {
	var projects []map[string]any
	f := newFakeT3(t)
	f.tool = func(name string, args map[string]any) (any, *fakeToolErr) {
		switch name {
		case "t3_project_list":
			return map[string]any{"projects": projects, "nextCursor": nil}, nil
		case "t3_project_create":
			projects = append(projects, map[string]any{"id": "p-other", "title": "x", "workspaceRoot": args["workspaceRoot"]})
			return nil, &fakeToolErr{"invalid_request", "The workspace is already registered to a project."}
		}
		return nil, nil
	}
	c, _, _ := newTestClient(t, f)
	p, err := c.ProjectForDir(context.Background(), "wizard", "/srv/x")
	if err != nil || p.ID != "p-other" {
		t.Fatalf("ProjectForDir = %+v, %v", p, err)
	}
}

func TestGitToplevel(t *testing.T) {
	dir := t.TempDir()
	got, err := GitToplevel(context.Background(), "wizard", dir+"/")
	if err != nil || got != dir {
		t.Fatalf("outside git: %q, %v", got, err)
	}
	if _, err := os.Stat("/usr/bin/git"); err != nil {
		t.Skip("no git")
	}
	cwd, _ := os.Getwd()
	got, err = GitToplevel(context.Background(), "wizard", cwd)
	if err != nil || got != filepath.Dir(cwd) {
		t.Fatalf("inside the repo: %q, %v", got, err)
	}
}
