package telemetry

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	standard "github.com/ViktorBarzin/telemetry/go"
	"github.com/segmentio/analytics-go/v3"
)

// sent is one call a fake sink saw, with the ids the library would read off
// the context.
type sent struct {
	kind, event, userID, anonymousID string
	props                            map[string]any
	req                              standard.Request
}

type fakeSink struct {
	mu    sync.Mutex
	calls []sent
}

func (f *fakeSink) Track(ctx context.Context, event string, props map[string]any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, sent{"track", event, standard.Enduser(ctx), standard.AnonymousID(ctx), props, standard.CurrentRequest(ctx)})
	return nil
}

func (f *fakeSink) Identify(ctx context.Context, userID string, traits map[string]any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, sent{"identify", "", userID, standard.AnonymousID(ctx), traits, standard.CurrentRequest(ctx)})
	return nil
}

func (f *fakeSink) Close() error { return nil }

// of waits for p to hand over what is queued, then returns the calls of kind.
func (f *fakeSink) of(p *Product, kind string) []sent {
	p.drain()
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []sent
	for _, c := range f.calls {
		if c.kind == kind {
			out = append(out, c)
		}
	}
	return out
}

// fakeSegment stands in for analytics-go under the real library client, so a
// test sees the message the pipeline would get.
type fakeSegment struct {
	mu   sync.Mutex
	msgs []analytics.Message
}

func (f *fakeSegment) Enqueue(m analytics.Message) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.msgs = append(f.msgs, m)
	return nil
}

func (f *fakeSegment) Close() error { return nil }

func (f *fakeSegment) tracks() []analytics.Track {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []analytics.Track
	for _, m := range f.msgs {
		if t, ok := m.(analytics.Track); ok {
			out = append(out, t)
		}
	}
	return out
}

const uidWizard = "0f3c5a4b2e1d9c8b7a6f5e4d3c2b1a09f8e7d6c5b4a3928170f6e5d4c3b2a190"

func newForwarding(t *testing.T) (*Emitter, *Product, *fakeSink) {
	t.Helper()
	sink := &fakeSink{}
	p := NewProduct(sink)
	e := New("tmux-api", "v1", &capture{})
	e.SetProduct(p)
	return e, p, sink
}

// The pipeline rejects a name outside noun.past_verb and a property key that
// is not snake_case, and it says so only in its own Loki stream. So every
// forwarded name has to pass the library's check here, and has to be a name
// the catalog lists, or the mapping names something Emit never lets through.
func TestEveryForwardedNameIsCataloguedAndPassesTheStandard(t *testing.T) {
	if len(productNames) < 40 {
		t.Fatalf("only %d events forwarded; the person-action set is about 70", len(productNames))
	}
	for from, to := range productNames {
		if !IsKnown(from) {
			t.Errorf("%q is forwarded but not in the catalog, so Emit never reaches the forwarder", from)
		}
		if err := standard.ValidateEventName(to); err != nil {
			t.Errorf("%q forwards as %q: %v", from, to, err)
		}
	}
}

// Two catalog names may not land on one Product event, or a count in Rybbit
// mixes two things people did.
func TestForwardedNamesAreDistinct(t *testing.T) {
	seen := map[string]string{}
	for from, to := range productNames {
		if other, dup := seen[to]; dup {
			t.Errorf("%q and %q both forward as %q", from, other, to)
		}
		seen[to] = from
	}
}

// Diagnostics, sweeps and load timings are Ops telemetry. They stay in the
// journal and never become Product events, whatever channel carries them.
func TestOpsRecordsAreNotForwarded(t *testing.T) {
	for _, name := range []string{
		"app.error", "app.reloaded", "api.error", "api.rejected", "mod.hello",
		"text.first_paint", "text.blank", "text.stale", "events.stream_opened",
		"session.grid_repinned", "session.grid_sized", "session.autonamed",
		"notify.stash_written", "notify.badge_set", "claude.permission_asked",
		"prompt.landed", "share.guest", "admin.actas", "admin.actas.exit",
	} {
		if to, ok := ProductName(name); ok {
			t.Errorf("%q is Ops telemetry but forwards as %q", name, to)
		}
	}
}

