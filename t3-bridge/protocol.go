package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os/exec"
	"strings"
	"sync"
	"time"

	"terminal-lobby/sessionio"
)

// The Agent SDK stream-json protocol, the half of it the bridge speaks.
//
// Shapes are transcribed from @anthropic-ai/claude-agent-sdk 0.3.233's sdk.d.ts
// as shipped inside t3 v0.0.34-nightly.20260815.1098 (the copy T3 actually
// talks to: /usr/lib/node_modules/t3/node_modules/@anthropic-ai/claude-agent-sdk).
// Where a field is REQUIRED there it has no omitempty here, because T3's
// decoder is the one that has to be satisfied — an omitted required field is a
// malformed frame, not a compact one.
//
// One line of JSON per frame, both directions. Nothing is buffered across
// lines, so a partial write can never be interpreted as a frame.

// Frame type discriminators.
const (
	TypeControlRequest  = "control_request"
	TypeControlResponse = "control_response"
	TypeSystem          = "system"
	TypeAssistant       = "assistant"
	TypeUser            = "user"
	TypeResult          = "result"
)

// Control-request subtypes the bridge recognises. Every OTHER subtype is
// answered with a bare success (see the reply rule on Encoder.ControlSuccess):
// SDKControlRequestInner has 35 members and T3 may send any of them, so
// refusing the unknown ones would stall a thread on a request we merely have no
// opinion about.
const (
	SubtypeInitialize        = "initialize"
	SubtypeInterrupt         = "interrupt"
	SubtypeSetPermissionMode = "set_permission_mode"
	SubtypeGetContextUsage   = "get_context_usage"
)

// Inbound is one frame T3 wrote to the bridge's stdin.
//
// The payload halves stay raw: `request` is a union of 35 shapes and `message`
// is an Anthropic MessageParam, and the bridge acts on a handful of fields in
// each. Decoding only what is needed keeps an unrecognised member of either
// union from failing the whole frame.
type Inbound struct {
	Type      string          `json:"type"`
	RequestID string          `json:"request_id"`
	Request   json.RawMessage `json:"request"`
	Message   json.RawMessage `json:"message"`
	SessionID string          `json:"session_id"`
	// Line is the frame as it arrived, for logging a frame we could not act on.
	Line []byte `json:"-"`
}

// ControlSubtype is the `request.subtype` of a control_request, "" for any
// other frame.
func (in Inbound) ControlSubtype() string {
	if in.Type != TypeControlRequest {
		return ""
	}
	var r struct {
		Subtype string `json:"subtype"`
	}
	if json.Unmarshal(in.Request, &r) != nil {
		return ""
	}
	return r.Subtype
}

// Text is the plain text of an inbound user message — what gets pasted into
// the pane. Content arrives as either a bare string or an array of blocks; the
// text blocks are joined in order, and non-text blocks (images, tool results)
// are skipped because a tmux pane has nowhere to put them.
//
// The join is a newline, not an empty string: t3 builds content as an array
// (buildUserMessage → sdkContent), so two text blocks are two parts of one
// prompt, and concatenating them welds the last word of the first onto the
// first word of the second.
//
// A prompt that carries no text at all — an image on its own — comes back "".
// The loop treats that as unmappable rather than pasting a blank line, which
// would submit an empty turn into somebody's session; see protoLoop.prompt.
func (in Inbound) Text() string {
	var s string
	if json.Unmarshal(in.Message, &s) == nil {
		return s
	}
	var msg struct {
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(in.Message, &msg) != nil {
		return ""
	}
	if json.Unmarshal(msg.Content, &s) == nil {
		return s
	}
	var out strings.Builder
	for _, b := range inboundBlocks(msg.Content) {
		if b.Type != "text" {
			continue
		}
		if out.Len() > 0 {
			out.WriteByte('\n')
		}
		out.WriteString(b.Text)
	}
	return out.String()
}

// inboundBlock is one content block of an inbound user message, decoded only
// as far as the two decisions the bridge makes about it: is it text, and if
// not, what was it (for the log).
type inboundBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func inboundBlocks(content json.RawMessage) []inboundBlock {
	var blocks []inboundBlock
	if json.Unmarshal(content, &blocks) != nil {
		return nil
	}
	return blocks
}

// protoDroppedBlocks names the non-text blocks of an inbound user message. It
// exists for the stderr log: "the prompt had an image the pane cannot show" is
// a useful thing to find in the journal, and "the prompt was empty" is not.
func protoDroppedBlocks(in Inbound) []string {
	var msg struct {
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(in.Message, &msg) != nil {
		return nil
	}
	var dropped []string
	for _, b := range inboundBlocks(msg.Content) {
		if b.Type != "text" {
			dropped = append(dropped, b.Type)
		}
	}
	return dropped
}

// protoMaxFrameBytes is the largest inbound line the bridge will assemble. It
// is generous because a user message can carry a pasted file, and finite
// because the alternative is letting one frame decide how much memory the
// bridge takes.
const protoMaxFrameBytes = 16 * 1024 * 1024

// ErrFrameTooLong is returned for a line over protoMaxFrameBytes. It is a
// RECOVERABLE error: the frame is skipped, and the caller closes whatever turn
// it opened rather than letting a paste over the limit end the process.
var ErrFrameTooLong = errors.New("inbound frame is over the size limit")

// Decoder reads inbound frames off T3's pipe.
type Decoder struct {
	r  io.Reader
	sc *bufio.Scanner
}

// NewDecoder wraps the bridge's stdin.
func NewDecoder(r io.Reader) *Decoder {
	return &Decoder{r: r, sc: newProtoScanner(r)}
}

func newProtoScanner(r io.Reader) *bufio.Scanner {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), protoMaxFrameBytes)
	return sc
}

