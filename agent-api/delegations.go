package main

// The Delegation endpoints. delegation.go has the store and the lifecycle;
// this file has who may do what.
//
// Three parties, decided by the credential's name and account:
//
//   - A creator is a Caller named in TL_DELEGATION_CREATORS (the homelab CLI's
//     credential). It creates delegations and records whether the send went
//     out, and only for the ones it created.
//   - The target is the Caller a delegation names (muse). It posts the result,
//     and nobody else may.
//   - Anyone else sees nothing. A delegation they cannot see answers exactly
//     like an id that was never issued, as a task on another account does.
//
// With TL_DELEGATION_CREATORS empty nobody can create one, which is how the
// feature ships off.

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// defaultPublicURL is the base the callback in a message names: the public
// terminal-api ingress, the address Muse reaches this service through.
const defaultPublicURL = "https://terminal-api.viktorbarzin.me"

// defaultStateDir is where the store lives when neither TL_AGENT_STATE_DIR nor
// systemd's STATE_DIRECTORY says otherwise.
const defaultStateDir = "/var/lib/agent-api"

// Limits on GET /v1/delegations.
const (
	defaultDelegationListLimit = 50
	maxDelegationListLimit     = 500
)

// delegationCreators reads TL_DELEGATION_CREATORS: comma-separated Caller
// names. Empty is nil, and nil creates nothing.
func delegationCreators(getenv func(string) string) map[string]bool {
	var out map[string]bool
	for _, raw := range strings.Split(getenv("TL_DELEGATION_CREATORS"), ",") {
		name := strings.TrimSpace(raw)
		if name == "" {
			continue
		}
		if out == nil {
			out = map[string]bool{}
		}
		out[name] = true
	}
	return out
}

// publicURL reads TL_AGENT_PUBLIC_URL, without a trailing slash.
func publicURL(getenv func(string) string) string {
	if v := strings.TrimRight(strings.TrimSpace(getenv("TL_AGENT_PUBLIC_URL")), "/"); v != "" {
		return v
	}
	return defaultPublicURL
}

// stateDir is TL_AGENT_STATE_DIR, else systemd's STATE_DIRECTORY (the unit's
// StateDirectory=, which systemd creates and owns as User=), else the compiled
// default. systemd joins several directories with ':'; this service declares
// one, and the first is it.
func stateDir(getenv func(string) string) string {
	if v := strings.TrimSpace(getenv("TL_AGENT_STATE_DIR")); v != "" {
		return v
	}
	if v := strings.TrimSpace(getenv("STATE_DIRECTORY")); v != "" {
		first, _, _ := strings.Cut(v, ":")
		return first
	}
	return defaultStateDir
}

func (s *Server) publicURL() string {
	if s.PublicURL != "" {
		return strings.TrimRight(s.PublicURL, "/")
	}
	return defaultPublicURL
}

func (s *Server) delegationCaps() delegationCaps {
	c := s.DelegationCaps
	if c.PerHour <= 0 {
		c.PerHour = defaultDelegationCaps.PerHour
	}
	if c.PerDay <= 0 {
		c.PerDay = defaultDelegationCaps.PerDay
	}
	return c
}

func (c *call) isCreatorOf(r delegationRecord) bool {
	return c.id.Header == r.CreatedBy && c.id.OSUser == r.CreatorOSUser
}

func (c *call) isTargetOf(r delegationRecord) bool {
	return c.id.Header == r.Caller && c.id.OSUser == r.CallerOSUser
}

// visibleDelegation finds a delegation this caller may see, or the 404 an
// unissued id gets.
func (s *Server) visibleDelegation(c *call) (delegationRecord, error) {
	id := c.r.PathValue("id")
	c.delegationID = id
	rec, ok := s.Delegations.Get(id)
	if !ok || !(c.isCreatorOf(rec) || c.isTargetOf(rec)) {
		return delegationRecord{}, notFound("no delegation %q", id)
	}
	return rec, nil
}

type createDelegationRequest struct {
	Caller      string  `json:"caller"`
	Task        *string `json:"task"`
	FromSession string  `json:"from_session"`
	ExpiresInS  *int64  `json:"expires_in_s"`
}

