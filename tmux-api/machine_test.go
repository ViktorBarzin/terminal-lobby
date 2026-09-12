package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

/*
The two ways the box's verdict reaches a browser.

health_test.go owns the arithmetic — what the thresholds mean and which resource
picks the colour. What is under test here is DELIVERY, and the test worth the
most is the body cache. GET /sessions memoises its body per OS user for five
seconds and shares it between that user's devices, so a verdict carried inside
one would be up to five seconds stale by the time it was read. The header is
stamped per response, ahead of the cache, exactly as X-TL-Net is.

The wire shapes are health.go's contract, so they are asserted here as a CLIENT
would read them — raw bytes and JSON keys — rather than by decoding back into
the structs that produced them. A round trip through its own encoder agrees with
a rename that would have broken the panel.
*/

// withMachineRing points the package ring at one the test built, for the test's
// duration. Nothing here starts a sampler — every ring below is a box whose
// history is known, which is what makes the assertions exact.
func withMachineRing(t *testing.T, r *healthRing) {
	t.Helper()
	old := machineHealth
	machineHealth = r
	t.Cleanup(func() { machineHealth = old })
}

// loadOnlyRing is a box whose kernel has no /proc/pressure: a load average, a
// memory figure, and no counters to subtract.
func loadOnlyRing(n int, load1 float64, nproc int) *healthRing {
	r := newHealthRing()
	for i := 0; i < n; i++ {
		r.add(healthSample{
			At:             healthEpoch.Add(time.Duration(i) * 10 * time.Second),
			PSI:            false,
			Load1:          load1,
			NProc:          nproc,
			MemTotalKB:     32857648,
			MemAvailableKB: 13143240,
		})
	}
	return r
}

func machineReq(method, authUser string) *http.Request {
	r := httptest.NewRequest(method, "/machine", nil)
	if authUser != "" {
		r.Header.Set(authHeader, authUser)
	}
	return r
}

func decodeJSON(t *testing.T, what, raw string) map[string]any {
	t.Helper()
	var got map[string]any
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		t.Fatalf("%s is not JSON (%v): %q", what, err, raw)
	}
	return got
}

// getMachine runs the handler as an authenticated caller and decodes what it
// wrote.
func getMachine(t *testing.T, authUser string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	handleMachine(rec, machineReq(http.MethodGet, authUser))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /machine: got %d, want 200: %s", rec.Code, rec.Body.String())
	}
	return rec, decodeJSON(t, "the body", rec.Body.String())
}

// --- the header a poll carries ------------------------------------------------

func TestMachineHeaderCarriesTheVerdict(t *testing.T) {
	// 12% CPU stall is past the 10% line and nowhere near the very-busy one, so
	// "busy" is the answer however that second line is drawn. Load at 40 over 32
	// cores is 1.25 per core, the same distance into the fallback.
	cases := []struct {
		name                string
		ring                *healthRing
		state, tier, source string
	}{
		{"nothing sampled yet", newHealthRing(), healthUnknown, healthTierFine, healthSourceUnknown},
		{"a quiet box", stallRing(120, 10*time.Second, 0.01, 0.02, 0), healthWorking, healthTierFine, healthSourcePSI},
		{"cpu past its line", stallRing(120, 10*time.Second, 0.12, 0.02, 0), healthDegraded, healthTierBusy, healthSourcePSI},
		{"no PSI, load past one per core", loadOnlyRing(3, 40, 32), healthDegraded, healthTierBusy, healthSourceLoad},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withMachineRing(t, c.ring)
			rec := httptest.NewRecorder()
			setMachineHeader(rec)

			raw := rec.Header().Get(machineHeader)
			if raw == "" {
				t.Fatal("no header was stamped; a client cannot tell that from an old build")
			}
			got := decodeJSON(t, machineHeader, raw)
			if got["state"] != c.state || got["tier"] != c.tier || got["source"] != c.source {
				t.Errorf("state=%v tier=%v source=%v, want %q %q %q",
					got["state"], got["tier"], got["source"], c.state, c.tier, c.source)
			}
			// The property that makes a JSON blob safe in a header: every field
			// is an enum from health.go or a number, so nothing free-form and
			// no newline can reach the value. A string field carrying a path or
			// an error message would break it, and this is what would notice.
			for i := 0; i < len(raw); i++ {
				if raw[i] < 0x20 || raw[i] > 0x7e {
					t.Fatalf("byte %d of the header is not printable ASCII: %q", i, raw)
				}
			}
			// The series is the reason the endpoint exists. An hour of points
			// on every five-second poll is what this header is defined not to
			// be.
			if _, ok := got["series"]; ok {
				t.Error("the header carried the series")
			}
		})
	}
}