// Next returns the next frame. io.EOF means T3 closed the pipe, which is how a
// bridge is normally told to exit. A line that is not a JSON object is skipped
// rather than fatal — see the same reasoning in sessionio.Tail.Next.
//
// An OVERSIZE line is the one error worth naming. bufio.Scanner cannot be used
// again after ErrTooLong, so before this the bridge exited on it — an
// unhandled process death driven by ordinary user input (paste more than 16 MiB
// into the composer) that also lost every frame queued behind it. The scanner
// is rebuilt instead, which resumes at the next newline, and the caller is told
// so it can close the turn with a legible reason.
func (d *Decoder) Next() (Inbound, error) {
	for {
		for d.sc.Scan() {
			line := append([]byte(nil), d.sc.Bytes()...)
			var in Inbound
			if json.Unmarshal(line, &in) != nil {
				continue
			}
			in.Line = line
			return in, nil
		}
		err := d.sc.Err()
		if err == nil {
			return Inbound{}, io.EOF
		}
		if !errors.Is(err, bufio.ErrTooLong) {
			return Inbound{}, err
		}
		// Scan stopped at the token, not at the newline, so the rebuilt scanner
		// picks up mid-line and its first "line" is the tail of the frame that
		// was too big. That tail is not JSON, so the loop above drops it.
		d.sc = newProtoScanner(d.r)
		return Inbound{}, ErrFrameTooLong
	}
}

// Encoder writes outbound frames to T3's pipe.
//
// It is safe for concurrent use, and has to be: the reply to a control_request
// and a mirrored assistant message from the transcript tail are written by
// different goroutines, and two interleaved half-lines are two malformed
// frames.
type Encoder struct {
	mu sync.Mutex
	w  io.Writer
}

// NewEncoder wraps the bridge's stdout.
func NewEncoder(w io.Writer) *Encoder { return &Encoder{w: w} }

// Frame is one outbound stream-json frame. The interface is closed to the
// types below on purpose: T3 stores whatever it is handed, so a hand-rolled map
// with a typo'd key becomes a malformed message in a real thread.
type Frame interface{ frameType() string }

func (f ControlResponse) frameType() string { return f.Type }
func (f SystemInit) frameType() string      { return f.Type }
func (f AssistantFrame) frameType() string  { return f.Type }
func (f UserFrame) frameType() string       { return f.Type }
func (f ResultFrame) frameType() string     { return f.Type }

// Emit writes one frame as a single line.
func (e *Encoder) Emit(frame Frame) error {
	b, err := json.Marshal(frame)
	if err != nil {
		return fmt.Errorf("encode frame: %w", err)
	}
	b = append(b, '\n')
	e.mu.Lock()
	defer e.mu.Unlock()
	_, err = e.w.Write(b)
	return err
}

