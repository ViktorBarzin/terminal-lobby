package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// GET /pi-models: which models this user's pi can run, asked of pi itself
// (docs/adr/0032-pi-lists-its-own-models-per-user.md).

// piListing is `pi --list-models` as pi 0.87.1 prints it: a header, then one
// padded row per model, provider then id, sorted.
const piListing = `provider   model                                 context  max-out  thinking  images
anthropic  claude-haiku-4-5-20251001             200K     64K      yes       yes
anthropic  claude-opus-5                         1M       128K     yes       yes
anthropic  claude-sonnet-4-5                     200K     64K      yes       yes
ollama     qwen2.5-coder:7b                      32K      8.2K     no        no
openai     gpt-4o                                128K     16.4K    no        yes
openrouter anthropic/claude-3.5-sonnet:beta      200K     8.2K     no        yes
`

// framed wraps a listing and a settings document the way tmux-user-attach
// --pi-models frames them, with an rc banner in front and a logout line after:
// the two kinds of noise a login shell adds.
func framed(listing, settings string) string {
	return "Welcome to the devvm!\n" +
		piMarkerModels + "\n" + listing +
		piMarkerSettings + "\n" + settings + "\n" +
		piMarkerEnd + "\nbye from .zlogout\n"
}

func TestParsePiModelsReadsTheListing(t *testing.T) {
	got, err := parsePiModels([]byte(framed(piListing, "")))
	if err != nil {
		t.Fatalf("parsePiModels: %v", err)
	}
	if !got.SignedIn {
		t.Error("a listing with rows is a signed-in pi")
	}
	want := []piModel{
		{Ref: "anthropic/claude-haiku-4-5-20251001", Provider: "anthropic", ID: "claude-haiku-4-5-20251001", Thinking: true},
		{Ref: "anthropic/claude-opus-5", Provider: "anthropic", ID: "claude-opus-5", Thinking: true},
		{Ref: "anthropic/claude-sonnet-4-5", Provider: "anthropic", ID: "claude-sonnet-4-5", Thinking: true},
		{Ref: "ollama/qwen2.5-coder:7b", Provider: "ollama", ID: "qwen2.5-coder:7b", Thinking: false},
		{Ref: "openai/gpt-4o", Provider: "openai", ID: "gpt-4o", Thinking: false},
		{Ref: "openrouter/anthropic/claude-3.5-sonnet:beta", Provider: "openrouter", ID: "anthropic/claude-3.5-sonnet:beta", Thinking: false},
	}
	if !reflect.DeepEqual(got.Models, want) {
		t.Fatalf("models =\n%+v\nwant\n%+v", got.Models, want)
	}
}

// What pi prints for an account with no provider signed in. It is an answer,
// not a failure: no rows, and nothing to report as an error.
func TestParsePiModelsKnowsANotSignedInPi(t *testing.T) {
	listing := "No models available. Use /login to log into a provider via OAuth or API key. See:\n" +
		"  /usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/providers.md\n" +
		"  /usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md\n"
	got, err := parsePiModels([]byte(framed(listing, "")))
	if err != nil {
		t.Fatalf("parsePiModels: %v", err)
	}
	if got.SignedIn || len(got.Models) != 0 {
		t.Fatalf("got %+v, want signed out with no rows", got)
	}
}

// Only rows in the listing's shape become models. The frame keeps banner and
// logout noise out; the shape keeps out anything pi itself adds that is not a
// row, and a row whose reference the launch gates would refuse.
func TestParsePiModelsKeepsOnlyRowsInTheListingsShape(t *testing.T) {
	listing := "provider   model  context  max-out  thinking  images\n" +
		"Warning: errors loading models.json:\n" +
		"anthropic  claude-opus-5  1M  128K  yes  yes\n" +
		"anthropic  claude opus 5  1M  128K  yes  yes\n" + // a space in an id: not a row
		"evil       x;rm -rf ~     1M  128K  yes  yes\n" +
		"anthropic  claude-opus-5[1m]  1M  128K  yes  yes\n" + // outside the pi gate
		"anthropic  " + strings.Repeat("m", 100) + "  1M  128K  yes  yes\n" +
		"anthropic  claude-x  1M  128K  maybe  yes\n"
	got, err := parsePiModels([]byte(framed(listing, "")))
	if err != nil {
		t.Fatalf("parsePiModels: %v", err)
	}
	if len(got.Models) != 1 || got.Models[0].Ref != "anthropic/claude-opus-5" {
		t.Fatalf("models = %+v, want only anthropic/claude-opus-5", got.Models)
	}
}