// createDelegation serves POST /v1/delegations.
func (s *Server) createDelegation(c *call) (any, error) {
	if !s.DelegationCreators[c.id.Header] {
		return nil, forbidden("%q may not create delegations; the Callers that may are named in "+
			"TL_DELEGATION_CREATORS on the workstation", c.id.Header)
	}
	var req createDelegationRequest
	if err := c.decode(&req); err != nil {
		return nil, err
	}
	if req.Caller == "" {
		return nil, badRequest("caller is required: the name of the Caller to hand the work to")
	}
	if req.Task == nil || strings.TrimSpace(*req.Task) == "" {
		return nil, badRequest("task is required and must not be blank")
	}
	if n := utf8.RuneCountInString(*req.Task); n > maxDelegationTask {
		return nil, badRequest("task is %d characters; the most a delegation carries is %d", n, maxDelegationTask)
	}
	if n := utf8.RuneCountInString(req.FromSession); n > maxFromSession {
		return nil, badRequest("from_session is %d characters; the most is %d", n, maxFromSession)
	}
	// It sits on a line of its own in the message, so a line break in it would
	// let a session write a line of the message the Caller trusts.
	if strings.IndexFunc(req.FromSession, unicode.IsControl) >= 0 {
		return nil, badRequest("from_session must not contain line breaks or other control characters")
	}
	expiresIn := defaultDelegationExpiry
	if req.ExpiresInS != nil {
		if *req.ExpiresInS < 1 || *req.ExpiresInS > maxDelegationExpirySeconds {
			return nil, badRequest("expires_in_s must be from 1 to %d seconds (14 days), not %d",
				maxDelegationExpirySeconds, *req.ExpiresInS)
		}
		expiresIn = time.Duration(*req.ExpiresInS) * time.Second
	}

	targetUser, ok := s.Gate.BearerCaller(req.Caller)
	if !ok {
		return nil, forbidden("no Caller called %q holds a credential on this workstation, so nothing "+
			"could collect the work", req.Caller)
	}
	// A Caller acting as another account is that account's assistant. The
	// creator was trusted to hand out its own account's work, not anyone's.
	if targetUser != c.id.OSUser {
		return nil, forbidden("the Caller %q acts for a different account than %q does", req.Caller, c.id.Header)
	}

	id := "d_" + s.IDs.New()
	c.delegationID = id
	expires := s.now().UTC().Truncate(time.Second).Add(expiresIn)
	rec := delegationRecord{
		Delegation: Delegation{
			ID:          id,
			Caller:      req.Caller,
			CreatedBy:   c.id.Header,
			FromSession: req.FromSession,
			Task:        *req.Task,
			ExpiresAt:   expires,
			Message:     renderDelegationMessage(id, req.FromSession, expires, *req.Task, s.publicURL()),
		},
		CreatorOSUser: c.id.OSUser,
		CallerOSUser:  targetUser,
	}
	d, err := s.Delegations.Create(rec, s.delegationCaps())
	var capErr *delegationCapError
	switch {
	case errors.As(err, &capErr):
		return nil, tooManyRequests(capErr.RetryAfter, "%s", capErr.Error())
	case err != nil:
		return nil, serverError("recording the delegation: %v", err)
	}
	c.status = http.StatusCreated
	c.event = "delegation.created"
	return d, nil
}

// markDelegationSent serves POST /v1/delegations/{id}/sent.
func (s *Server) markDelegationSent(c *call) (any, error) {
	rec, err := s.visibleDelegation(c)
	if err != nil {
		return nil, err
	}
	if !c.isCreatorOf(rec) {
		return nil, forbidden("only %q, which created delegation %q, records whether it was sent", rec.CreatedBy, rec.ID)
	}
	d, err := s.Delegations.MarkSent(rec.ID)
	if err != nil {
		return nil, s.delegationError(rec.ID, d, err)
	}
	c.event = "delegation.sent"
	return d, nil
}

type undeliveredRequest struct {
	Reason string `json:"reason"`
}

// markDelegationUndelivered serves POST /v1/delegations/{id}/undelivered.
//
// The trace line it writes carries event delegation.undelivered and the
// reason as fields of their own, which is what infra's Loki alert matches: a
// logged-out WhatsApp Web should page someone rather than strand work.
func (s *Server) markDelegationUndelivered(c *call) (any, error) {
	rec, err := s.visibleDelegation(c)
	if err != nil {
		return nil, err
	}
	if !c.isCreatorOf(rec) {
		return nil, forbidden("only %q, which created delegation %q, records whether it was sent", rec.CreatedBy, rec.ID)
	}
	var req undeliveredRequest
	if err := c.decode(&req); err != nil {
		return nil, err
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		return nil, badRequest("reason is required: say why the message did not go out")
	}
	if n := utf8.RuneCountInString(reason); n > maxDelegationReason {
		return nil, badRequest("reason is %d characters; the most is %d", n, maxDelegationReason)
	}
	d, err := s.Delegations.MarkUndelivered(rec.ID, reason)
	if err != nil {
		return nil, s.delegationError(rec.ID, d, err)
	}
	c.event = "delegation.undelivered"
	c.reason = reason
	return d, nil
}