// ControlSuccess answers a control_request. payload may be nil, which is the
// right answer for every subtype the bridge has no opinion about — replying
// success to everything unrecognised is what keeps a T3 upgrade that adds a
// control verb from stalling a thread.
func (e *Encoder) ControlSuccess(requestID string, payload json.RawMessage) error {
	return e.Emit(ControlResponse{
		Type: TypeControlResponse,
		Response: ControlResponseBody{
			Subtype:   "success",
			RequestID: requestID,
			Response:  payload,
		},
	})
}

// ControlError answers a control_request that genuinely cannot be served.
func (e *Encoder) ControlError(requestID, message string) error {
	return e.Emit(ControlResponse{
		Type: TypeControlResponse,
		Response: ControlResponseBody{
			Subtype:   "error",
			RequestID: requestID,
			Error:     message,
		},
	})
}

// ControlResponse is the reply envelope. Note the nesting: request_id lives on
// the INNER object, not beside `type` (SDKControlResponse).
type ControlResponse struct {
	Type     string              `json:"type"`
	Response ControlResponseBody `json:"response"`
}

// ControlResponseBody is ControlResponse | ControlErrorResponse flattened —
// `error` is set on the error subtype, `response` on the success one.
type ControlResponseBody struct {
	Subtype   string          `json:"subtype"` // "success" | "error"
	RequestID string          `json:"request_id"`
	Response  json.RawMessage `json:"response,omitempty"`
	Error     string          `json:"error,omitempty"`
}

// SystemInit is the frame that tells T3 the session is up, and — decisively —
// which session id the thread's resume cursor should point at (verified fact
// 4: whatever the binary reports here becomes the cursor).
//
// The fields without omitempty are the ones SDKSystemMessage marks required.
type SystemInit struct {
	Type              string             `json:"type"`    // "system"
	Subtype           string             `json:"subtype"` // "init"
	SessionID         string             `json:"session_id"`
	UUID              string             `json:"uuid"`
	CWD               string             `json:"cwd"`
	Model             string             `json:"model"`
	PermissionMode    string             `json:"permissionMode"`
	APIKeySource      string             `json:"apiKeySource"`
	ClaudeCodeVersion string             `json:"claude_code_version"`
	OutputStyle       string             `json:"output_style"`
	Tools             []string           `json:"tools"`
	SlashCommands     []string           `json:"slash_commands"`
	Skills            []string           `json:"skills"`
	MCPServers        []MCPServerStatus  `json:"mcp_servers"`
	Plugins           []PluginDescriptor `json:"plugins"`
}

// MCPServerStatus is one entry of system/init's mcp_servers.
type MCPServerStatus struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

// PluginDescriptor is one entry of system/init's plugins.
type PluginDescriptor struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// AssistantFrame mirrors one transcript assistant record into the thread.
//
// Message is the transcript record's `message` object VERBATIM
// (sessionio.Record.Message.Raw): it is already a BetaMessage, so re-encoding
// it from parsed fields would drop usage, stop_details and anything a future
// Claude adds. ParentToolUseID is a pointer because the SDK type requires the
// key and allows null — an omitted key is not the same frame.
type AssistantFrame struct {
	Type            string          `json:"type"` // "assistant"
	Message         json.RawMessage `json:"message"`
	ParentToolUseID *string         `json:"parent_tool_use_id"`
	UUID            string          `json:"uuid"`
	SessionID       string          `json:"session_id"`
	Timestamp       string          `json:"timestamp,omitempty"`
}

// UserFrame mirrors one transcript user record — the human's prompt, or the
// harness handing Claude back a tool_result.
//
// IsReplay marks the frames emitted by the adoption replay rather than by live
// work (SDKUserMessageReplay, which requires uuid, session_id and isReplay).
// The SDK types it as the literal `true`, so a false value must be OMITTED
// rather than written — hence omitempty on a plain bool.
type UserFrame struct {
	Type            string          `json:"type"` // "user"
	Message         json.RawMessage `json:"message"`
	ParentToolUseID *string         `json:"parent_tool_use_id"`
	UUID            string          `json:"uuid"`
	SessionID       string          `json:"session_id"`
	Timestamp       string          `json:"timestamp,omitempty"`
	IsReplay        bool            `json:"isReplay,omitempty"`
}