func TestPropertiesFollowTheStandard(t *testing.T) {
	got := ProductProperties(Attrs{
		"tl.session":     "worktree",
		"tl.idleSeconds": float64(86400),
		"tl.eng.missing": "AbortSignal.timeout",
		"tl.multi":       true,
		"tl.count":       3,
		"tl.empty":       nil,
		TraceKey:         []any{map[string]any{"k": "v"}},
		"tl.nested":      map[string]any{"a": 1},
		"tl.9lives":      "starts with a digit",
	})
	want := map[string]any{
		"session": "worktree", "idle_seconds": float64(86400),
		"eng_missing": "AbortSignal.timeout", "multi": true, "count": 3,
	}
	if len(got) != len(want) {
		t.Fatalf("properties = %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
	if err := standard.ValidateProperties(got); err != nil {
		t.Fatalf("the pipeline would reject these: %v", err)
	}
}

// The record shape allows 48 attributes of 512 bytes each, about 24 KB, and
// the pipeline takes 2,048 characters of properties. What leaves has to fit,
// and the same input has to keep the same keys every time.
func TestPropertiesFitThePipelineLimit(t *testing.T) {
	attrs := Attrs{}
	for i := 0; i < MaxAttrs; i++ {
		attrs["tl.k"+strings.Repeat("x", i%7)+string(rune('a'+i%26))+string(rune('a'+i/26))] = strings.Repeat("v", MaxValueLen)
	}
	first := ProductProperties(attrs)
	raw, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) > standard.MaxPropertiesLength {
		t.Fatalf("properties are %d bytes, over %d", len(raw), standard.MaxPropertiesLength)
	}
	if len(first) == 0 {
		t.Fatal("bounding dropped every property")
	}
	for i := 0; i < 5; i++ {
		again := ProductProperties(attrs)
		if len(again) != len(first) {
			t.Fatalf("run %d kept %d keys, the first kept %d", i, len(again), len(first))
		}
		for k := range first {
			if _, ok := again[k]; !ok {
				t.Fatalf("run %d dropped %q, which the first run kept", i, k)
			}
		}
	}
}

func TestEmitForwardsAPersonsActionUnderTheirPersonID(t *testing.T) {
	e, p, sink := newForwarding(t)
	p.LearnPerson("wizard", uidWizard)
	e.Emit("palette.action", "wizard", Attrs{"tl.key": "session.new", "tl.client": "lobby-v2"})

	tracks := sink.of(p, "track")
	if len(tracks) != 1 {
		t.Fatalf("want 1 track, got %d", len(tracks))
	}
	got := tracks[0]
	if got.event != "command.dispatched" {
		t.Errorf("event = %q, want the renamed command.dispatched", got.event)
	}
	if got.userID != uidWizard {
		t.Errorf("userId = %q, want the learned Person id", got.userID)
	}
	if got.anonymousID != "" {
		t.Errorf("anonymousId = %q, want none: the event has a userId and no visitor id", got.anonymousID)
	}
	if got.props["key"] != "session.new" || got.props["client"] != "lobby-v2" || got.props["service"] != "tmux-api" {
		t.Errorf("properties = %v", got.props)
	}
}

// A sweep or a hook can fire before the person's first request has told this
// process who they are. The event still goes, anonymous under the OS user's
// stable id, and the identify sent when the id is learned joins the two.
func TestBeforeThePersonIsKnownTheEventIsAnonymous(t *testing.T) {
	e, p, sink := newForwarding(t)
	e.Emit("claude.state_changed", "emo", Attrs{"tl.from": "running", "tl.to": "awaiting"})
	p.LearnPerson("emo", uidWizard)

	tracks := sink.of(p, "track")
	if len(tracks) != 1 || tracks[0].userID != "" || tracks[0].anonymousID != AnonymousFor("emo") {
		t.Fatalf("tracks = %+v", tracks)
	}
	ids := sink.of(p, "identify")
	if len(ids) != 1 || ids[0].userID != uidWizard || ids[0].anonymousID != AnonymousFor("emo") {
		t.Fatalf("identify = %+v, want one tying emo's anonymous id to the Person", ids)
	}
}

func TestIdentifyIsSentOncePerPersonAndAgainOnAChange(t *testing.T) {
	_, p, sink := newForwarding(t)
	p.LearnPerson("wizard", uidWizard)
	p.LearnPerson("wizard", uidWizard)
	p.LearnPerson("wizard", uidWizard)
	other := strings.Repeat("ab", 32)
	p.LearnPerson("wizard", other)
	ids := sink.of(p, "identify")
	if len(ids) != 2 || ids[0].userID != uidWizard || ids[1].userID != other {
		t.Fatalf("identify = %+v, want one per distinct id", ids)
	}
}

// The id comes off a request header. Something that is not an id shape is
// ignored rather than sent as a Person.
func TestLearnPersonIgnoresWhatIsNotAnID(t *testing.T) {
	_, p, sink := newForwarding(t)
	for _, bad := range []string{"", " ", "a b", "x\ny", strings.Repeat("a", 129), "wizard@example.com"} {
		p.LearnPerson("wizard", bad)
	}
	p.LearnPerson("", uidWizard)
	if n := len(sink.of(p, "identify")); n != 0 {
		t.Fatalf("%d identifies sent for ids that are not ids", n)
	}
}

// tl.device names a browser installation, which Rybbit knows nothing about.
// Sent as the anonymousId it made a Rybbit user of its own, apart from the
// pageviews of the same browser, so it is neither the id nor a property.
func TestTheDeviceIDIsNotTheAnonymousID(t *testing.T) {
	e, p, sink := newForwarding(t)
	p.LearnPerson("wizard", uidWizard)
	e.Emit("session.selected", "wizard", Attrs{"tl.device": "d-1f2e3c", "tl.session": "w1"})
	tracks := sink.of(p, "track")
	if len(tracks) != 1 || tracks[0].anonymousID != "" {
		t.Fatalf("tracks = %+v, want no explicit anonymousId", tracks)
	}
	if _, kept := tracks[0].props["device"]; kept {
		t.Error("the device id is not a Product property")
	}
}

var wizardBrowser = standard.Request{
	VisitorID: "rv-8c2f4e1a9b",
	ClientIP:  "203.0.113.7",
	UserAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)",
}

