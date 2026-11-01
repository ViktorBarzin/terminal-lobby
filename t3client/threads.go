package t3client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// maxPages bounds how far ListThreads and ListProjects follow nextCursor.
// At 100 a page it is 5,000 rows, far past any sidebar.
const maxPages = 50

// Thread is one row of t3_thread_list.
type Thread struct {
	ThreadID             string `json:"threadId"`
	ProjectID            string `json:"projectId"`
	Title                string `json:"title"`
	Link                 string `json:"link"`
	CreatedBy            string `json:"createdBy"`
	CreationSource       string `json:"creationSource"`
	Status               string `json:"status"`
	LatestRunID          string `json:"latestRunId"`
	ProviderInstanceID   string `json:"providerInstanceId"`
	Model                string `json:"model"`
	RuntimeMode          string `json:"runtimeMode"`
	InteractionMode      string `json:"interactionMode"`
	Settled              bool   `json:"settled"`
	Snoozed              bool   `json:"snoozed"`
	ParentThreadID       string `json:"parentThreadId"`
	RelationshipToParent string `json:"relationshipToParent"`
	ItemCount            int    `json:"itemCount"`
	CreatedAt            string `json:"createdAt"`
	UpdatedAt            string `json:"updatedAt"`
}

// LobbyState maps the thread's status onto the lobby's states.
func (t Thread) LobbyState() string { return LobbyState(t.Status) }

// ListThreads returns what T3's sidebar shows by default: every project's
// unarchived, unsettled, top-level threads. It follows nextCursor to the end
// and drops any subagent row T3 includes anyway.
func (c *Client) ListThreads(ctx context.Context, user string) ([]Thread, error) {
	var all []Thread
	err := c.pages(ctx, user, "t3_thread_list", map[string]any{
		"allProjects": true, "settled": false, "includeSubagents": false, "limit": 100,
	}, func(raw json.RawMessage) (*int, error) {
		var page struct {
			Threads    []Thread `json:"threads"`
			NextCursor *int     `json:"nextCursor"`
		}
		if err := json.Unmarshal(raw, &page); err != nil {
			return nil, fmt.Errorf("t3client: t3_thread_list: %w", err)
		}
		for _, t := range page.Threads {
			if t.RelationshipToParent != "subagent" {
				all = append(all, t)
			}
		}
		return page.NextCursor, nil
	})
	return all, err
}