// ResultFrame closes a turn. T3 treats it as "the turn is over"; the bridge
// emits one when the transcript settles (sessionio.EndsTurn) or when an
// interrupt lands.
//
// Subtype is "success", or one of error_during_execution / error_max_turns /
// error_max_budget_usd / error_max_structured_output_retries.
type ResultFrame struct {
	Type          string          `json:"type"`    // "result"
	Subtype       string          `json:"subtype"` // "success" | "error_*"
	IsError       bool            `json:"is_error"`
	DurationMs    int64           `json:"duration_ms"`
	DurationAPIMs int64           `json:"duration_api_ms"`
	NumTurns      int             `json:"num_turns"`
	Result        string          `json:"result"`
	StopReason    *string         `json:"stop_reason"`
	TotalCostUSD  float64         `json:"total_cost_usd"`
	Usage         json.RawMessage `json:"usage,omitempty"`
	UUID          string          `json:"uuid"`
	SessionID     string          `json:"session_id"`
}

// protoHandler is the tmux side of the bridge as the protocol loop sees it:
// somewhere to put a prompt, and a way to stop a turn. *Attacher satisfies it.
//
// The loop knows nothing else about tmux, which is what lets the whole
// handshake be exercised over two buffers with no session, no transcript and
// no T3 anywhere near the test.
type protoHandler interface {
	Send(text string) error
	Interrupt() error
}

// protoLoop is the upward half of the bridge: it decodes T3's frames, answers
// the control channel, and hands prompts to the tmux side.
type protoLoop struct {
	In      *Decoder
	Out     *Encoder
	Handler protoHandler
	// SessionID is the Claude session uuid this bridge declared in system/init.
	// Every frame it originates carries that id, so the thread only ever hears
	// about one conversation.
	SessionID string
}

// Handshake completes T3's opening exchange: answer the initialize
// control_request, then emit system/init (verified fact 2). It returns the
// frames that arrived BEFORE initialize, which Serve delivers first.
//
// Those early frames are held rather than dropped because a prompt T3 has
// already written is a turn: dropping it leaves the thread waiting for a reply
// to something the bridge threw away. Control requests that precede initialize
// are answered on the spot — a promise T3 is holding must settle whatever else
// is going on.
func (l *protoLoop) Handshake(init SystemInit) ([]Inbound, error) {
	var pending []Inbound
	for {
		frame, err := l.In.Next()
		if errors.Is(err, ErrFrameTooLong) {
			log.Printf("handshake: dropped an inbound frame over %d bytes", protoMaxFrameBytes)
			continue
		}
		if err != nil {
			return pending, fmt.Errorf("handshake: %w", err)
		}
		if frame.Type != TypeControlRequest {
			pending = append(pending, frame)
			continue
		}
		if frame.ControlSubtype() != SubtypeInitialize {
			if err := l.Out.ControlSuccess(frame.RequestID, nil); err != nil {
				return pending, fmt.Errorf("handshake: answer %s: %w", frame.ControlSubtype(), err)
			}
			continue
		}
		if err := l.Out.ControlSuccess(frame.RequestID, protoInitializeResponse()); err != nil {
			return pending, fmt.Errorf("handshake: answer initialize: %w", err)
		}
		if err := l.Out.Emit(init); err != nil {
			return pending, fmt.Errorf("handshake: system/init: %w", err)
		}
		return pending, nil
	}
}

// protoPromptQueue is how many prompts may be waiting on the tmux side before
// the reader has to wait too. T3 sends one turn at a time in practice, so this
// is slack for a burst rather than a design capacity.
const protoPromptQueue = 32