// An event sent while handling a browser's request carries who sent it: the
// Rybbit visitor id, the IP and the User-Agent. The visitor id is left for the
// library to send as the anonymousId, which an explicit one would override.
func TestAnEventFromARequestCarriesTheBrowser(t *testing.T) {
	e, p, sink := newForwarding(t)
	ctx := standard.WithRequest(context.Background(), wizardBrowser)
	e.EmitContext(ctx, "palette.opened", "wizard", Attrs{"tl.client": "lobby-v2"})

	tracks := sink.of(p, "track")
	if len(tracks) != 1 {
		t.Fatalf("want 1 track, got %d", len(tracks))
	}
	if tracks[0].req != wizardBrowser {
		t.Errorf("request = %+v, want %+v", tracks[0].req, wizardBrowser)
	}
	if tracks[0].anonymousID != "" {
		t.Errorf("anonymousId = %q set explicitly, which would hide the visitor id", tracks[0].anonymousID)
	}
}

// A request with no visitor id, before the Person is known, still needs a
// stable id: the OS user's, which the identify sent on learning joins.
func TestARequestWithoutAVisitorIDFallsBackToTheOSUsersID(t *testing.T) {
	e, p, sink := newForwarding(t)
	ctx := standard.WithRequest(context.Background(), standard.Request{ClientIP: "203.0.113.7"})
	e.EmitContext(ctx, "palette.opened", "emo", nil)
	tracks := sink.of(p, "track")
	if len(tracks) != 1 || tracks[0].anonymousID != AnonymousFor("emo") || tracks[0].req.ClientIP != "203.0.113.7" {
		t.Fatalf("tracks = %+v", tracks)
	}
}