// The ways the call can fail to answer the question at all. Each is an error,
// which the handler turns into signedIn:false with a short reason.
func TestParsePiModelsFailures(t *testing.T) {
	for name, out := range map[string]string{
		"pi is not installed": "banner\n" + piMarkerMissing + "\n",
		"no frame at all":     "provider  model\nanthropic  claude-opus-5  1M  128K  yes  yes\n",
		"an empty listing":    framed("", ""),
		"only noise":          framed("something pi never prints\n", ""),
	} {
		t.Run(name, func(t *testing.T) {
			if got, err := parsePiModels([]byte(out)); err == nil {
				t.Fatalf("got %+v and no error", got)
			}
		})
	}
}

// enabledModels comes off the same call, framed after the listing. A settings
// file that is missing, empty or not JSON is no setting at all.
func TestParsePiModelsReadsEnabledModels(t *testing.T) {
	for name, tc := range map[string]struct {
		settings string
		want     []string
	}{
		"absent":         {"", nil},
		"not json":       {"{ this is not json", nil},
		"no key":         {`{"defaultModel":"claude-opus-5"}`, nil},
		"set":            {`{"enabledModels":["claude-opus-5","anthropic/*sonnet*:high"]}`, []string{"claude-opus-5", "anthropic/*sonnet*:high"}},
		"with a BOM":     {"\ufeff" + `{"enabledModels":["gpt-4o"]}`, []string{"gpt-4o"}},
		"a stray number": {`{"enabledModels":["gpt-4o",7]}`, []string{"gpt-4o"}},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := parsePiModels([]byte(framed(piListing, tc.settings)))
			if err != nil {
				t.Fatalf("parsePiModels: %v", err)
			}
			if !reflect.DeepEqual(got.Enabled, tc.want) {
				t.Fatalf("enabled = %q, want %q", got.Enabled, tc.want)
			}
		})
	}
}

func refsOf(ms []piModel) []string {
	out := make([]string, 0, len(ms))
	for _, m := range ms {
		out = append(out, m.Ref)
	}
	return out
}

// The filter the ADR describes: an exact id, an exact provider/id, or a glob
// with * and ?, each after its :thinking suffix is taken off. No setting, or a
// setting that matches nothing, keeps every row.
func TestFilterPiModels(t *testing.T) {
	listing, err := parsePiModels([]byte(framed(piListing, "")))
	if err != nil {
		t.Fatal(err)
	}
	all := refsOf(listing.Models)
	for name, tc := range map[string]struct {
		patterns []string
		want     []string
	}{
		"no setting":       {nil, all},
		"empty setting":    {[]string{}, all},
		"matches nothing":  {[]string{"mistral/*", "nope"}, all},
		"exact id":         {[]string{"claude-opus-5"}, []string{"anthropic/claude-opus-5"}},
		"exact ref":        {[]string{"openai/gpt-4o"}, []string{"openai/gpt-4o"}},
		"case-insensitive": {[]string{"Anthropic/Claude-Opus-5"}, []string{"anthropic/claude-opus-5"}},
		"thinking suffix":  {[]string{"claude-opus-5:high"}, []string{"anthropic/claude-opus-5"}},
		// pi tries a glob against the bare id as well as provider/id, so an
		// OpenRouter id that itself starts anthropic/ is caught too, there and
		// here.
		"glob on the ref":      {[]string{"anthropic/*"}, []string{"anthropic/claude-haiku-4-5-20251001", "anthropic/claude-opus-5", "anthropic/claude-sonnet-4-5", "openrouter/anthropic/claude-3.5-sonnet:beta"}},
		"glob on one provider": {[]string{"anthropic/claude-*-5"}, []string{"anthropic/claude-opus-5", "anthropic/claude-sonnet-4-5"}},
		// pi matches a glob with minimatch, whose * stops at a slash, so an id
		// that carries one is out of reach of a slash-free pattern there too.
		"glob on the id":    {[]string{"*sonnet*"}, []string{"anthropic/claude-sonnet-4-5"}},
		"glob with suffix":  {[]string{"*haiku*:low"}, []string{"anthropic/claude-haiku-4-5-20251001"}},
		"question mark":     {[]string{"gpt-4?"}, []string{"openai/gpt-4o"}},
		"star stops at /":   {[]string{"openrouter/*"}, all},
		"globstar crosses":  {[]string{"openrouter/**"}, []string{"openrouter/anthropic/claude-3.5-sonnet:beta"}},
		"a colon in the id": {[]string{"ollama/qwen2.5-coder:7b"}, []string{"ollama/qwen2.5-coder:7b"}},
		"several":           {[]string{"gpt-4o", "claude-opus-5"}, []string{"anthropic/claude-opus-5", "openai/gpt-4o"}},
		"order is pi's":     {[]string{"openai/*", "anthropic/claude-opus-5"}, []string{"anthropic/claude-opus-5", "openai/gpt-4o"}},
		"regex metachars":   {[]string{"gpt-4.", "(claude)+"}, all},
	} {
		t.Run(name, func(t *testing.T) {
			if got := refsOf(filterPiModels(listing.Models, tc.patterns)); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("filter %q = %q, want %q", tc.patterns, got, tc.want)
			}
		})
	}
}