// Serve reads frames until T3 closes the pipe, delivering pending (the frames
// Handshake held back) first.
//
// CONTROL REQUESTS ARE ANSWERED ON THE READING GOROUTINE; prompts are handed to
// a worker. That split is the whole point of this function. Delivering a prompt
// can take seconds — the tmux session may have to be brought back first, and
// the stamp it waits for travels the long way round — and while the reader was
// the thing doing that, nothing read the pipe: an operator pressing Stop got no
// control_response at all until the wait finished, or ever, if it timed out.
// T3 is holding a promise on every control_request, and a promise has to settle
// whatever else is going on.
//
// It takes no context on purpose. A blocking read on stdin is not cancellable,
// so a context here would be a promise the loop cannot keep; run owns
// cancellation and lets the process exit out from under this goroutine.
func (l *protoLoop) Serve(pending []Inbound) error {
	prompts := make(chan Inbound, protoPromptQueue)
	worked := make(chan error, 1)
	go func() {
		for frame := range prompts {
			if err := l.prompt(frame); err != nil {
				worked <- err
				return
			}
		}
		worked <- nil
	}()
	// The worker owns the channel's close, and the reader owns the send, so the
	// reader closes on its way out and then waits for the worker to drain.
	defer func() { <-worked }()
	defer close(prompts)

	deliver := func(frame Inbound) error {
		if frame.Type == TypeUser {
			select {
			case prompts <- frame:
				return nil
			case err := <-worked:
				// The worker has stopped; nothing will ever take this prompt.
				worked <- err
				if err == nil {
					err = errors.New("the prompt worker stopped")
				}
				return err
			}
		}
		return l.dispatch(frame)
	}

	for _, frame := range pending {
		if err := deliver(frame); err != nil {
			return err
		}
	}
	for {
		frame, err := l.In.Next()
		if errors.Is(err, ErrFrameTooLong) {
			// The frame is gone and the stream has been re-anchored. If it was a
			// prompt T3 is waiting on, this is the only chance to say so.
			log.Printf("dropped an inbound frame over %d bytes", protoMaxFrameBytes)
			if emitErr := l.Out.Emit(protoResultError(l.SessionID,
				fmt.Sprintf("that message is larger than the %d MiB the bridge can carry", protoMaxFrameBytes>>20))); emitErr != nil {
				return emitErr
			}
			continue
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("read from t3: %w", err)
		}
		if err := deliver(frame); err != nil {
			return err
		}
	}
}

// dispatch acts on one inbound frame. An error here is a write failure on the
// pipe to T3, not a frame the bridge disliked: a frame it cannot map is logged
// and stepped over, because T3 upgrades nightly and one unknown frame type
// must not end a session.
func (l *protoLoop) dispatch(frame Inbound) error {
	switch frame.Type {
	case TypeControlRequest:
		return l.control(frame)
	case TypeUser:
		return l.prompt(frame)
	default:
		protoUnmappable("inbound frame", frame.Line, fmt.Sprintf("type %q is not one the bridge acts on", frame.Type))
		return nil
	}
}

// control answers one control_request.
func (l *protoLoop) control(frame Inbound) error {
	switch subtype := frame.ControlSubtype(); subtype {
	case SubtypeInterrupt:
		// A Stop button that stopped nothing must not report success — the
		// operator would believe the turn was cancelled while it runs on.
		if err := l.Handler.Interrupt(); err != nil {
			log.Printf("interrupt failed: %v", err)
			return l.Out.ControlError(frame.RequestID, err.Error())
		}
		return l.Out.ControlSuccess(frame.RequestID, nil)

	case SubtypeInitialize:
		// A second initialize is a client re-attaching (SDK reinitialize).
		return l.Out.ControlSuccess(frame.RequestID, protoInitializeResponse())

	case SubtypeSetPermissionMode:
		// The pane's Claude was started with the mode it has; --permission-mode
		// is a launch flag and there is no way to change it from outside. Say
		// so in the journal and succeed, because failing here would wedge the
		// thread over a setting the operator can change in the pane.
		log.Printf("set_permission_mode ignored: the session's permission mode is fixed at launch")
		return l.Out.ControlSuccess(frame.RequestID, nil)

	default:
		// Includes get_context_usage — the bridge genuinely does not know the
		// pane Claude's context usage, and t3 treats an absent response as
		// "no data" (`if (!usage) return`) rather than an error.
		return l.Out.ControlSuccess(frame.RequestID, nil)
	}
}