// What the pipeline receives, through the real library: the browser's visitor
// id as anonymousId beside the Person, and the IP and agent in the context, so
// Rybbit can give the event a country and a device. Never a random id.
func TestThePipelineGetsTheVisitorIPAndAgent(t *testing.T) {
	seg := &fakeSegment{}
	client, err := standard.New(standard.Config{App: App, WriteKey: "k-0123456789", Environment: standard.Production},
		standard.WithSegmentClient(seg))
	if err != nil {
		t.Fatal(err)
	}
	p := NewProduct(client)
	e := New("tmux-api", "v1", &capture{})
	e.SetProduct(p)
	p.LearnPerson("wizard", uidWizard)

	e.EmitContext(standard.WithRequest(context.Background(), wizardBrowser), "palette.opened", "wizard", nil)
	e.Emit("session.suspended", "wizard", Attrs{"tl.session": "w1"})
	e.Emit("session.suspended", "emo", Attrs{"tl.session": "e1"})
	p.drain()

	tracks := seg.tracks()
	if len(tracks) != 3 {
		t.Fatalf("want 3 tracks, got %d", len(tracks))
	}
	browser, sweep, unknown := tracks[0], tracks[1], tracks[2]
	if browser.AnonymousId != wizardBrowser.VisitorID || browser.UserId != uidWizard {
		t.Errorf("browser event ids = %q / %q", browser.AnonymousId, browser.UserId)
	}
	if browser.Context == nil || browser.Context.IP.String() != wizardBrowser.ClientIP || browser.Context.UserAgent != wizardBrowser.UserAgent {
		t.Errorf("browser event context = %+v", browser.Context)
	}
	if sweep.AnonymousId != "" || sweep.UserId != uidWizard {
		t.Errorf("a known Person's sweep event = %q / %q, want no anonymousId", sweep.AnonymousId, sweep.UserId)
	}
	if sweep.Context != nil && (sweep.Context.IP != nil || sweep.Context.UserAgent != "") {
		t.Errorf("an event from no request carries a browser: %+v", sweep.Context)
	}
	if unknown.AnonymousId != AnonymousFor("emo") || unknown.UserId != "" {
		t.Errorf("an unknown Person's event = %q / %q, want the OS user's stable id", unknown.AnonymousId, unknown.UserId)
	}
}

// RequestContext is what puts the browser on a request's context, from the
// headers Traefik and the lobby page send.
func TestRequestContextReadsTheBrowserOffTheRequest(t *testing.T) {
	e, p, sink := newForwarding(t)
	h := RequestContext(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		e.EmitContext(r.Context(), "palette.opened", "wizard", nil)
	}))
	r := httptest.NewRequest(http.MethodPost, "/telemetry", nil)
	r.Header.Set(standard.VisitorHeader, wizardBrowser.VisitorID)
	r.Header.Set("X-Real-Ip", wizardBrowser.ClientIP)
	r.Header.Set("User-Agent", wizardBrowser.UserAgent)
	h.ServeHTTP(httptest.NewRecorder(), r)

	tracks := sink.of(p, "track")
	if len(tracks) != 1 || tracks[0].req != wizardBrowser {
		t.Fatalf("tracks = %+v, want the request's browser", tracks)
	}
}

