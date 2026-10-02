package main

// The dialog a Claude session is waiting on, read from session-events and
// answered through the session's mod (ADR-0037): the path the lobby's Text
// view takes. session-events serves two internal routes for it, on loopback,
// to this service's own OS account only (session-events/internal.go). They
// take no proxy secret and no identity header, so this service still holds
// neither.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"terminal-lobby/sessionio"
)

var (
	// errNoMod — session-events has no mod connected for the session: the
	// Claude in it never loaded the lobby's mod, or session-events restarted
	// a moment ago and the mod has not said hello yet.
	errNoMod = errors.New("the lobby's mod is not connected for this session")
	// errNoDialog — the mod is connected and nothing is waiting on a person.
	errNoDialog = errors.New("no dialog is open")
	// errDialogGone — the dialog an answer named is no longer open.
	errDialogGone = errors.New("that dialog is no longer open")
)

// modDialog is one open dialog as session-events reports it.
type modDialog struct {
	Kind         string        `json:"kind"` // ask, plan or permission
	ToolID       string        `json:"toolId"`
	Questions    []modQuestion `json:"questions,omitempty"`
	Plan         string        `json:"plan,omitempty"`
	PlanFilePath string        `json:"planFilePath,omitempty"`
	Tool         string        `json:"tool,omitempty"`
	Title        string        `json:"title,omitempty"`
	Detail       []string      `json:"detail,omitempty"`
	Reason       string        `json:"reason,omitempty"`
}

type modQuestion struct {
	Question    string      `json:"question"`
	Header      string      `json:"header,omitempty"`
	MultiSelect bool        `json:"multiSelect,omitempty"`
	Options     []modOption `json:"options"`
}

type modOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// dialogClient calls session-events' internal routes.
type dialogClient struct {
	base string
	http *http.Client
}

// newDialogClient points at TL_SESSION_EVENTS_URL, by default this box's
// session-events. The timeout outlasts session-events' own wait for the mod's
// ack (modAckWait, 10 s), so a slow ack comes back as its "unverified" answer
// rather than as a client error.
func newDialogClient() *dialogClient {
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("TL_SESSION_EVENTS_URL")), "/")
	if base == "" {
		base = "http://127.0.0.1:7685"
	}
	return &dialogClient{base: base, http: &http.Client{Timeout: 15 * time.Second}}
}

func (d *dialogClient) do(ctx context.Context, method, route, osUser, session string, body any) (*http.Response, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}
	u := d.base + route + "/" + url.PathEscape(osUser) + "/" + url.PathEscape(session)
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-TL-Internal", "1")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return d.http.Do(req)
}

// Dialog reads the oldest dialog open in the session.
func (d *dialogClient) Dialog(osUser, session string) (modDialog, error) {
	resp, err := d.do(context.Background(), http.MethodGet, "/internal/v1/dialog", osUser, session, nil)
	if err != nil {
		return modDialog{}, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		var out modDialog
		if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
			return modDialog{}, fmt.Errorf("session-events sent an unreadable dialog: %w", err)
		}
		return out, nil
	case http.StatusNoContent:
		return modDialog{}, errNoDialog
	case http.StatusNotFound:
		return modDialog{}, errNoMod
	}
	return modDialog{}, statusError(resp)
}

// AnswerDialog answers the dialog req.ToolID names.
func (d *dialogClient) AnswerDialog(ctx context.Context, osUser, session string, req sessionio.AnswerRequest) (sessionio.AnswerResponse, error) {
	resp, err := d.do(ctx, http.MethodPost, "/internal/v1/answer", osUser, session, req)
	if err != nil {
		return sessionio.AnswerResponse{}, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		var out sessionio.AnswerResponse
		if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
			return sessionio.AnswerResponse{}, fmt.Errorf("session-events sent an unreadable answer: %w", err)
		}
		return out, nil
	case http.StatusConflict:
		return sessionio.AnswerResponse{}, errDialogGone
	case http.StatusNotFound:
		return sessionio.AnswerResponse{}, errNoMod
	}
	return sessionio.AnswerResponse{}, statusError(resp)
}

func statusError(resp *http.Response) error {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	return fmt.Errorf("session-events answered %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
}