// prompt delivers one user message to the pane.
//
// The syncer's warm-up turn (decision 11) goes through the handler like any
// other prompt rather than being answered here. It has to: it is the frame that
// tells an adoption which conversation it is adopting, so the tmux side is the
// only thing that can act on it. Every handler on that side swallows it —
// Attacher.Send checks IsSentinel before it reaches a pane — so the rule "it
// never gets typed into a live session" is still held where a prompt could
// actually get out.
func (l *protoLoop) prompt(frame Inbound) error {
	text := frame.Text()

	if strings.TrimSpace(text) == "" {
		// An image-only prompt, or a shape we have not met. Pasting it would
		// submit a blank line into a live session, which is worse than
		// dropping it: the design has no ruling here, so the journal gets the
		// whole frame and the pane gets nothing.
		reason := "no text to paste"
		if dropped := protoDroppedBlocks(frame); len(dropped) > 0 {
			reason = fmt.Sprintf("no text to paste, only %s", strings.Join(dropped, ", "))
		}
		protoUnmappable("user frame", frame.Line, reason)
		return nil
	}

	if err := l.Handler.Send(text); err != nil {
		// A prompt that could not be pasted is a turn T3 will wait on forever
		// unless it is told. The session itself is still fine, so this closes
		// the turn rather than ending the bridge.
		log.Printf("send failed: %v", err)
		return l.Out.Emit(protoResultError(l.SessionID, err.Error()))
	}
	return nil
}

// protoFrameFor translates one transcript record into the frame that mirrors it
// (CONTRACT §4.5). ok=false means the record carries no conversation and is
// dropped — Record.Conversational is a whitelist, so every record type Claude
// Code invents next is dropped by default rather than leaking into a thread.
//
// This is a key mapping, not a rewrite: `message` goes across verbatim, so
// tool_use and tool_result blocks arrive exactly as Claude wrote them and T3
// renders them natively.
//
// sessionID is the identity the bridge declared in system/init and wins over
// the record's own when set. A bridge speaks for one conversation per
// invocation; a frame that suddenly claimed a different session would be a
// thread talking about a session T3 has never heard of.
func protoFrameFor(rec sessionio.Record, sessionID string, replay bool) (Frame, bool) {
	if !rec.Conversational() {
		return nil, false
	}
	if len(rec.Message.Raw) == 0 {
		protoUnmappable("transcript record", rec.Line, "conversational record with no message object")
		return nil, false
	}
	id := sessionID
	if id == "" {
		id = rec.ClaudeID()
	}
	switch rec.Type {
	case sessionio.RecordAssistant:
		return AssistantFrame{
			Type:      TypeAssistant,
			Message:   rec.Message.Raw,
			UUID:      rec.UUID,
			SessionID: id,
			Timestamp: rec.Timestamp,
		}, true
	case sessionio.RecordUser:
		return UserFrame{
			Type:      TypeUser,
			Message:   rec.Message.Raw,
			UUID:      rec.UUID,
			SessionID: id,
			Timestamp: rec.Timestamp,
			IsReplay:  replay,
		}, true
	}
	return nil, false
}

// protoResult closes a turn cleanly. The durations and the cost are zero
// because the bridge did not run the turn — the pane's Claude did, and the
// numbers it would need are not in the transcript.
func protoResult(sessionID, stopReason string) ResultFrame {
	frame := ResultFrame{
		Type:      TypeResult,
		Subtype:   "success",
		NumTurns:  1,
		UUID:      protoUUID(),
		SessionID: sessionID,
	}
	// stop_reason is required and nullable; "unknown" is null, not "".
	if stopReason != "" {
		frame.StopReason = &stopReason
	}
	return frame
}

// protoResultError closes a turn that could not be served. T3 shows `result`
// to the operator, so it carries the reason rather than a code.
func protoResultError(sessionID, message string) ResultFrame {
	frame := protoResult(sessionID, "")
	frame.Subtype = "error_during_execution"
	frame.IsError = true
	frame.Result = message
	return frame
}