// The reason this is a header. The BODY of /sessions is memoised per OS user for
// five seconds; the verdict is stamped per response, so a box that turns busy
// between two polls says so on the second one even though the list it carries
// came out of the cache.
func TestMachineHeaderRidesTheSessionsPollPastTheBodyCache(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	sessionsCacheInstance.invalidate(me)
	t.Cleanup(func() { sessionsCacheInstance.invalidate(me) })

	get := func() (map[string]any, string) {
		r := httptest.NewRequest(http.MethodGet, "/sessions", nil)
		r.Header.Set(authHeader, "wiz")
		rec := httptest.NewRecorder()
		handleSessions(rec, r)
		return decodeJSON(t, machineHeader, rec.Header().Get(machineHeader)), rec.Body.String()
	}

	withMachineRing(t, stallRing(120, 10*time.Second, 0.01, 0.02, 0))
	quiet, bodyA := get() // warms the per-user body cache

	// The box gets busy. The list is still the one from a moment ago, and the
	// verdict beside it must not be.
	machineHealth = stallRing(120, 10*time.Second, 0.12, 0.02, 0)
	busy, bodyB := get()

	if quiet["state"] != healthWorking {
		t.Fatalf("first poll: state=%v, want %q", quiet["state"], healthWorking)
	}
	if busy["state"] != healthDegraded || busy["tier"] != healthTierBusy {
		t.Fatalf("second poll: state=%v tier=%v — the verdict rode the cached body",
			busy["state"], busy["tier"])
	}
	if bodyA != bodyB {
		t.Fatalf("bodies differ (%q vs %q); the cache was supposed to serve both", bodyA, bodyB)
	}
	if _, warm := sessionsCacheInstance.get(me); !warm {
		t.Fatal("the body cache never warmed, so this proved nothing")
	}
}

// --- the endpoint the panel polls ---------------------------------------------

func TestMachineEndpointReportsTheWholeReading(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	// Twenty minutes of history at 12% CPU stall: a full ten-minute window for
	// the verdict, and ten minutes of line behind it for the sparkline.
	withMachineRing(t, stallRing(120, 10*time.Second, 0.12, 0.02, 0))

	rec, body := getMachine(t, "wiz")
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		// The number moves while someone watches it, which is the one thing a
		// cached response cannot show.
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}

	// The wrapper, not a flat object: "verdict" maps onto the frontend's
	// MachineReport with no reshaping, and "series" stays a different kind of
	// thing beside it.
	verdict, ok := body["verdict"].(map[string]any)
	if !ok {
		t.Fatalf("no verdict object in the reading: %v", body)
	}
	// Every key the panel reads. Presence rather than an exact set: health.go
	// owns the verdict and may grow a field, and a client that has these keeps
	// working when it does.
	for _, k := range []string{
		"state", "tier", "worst",
		"cpuPct", "ioPct", "memPct",
		"load1", "nproc", "memAvailableMb", "memTotalMb",
		"source", "windowSeconds", "partialWindow",
	} {
		if _, ok := verdict[k]; !ok {
			t.Errorf("no %q in the verdict: %v", k, verdict)
		}
	}
	// One encoder, one shape: the endpoint's verdict is byte-for-byte what the
	// header carries, so a client validates the same thing either way.
	hdr := httptest.NewRecorder()
	setMachineHeader(hdr)
	if same := decodeJSON(t, machineHeader, hdr.Header().Get(machineHeader)); !sameJSON(same, verdict) {
		t.Errorf("the header and the endpoint disagree:\n header: %v\n body:   %v", same, verdict)
	}

	if verdict["state"] != healthDegraded || verdict["tier"] != healthTierBusy || verdict["worst"] != "cpu" {
		t.Errorf("state=%v tier=%v worst=%v, want degraded busy cpu",
			verdict["state"], verdict["tier"], verdict["worst"])
	}
	if pct, _ := verdict["cpuPct"].(float64); !closeTo(pct, 12) {
		t.Errorf("cpuPct = %v, want 12", verdict["cpuPct"])
	}
	if verdict["source"] != healthSourcePSI {
		t.Errorf("source = %v, want %q", verdict["source"], healthSourcePSI)
	}
	if secs, _ := verdict["windowSeconds"].(float64); secs != 600 {
		t.Errorf("windowSeconds = %v, want 600", verdict["windowSeconds"])
	}
	if verdict["partialWindow"] != false {
		t.Errorf("partialWindow = %v over a full ten minutes", verdict["partialWindow"])
	}
	if l, _ := verdict["load1"].(float64); !closeTo(l, 1.04) {
		t.Errorf("load1 = %v, want 1.04", verdict["load1"])
	}
	if n, _ := verdict["nproc"].(float64); n != 32 {
		t.Errorf("nproc = %v, want 32", verdict["nproc"])
	}
	if avail, _ := verdict["memAvailableMb"].(float64); avail != 12835 {
		t.Errorf("memAvailableMb = %v, want 12835", verdict["memAvailableMb"])
	}

	// The hour behind the dot. Twenty minutes of samples give sixty points: the
	// first sixty samples have less than ten minutes behind them and are left
	// out rather than drawn as zero.
	series, ok := body["series"].([]any)
	if !ok || len(series) != 60 {
		t.Fatalf("series: got %d points, want 60: %v", len(series), body["series"])
	}
	last, _ := series[len(series)-1].(map[string]any)
	for _, k := range []string{"at", "res", "pct", "ofLimit"} {
		if _, ok := last[k]; !ok {
			t.Errorf("no %q on a series point: %v", k, last)
		}
	}
	// The right-hand end of the line is the number that picked the colour, so
	// the two can never disagree on screen.
	if last["res"] != verdict["worst"] {
		t.Errorf("the line ends on %v while the verdict blames %v", last["res"], verdict["worst"])
	}
	if of, _ := last["ofLimit"].(float64); !closeTo(of, 1.2) {
		t.Errorf("ofLimit = %v, want 1.2 — 12%% against a 10%% line", last["ofLimit"])
	}
	if at, _ := last["at"].(float64); at <= 0 {
		t.Errorf("the newest point carries no timestamp: %v", last["at"])
	}
}

