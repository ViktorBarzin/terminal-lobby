package telemetry

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"sync"

	standard "github.com/ViktorBarzin/telemetry/go"
)

// Product events (docs/adr/0048-usage-events-reach-the-event-pipeline.md).
//
// The usage events a PERSON causes are also sent, as Product events in the
// Segment spec, to the homelab's Event pipeline (infra ADR-0041), which keeps
// them in Rybbit beside every other app's. The journal line is written either
// way and stays the source the Grafana dashboard reads; this is a second copy
// of a subset, not a replacement for the stream.
//
// What is forwarded is a closed list, productNames below: things somebody did
// (a session created, a file saved, a prompt sent) and real state changes
// (claude.state_changed fires on a transition only, never on a repeated
// stamp). Diagnostics, sweeps, load timings and errors stay Ops telemetry and
// never leave the journal by this route.

// App is the name the Event pipeline knows this app by, and the key its
// Write key is registered under in Vault secret/rybbit.
const App = "terminal-lobby"

// productNames maps a catalog name to the Product event it is sent as. A name
// absent from the map is not forwarded. Most keep their name; the few whose
// verb was not past tense are renamed here, so the journal's series keep the
// names every existing query uses.
var productNames = map[string]string{
	"app.loaded": "app.loaded",

	"session.create_opened": "session.create_opened",
	"session.created":       "session.created",
	"session.selected":      "session.selected",
	"session.reopened":      "session.reopened",
	"session.renamed":       "session.renamed",
	"session.retitled":      "session.retitled",
	"session.moved":         "session.moved",
	"session.killed":        "session.killed",
	"session.restored":      "session.restored",
	"session.suspended":     "session.suspended",
	"session.resumed":       "session.resumed",
	"session.restarted":     "session.restarted",
	"text.picture_opened":   "text.picture_opened",
	"view.switched":         "view.switched",
	"watch.switched":        "watch.switched",

	"skill.installed":    "skill.installed",
	"skill.removed":      "skill.removed",
	"skill.deleted":      "skill.deleted",
	"skill.toggled":      "skill.toggled",
	"skill.edited":       "skill.edited",
	"plugin.installed":   "plugin.installed",
	"plugin.updated":     "plugin.updated",
	"plugin.uninstalled": "plugin.uninstalled",

	"project.created":        "project.created",
	"project.renamed":        "project.renamed",
	"project.deleted":        "project.deleted",
	"project.dir_changed":    "project.dir_changed",
	"project.member_added":   "project.member_added",
	"project.member_removed": "project.member_removed",
	"project.mode_changed":   "project.mode_changed",
	"project.coown_changed":  "project.coown_changed",
	"layout.reordered":       "layout.reordered",
	"layout.group_toggled":   "layout.group_toggled",
	"sidebar.toggled":        "sidebar.toggled",
	"agents.rail_toggled":    "agents.rail_toggled",
	"agents.steer_sent":      "agents.steer_sent",
	"workspace.arranged":     "workspace.arranged",

	"share.granted":     "share.granted",
	"share.revoked":     "share.revoked",
	"share.prompt_sent": "share.prompt_sent",
	"link.created":      "link.created",
	"link.revoked":      "link.revoked",

	"palette.opened": "palette.opened",
	"palette.action": "command.dispatched",
	"help.opened":    "help.opened",

	"gallery.opened":       "gallery.opened",
	"gallery.image_opened": "gallery.image_opened",
	"image.pasted":         "image.pasted",
	"image.uploaded":       "image.uploaded",
	"image.dropped":        "image.dropped",
	"image.shown":          "image.shown",
	"file.transferred":     "file.transferred",
	"file.attached":        "file.attached",
	"file.previewed":       "file.previewed",
	"file.edit_opened":     "file.edit_opened",
	"file.saved":           "file.saved",

	"browser.panel_open":   "browser.panel_opened",
	"browser.take_control": "browser.control_taken",
	"browser.hand_back":    "browser.control_returned",
	"browser.copy":         "browser.copied",
	"browser.paste":        "browser.pasted",
	"terminal.copied":      "terminal.copied",
	"terminal.pasted":      "terminal.pasted",
	"terminal.softkey":     "terminal.softkey_pressed",
	"terminal.gesture":     "terminal.gesture_used",

	"settings.opened": "settings.opened",
	"prefs.changed":   "prefs.changed",
	"theme.changed":   "theme.changed",

	"notify.opt_in":            "notify.opted_in",
	"notify.push_subscribed":   "notify.push_subscribed",
	"notify.push_unsubscribed": "notify.push_unsubscribed",
	"notify.clicked":           "notify.clicked",

	"claude.prompt_sent":   "claude.prompt_sent",
	"claude.cancelled":     "claude.cancelled",
	"claude.answered":      "claude.answered",
	"claude.state_changed": "claude.state_changed",
	"claude.state_set":     "claude.state_set",
}

// notAChange holds the forwarded events that are sometimes not what they say.
// claude.state_changed from "none" is a Claude's state stamped afresh when its
// mod says hello, which every live session does again each time session-events
// restarts; the journal keeps it, the Product event would count deploys.
var notAChange = map[string]func(Attrs) bool{
	"claude.state_changed": func(a Attrs) bool { return a["tl.from"] == "none" },
}

// ProductName reports the Product event a catalog name is sent as, and
// whether it is sent at all.
func ProductName(name string) (string, bool) {
	to, ok := productNames[name]
	return to, ok
}

// DeviceAttr is the browser's per-installation id (frontend-v2/src/telemetry/
// device.ts). It is sent as the event's anonymousId rather than a property.
const DeviceAttr = "tl.device"