// protoSystemInit builds the frame that opens the session.
//
// session_id is the decisive field: whatever goes here becomes the thread's
// resume cursor in T3 (verified fact 4), so it is the Claude session uuid of
// the conversation this bridge is about to mirror and nothing else.
//
// The slices are non-nil deliberately — T3 maps over them, and a nil slice
// marshals to null.
func protoSystemInit(cfg Config, claudeVersion string) SystemInit {
	mode := cfg.PermissionMode
	if mode == "" {
		mode = "default"
	}
	if claudeVersion == "" {
		claudeVersion = protoUnknownVersion
	}
	return SystemInit{
		Type:           TypeSystem,
		Subtype:        "init",
		SessionID:      cfg.ClaudeID(),
		UUID:           protoUUID(),
		CWD:            cfg.CWD,
		Model:          cfg.Model,
		PermissionMode: mode,
		// The credentials belong to the Claude running in the pane, which is
		// signed in the ordinary way; the bridge holds none of its own.
		APIKeySource:      "oauth",
		ClaudeCodeVersion: claudeVersion,
		OutputStyle:       "default",
		Tools:             []string{},
		SlashCommands:     []string{},
		Skills:            []string{},
		MCPServers:        []MCPServerStatus{},
		Plugins:           []PluginDescriptor{},
	}
}

// protoInitializeResponse is the payload of the initialize reply.
//
// Everything is empty because the bridge offers nothing of its own: the slash
// commands, agents and models all belong to the Claude in the pane, which T3
// cannot drive through this channel anyway. The keys are present because
// SDKControlInitializeResponse marks them required, and empty arrays are what
// a consumer that maps over them needs. `account` is omitted rather than
// faked — t3 reads it with optional chaining.
func protoInitializeResponse() json.RawMessage {
	return json.RawMessage(`{"commands":[],"agents":[],"output_style":"default","available_output_styles":["default"],"models":[]}`)
}

// protoUnknownVersion is what the bridge reports when it could not ask the real
// claude. It is a legible placeholder rather than a plausible number: a wrong
// version in T3's UI is worse than an obviously absent one.
const protoUnknownVersion = "unknown"

// protoClaudeVersionTimeout bounds the one subprocess the handshake makes. T3
// has its own initialize timeout, and a hung `claude --version` must not be
// what spends it.
const protoClaudeVersionTimeout = 5 * time.Second

// protoClaudeVersion asks the real claude what version it is, for system/init's
// claude_code_version.
//
// It shells out — the same thing T3's own provider health probe does — because
// the alternative is hardcoding a number that goes stale the next time claude
// auto-updates. Called once per bridge start, so the cost is one short-lived
// process per thread opened, and never in the hot path.
func protoClaudeVersion() string {
	bin, err := RealClaudePath()
	if err != nil {
		log.Printf("cannot report claude_code_version: %v", err)
		return protoUnknownVersion
	}
	ctx, cancel := context.WithTimeout(context.Background(), protoClaudeVersionTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "--version").Output()
	if err != nil {
		log.Printf("%s --version: %v", bin, err)
		return protoUnknownVersion
	}
	// "2.1.233 (Claude Code)" — the version is the first field.
	fields := strings.Fields(string(out))
	if len(fields) == 0 {
		return protoUnknownVersion
	}
	return fields[0]
}

// protoUnmappableLogBytes caps what a dropped frame contributes to the journal.
// An inbound prompt can carry a pasted image; logging it whole would push
// megabytes into the journal for one dropped frame.
const protoUnmappableLogBytes = 512

// protoUnmappable records something the bridge received and could not act on.
//
// It goes to stderr, which T3 keeps out of the thread, and it always includes
// the payload: the frames worth finding here are the ones a T3 upgrade
// introduced, and a message without the bytes is not enough to act on.
func protoUnmappable(what string, payload []byte, reason string) {
	body := string(payload)
	if len(body) > protoUnmappableLogBytes {
		body = body[:protoUnmappableLogBytes] + fmt.Sprintf("… (%d bytes)", len(payload))
	}
	log.Printf("unmappable %s: %s: %s", what, reason, body)
}

// protoUUID mints a version-4 uuid for the frames the bridge originates
// (system/init and result). Frames that mirror a transcript record reuse that
// record's uuid instead, so re-emitting one is idempotent.
func protoUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand does not fail on Linux in practice, and a bridge that
		// exited here would take a live session's thread down over a cosmetic
		// field. Fall back to the clock: uniqueness within one process is all
		// this id is asked for.
		log.Printf("crypto/rand: %v — falling back to a clock-derived uuid", err)
		binary.BigEndian.PutUint64(b[0:8], uint64(time.Now().UnixNano()))
		binary.BigEndian.PutUint64(b[8:16], uint64(time.Now().UnixNano()>>7))
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}
