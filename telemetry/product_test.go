package telemetry

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	standard "github.com/ViktorBarzin/telemetry/go"
)

// sent is one call a fake sink saw, with the ids the library would read off
// the context.
type sent struct {
	kind, event, userID, anonymousID string
	props                            map[string]any
}

type fakeSink struct {
	mu    sync.Mutex
	calls []sent
}

func (f *fakeSink) Track(ctx context.Context, event string, props map[string]any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, sent{"track", event, standard.Enduser(ctx), standard.AnonymousID(ctx), props})
	return nil
}

func (f *fakeSink) Identify(ctx context.Context, userID string, traits map[string]any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, sent{"identify", "", userID, standard.AnonymousID(ctx), traits})
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
	if got.anonymousID != AnonymousFor("wizard") {
		t.Errorf("anonymousId = %q, want the OS user's stable id", got.anonymousID)
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

func TestTheBrowsersDeviceIDIsTheAnonymousID(t *testing.T) {
	e, p, sink := newForwarding(t)
	e.Emit("session.selected", "wizard", Attrs{"tl.device": "d-1f2e3c", "tl.session": "w1"})
	tracks := sink.of(p, "track")
	if len(tracks) != 1 || tracks[0].anonymousID != "d-1f2e3c" {
		t.Fatalf("tracks = %+v", tracks)
	}
	if _, kept := tracks[0].props["device"]; kept {
		t.Error("the device id rides as anonymousId and should not be repeated as a property")
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