// The first seconds of a process, and the first response a panel opened during
// them receives.
func TestMachineEndpointBeforeAnythingHasBeenSampled(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	withMachineRing(t, newHealthRing())

	rec, body := getMachine(t, "wiz")
	verdict, _ := body["verdict"].(map[string]any)
	if verdict["state"] != healthUnknown || verdict["source"] != healthSourceUnknown {
		t.Errorf("state=%v source=%v, want unknown unknown", verdict["state"], verdict["source"])
	}
	if verdict["partialWindow"] != true {
		t.Errorf("partialWindow = %v with nothing measured", verdict["partialWindow"])
	}
	// An empty ARRAY and never null. The panel maps over this to draw the line,
	// and null does not map.
	if !strings.Contains(rec.Body.String(), `"series":[]`) {
		t.Errorf("series is not an empty array: %s", rec.Body.String())
	}
	if series, _ := body["series"].([]any); len(series) != 0 {
		t.Errorf("an unsampled ring drew %d points", len(series))
	}
}

// Old kernels, some container runtimes, the Docker dev environment. The row
// keeps reporting and the reading says which signal it is on, because a row
// that disappears reads as a bug and cannot be asked about.
func TestMachineEndpointWhenTheKernelHasNoPressure(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	withMachineRing(t, loadOnlyRing(3, 40, 32))

	_, body := getMachine(t, "wiz")
	verdict, _ := body["verdict"].(map[string]any)
	if verdict["source"] != healthSourceLoad {
		t.Errorf("source = %v, want %q", verdict["source"], healthSourceLoad)
	}
	if verdict["worst"] != "load" || verdict["state"] != healthDegraded || verdict["tier"] != healthTierBusy {
		t.Errorf("worst=%v state=%v tier=%v, want load degraded busy",
			verdict["worst"], verdict["state"], verdict["tier"])
	}
	if l, _ := verdict["load1"].(float64); !closeTo(l, 40) {
		t.Errorf("load1 = %v, want 40", verdict["load1"])
	}
	if n, _ := verdict["nproc"].(float64); n != 32 {
		t.Errorf("nproc = %v, want 32", verdict["nproc"])
	}
	// The three rates read zero because nothing was measured, not because the
	// box was idle — which is why `source` has to travel with them.
	for _, k := range []string{"cpuPct", "ioPct", "memPct"} {
		if v, _ := verdict[k].(float64); v != 0 {
			t.Errorf("%s = %v on a box with no PSI", k, verdict[k])
		}
	}
	// No pressure to subtract, so no line to draw. The words carry it instead.
	if series, _ := body["series"].([]any); len(series) != 0 {
		t.Errorf("a box with no PSI drew %d points", len(series))
	}
}

