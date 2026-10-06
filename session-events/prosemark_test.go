package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"terminal-lobby/sessionio"
)

// A prompt that opens with a pasted image's path reaches the mod marked, so
// Claude Code takes it even from a session running a mod older than 0.4.1
// (sessionio/prose.go). A command and plain prose go as written.
func TestAPathFirstPromptReachesTheModMarked(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	tok, _ := rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _, _ = c.send(ctx, modCommand{Op: "prompt", Text: "/tmp/a.png what is this?"}) }()
	go func() {
		_ = c.sendAll(ctx, []modCommand{{Op: "prompt", Text: "/unslop"}, {Op: "prompt", Text: "/var/b.png and this"}})
	}()
	want := map[string]bool{
		sessionio.ProseMark + "/tmp/a.png what is this?": true,
		"/unslop": true,
		sessionio.ProseMark + "/var/b.png and this": true,
	}
	for len(want) > 0 {
		rec := httptest.NewRecorder()
		rg.mods.handlePoll()(rec, httptest.NewRequest("GET", "/mod/v1/poll?token="+tok, nil))
		var body struct {
			Commands []modCommand `json:"commands"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("poll = %s (%v)", rec.Body.String(), err)
		}
		for _, cmd := range body.Commands {
			if !want[cmd.Text] {
				t.Fatalf("the mod got %q", cmd.Text)
			}
			delete(want, cmd.Text)
		}
	}
}