// sendBeacon cannot set a header, so a batch the page sends as it hides
// names its visitor id in the body. The header wins when both are there, and
// a value that is not an id shape is ignored as the header's would be.
func TestWithVisitorFillsInAMissingVisitorID(t *testing.T) {
	base := standard.WithRequest(context.Background(), standard.Request{ClientIP: "203.0.113.7"})
	if got := standard.CurrentRequest(WithVisitor(base, "rv-beacon")); got.VisitorID != "rv-beacon" || got.ClientIP != "203.0.113.7" {
		t.Errorf("from the body: %+v", got)
	}
	withHeader := standard.WithRequest(context.Background(), wizardBrowser)
	if got := standard.CurrentRequest(WithVisitor(withHeader, "rv-beacon")); got.VisitorID != wizardBrowser.VisitorID {
		t.Errorf("the body replaced the header: %+v", got)
	}
	for _, bad := range []string{"", "a b", "x\ny", strings.Repeat("a", 200)} {
		if got := standard.CurrentRequest(WithVisitor(base, bad)); got.VisitorID != "" {
			t.Errorf("%q accepted as a visitor id", bad)
		}
	}
}

// A Caller's session is a program's work, and a System session is tooling's.
// Neither is something a person did.
func TestProgramsAndSystemSessionsAreNotForwarded(t *testing.T) {
	e, p, sink := newForwarding(t)
	e.SetDropRule(func(_, session string) bool { return session == "qa-1" })
	e.SetCallerRule(func(_, session string) string {
		if session == "muse-1" {
			return "muse"
		}
		return ""
	})
	e.Emit("claude.prompt_sent", "wizard", Attrs{"tl.session": "qa-1"})
	e.Emit("claude.prompt_sent", "wizard", Attrs{"tl.session": "muse-1"})
	e.Emit("claude.prompt_sent", "wizard", Attrs{"tl.session": "w1", CallerAttr: "muse"})
	e.Emit("claude.prompt_sent", "wizard", Attrs{"tl.session": "w1"})
	tracks := sink.of(p, "track")
	if len(tracks) != 1 || tracks[0].props["session"] != "w1" {
		t.Fatalf("tracks = %+v, want only the person's own session", tracks)
	}
}

func TestNotForwardedEventsStillReachTheJournal(t *testing.T) {
	c := &capture{}
	sink := &fakeSink{}
	p := NewProduct(sink)
	e := New("session-events", "v1", c)
	e.SetProduct(p)
	e.Emit("events.stream_opened", "wizard", Attrs{"tl.session": "w1"})
	e.Emit("claude.prompt_sent", "wizard", Attrs{"tl.session": "w1", "tl.n": 12})
	if len(c.lines) != 2 {
		t.Fatalf("journal lines = %d, want both events", len(c.lines))
	}
	if tracks := sink.of(p, "track"); len(tracks) != 1 || tracks[0].event != "claude.prompt_sent" {
		t.Fatalf("tracks = %+v", tracks)
	}
}

func TestANilProductIsInert(t *testing.T) {
	var p *Product
	p.LearnPerson("wizard", uidWizard)
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	e := New("tmux-api", "v1", &capture{})
	e.SetProduct(nil)
	e.Emit("session.created", "wizard", nil)
}

func TestAnonymousForIsStableAndPerUser(t *testing.T) {
	if AnonymousFor("wizard") != AnonymousFor("wizard") {
		t.Fatal("not stable")
	}
	if AnonymousFor("wizard") == AnonymousFor("emo") {
		t.Fatal("two users share an id")
	}
	if strings.Contains(AnonymousFor("wizard"), "wizard") {
		t.Fatal("the id spells out the account name")
	}
}

// When session-events restarts, every live Claude's mod says hello again and
// its state is stamped from nothing, which the journal records as a
// transition from "none". Measured on the first deploy: 11 of 11 forwarded
// state changes were that, none of them something a session did.
func TestAStateStampedFromNothingIsNotForwarded(t *testing.T) {
	e, p, sink := newForwarding(t)
	e.Emit("claude.state_changed", "wizard", Attrs{"tl.session": "w1", "tl.from": "none", "tl.to": "done"})
	e.Emit("claude.state_changed", "wizard", Attrs{"tl.session": "w1", "tl.from": "running", "tl.to": "done"})
	tracks := sink.of(p, "track")
	if len(tracks) != 1 || tracks[0].props["from"] != "running" {
		t.Fatalf("tracks = %+v, want only the real transition", tracks)
	}
}