func TestMachineEndpointRefusesNonGETAndTheUnauthenticated(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	withMachineRing(t, stallRing(120, 10*time.Second, 0.01, 0.02, 0))

	for _, m := range []string{http.MethodPost, http.MethodDelete, http.MethodPut} {
		rec := httptest.NewRecorder()
		handleMachine(rec, machineReq(m, "wiz"))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s /machine: got %d, want %d", m, rec.Code, http.StatusMethodNotAllowed)
		}
	}
	// The answer is about a box every user shares, and it is still not
	// something an unauthenticated caller gets to ask for.
	rec := httptest.NewRecorder()
	handleMachine(rec, machineReq(http.MethodGet, ""))
	if rec.Code == http.StatusOK {
		t.Errorf("an unauthenticated caller read the machine: %s", rec.Body.String())
	}
}

// Everything above builds its own history, which is what makes those
// assertions exact — and also what would let both surfaces pass against a
// kernel whose /proc this code cannot actually read. This one runs the real
// sampler over the real /proc and asks over a real socket, so the values are
// this host's and the assertions are about shape.
func TestMachineSurfaceAnswersOverARealSocket(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	sessionsCacheInstance.invalidate(me)
	t.Cleanup(func() { sessionsCacheInstance.invalidate(me) })
	withMachineRing(t, newHealthRing())

	restore := healthSampleInterval
	healthSampleInterval = 300 * time.Millisecond
	defer func() { healthSampleInterval = restore }()
	stop, done := make(chan struct{}), make(chan struct{})
	go func() { runHealthSampler(stop); close(done) }()
	// Stops before withMachineRing's cleanup restores the package ring, so the
	// sampler is never writing to a ring this test no longer owns.
	defer func() {
		close(stop)
		<-done
	}()
	// Five samples 300ms apart span 1.2s, past the one-second floor a verdict
	// needs.
	deadline := time.Now().Add(10 * time.Second)
	for machineHealth.len() < 5 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := machineHealth.len(); n < 5 {
		t.Fatalf("the sampler wrote %d samples in ten seconds", n)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/sessions", handleSessions)
	mux.HandleFunc("/machine", handleMachine)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	ask := func(path string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, srv.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set(authHeader, "wiz")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s: %d", path, resp.StatusCode)
		}
		return resp
	}

	// The header survives a real ReadResponse — a value Go's own writer would
	// have refused never reaches a browser either.
	poll := ask("/sessions")
	defer poll.Body.Close()
	hdr := decodeJSON(t, machineHeader, poll.Header.Get(machineHeader))

	reading := ask("/machine")
	defer reading.Body.Close()
	raw, err := io.ReadAll(reading.Body)
	if err != nil {
		t.Fatal(err)
	}
	verdict, _ := decodeJSON(t, "the body", string(raw))["verdict"].(map[string]any)
	if verdict == nil {
		t.Fatalf("no verdict over the wire: %s", raw)
	}

	// Something was measured, so the SOURCE is the field that would show the
	// surface is not reading what the sampler wrote. The state is not: five
	// samples a few milliseconds apart is a partial window, and a partial
	// window deliberately reports `unknown` rather than a colour, because the
	// thresholds are ten-minute rates and a narrower one is a different
	// measurement wearing the same number.
	if verdict["source"] != healthSourcePSI && verdict["source"] != healthSourceLoad {
		t.Errorf("source = %v after five real samples", verdict["source"])
	}
	// The figures must still have arrived, which is what proves the surface is
	// wired to the sampler at all.
	if _, ok := verdict["windowSeconds"].(float64); !ok {
		t.Errorf("no window over the wire after five real samples: %v", verdict)
	}
	if n, _ := verdict["nproc"].(float64); n < 1 {
		t.Errorf("nproc = %v, so nothing was measured: %v", n, verdict)
	}
	if partial, _ := verdict["partialWindow"].(bool); partial && verdict["state"] != healthUnknown {
		t.Errorf("a partial window produced a colour over the wire: %v", verdict)
	}
	if partial, _ := verdict["partialWindow"].(bool); !partial && verdict["state"] == healthUnknown {
		t.Errorf("a full window produced no verdict over the wire: %v", verdict)
	}
	// Never red, on any reading this host could produce.
	if verdict["state"] == "down" {
		t.Errorf("this channel reported down: %v", verdict)
	}
	if n, _ := verdict["nproc"].(float64); n < 1 {
		t.Errorf("nproc = %v on a host that is running this test", verdict["nproc"])
	}
	// Both doors, one verdict. They are read microseconds apart from the same
	// ring, so the state cannot differ even when a sample lands between them.
	if hdr["state"] != verdict["state"] || hdr["source"] != verdict["source"] {
		t.Errorf("the header and the endpoint disagree: %v against %v", hdr, verdict)
	}
}

// sameJSON compares two decoded objects field by field. Both sides came out of
// json.Unmarshal into `any`, so every number is a float64 and every value
// compares with ==.
func sameJSON(a, b map[string]any) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}
