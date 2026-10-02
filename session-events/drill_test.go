package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/sessionio/siotest"
)

func TestValidAgentID(t *testing.T) {
	for _, c := range []struct {
		id   string
		want bool
	}{
		{"a2b26c69d1c5ceb7b", true},
		{"aAngleA-46ca919f1dfe470f", true},
		{"wf_7e41b0c2-5d8#3", true}, // a member that never started: named, then 404
		{"", false},
		{".", false},
		{"..", false},
		{"../agent-a1", false},
		{"a1/../../x", false},
		{`a1\b`, false},
		{"a1\x00", false},
		{"a1\n", false},
		{strings.Repeat("a", 129), false},
	} {
		if got := validAgentID(c.id); got != c.want {
			t.Errorf("validAgentID(%q) = %v, want %v", c.id, got, c.want)
		}
	}
}

// A drill-in names an agent by id, and only an agent file the session
// directory really holds resolves. The watch's listing answers when it has the
// id; a watch nobody has subscribed to has listed nothing yet, so the
// directory is read once more rather than the agent being refused.
func TestAgentWatchResolvesOnlyTheSessionsOwnAgents(t *testing.T) {
	dir := t.TempDir()
	adHoc := writeAgent(t, dir, "subagents", "a1", `{"description":"first"}`,
		[]string{userLine("a1", 0, "go")}, agentClock)
	member := writeAgent(t, dir, "subagents/workflows/wf_r1", "m1", `{"agentType":"workflow-subagent"}`,
		[]string{userLine("m1", 0, "go")}, agentClock)
	writeAgent(t, dir, "subagents", "a2", `{"description":"no transcript yet"}`, nil, agentClock)

	r := newCountingReader()
	aw := newAgentWatch(dir, r)
	for _, c := range []struct {
		id   string
		want string
	}{
		{"a1", adHoc},
		{"m1", member},
		{"a2", ""},
		{"nobody", ""},
		{"../agent-a1", ""},
	} {
		got, ok := aw.Resolve(c.id)
		if ok != (c.want != "") || got != c.want {
			t.Errorf("Resolve(%q) = %q, %v; want %q", c.id, got, ok, c.want)
		}
	}

	// Once the watch has listed the directory, a known id costs no listing.
	aw.scan()
	before := r.listings()
	if got, ok := aw.Resolve("a1"); !ok || got != adHoc {
		t.Fatalf("Resolve after a scan = %q, %v", got, ok)
	}
	if r.listings() != before {
		t.Fatalf("a listed agent was resolved with another listing")
	}
}

// drillFixture is a registered session with one agent that has finished its
// work: a prompt, one tool call and its result, and an answer.
type drillFixture struct {
	rg      *registry
	tmux    string
	agent   string
	homeDir string
	cancel  context.CancelFunc
}

func newDrillFixture(t *testing.T) *drillFixture {
	t.Helper()
	const (
		osUser = "wizard"
		cwd    = "/home/wizard/qa"
		tmux   = "qa-drill"
	)
	homeBase := t.TempDir()
	transcript := writeTranscript(t, homeBase, osUser, cwd, "dddd-1111", "MARKER-DRILL")
	writeAgent(t, sessionio.SessionDir(transcript), "subagents", "a1", `{"description":"find the strip"}`, []string{
		userLine("a1", 0, "Find where the strip is drawn"),
		toolLine("a1", time.Second, "m1", "tu_grep", "Grep", `{"pattern":"tl-bg-strip"}`),
		`{"type":"user","isSidechain":true,"agentId":"a1","timestamp":"` + agentAt(2*time.Second) +
			`","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_grep","content":"TextView.tsx:863"}]}}`,
		endLine("a1", 3*time.Second, "m2", "It is drawn in TextView.tsx."),
	}, time.Now())

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	rg := newRegistry(ctx, time.Millisecond, homeBase, siotest.NewFakeOptions(osUser+"/"+tmux), osUser)
	rg.agentEvery = 5 * time.Millisecond
	register(t, rg, osUser, "dddd-1111", cwd, tmux)
	return &drillFixture{rg: rg, tmux: tmux, agent: "a1", homeDir: homeBase, cancel: cancel}
}

// server mounts the three drill-in routes the way main.go does, with the
// identity the auth middleware would have put on the request.
func (f *drillFixture) server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /events/{session}/agents/{agent}", f.rg.handleDrillEvents(time.Hour))
	mux.HandleFunc("GET /events/{session}/agents/{agent}/earlier", f.rg.handleDrillEarlier())
	mux.HandleFunc("GET /events/{session}/agents/{agent}/result/{toolId}", f.rg.handleDrillResult())
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mux.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), osUserKey, "wizard")))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// frame is one SSE frame: its event name ("" for a data-only one) and data.
type frame struct {
	name string
	data string
}

