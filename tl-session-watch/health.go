package main

import (
	"fmt"
	"net/http"
	"sync/atomic"
	"time"
)

// The loopback health surface, matching every other service in this package so
// that tl-apply's post-install check covers this unit too. Without one, a
// release could break the watcher and still verify clean.
//
// It reports stale rather than up when ticks have stopped. A process answering
// 200 while wedged is the listener-less-zombie failure t3-watchdog exists for,
// and it is the same reason SessionWatchSilent watches the heartbeat rather than
// the unit's state.

// staleAfter is how many missed intervals make the answer untrustworthy. Three
// leaves room for one slow tick without flapping the check during a deploy.
const staleAfter = 3

func healthStatus(lastTick, now time.Time, interval time.Duration) (int, string) {
	if lastTick.IsZero() {
		return http.StatusServiceUnavailable, "no tick yet\n"
	}
	age := now.Sub(lastTick)
	body := fmt.Sprintf("last_tick=%s age=%s\n", lastTick.UTC().Format(time.RFC3339), age.Truncate(time.Second))
	if age > staleAfter*interval {
		return http.StatusServiceUnavailable, "stale " + body
	}
	return http.StatusOK, "ok " + body
}

// tickClock carries the last tick across the handler and the loop. Stored as
// unix nanos so the read needs no lock.
type tickClock struct{ nanos atomic.Int64 }

func (c *tickClock) mark(t time.Time) { c.nanos.Store(t.UnixNano()) }

func (c *tickClock) last() time.Time {
	n := c.nanos.Load()
	if n == 0 {
		return time.Time{}
	}
	return time.Unix(0, n)
}

// serveHealth starts the loopback listener. A failure to bind is logged and not
// fatal: the alerting half is what matters, and losing the check is a smaller
// loss than losing the watcher.
func serveHealth(addr string, clock *tickClock, interval time.Duration, logf func(string, ...any)) {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		code, body := healthStatus(clock.last(), time.Now(), interval)
		w.WriteHeader(code)
		_, _ = w.Write([]byte(body))
	})
	go func() {
		if err := http.ListenAndServe(addr, mux); err != nil {
			logf("event=health_listener_failed addr=%s error=%q", addr, err.Error())
		}
	}()
}