// getDelegation serves GET /v1/delegations/{id}, with ?wait=N as a long-poll
// that returns when the status changes.
func (s *Server) getDelegation(c *call) (any, error) {
	wait, err := waitSeconds(c.r.URL.Query())
	if err != nil {
		return nil, err
	}
	rec, err := s.visibleDelegation(c)
	if err != nil {
		return nil, err
	}
	if wait == 0 || rec.Status.finished() {
		return rec.Delegation, nil
	}
	if moved, ok := s.Delegations.Wait(c.r.Context(), rec.ID, time.Duration(wait)*s.waitUnit(), rec.Status); ok {
		rec = moved
	}
	return rec.Delegation, nil
}

// listDelegations serves GET /v1/delegations: the ones this caller created or
// is the target of, newest first.
func (s *Server) listDelegations(c *call) (any, error) {
	q := c.r.URL.Query()
	status, err := delegationStatusFilter(q)
	if err != nil {
		return nil, err
	}
	limit, present, err := queryInt(q, "limit")
	if err != nil {
		return nil, err
	}
	if !present || limit == 0 {
		limit = defaultDelegationListLimit
	}
	if limit > maxDelegationListLimit {
		limit = maxDelegationListLimit
	}
	recs := s.Delegations.List(func(r delegationRecord) bool {
		return (c.isCreatorOf(r) || c.isTargetOf(r)) && (status == "" || r.Status == status)
	}, limit)
	out := make([]Delegation, 0, len(recs))
	for _, r := range recs {
		out = append(out, r.Delegation)
	}
	// A list of whole tasks can be megabytes; the trace keeps the ids.
	ids := make([]string, 0, len(out))
	for _, d := range out {
		ids = append(ids, d.ID)
	}
	c.traceResponse = map[string]any{"delegation_ids": ids}
	return map[string]any{"delegations": out}, nil
}

func delegationStatusFilter(q url.Values) (DelegationStatus, error) {
	raw := q.Get("status")
	if raw == "" {
		return "", nil
	}
	for _, s := range delegationStatuses {
		if string(s) == raw {
			return s, nil
		}
	}
	return "", badRequest("status must be one of pending, sent, done, failed, expired or undelivered, not %q", raw)
}

type delegationResultRequest struct {
	Status DelegationStatus `json:"status"`
	Result *string          `json:"result"`
}

// postDelegationResult serves POST /v1/delegations/{id}/result, the target
// Caller's answer.
func (s *Server) postDelegationResult(c *call) (any, error) {
	rec, err := s.visibleDelegation(c)
	if err != nil {
		return nil, err
	}
	if !c.isTargetOf(rec) {
		return nil, forbidden("delegation %q was handed to %q, so only %q may post its result",
			rec.ID, rec.Caller, rec.Caller)
	}
	var req delegationResultRequest
	if err := c.decode(&req); err != nil {
		return nil, err
	}
	if req.Status != DelegationDone && req.Status != DelegationFailed {
		return nil, badRequest(`status must be "done" or "failed", not %q`, req.Status)
	}
	if req.Result == nil || strings.TrimSpace(*req.Result) == "" {
		return nil, badRequest("result is required: what happened, in words the delegating session can use")
	}
	if n := utf8.RuneCountInString(*req.Result); n > maxDelegationResult {
		return nil, badRequest("result is %d characters; the most is %d", n, maxDelegationResult)
	}
	d, err := s.Delegations.Finish(rec.ID, req.Status, *req.Result)
	if err != nil {
		return nil, s.delegationError(rec.ID, d, err)
	}
	c.event = "delegation." + string(req.Status)
	return d, nil
}

// delegationError maps a store refusal to its status. d is the delegation as
// the store left it, so the refusal can say what state it is in.
func (s *Server) delegationError(id string, d Delegation, err error) error {
	switch {
	case errors.Is(err, errDelegationNotFound):
		return notFound("no delegation %q", id)
	case errors.Is(err, errDelegationExpired):
		return gone("delegation %q expired at %s and nobody is waiting for its result any more; "+
			"drop the work and do not retry", id, d.ExpiresAt.UTC().Format(time.RFC3339))
	case errors.Is(err, errDelegationNotPending), errors.Is(err, errDelegationFinished):
		return conflict("delegation %q is already %s", id, d.Status)
	}
	return serverError("updating delegation %q: %v", id, err)
}

// retryAfterSeconds rounds up, so a caller that waits exactly that long finds
// room.
func retryAfterSeconds(d time.Duration) string {
	secs := int((d + time.Second - 1) / time.Second)
	if secs < 1 {
		secs = 1
	}
	return strconv.Itoa(secs)
}