func getPiModels(t *testing.T, auth string) piModelsBody {
	t.Helper()
	rec := httptest.NewRecorder()
	handlePiModels(rec, projectsReq(http.MethodGet, "/pi-models", "", auth))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 whatever pi said (%s)", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q", ct)
	}
	var body piModelsBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	// Models is a list on every path, never null: the picker iterates it.
	if !strings.Contains(rec.Body.String(), `"models":[`) {
		t.Errorf("models is not a JSON list: %s", rec.Body.String())
	}
	return body
}

func TestPiModelsServesTheFilteredListing(t *testing.T) {
	_, other := actAsFixture(t)
	t.Cleanup(stubPiModels(func(u string) ([]byte, error) {
		if u != other {
			t.Errorf("ran as %q, want the resolved OS user %q", u, other)
		}
		return []byte(framed(piListing, `{"enabledModels":["anthropic/claude-*-5"]}`)), nil
	}))
	got := getPiModels(t, "otherauth")
	if !got.SignedIn || got.Error != "" {
		t.Fatalf("got %+v, want a signed-in answer with no error", got)
	}
	if want := []string{"anthropic/claude-opus-5", "anthropic/claude-sonnet-4-5"}; !reflect.DeepEqual(refsOf(got.Models), want) {
		t.Fatalf("models = %q, want %q", refsOf(got.Models), want)
	}
	if got.Models[0] != (piModel{Ref: "anthropic/claude-opus-5", Provider: "anthropic", ID: "claude-opus-5", Thinking: true}) {
		t.Fatalf("row = %+v", got.Models[0])
	}
}

func TestPiModelsSaysWhenPiIsNotSignedIn(t *testing.T) {
	_, _ = actAsFixture(t)
	t.Cleanup(stubPiModels(func(string) ([]byte, error) {
		return []byte(framed("No models available. Use /login to log into a provider via OAuth or API key. See:\n", "")), nil
	}))
	got := getPiModels(t, "otherauth")
	if got.SignedIn || len(got.Models) != 0 || got.Error != "" {
		t.Fatalf("got %+v, want signed out, no rows, no error", got)
	}
}

// A call that fails is still a 200: the picker keeps its default choice, and
// the short reason says why there is nothing to pick from.
func TestPiModelsFailsSoft(t *testing.T) {
	_, _ = actAsFixture(t)
	for name, run := range map[string]func(string) ([]byte, error){
		"the call failed":     func(string) ([]byte, error) { return nil, errors.New("exit status 1") },
		"pi is not installed": func(string) ([]byte, error) { return []byte(piMarkerMissing + "\n"), nil },
		"noise":               func(string) ([]byte, error) { return []byte("nothing framed"), nil },
	} {
		t.Run(name, func(t *testing.T) {
			t.Cleanup(stubPiModels(run))
			got := getPiModels(t, "otherauth")
			if got.SignedIn || len(got.Models) != 0 || got.Error == "" {
				t.Fatalf("got %+v, want signedIn false, no rows and a reason", got)
			}
			if len(got.Error) > 80 {
				t.Errorf("error %q is not short", got.Error)
			}
		})
	}
}

