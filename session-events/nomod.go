package main

import (
	"net/http"
	"strings"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
)

// StartingWait is how long a stream waits on a Claude that is running but has
// not said hello before it says the session has no mod. Today's slowest hello
// was 11 s after the session was created (2026-10-03).
const StartingWait = 30 * time.Second

// claudeSession reports whether a tmux session has run Claude: one of the
// options only Claude's state writers stamp is set. A pi or codex session, or
// a plain shell, has neither, and its Text view has never had a stream.
func claudeSession(o sessionio.Options, osUser, session string) bool {
	if v, _ := o.Option(osUser, session, sessionio.OptionTranscript); v != "" {
		return true
	}
	v, _ := o.Option(osUser, session, sessionio.OptionState)
	return v != ""
}

// paneProc is one pane's foreground command and the command it started with.
type paneProc struct{ Cmd, Start string }

// claudeRunning reports whether Claude is the foreground command of a pane.
func claudeRunning(panes []paneProc) bool {
	for _, p := range panes {
		if p.Cmd == "claude" {
			return true
		}
	}
	return false
}

// noStream is why a session has no mod stream, which decides what its Text
// view is told.
type noStream string

const (
	// noStreamShell: nothing Claude has ever run here. 404.
	noStreamShell noStream = "shell"
	// noStreamStarting: Claude is running, or about to be, and has not said
	// hello yet. Every new session spends its first seconds here.
	noStreamStarting noStream = "starting"
	// noStreamNoMod: a Claude that started before the lobby's mod existed.
	noStreamNoMod noStream = "nomod"
	// noStreamExited: Claude ran here and is not running now.
	noStreamExited noStream = "exited"
)

// classifyNoStream names why a session has no stream. stamped is
// claudeSession: the mod's hello stamps a session, so an unstamped one with
// Claude in its pane has not said hello yet. panes nil means they could not be
// read, and the stamps decide alone, as they did before panes were read.
func classifyNoStream(stamped bool, panes []paneProc) noStream {
	if panes == nil {
		if stamped {
			return noStreamNoMod
		}
		return noStreamShell
	}
	running, launched := claudeRunning(panes), false
	for _, p := range panes {
		if strings.Contains(p.Start, "claude") {
			launched = true
		}
	}
	switch {
	case running && stamped:
		return noStreamNoMod
	case running:
		return noStreamStarting
	case stamped:
		return noStreamExited
	case launched:
		// The login shell is still reading its rc files before it execs claude.
		return noStreamStarting
	}
	return noStreamShell
}

// whyNoStream classifies a session from its stamps and its panes.
func (h *modHub) whyNoStream(o sessionio.Options, osUser, session string) noStream {
	var panes []paneProc
	if h.paneProcs != nil {
		panes = h.paneProcs(osUser, session)
	}
	return classifyNoStream(claudeSession(o, osUser, session), panes)
}

// noModFrame is the `nomod` frame for a reason: a Claude from before the mod
// is restarted onto it once idle (rollout.go), an exited one is not.
func noModFrame(why noStream) map[string]string {
	if why == noStreamExited {
		return map[string]string{"claude": "exited"}
	}
	return map[string]string{"restart": "when-idle"}
}

// serveNoStream holds a stream open for a Claude session whose mod has not
// said hello, and ends it once one does, so the client reconnects onto the
// real stream. A starting Claude gets a `starting` frame; if it has not said
// hello within startingFor, recheck says what it is now and that frame
// follows. Otherwise the `nomod` frame goes out at once.
func serveNoStream(w http.ResponseWriter, r *http.Request, rg *registry, hb time.Duration,
	why noStream, recheck func() noStream, startingFor time.Duration) {
	osUser, session := osUserFrom(r.Context()), r.PathValue("session")
	hello, stop := rg.mods.awaitHello(osUser, session)
	defer stop()
	if rg.mods.conn(osUser, session) != nil {
		// Said hello between the lookup and the wait: the client reconnects.
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	sink, ok := openSSE(w, r)
	if !ok {
		return
	}
	defer sink.close()
	opened := time.Now()
	var deadline <-chan time.Time
	if why == noStreamStarting {
		sinkFrame(sink, "starting", map[string]int{"waitS": int(startingFor / time.Second)})
		dt := time.NewTimer(startingFor)
		defer dt.Stop()
		deadline = dt.C
	} else {
		sinkFrame(sink, "nomod", noModFrame(why))
	}
	sink.flush()
	// How long a Claude took to say hello, which nothing measured before.
	ended := func(outcome string) {
		if why == noStreamStarting {
			events.Emit("events.starting_ended", osUser, telemetry.Attrs{
				"tl.session": session, "tl.outcome": outcome,
				"tl.ms": time.Since(opened).Milliseconds(),
			})
		}
	}
	t := time.NewTicker(hb)
	defer t.Stop()
	for {
		select {
		case <-hello:
			ended("hello")
			return
		case <-r.Context().Done():
			ended("left")
			return
		case <-deadline:
			deadline = nil
			now := noStreamNoMod
			if recheck != nil {
				if n := recheck(); n == noStreamExited {
					now = n
				}
			}
			ended("timeout")
			why = now
			sinkFrame(sink, "nomod", noModFrame(now))
			sink.flush()
		case <-t.C:
			sink.print(": hb\n\n")
			sink.flush()
		}
	}
}