// openDrill reads a drill-in stream up to and including its `ready` frame.
func openDrill(t *testing.T, srv *httptest.Server, path string) ([]frame, func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, "GET", srv.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: %d", path, res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type %q", ct)
	}
	var frames []frame
	var cur frame
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				cur.name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				cur.data = strings.TrimPrefix(line, "data: ")
			case line == "" && cur.data != "":
				frames = append(frames, cur)
				if cur.name == "ready" {
					return
				}
				cur = frame{}
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("the drill-in stream never reached its ready frame")
	}
	return frames, func() {
		cancel()
		res.Body.Close()
	}
}

// The drill-in opens like a session does, on the agent's own file: the state
// frame, the history newest first, the ready frame. The agent's records read
// as a conversation of their own, so nothing on this stream is marked as work
// nested under a call, and the panel's `agents` frame is not sent here.
func TestDrillInStreamsTheAgentsOwnTranscript(t *testing.T) {
	f := newDrillFixture(t)
	srv := f.server(t)
	frames, closeStream := openDrill(t, srv, "/events/"+f.tmux+"/agents/"+f.agent+"?rev=1")
	defer closeStream()

	if frames[0].name != "state" {
		t.Fatalf("first frame is %q, want state", frames[0].name)
	}
	var back []sessionio.Event
	for _, fr := range frames {
		switch fr.name {
		case "agents":
			t.Fatal("the panel's agent set was sent on a drill-in stream")
		case "back":
			var e sessionio.Event
			if err := json.Unmarshal([]byte(fr.data), &e); err != nil {
				t.Fatalf("back frame %q: %v", fr.data, err)
			}
			back = append(back, e)
		}
	}
	if len(back) == 0 {
		t.Fatal("no history on the drill-in stream")
	}
	oldest := back[len(back)-1]
	if oldest.Kind != sessionio.KindUser || oldest.Body != "Find where the strip is drawn" {
		t.Fatalf("the oldest event is %+v, want the agent's prompt", oldest)
	}
	var sawTool, sawAnswer bool
	for _, e := range back {
		if e.Sidechain || e.AgentID != "" {
			t.Fatalf("event %d is marked as nested work: %+v", e.ID, e)
		}
		sawTool = sawTool || e.Kind == sessionio.KindToolUse && e.Tool == "Grep"
		sawAnswer = sawAnswer || e.Kind == sessionio.KindText && e.Body == "It is drawn in TextView.tsx."
	}
	if !sawTool || !sawAnswer {
		t.Fatalf("history is missing the tool call or the answer: %+v", back)
	}
	if frames[len(frames)-1].name != "ready" {
		t.Fatalf("last frame read is %q, want ready", frames[len(frames)-1].name)
	}
}