// A login shell per request would be felt; the picker may open often.
func TestPiModelsCachesPerUser(t *testing.T) {
	admin, other := actAsFixture(t)
	calls := map[string]int{}
	t.Cleanup(stubPiModels(func(u string) ([]byte, error) {
		calls[u]++
		return []byte(framed(piListing, "")), nil
	}))
	for i := 0; i < 3; i++ {
		getPiModels(t, "otherauth")
	}
	getPiModels(t, "adminauth")
	if calls[other] != 1 || calls[admin] != 1 {
		t.Fatalf("calls = %v, want one per user", calls)
	}
	if piModelsTTL != 2*time.Minute {
		t.Errorf("piModelsTTL = %s, want the agreed 2m", piModelsTTL)
	}
}

func TestPiModelsIsGETOnly(t *testing.T) {
	_, _ = actAsFixture(t)
	t.Cleanup(stubPiModels(func(string) ([]byte, error) {
		t.Fatal("a refused method still ran pi")
		return nil, nil
	}))
	rec := httptest.NewRecorder()
	handlePiModels(rec, projectsReq(http.MethodPost, "/pi-models", "{}", "otherauth"))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST answered %d, want 405", rec.Code)
	}
}

// The same gate every per-user read uses: no identity, no answer, and no
// login shell run for nobody.
func TestPiModelsRefusesAnonymous(t *testing.T) {
	_, _ = actAsFixture(t)
	t.Cleanup(stubPiModels(func(string) ([]byte, error) {
		t.Fatal("an anonymous request ran pi")
		return nil, nil
	}))
	rec := httptest.NewRecorder()
	handlePiModels(rec, projectsReq(http.MethodGet, "/pi-models", "", ""))
	if rec.Code == http.StatusOK {
		t.Fatalf("an anonymous request answered 200: %s", rec.Body.String())
	}
}

func TestPiModelsGivesUpOnAShellThatHangs(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "hangs")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nsleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	prevScript, prevTimeout := attachScript, piModelsTimeout
	attachScript, piModelsTimeout = script, 200*time.Millisecond
	t.Cleanup(func() { attachScript, piModelsTimeout = prevScript, prevTimeout })

	start := time.Now()
	if _, err := runPiModels(selfUser); err == nil {
		t.Fatal("a call that never returns must be an error, not a wait")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("took %s to give up; the timeout is not being applied", elapsed)
	}
}

// The real script, end to end, with a stub pi and a stub password database.
// What it prints is what the parser above reads, so the two halves are tested
// against each other rather than each against a copy of the other.
func runPiModelsScript(t *testing.T, env []string, settings string, piBody string) string {
	return runPiModelsScriptRC(t, env, settings, piBody, "")
}

// runPiModelsScriptRC is runPiModelsScript with a ~/.bash_profile, which the
// snippet's login shell reads before it runs.
func runPiModelsScriptRC(t *testing.T, env []string, settings string, piBody string, rc string) string {
	t.Helper()
	script, err := filepath.Abs(filepath.Join("..", "devvm", "tmux-user-attach"))
	if err != nil || !fileExists(script) {
		t.Skip("tmux-user-attach not present")
	}
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}
	bin, home := t.TempDir(), t.TempDir()
	write := func(path, body string, mode os.FileMode) {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), mode); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(bin, "getent"), "#!/usr/bin/env bash\nprintf 'tl:x:1000:1000::%s:/bin/bash\\n' "+shellQuote(home)+"\n", 0o755)
	// Only the tools the script and the snippet use, linked in one by one. A
	// PATH that reached /usr/bin would find whatever pi this box has
	// installed, which is not the pi under test.
	for _, tool := range []string{"bash", "cat", "cut", "id", "timeout"} {
		real, err := exec.LookPath(tool)
		if err != nil {
			t.Skipf("%s not available", tool)
		}
		if err := os.Symlink(real, filepath.Join(bin, tool)); err != nil {
			t.Fatal(err)
		}
	}
	if piBody != "" {
		write(filepath.Join(bin, "pi"), piBody, 0o755)
	}
	if settings != "" {
		write(filepath.Join(home, ".pi", "agent", "settings.json"), settings, 0o644)
	}
	if rc != "" {
		write(filepath.Join(home, ".bash_profile"), rc, 0o644)
	}
	cmd := exec.Command(filepath.Join(bin, "bash"), script, "--pi-models")
	// PATH is the stubs and nothing else; HOME is the stub account's, as sudo
	// -H sets it.
	cmd.Env = append(os.Environ(), append([]string{"PATH=" + bin, "HOME=" + home}, env...)...)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("--pi-models: %v\n%s", err, out)
	}
	return string(out)
}