// Per-value cap on a forwarded string. The journal allows MaxValueLen; the
// pipeline's whole property budget is standard.MaxPropertiesLength.
const maxProductValueLen = 256

var (
	productKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	personIDPattern   = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
)

// productKey turns tl.idleSeconds into idle_seconds and tl.eng.missing into
// eng_missing, or "" when nothing valid is left.
func productKey(key string) string {
	key = strings.TrimPrefix(key, "tl.")
	key = strings.ReplaceAll(standard.SnakeCaseKey(key), ".", "_")
	if !productKeyPattern.MatchString(key) {
		return ""
	}
	return key
}

// ProductProperties converts an event's attributes into Product event
// properties: tl.* names in snake_case, JSON scalars only, and at most
// standard.MaxPropertiesLength bytes as JSON. Keys are dropped from the end
// of their sorted order until the rest fit, so the same call site always
// sends the same shape.
func ProductProperties(attrs Attrs) map[string]any {
	out := make(map[string]any, len(attrs))
	for k, v := range attrs {
		if k == TraceKey || k == DeviceAttr || k == CallerAttr {
			continue
		}
		key := productKey(k)
		if key == "" {
			continue
		}
		switch val := v.(type) {
		case string:
			if len(val) > maxProductValueLen {
				val = val[:maxProductValueLen]
			}
			out[key] = val
		case bool, float64, float32, int, int64, int32, uint, uint64, uint32:
			out[key] = val
		}
	}
	if fits(out) {
		return out
	}
	keys := make([]string, 0, len(out))
	for k := range out {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for i := len(keys) - 1; i >= 0 && !fits(out); i-- {
		delete(out, keys[i])
	}
	return out
}

func fits(props map[string]any) bool {
	raw, err := json.Marshal(props)
	return err == nil && len(raw) <= standard.MaxPropertiesLength
}

// AnonymousFor is the anonymousId of a server-side event about osUser that
// carries no browser device id. Stable, so the identify sent once the Person
// is known joins every earlier event to them; a hash, so the id does not spell
// out the account name.
func AnonymousFor(osUser string) string {
	sum := sha256.Sum256([]byte(App + "/" + osUser))
	return "tl-" + hex.EncodeToString(sum[:16])
}

// ProductSink is the part of the telemetry library's *Client a Product calls.
type ProductSink interface {
	Track(ctx context.Context, event string, props map[string]any) error
	Identify(ctx context.Context, userID string, traits map[string]any) error
	Close() error
}

// queueSize bounds what waits for the sink. Telemetry never blocks a request:
// once this is full, new events are dropped.
const queueSize = 1024

// Product forwards one service's Product events and holds the Person id of
// each OS user it has seen a request from. A nil *Product does nothing.
type Product struct {
	sink  ProductSink
	queue chan func()
	done  chan struct{}

	mu      sync.Mutex
	persons map[string]string
	closed  bool
}

// NewProduct starts a Product sending through sink.
func NewProduct(sink ProductSink) *Product {
	p := &Product{
		sink:    sink,
		queue:   make(chan func(), queueSize),
		done:    make(chan struct{}),
		persons: map[string]string{},
	}
	go p.run()
	return p
}

func (p *Product) run() {
	defer close(p.done)
	for send := range p.queue {
		send()
	}
}

// enqueue hands send to the sending goroutine, or drops it when the queue is
// full or the Product is closed.
func (p *Product) enqueue(send func()) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return
	}
	select {
	case p.queue <- send:
	default:
	}
}

// drain waits until everything queued so far has reached the sink.
func (p *Product) drain() {
	reached := make(chan struct{})
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.queue <- func() { close(reached) }
	p.mu.Unlock()
	<-reached
}

// LearnPerson records that osUser is the Person personID: the Authentik hashed
// user id the proxy sends with each request (X-Authentik-Uid). A new or
// changed id sends one identify, which joins the OS user's earlier anonymous
// events to the Person. Something that is not an id shape is ignored.
func (p *Product) LearnPerson(osUser, personID string) {
	if p == nil || osUser == "" || !personIDPattern.MatchString(personID) {
		return
	}
	p.mu.Lock()
	if p.persons[osUser] == personID {
		p.mu.Unlock()
		return
	}
	p.persons[osUser] = personID
	p.mu.Unlock()
	ctx := standard.WithAnonymousID(context.Background(), AnonymousFor(osUser))
	p.enqueue(func() { _ = p.sink.Identify(ctx, personID, nil) })
}

func (p *Product) personOf(osUser string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.persons[osUser]
}

// forward sends one emitted event when it is a person's: on the list, and not
// in a session a Caller made.
func (p *Product) forward(service, name, osUser string, attrs Attrs) {
	if p == nil {
		return
	}
	event, ok := productNames[name]
	if !ok {
		return
	}
	if caller, _ := attrs[CallerAttr].(string); caller != "" {
		return
	}
	if skip := notAChange[name]; skip != nil && skip(attrs) {
		return
	}
	anon, _ := attrs[DeviceAttr].(string)
	if !personIDPattern.MatchString(anon) {
		anon = AnonymousFor(osUser)
	}
	props := ProductProperties(attrs)
	props["service"] = service
	if !fits(props) {
		delete(props, "service")
	}
	ctx := standard.WithAnonymousID(context.Background(), anon)
	if person := p.personOf(osUser); person != "" {
		ctx = standard.WithEnduser(ctx, person)
	}
	p.enqueue(func() { _ = p.sink.Track(ctx, event, props) })
}

// Close sends what is queued and stops the sink. Call it on shutdown.
func (p *Product) Close() error {
	if p == nil {
		return nil
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	close(p.queue)
	p.mu.Unlock()
	<-p.done
	return p.sink.Close()
}
