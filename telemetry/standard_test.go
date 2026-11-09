package telemetry

import (
	"bytes"
	"context"
	"log"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

type countingHandler struct{ n *int }

func (h countingHandler) Enabled(context.Context, slog.Level) bool  { return true }
func (h countingHandler) Handle(context.Context, slog.Record) error { *h.n++; return nil }
func (h countingHandler) WithAttrs([]slog.Attr) slog.Handler        { return h }
func (h countingHandler) WithGroup(string) slog.Handler             { return h }

// The dashboard's queries strip everything up to "TLEVENT " and parse the
// rest. Once a service sends its log lines through the JSON handler, an event
// line routed the same way would arrive as an escaped string inside "body"
// and parse as nothing, silently. So event lines bypass slog and keep the
// standard logger's text shape.
func TestJournalLinesBypassTheJSONLogHandler(t *testing.T) {
	var buf bytes.Buffer
	saved := journal.Load()
	journal.Store(log.New(&buf, "", log.LstdFlags))
	defer journal.Store(saved)
	prev := slog.Default()
	defer slog.SetDefault(prev)
	n := 0
	slog.SetDefault(slog.New(countingHandler{&n}))

	New("tmux-api", "v1", nil).Emit("session.created", "wizard", Attrs{"tl.session": "w1"})

	if n != 0 {
		t.Fatalf("the event went through slog %d time(s)", n)
	}
	line := strings.TrimSpace(buf.String())
	if !regexp.MustCompile(`^\d{4}/\d\d/\d\d \d\d:\d\d:\d\d TLEVENT \{"ts":`).MatchString(line) {
		t.Fatalf("journal line = %q", line)
	}
}

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

// The package is open source and runs on boxes that have no pipeline: without
// a Write key nothing is built and nothing is sent.
func TestProductIsOffWithoutAWriteKey(t *testing.T) {
	p, err := ProductFromEnv(env(map[string]string{"TELEMETRY_ENVIRONMENT": "production"}), "v1")
	if err != nil || p != nil {
		t.Fatalf("got %v, %v; want no Product and no error", p, err)
	}
}

// Outside production the library validates and sends nothing, which is what
// a dev tier or a laptop with the key copied in should do.
func TestProductOutsideProductionSendsNothing(t *testing.T) {
	p, err := ProductFromEnv(env(map[string]string{"TELEMETRY_WRITE_KEY": "k-0123456789"}), "v1")
	if err != nil {
		t.Fatal(err)
	}
	if p == nil {
		t.Fatal("a Write key gives a Product, which validates and drops outside production")
	}
	defer p.Close()
}

func TestProductionNeedsThePipelineURL(t *testing.T) {
	_, err := ProductFromEnv(env(map[string]string{
		"TELEMETRY_WRITE_KEY": "k-0123456789", "TELEMETRY_ENVIRONMENT": "production",
	}), "v1")
	if err == nil {
		t.Fatal("production with no TELEMETRY_HOST should say so rather than send nowhere")
	}
}

func TestProductionBuildsAClient(t *testing.T) {
	p, err := ProductFromEnv(env(map[string]string{
		"TELEMETRY_WRITE_KEY":   "k-0123456789",
		"TELEMETRY_ENVIRONMENT": "production",
		"TELEMETRY_HOST":        "http://127.0.0.1:9/_t/e",
	}), "v1")
	if err != nil || p == nil {
		t.Fatalf("got %v, %v", p, err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
}

// A panicking handler still panics on after the report, so net/http keeps
// logging it and dropping the connection the way it did before.
func TestReportPanicsPanicsOn(t *testing.T) {
	h := ReportPanics(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }))
	defer func() {
		if recover() == nil {
			t.Fatal("the panic was swallowed")
		}
	}()
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
}