func TestPiModelsScriptFramesTheListingAndTheSettings(t *testing.T) {
	stub := "#!/bin/sh\ncase \" $* \" in *\" --list-models \"*) ;; *) exit 9 ;; esac\ncat <<'EOF'\n" + piListing + "EOF\n"
	out := runPiModelsScript(t, nil, `{"enabledModels":["claude-opus-5"]}`, stub)
	got, err := parsePiModels([]byte(out))
	if err != nil {
		t.Fatalf("parsePiModels: %v\n%s", err, out)
	}
	if !got.SignedIn || len(got.Models) != 6 {
		t.Fatalf("got %+v from\n%s", got, out)
	}
	if !reflect.DeepEqual(got.Enabled, []string{"claude-opus-5"}) {
		t.Fatalf("enabled = %q from\n%s", got.Enabled, out)
	}
}

// The listing runs with pi's extensions off. Loading them is what made the
// picker time out on 2026-09-26: pi-fabric took the call from 0.9 s to 7.7 s
// and started the user's MCP servers, for a list extensions do not change.
func TestPiModelsScriptListsWithoutExtensions(t *testing.T) {
	stub := "#!/bin/sh\ncase \" $* \" in *\" --no-extensions \"*) ;; *) exit 9 ;; esac\ncat <<'EOF'\n" + piListing + "EOF\n"
	got, err := parsePiModels([]byte(runPiModelsScript(t, nil, "", stub)))
	if err != nil {
		t.Fatal(err)
	}
	if !got.SignedIn || len(got.Models) != 6 {
		t.Fatalf("got %+v, want the listing from a pi run with --no-extensions", got)
	}
}

// A shell startup file that prints without a trailing newline must not glue
// itself onto the first marker. wizard's did on 2026-09-26, with a terminal
// escape sequence, and the picker read "pi printed no model list".
func TestPiModelsScriptSurvivesABannerWithoutANewline(t *testing.T) {
	stub := "#!/bin/sh\ncat <<'EOF'\n" + piListing + "EOF\n"
	rc := "printf '\\033]1337;SetUserVar=token=abc\\007'\n"
	got, err := parsePiModels([]byte(runPiModelsScriptRC(t, nil, "", stub, rc)))
	if err != nil {
		t.Fatal(err)
	}
	if !got.SignedIn || len(got.Models) != 6 {
		t.Fatalf("got %+v, want the listing despite the banner", got)
	}
}

// A user who relocated pi's directory set PI_CODING_AGENT_DIR in their own
// environment, and the settings are read from there.
func TestPiModelsScriptHonoursPiCodingAgentDir(t *testing.T) {
	elsewhere := t.TempDir()
	if err := os.WriteFile(filepath.Join(elsewhere, "settings.json"), []byte(`{"enabledModels":["gpt-4o"]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	stub := "#!/bin/sh\ncat <<'EOF'\n" + piListing + "EOF\n"
	out := runPiModelsScript(t, []string{"PI_CODING_AGENT_DIR=" + elsewhere}, `{"enabledModels":["claude-opus-5"]}`, stub)
	got, err := parsePiModels([]byte(out))
	if err != nil {
		t.Fatalf("parsePiModels: %v\n%s", err, out)
	}
	if !reflect.DeepEqual(got.Enabled, []string{"gpt-4o"}) {
		t.Fatalf("enabled = %q, want the relocated directory's setting\n%s", got.Enabled, out)
	}
}

func TestPiModelsScriptSaysWhenPiIsMissing(t *testing.T) {
	out := runPiModelsScript(t, nil, "", "")
	if _, err := parsePiModels([]byte(out)); err == nil || !strings.Contains(err.Error(), "not installed") {
		t.Fatalf("err = %v, want pi reported missing\n%s", err, out)
	}
}

// pi's stderr is not the listing. A warning there must not become a row, and
// must not stop the listing on stdout from being read.
func TestPiModelsScriptDropsPisStderr(t *testing.T) {
	stub := "#!/bin/sh\necho 'anthropic  from-stderr  1M  128K  yes  yes' >&2\ncat <<'EOF'\n" + piListing + "EOF\n"
	got, err := parsePiModels([]byte(runPiModelsScript(t, nil, "", stub)))
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range got.Models {
		if m.ID == "from-stderr" {
			t.Fatal("a line pi wrote to stderr became a model")
		}
	}
}
