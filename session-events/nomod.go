package main

import (
	"net/http"
	"time"

	"terminal-lobby/sessionio"
)

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

// serveNoMod holds a stream open for a Claude session whose mod has not said
// hello: one `nomod` frame, then heartbeats, and the stream ends once the mod
// connects so the client reconnects onto the real one.
func serveNoMod(w http.ResponseWriter, r *http.Request, rg *registry, hb time.Duration) {
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
	sinkFrame(sink, "nomod", map[string]string{"restart": "when-idle"})
	sink.flush()
	t := time.NewTicker(hb)
	defer t.Stop()
	for {
		select {
		case <-hello:
			return
		case <-r.Context().Done():
			return
		case <-t.C:
			sink.print(": hb\n\n")
			sink.flush()
		}
	}
}