// pages calls a cursor-paged tool until nextCursor is null. T3 sends the
// cursor as a non-negative integer offset. each decodes a page and returns
// its nextCursor.
func (c *Client) pages(ctx context.Context, user, tool string, args map[string]any, each func(json.RawMessage) (*int, error)) error {
	seen := map[int]bool{}
	var cursor *int
	for i := 0; i < maxPages; i++ {
		a := make(map[string]any, len(args)+1)
		for k, v := range args {
			a[k] = v
		}
		if cursor != nil {
			a["cursor"] = *cursor
		}
		raw, err := c.Call(ctx, user, tool, a)
		if err != nil {
			return err
		}
		next, err := each(raw)
		if err != nil {
			return err
		}
		if next == nil {
			return nil
		}
		if seen[*next] {
			return fmt.Errorf("t3client: %s returned cursor %d twice", tool, *next)
		}
		seen[*next] = true
		cursor = next
	}
	return fmt.Errorf("t3client: %s has more than %d pages", tool, maxPages)
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// LaunchRequest starts a thread. ProjectID and Model are required.
type LaunchRequest struct {
	ProjectID string
	Title     string
	// Prompt becomes the first message. Empty starts the thread without a
	// turn, so nothing runs until a message is sent.
	Prompt string
	Model  string
	// InstanceID defaults to "claudeAgent". Always set, since a fresh T3
	// has no default model.
	InstanceID string
	// RuntimeMode defaults to "full-access".
	RuntimeMode string
	// InteractionMode is "default" or "plan"; empty leaves T3's default.
	InteractionMode string
	// ClientRequestID makes the launch idempotent: T3 derives the thread id
	// from it, so a retry finds the same thread. Generated when empty.
	ClientRequestID string
}

// Launched is what t3_thread_launch returns.
type Launched struct {
	ThreadID  string `json:"threadId"`
	Link      string `json:"link"`
	ProjectID string `json:"projectId"`
	RunID     string `json:"-"`
	Status    string `json:"-"`
}

// Launch starts a thread in the project's root workspace.
func (c *Client) Launch(ctx context.Context, user string, r LaunchRequest) (Launched, error) {
	if r.ProjectID == "" || r.Model == "" {
		return Launched{}, errors.New("t3client: Launch needs a ProjectID and a Model")
	}
	if r.InstanceID == "" {
		r.InstanceID = "claudeAgent"
	}
	if r.RuntimeMode == "" {
		r.RuntimeMode = "full-access"
	}
	if r.ClientRequestID == "" {
		r.ClientRequestID = "tl-" + randomString(18)
	}
	args := map[string]any{
		"projectId":         r.ProjectID,
		"modelSelection":    map[string]any{"instanceId": r.InstanceID, "model": r.Model},
		"runtimeMode":       r.RuntimeMode,
		"workspaceStrategy": map[string]any{"type": "root"},
		"clientRequestId":   r.ClientRequestID,
	}
	if r.Title != "" {
		args["title"] = r.Title
	}
	if r.Prompt != "" {
		args["message"] = r.Prompt
	}
	if r.InteractionMode != "" {
		args["interactionMode"] = r.InteractionMode
	}
	raw, err := c.Call(ctx, user, "t3_thread_launch", args)
	if err != nil {
		return Launched{}, err
	}
	var out struct {
		Launched
		RunID  *string `json:"runId"`
		Status *string `json:"status"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return Launched{}, fmt.Errorf("t3client: t3_thread_launch: %w", err)
	}
	if out.ThreadID == "" {
		return Launched{}, errors.New("t3client: t3_thread_launch returned no threadId")
	}
	l := out.Launched
	l.RunID, l.Status = deref(out.RunID), deref(out.Status)
	return l, nil
}

// Rename sets a thread's title.
func (c *Client) Rename(ctx context.Context, user, threadID, title string) error {
	_, err := c.Call(ctx, user, "t3_thread_update", map[string]any{"threadId": threadID, "action": "rename", "title": title})
	return err
}

// Archive archives a thread, which drops it out of ListThreads. MCP has no
// delete, so this is what closing a T3 row means.
func (c *Client) Archive(ctx context.Context, user, threadID string) error {
	_, err := c.Call(ctx, user, "t3_thread_organize", map[string]any{"threadId": threadID, "action": "archive"})
	return err
}

// Sent is what t3_thread_send returns; Raw keeps the whole answer.
type Sent struct {
	RunID string
	Raw   json.RawMessage
}

// Send posts a message. mode is "", "auto", "queue", "steer" or "restart".
func (c *Client) Send(ctx context.Context, user, threadID, message, mode string) (Sent, error) {
	args := map[string]any{"threadId": threadID, "message": message}
	if mode != "" {
		args["mode"] = mode
	}
	raw, err := c.Call(ctx, user, "t3_thread_send", args)
	if err != nil {
		return Sent{}, err
	}
	var out struct {
		RunID string `json:"runId"`
	}
	json.Unmarshal(raw, &out)
	return Sent{RunID: out.RunID, Raw: raw}, nil
}

// Wait blocks until the run ends or timeout passes on T3's side. runID is
// required: without one T3 waits on whatever run is latest, which may not be
// the one the caller started. When ctx has no deadline it gets timeout plus
// a margin, so T3 answers before the client gives up.
func (c *Client) Wait(ctx context.Context, user, threadID, runID string, timeout time.Duration) (json.RawMessage, error) {
	if runID == "" {
		return nil, errors.New("t3client: Wait needs the runId that Send returned")
	}
	args := map[string]any{"threadId": threadID, "runId": runID}
	if timeout > 0 {
		args["timeoutMs"] = timeout.Milliseconds()
		if _, ok := ctx.Deadline(); !ok {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, timeout+15*time.Second)
			defer cancel()
		}
	}
	return c.Call(ctx, user, "t3_thread_wait", args)
}

// ReadOptions narrows t3_thread_read. Zero fields are left out.
type ReadOptions struct {
	View            string // "messages" or "activity"
	ItemID          string
	AfterPosition   int
	Limit           int
	RunLimit        int
	MaxCharsPerItem int
}

// Read returns t3_thread_read's answer as T3 sent it.
func (c *Client) Read(ctx context.Context, user, threadID string, o ReadOptions) (json.RawMessage, error) {
	args := map[string]any{"threadId": threadID}
	setStr(args, "view", o.View)
	setStr(args, "itemId", o.ItemID)
	setInt(args, "afterPosition", o.AfterPosition)
	setInt(args, "limit", o.Limit)
	setInt(args, "runLimit", o.RunLimit)
	setInt(args, "maxCharsPerItem", o.MaxCharsPerItem)
	return c.Call(ctx, user, "t3_thread_read", args)
}

// Interrupt stops the thread's current run; runID may be empty.
func (c *Client) Interrupt(ctx context.Context, user, threadID, runID string) error {
	args := map[string]any{"threadId": threadID}
	setStr(args, "runId", runID)
	_, err := c.Call(ctx, user, "t3_thread_interrupt", args)
	return err
}

// PendingList lists the questions and approvals a thread is waiting on.
func (c *Client) PendingList(ctx context.Context, user, threadID string) (json.RawMessage, error) {
	return c.Call(ctx, user, "t3_pending_request", map[string]any{"action": "list", "threadId": threadID})
}

// PendingRead reads one pending request.
func (c *Client) PendingRead(ctx context.Context, user, threadID, requestID string) (json.RawMessage, error) {
	return c.Call(ctx, user, "t3_pending_request", map[string]any{"action": "read", "threadId": threadID, "requestId": requestID})
}

// PendingRespond answers one pending request.
func (c *Client) PendingRespond(ctx context.Context, user, threadID, requestID string, answers map[string]any) (json.RawMessage, error) {
	return c.Call(ctx, user, "t3_pending_request", map[string]any{
		"action": "respond", "threadId": threadID, "requestId": requestID, "answers": answers,
	})
}

func setStr(m map[string]any, k, v string) {
	if v != "" {
		m[k] = v
	}
}

func setInt(m map[string]any, k string, v int) {
	if v != 0 {
		m[k] = v
	}
}

// Project is one row of t3_project_list.
type Project struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	WorkspaceRoot string `json:"workspaceRoot"`
}

// ListProjects returns every project.
func (c *Client) ListProjects(ctx context.Context, user string) ([]Project, error) {
	var all []Project
	err := c.pages(ctx, user, "t3_project_list", map[string]any{"limit": 100}, func(raw json.RawMessage) (*int, error) {
		var page struct {
			Projects   []Project `json:"projects"`
			NextCursor *int      `json:"nextCursor"`
		}
		if err := json.Unmarshal(raw, &page); err != nil {
			return nil, fmt.Errorf("t3client: t3_project_list: %w", err)
		}
		all = append(all, page.Projects...)
		return page.NextCursor, nil
	})
	return all, err
}

// ProjectForDir returns the project whose workspace root is dir's toplevel
// (Config.Toplevel, git by default), creating it, titled with the root's
// base name, when there is none.
func (c *Client) ProjectForDir(ctx context.Context, user, dir string) (Project, error) {
	if !filepath.IsAbs(dir) {
		return Project{}, fmt.Errorf("t3client: %q is not an absolute path", dir)
	}
	root, err := c.cfg.Toplevel(ctx, user, filepath.Clean(dir))
	if err != nil {
		return Project{}, err
	}
	root = filepath.Clean(root)
	find := func() (Project, bool, error) {
		ps, err := c.ListProjects(ctx, user)
		if err != nil {
			return Project{}, false, err
		}
		for _, p := range ps {
			if filepath.Clean(p.WorkspaceRoot) == root {
				return p, true, nil
			}
		}
		return Project{}, false, nil
	}
	if p, ok, err := find(); err != nil || ok {
		return p, err
	}
	raw, err := c.Call(ctx, user, "t3_project_create", map[string]any{"title": filepath.Base(root), "workspaceRoot": root})
	if IsToolError(err, "invalid_request") {
		// Created by someone else since the list; T3 refuses a duplicate root.
		if p, ok, ferr := find(); ferr == nil && ok {
			return p, nil
		}
	}
	if err != nil {
		return Project{}, err
	}
	var p Project
	if err := json.Unmarshal(raw, &p); err != nil || p.ID == "" {
		return Project{}, fmt.Errorf("t3client: t3_project_create returned %s", raw)
	}
	return p, nil
}

// GitToplevel resolves dir to its git toplevel, running git as the current
// user, and falls back to the cleaned dir itself outside git or when git
// cannot read it (another user's private directory, say). A caller that can
// run git as the target user injects its own resolver instead.
func GitToplevel(ctx context.Context, user, dir string) (string, error) {
	out, err := exec.CommandContext(ctx, "git", "-C", dir, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return filepath.Clean(dir), nil
	}
	return strings.TrimSpace(string(out)), nil
}