// Only what the session directory holds is served, and a request that names
// no session, or no agent of this one, or something that is not an id at all,
// is answered as such rather than read.
func TestDrillInRefusesWhatTheSessionDoesNotHold(t *testing.T) {
	f := newDrillFixture(t)
	srv := f.server(t)
	for _, c := range []struct {
		path string
		code int
	}{
		{"/events/" + f.tmux + "/agents/nobody?rev=1", http.StatusNotFound},
		{"/events/qa-unregistered/agents/a1?rev=1", http.StatusNotFound},
		{"/events/" + f.tmux + "/agents/..%2Fagent-a1?rev=1", http.StatusBadRequest},
		{"/events/" + f.tmux + "/agents/nobody/earlier?before=9&bytes=100", http.StatusNotFound},
		{"/events/" + f.tmux + "/agents/nobody/result/tu_grep", http.StatusNotFound},
		{"/events/" + f.tmux + "/agents/a1/result/tu_missing", http.StatusNotFound},
	} {
		res, err := http.Get(srv.URL + c.path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != c.code {
			t.Errorf("GET %s: %d, want %d", c.path, res.StatusCode, c.code)
		}
	}
}

// A capped tool result inside an agent is fetched in full from the agent's own
// file, and history further back is paged the way a session's is.
func TestDrillInServesFullResultsAndEarlierHistory(t *testing.T) {
	f := newDrillFixture(t)
	srv := f.server(t)

	res, err := http.Get(srv.URL + "/events/" + f.tmux + "/agents/a1/result/tu_grep")
	if err != nil {
		t.Fatal(err)
	}
	var full struct {
		Body string `json:"body"`
	}
	if err := json.NewDecoder(res.Body).Decode(&full); err != nil || res.StatusCode != 200 {
		t.Fatalf("result: %d %v", res.StatusCode, err)
	}
	res.Body.Close()
	if full.Body != "TextView.tsx:863" {
		t.Fatalf("full result = %q", full.Body)
	}

	// Everything below the newest event, one byte at a time: the step still
	// carries at least one event and says where the next one starts.
	d, err := f.rg.drill("wizard", f.tmux, "a1")
	if err != nil {
		t.Fatal(err)
	}
	<-d.ready
	head, _ := d.fs.Head()
	res, err = http.Get(srv.URL + "/events/" + f.tmux + "/agents/a1/earlier?before=" +
		itoa(head) + "&bytes=1")
	if err != nil {
		t.Fatal(err)
	}
	var step struct {
		Events []sessionio.Event `json:"events"`
		Cursor int64             `json:"cursor"`
	}
	if err := json.NewDecoder(res.Body).Decode(&step); err != nil || res.StatusCode != 200 {
		t.Fatalf("earlier: %d %v", res.StatusCode, err)
	}
	res.Body.Close()
	if len(step.Events) == 0 || step.Events[len(step.Events)-1].ID >= head {
		t.Fatalf("earlier returned %+v below %d", step.Events, head)
	}
}

// Two drill-ins of one agent share one source: the second finds the one the
// first built, so a big agent file is read once however many tabs open it.
func TestDrillInBuildsOneSourcePerAgent(t *testing.T) {
	f := newDrillFixture(t)
	a, err := f.rg.drill("wizard", f.tmux, "a1")
	if err != nil {
		t.Fatal(err)
	}
	b, err := f.rg.drill("wizard", f.tmux, "a1")
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatal("a second drill-in of the same agent built a second source")
	}
}

// A drill-in stream is a reader of its session: while one is open the idle
// sweep keeps the session's source, and so its agent watch, which is how a
// drill-in opened on its own still resolves agents. A drill-in nobody reads is
// let go after the same grace as a session, and the session with it once
// nothing at all reads it.
func TestADrillInKeepsItsSessionAlive(t *testing.T) {
	f := newDrillFixture(t)
	now := time.Unix(1000, 0)
	f.rg.now = func() time.Time { return now }

	ls, ok := f.rg.live("wizard", f.tmux)
	if !ok {
		t.Fatal("session does not resolve")
	}
	d, err := f.rg.drill("wizard", f.tmux, "a1")
	if err != nil {
		t.Fatal(err)
	}
	_, release := d.fs.Subscribe()

	for i := 0; i < 3; i++ {
		f.rg.sweep()
		now = now.Add(idleGrace)
	}
	select {
	case <-ls.done:
		t.Fatal("the sweep retired a session somebody was reading an agent of")
	default:
	}
	if again, err := f.rg.drill("wizard", f.tmux, "a1"); err != nil || again != d {
		t.Fatalf("the drill-in source did not survive the sweep: %v", err)
	}

	// Once nobody reads the agent, its drill-in is let go. The session stays:
	// its mod is still connected and feeding it.
	release()
	for i := 0; i < 3; i++ {
		f.rg.sweep()
		now = now.Add(idleGrace)
	}
	select {
	case <-d.done:
	case <-time.After(2 * time.Second):
		t.Fatal("an unread drill-in was not let go")
	}
	select {
	case <-ls.ctx.Done():
		t.Fatal("the session was retired while its mod is connected")
	default:
	}
}

// While the session has a reader of its own, an agent nobody is reading any
// more is let go on its own, and the session stays.
func TestAnUnreadDrillInIsLetGoOnItsOwn(t *testing.T) {
	f := newDrillFixture(t)
	now := time.Unix(1000, 0)
	f.rg.now = func() time.Time { return now }

	ls, _ := f.rg.live("wizard", f.tmux)
	_, releaseSession := ls.fs.Subscribe()
	defer releaseSession()
	d, err := f.rg.drill("wizard", f.tmux, "a1")
	if err != nil {
		t.Fatal(err)
	}
	f.rg.sweep()
	now = now.Add(idleGrace + time.Second)
	f.rg.sweep()
	select {
	case <-d.done:
	case <-time.After(2 * time.Second):
		t.Fatal("a drill-in nobody reads kept tailing")
	}
	select {
	case <-ls.done:
		t.Fatal("letting an agent go retired its session too")
	default:
	}
	if again, err := f.rg.drill("wizard", f.tmux, "a1"); err != nil || again == d {
		t.Fatalf("reopening a let-go drill-in: %v (same source: %v)", err, again == d)
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
