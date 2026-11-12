package telemetry

import (
	"context"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	standard "github.com/ViktorBarzin/telemetry/go"
	"github.com/getsentry/sentry-go"
	sentryhttp "github.com/getsentry/sentry-go/http"
	"github.com/segmentio/analytics-go/v3"
)

// The homelab telemetry standard (infra ADR-0041), as each service turns it
// on at start: JSON log lines with OpenTelemetry field names, Product events
// to the Event pipeline, and errors to GlitchTip. All three read the
// environment, which on the devvm is /etc/terminal-lobby.local.conf:
//
//	TELEMETRY_WRITE_KEY    the app's Write key; unset sends no events
//	TELEMETRY_HOST         the Event pipeline's base URL
//	TELEMETRY_ENVIRONMENT  only "production" sends anything
//	SENTRY_DSN             GlitchTip's DSN; unset reports no errors
//
// A box with none of them set writes JSON logs and sends nothing.

// sendInterval is how long an event can wait in analytics-go before it is
// posted. Its default is five seconds, and a restart loses what is waiting;
// the lobby restarts its services on every release, so the window is kept
// short.
const sendInterval = time.Second

// ProductFromEnv builds the Product a service forwards through, from getenv.
// No Write key means no Product and no error.
func ProductFromEnv(getenv func(string) string, release string) (*Product, error) {
	key := strings.TrimSpace(getenv("TELEMETRY_WRITE_KEY"))
	if key == "" {
		return nil, nil
	}
	environment := strings.TrimSpace(getenv(standard.EnvironmentVariable))
	if environment == "" {
		environment = "dev"
	}
	cfg := standard.Config{
		App:         App,
		WriteKey:    key,
		Release:     release,
		Environment: environment,
		Endpoint:    strings.TrimSpace(getenv(standard.HostVariable)),
	}
	var opts []standard.Option
	if cfg.IsProduction() {
		if cfg.Endpoint == "" {
			return nil, fmt.Errorf("production telemetry needs $%s, the Event pipeline's URL", standard.HostVariable)
		}
		sc := standard.SegmentConfig(cfg)
		sc.Interval = sendInterval
		seg, err := analytics.NewWithConfig(key, sc)
		if err != nil {
			return nil, fmt.Errorf("segment client: %w", err)
		}
		opts = append(opts, standard.WithSegmentClient(seg))
	}
	client, err := standard.New(cfg, opts...)
	if err != nil {
		return nil, err
	}
	return NewProduct(client), nil
}

// Start turns the standard on for one service: its log lines become JSON on
// stdout, usage's person events are forwarded, and errors are reported. It returns the Product (nil when events are off), for the
// service to learn Person ids into, and a stop to call on a clean shutdown.
func Start(service, release string, usage *Emitter) (*Product, func()) {
	journal.Store(log.New(os.Stderr, "", log.LstdFlags))
	standard.SetupLogging(standard.HandlerOptions{ServiceName: service, ServiceVersion: release})
	var product *Product
	var err error
	if usage != nil {
		product, err = ProductFromEnv(os.Getenv, release)
	}
	switch {
	case usage == nil:
	case err != nil:
		slog.Warn("product events are off", "reason", err.Error())
	case product == nil:
		slog.Info("product events are off: no TELEMETRY_WRITE_KEY")
	default:
		slog.Info("product events are on", "environment", standard.ResolveEnvironment(""))
	}
	usage.SetProduct(product)

	cfg := standard.Config{App: App, Release: release, DSN: strings.TrimSpace(os.Getenv("SENTRY_DSN"))}
	if on, err := standard.InitSentry(cfg); err != nil {
		slog.Warn("error reports are off", "reason", err.Error())
	} else if on {
		sentry.ConfigureScope(func(s *sentry.Scope) { s.SetTag("service", service) })
	}
	return product, func() {
		_ = product.Close()
		sentry.Flush(2 * time.Second)
	}
}

// ReportPanics sends a handler's panic to GlitchTip and then panics on, so
// net/http still logs it and closes the connection as it always has. Without
// Sentry configured it only passes the request through.
func ReportPanics(h http.Handler) http.Handler {
	return sentryhttp.New(sentryhttp.Options{Repanic: true}).Handle(h)
}

// RequestContext puts each request's sender on its context: the browser's
// Rybbit visitor id (X-Visitor-Id), its IP (X-Real-Ip, which Traefik sets)
// and its User-Agent. Product events a handler emits with EmitContext and
// the request's context carry them, so Rybbit joins the event to the
// browser's visits and gives it a country and a device.
func RequestContext(h http.Handler) http.Handler {
	return standard.RequestMiddleware(nil)(h)
}

// WithVisitor fills in the visitor id when the request's header had none.
// sendBeacon cannot set headers, so the page's last batch before it hides
// names its visitor in the body instead. A value the header would not have
// passed is ignored.
func WithVisitor(ctx context.Context, visitorID string) context.Context {
	req := standard.CurrentRequest(ctx)
	if req.VisitorID != "" {
		return ctx
	}
	// Through RequestFrom, so the body's value meets the header's rules.
	h := http.Header{}
	h.Set(standard.VisitorHeader, visitorID)
	req.VisitorID = standard.RequestFrom(&http.Request{Header: h}).VisitorID
	return standard.WithRequest(ctx, req)
}
