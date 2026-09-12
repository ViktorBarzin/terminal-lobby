package main

import (
	"encoding/json"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

/*
What a person asks when a terminal goes quiet is "is it me or is it the box",
and this file pins the half of the answer the box gives about itself.

The numbers under test are not arbitrary. The three thresholds come from 696
hours of this devvm's own history (docs/adr/0028-stall-time-says-the-box-is-busy.md),
calibrated against 10-MINUTE RATES, so the tests state them the way the design
states them and check the arithmetic that turns two cumulative counters into the
rate they were calibrated against.

The invariant worth the most here is the last one: this channel reaches amber
and stops. Red already means "you are disconnected", and a busy box is the
opposite of disconnected — the person is talking to it.
*/

// Captured from this devvm on 2026-09-12, 56.2 days into the current boot, and
// kept verbatim including the zero `full` row on CPU. A parser that has only
// ever met hand-written input is a parser that has never met /proc.
const (
	fixtureCPUPressure = `some avg10=0.00 avg60=0.31 avg300=0.57 total=32098861209
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
`
	fixtureIOPressure = `some avg10=0.05 avg60=0.88 avg300=0.88 total=145854004760
full avg10=0.05 avg60=0.84 avg300=0.85 total=135812170993
`
	fixtureMemPressure = `some avg10=0.01 avg60=0.04 avg300=0.01 total=10265727711
full avg10=0.01 avg60=0.04 avg300=0.01 total=9305533427
`
	// Kernels before 5.13 report no `full` row for CPU at all, so the parser
	// has to treat its absence as zero rather than as a broken file.
	fixtureCPUPressureNoFull = "some avg10=0.00 avg60=0.00 avg300=0.00 total=1234567\n"

	fixtureLoadavg = "1.04 0.94 1.40 2/3664 3791539\n"

	fixtureMeminfo = `MemTotal:       32857648 kB
MemFree:         2479088 kB
MemAvailable:   13143240 kB
Buffers:         1431820 kB
Cached:          8162484 kB
`
)

// healthEpoch is an arbitrary fixed clock. Every ring built here starts from it
// so a failure message names a readable offset rather than a wall time.
var healthEpoch = time.Date(2026, 9, 12, 10, 0, 0, 0, time.UTC)

// stallRing builds n samples `step` apart whose three counters advance by the
// given FRACTION of the wall time between samples. A fraction of 0.10 makes a
// 10% rate over every window in the ring, which is the unit the thresholds are
// written in, so a test can say "just over the CPU line" and mean it.
func stallRing(n int, step time.Duration, cpu, io, mem float64) *healthRing {
	r := newHealthRing()
	var cpuTotal, ioTotal, memTotal float64
	for i := 0; i < n; i++ {
		if i > 0 {
			micros := float64(step.Microseconds())
			cpuTotal += cpu * micros
			ioTotal += io * micros
			memTotal += mem * micros
		}
		r.add(healthSample{
			At:             healthEpoch.Add(time.Duration(i) * step),
			PSI:            true,
			CPUSomeTotal:   uint64(cpuTotal),
			IOFullTotal:    uint64(ioTotal),
			MemFullTotal:   uint64(memTotal),
			Load1:          1.04,
			NProc:          32,
			MemTotalKB:     32857648,
			MemAvailableKB: 13143240,
		})
	}
	return r
}

// closeTo compares rates that came through float arithmetic. A tenth of a
// percentage point is far finer than any threshold in the design.
func closeTo(got, want float64) bool { return math.Abs(got-want) < 0.1 }

// defaultLimits is what the service ships with, read from the constants rather
// than retyped here, so the reachability test below is a statement about the
// shipped numbers and not about a copy of them.
func defaultLimits() healthThresholds {
	return healthThresholds{
		CPUPct:     defaultHealthCPUPct,
		IOPct:      defaultHealthIOPct,
		MemPct:     defaultHealthMemPct,
		CPUVeryPct: defaultHealthCPUVeryPct,
		IOVeryPct:  defaultHealthIOVeryPct,
		MemVeryPct: defaultHealthMemVeryPct,
	}
}

// --- reading /proc ------------------------------------------------------------

func TestHealthParsePressureReadsTotalsFromRealProcText(t *testing.T) {
	cases := []struct {
		name                 string
		text                 string
		someTotal, fullTotal uint64
		someAvg60            float64
	}{
		{"cpu", fixtureCPUPressure, 32098861209, 0, 0.31},
		{"io", fixtureIOPressure, 145854004760, 135812170993, 0.88},
		{"memory", fixtureMemPressure, 10265727711, 9305533427, 0.04},
		{"cpu without a full row", fixtureCPUPressureNoFull, 1234567, 0, 0.00},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := parsePressure(strings.NewReader(c.text))
			if !ok {
				t.Fatalf("parsePressure(%q) said the file was unusable", c.name)
			}
			if got.Some.Total != c.someTotal {
				t.Errorf("some total: got %d, want %d", got.Some.Total, c.someTotal)
			}
			if got.Full.Total != c.fullTotal {
				t.Errorf("full total: got %d, want %d", got.Full.Total, c.fullTotal)
			}
			if !closeTo(got.Some.Avg60, c.someAvg60) {
				t.Errorf("some avg60: got %v, want %v", got.Some.Avg60, c.someAvg60)
			}
		})
	}
}

func TestHealthParsePressureRejectsWhatItCannotRead(t *testing.T) {
	for _, text := range []string{"", "\n", "not a pressure file", "some\n", "full avg10=0.00 total=5\n"} {
		if _, ok := parsePressure(strings.NewReader(text)); ok {
			t.Errorf("parsePressure(%q) claimed a usable reading", text)
		}
	}
}

func TestHealthParseLoadavgAndMeminfo(t *testing.T) {
	load1, ok := parseLoadavg(fixtureLoadavg)
	if !ok || !closeTo(load1, 1.04) {
		t.Errorf("parseLoadavg: got %v ok=%v, want 1.04 true", load1, ok)
	}
	if _, ok := parseLoadavg("nonsense"); ok {
		t.Error("parseLoadavg accepted a line with no number in it")
	}
	total, avail, ok := parseMeminfo(strings.NewReader(fixtureMeminfo))
	if !ok || total != 32857648 || avail != 13143240 {
		t.Errorf("parseMeminfo: got total=%d avail=%d ok=%v, want 32857648 13143240 true", total, avail, ok)
	}
	// MemAvailable arrived in 3.14. Without it there is no headroom figure, and
	// saying so beats inventing one out of MemFree.
	if _, _, ok := parseMeminfo(strings.NewReader("MemTotal: 32857648 kB\n")); ok {
		t.Error("parseMeminfo answered without MemAvailable")
	}
}

func TestHealthSampleWithoutPSIStillCarriesLoadAndMemory(t *testing.T) {
	s := healthSampleFrom(healthEpoch, healthSources{
		Loadavg: fixtureLoadavg, Meminfo: fixtureMeminfo, NProc: 32,
	})
	if s.PSI {
		t.Error("a sample built from no pressure text claims PSI")
	}
	if !closeTo(s.Load1, 1.04) || s.NProc != 32 || s.MemAvailableKB != 13143240 {
		t.Errorf("fallback figures lost: %+v", s)
	}
}

func TestHealthReadSampleFromAFakeProcDir(t *testing.T) {
	withPSI := t.TempDir()
	if err := os.MkdirAll(filepath.Join(withPSI, "pressure"), 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(dir, name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(withPSI, "loadavg", fixtureLoadavg)
	write(withPSI, "meminfo", fixtureMeminfo)
	write(withPSI, "pressure/cpu", fixtureCPUPressure)
	write(withPSI, "pressure/io", fixtureIOPressure)
	write(withPSI, "pressure/memory", fixtureMemPressure)

	s := readHealthSampleFrom(healthEpoch, withPSI)
	if !s.PSI || s.CPUSomeTotal != 32098861209 || s.IOFullTotal != 135812170993 {
		t.Errorf("PSI read from a real-shaped /proc came back wrong: %+v", s)
	}

	// A kernel with no /proc/pressure at all is a documented state, not a
	// failure: the row falls back to load and says so.
	noPSI := t.TempDir()
	write(noPSI, "loadavg", fixtureLoadavg)
	write(noPSI, "meminfo", fixtureMeminfo)
	s = readHealthSampleFrom(healthEpoch, noPSI)
	if s.PSI {
		t.Error("a /proc without pressure/ was read as a PSI sample")
	}
	if !closeTo(s.Load1, 1.04) {
		t.Errorf("load average lost on the fallback path: %+v", s)
	}
}

// --- the ring buffer ----------------------------------------------------------

func TestHealthRingKeepsTheLastHourAfterWrapping(t *testing.T) {
	r := stallRing(500, 10*time.Second, 0, 0, 0)
	if got := r.len(); got != healthRingSize {
		t.Fatalf("ring length: got %d, want %d", got, healthRingSize)
	}
	all := r.all()
	// 500 samples into 360 slots leaves #140 the oldest survivor.
	wantOldest := healthEpoch.Add(140 * 10 * time.Second)
	if !all[0].At.Equal(wantOldest) {
		t.Errorf("oldest survivor: got %v, want %v", all[0].At, wantOldest)
	}
	wantNewest := healthEpoch.Add(499 * 10 * time.Second)
	if !all[len(all)-1].At.Equal(wantNewest) {
		t.Errorf("newest: got %v, want %v", all[len(all)-1].At, wantNewest)
	}
	// 360 samples 10 seconds apart is the hour the panel draws.
	if span := all[len(all)-1].At.Sub(all[0].At); span != 359*10*time.Second {
		t.Errorf("span: got %v, want %v", span, 359*10*time.Second)
	}
}

func TestHealthRingWindowPicksTheSampleTenMinutesBack(t *testing.T) {
	r := stallRing(360, 10*time.Second, 0, 0, 0)
	from, to, ok := r.window(10 * time.Minute)
	if !ok {
		t.Fatal("a full ring produced no window")
	}
	if span := to.At.Sub(from.At); span != 10*time.Minute {
		t.Errorf("window span: got %v, want 10m", span)
	}
}

func TestHealthRingWindowFallsBackToTheWidestAvailable(t *testing.T) {
	r := stallRing(10, 10*time.Second, 0, 0, 0)
	from, to, ok := r.window(10 * time.Minute)
	if !ok {
		t.Fatal("a short ring produced no window at all")
	}
	if span := to.At.Sub(from.At); span != 90*time.Second {
		t.Errorf("window span: got %v, want the whole 90s of history", span)
	}
	if _, _, ok := newHealthRing().window(10 * time.Minute); ok {
		t.Error("an empty ring produced a window")
	}
}

// --- rate arithmetic ----------------------------------------------------------

func TestHealthRateArithmeticAcrossTheTotals(t *testing.T) {
	cases := []struct {
		name     string
		from, to uint64
		elapsed  time.Duration
		want     float64
	}{
		// 60 seconds of stall inside a 10-minute window is the CPU line exactly.
		{"a tenth of the window", 0, 60_000_000, 10 * time.Minute, 10},
		{"half the window", 1_000_000, 301_000_000, 10 * time.Minute, 50},
		{"nothing stalled", 32098861209, 32098861209, 10 * time.Minute, 0},
		{"the whole window", 0, 600_000_000, 10 * time.Minute, 100},
		// A counter that went backwards is a reset, not negative stall.
		{"a counter reset", 500_000, 1_000, 10 * time.Minute, 0},
		{"no time passed", 0, 5_000_000, 0, 0},
		// Clock skew cannot buy more stall than there was wall time.
		{"more stall than wall clock", 0, 2_000_000_000, 10 * time.Minute, 100},
		{"real totals, one 10s tick", 32098861209, 32098961209, 10 * time.Second, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := stallRatePct(c.from, c.to, c.elapsed); !closeTo(got, c.want) {
				t.Errorf("stallRatePct: got %v, want %v", got, c.want)
			}
		})
	}
}

// --- the verdict --------------------------------------------------------------

func TestHealthEachThresholdFiresOnItsOwn(t *testing.T) {
	cases := []struct {
		name         string
		cpu, io, mem float64
		wantState    string
		wantWorst    string
		wantTier     string
	}{
		{"a quiet box", 0.01, 0.02, 0.00, healthWorking, "cpu", healthTierFine},
		{"just under every line", 0.099, 0.40, 0.05, healthWorking, "cpu", healthTierFine},
		{"cpu alone", 0.11, 0.02, 0.00, healthDegraded, "cpu", healthTierBusy},
		{"io alone", 0.01, 0.55, 0.00, healthDegraded, "io", healthTierBusy},
		{"memory alone", 0.01, 0.02, 0.11, healthDegraded, "memory", healthTierBusy},
		// Worst is measured against each resource's own line, not as a raw
		// percentage: 15% CPU is 1.5x its line while 55% IO is only 1.1x.
		{"cpu further over than io", 0.15, 0.55, 0.00, healthDegraded, "cpu", healthTierBusy},
		// 90% IO is past IO's very-busy line of 70, so this one is not merely
		// the worst of two ambers.
		{"io further over than cpu", 0.11, 0.90, 0.00, healthDegraded, "io", healthTierVeryBusy},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v := healthVerdictFrom(stallRing(120, 10*time.Second, c.cpu, c.io, c.mem), defaultLimits())
			if v.State != c.wantState || v.Worst != c.wantWorst || v.Tier != c.wantTier {
				t.Errorf("got state=%q worst=%q tier=%q, want %q %q %q\nrates: cpu=%.2f io=%.2f mem=%.2f",
					v.State, v.Worst, v.Tier, c.wantState, c.wantWorst, c.wantTier, v.CPUPct, v.IOPct, v.MemPct)
			}
			if v.Source != healthSourcePSI {
				t.Errorf("source: got %q, want %q", v.Source, healthSourcePSI)
			}
			if v.State == healthDegraded && v.Tier == healthTierFine {
				t.Error("degraded with nothing to say about it")
			}
		})
	}
}

func TestHealthReportsTheRatesAndTheMachineFigures(t *testing.T) {
	v := healthVerdictFrom(stallRing(120, 10*time.Second, 0.20, 0.40, 0.05), defaultLimits())
	if !closeTo(v.CPUPct, 20) || !closeTo(v.IOPct, 40) || !closeTo(v.MemPct, 5) {
		t.Errorf("rates: got cpu=%v io=%v mem=%v, want 20 40 5", v.CPUPct, v.IOPct, v.MemPct)
	}
	if !closeTo(v.Load1, 1.04) || v.NProc != 32 {
		t.Errorf("load: got %v over %d cores, want 1.04 over 32", v.Load1, v.NProc)
	}
	if v.MemTotalMB != 32087 || v.MemAvailableMB != 12835 {
		t.Errorf("memory: got %d of %d MB, want 12835 of 32087", v.MemAvailableMB, v.MemTotalMB)
	}
	if v.WindowSeconds != 600 || v.PartialWindow {
		t.Errorf("window: got %ds partial=%v, want 600s and a full window", v.WindowSeconds, v.PartialWindow)
	}
}

// Each resource reaches very-busy at ITS OWN line — 20% CPU, 70% IO, 20%
// memory — rather than at a shared multiple of its amber line. The cases below
// sit either side of each one.
func TestHealthTierSaysVeryBusyPastEachResourcesOwnLine(t *testing.T) {
	cases := []struct {
		name         string
		cpu, io, mem float64
		wantTier     string
	}{
		{"cpu just over its amber line", 0.11, 0, 0, healthTierBusy},
		{"cpu at its very-busy line", 0.20, 0, 0, healthTierBusy},
		{"cpu over its very-busy line", 0.21, 0, 0, healthTierVeryBusy},
		{"io at its very-busy line", 0, 0.70, 0, healthTierBusy},
		{"io over its very-busy line", 0, 0.71, 0, healthTierVeryBusy},
		{"memory at its very-busy line", 0, 0, 0.20, healthTierBusy},
		{"memory over its very-busy line", 0, 0, 0.21, healthTierVeryBusy},
		{"one resource over its line is enough", 0.25, 0.55, 0, healthTierVeryBusy},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v := healthVerdictFrom(stallRing(120, 10*time.Second, c.cpu, c.io, c.mem), defaultLimits())
			if v.Tier != c.wantTier {
				t.Errorf("tier: got %q, want %q\nrates: cpu=%.2f io=%.2f mem=%.2f",
					v.Tier, c.wantTier, v.CPUPct, v.IOPct, v.MemPct)
			}
		})
	}
}

// A threshold a resource cannot reach is a threshold that is not there. An
// earlier draft made very-busy mean twice the amber line, which put IO's at
// 100% — the ceiling of a rate — so a box stalling on disk for ten straight
// minutes could only ever read "busy". This pins the property that makes the
// tier mean anything: all three lines are reachable, at rates this hardware has
// actually produced.
//
// The rates are the 30-day maxima of the 10-minute rate on this devvm, measured
// in Prometheus on 2026-09-12: 60.39% CPU `some`, 87.59% IO `full`, 56.59%
// memory `full`.
func TestHealthEveryResourceCanReachVeryBusy(t *testing.T) {
	limits := defaultLimits()
	cases := []struct {
		name         string
		cpu, io, mem float64
		line         float64
	}{
		{"cpu at its measured 30-day peak", 0.6039, 0, 0, limits.CPUVeryPct},
		{"io at its measured 30-day peak", 0, 0.8759, 0, limits.IOVeryPct},
		{"memory at its measured 30-day peak", 0, 0, 0.5659, limits.MemVeryPct},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v := healthVerdictFrom(stallRing(120, 10*time.Second, c.cpu, c.io, c.mem), limits)
			if v.Tier != healthTierVeryBusy {
				t.Errorf("tier: got %q, want %q — a rate this box has reached does not raise a line of %g%%",
					v.Tier, healthTierVeryBusy, c.line)
			}
		})
	}
	// No rate can exceed 100%, so a line at or above it is a tier nothing can
	// enter. This is about the SHIPPED numbers, which is why defaultLimits
	// reads the constants rather than restating them.
	for name, line := range map[string]float64{
		"cpu": limits.CPUVeryPct, "io": limits.IOVeryPct, "memory": limits.MemVeryPct,
	} {
		if line >= 100 {
			t.Errorf("the very-busy line for %s is %g%%, which no rate can exceed", name, line)
		}
	}
}

// `worst` names the resource that raised the tier, which is what makes the
// sentence beside it true. The very-busy lines are not a fixed multiple of the
// amber ones — 2x on CPU and memory, 1.4x on IO — so the resource furthest into
// amber is not always the one that crossed red. Here CPU leads on the amber
// ratio (1.6x against IO's 1.5x) while IO is the one past its very-busy line,
// and IO is what the row has to blame: "very busy, the processor is busy" would
// accuse the wrong resource in the one sentence a person reads to decide
// whether to stop typing.
//
// The sparkline still draws CPU, and that divergence is deliberate: a point's
// res, pct and ofLimit have to describe one resource, so the line stays in
// amber ratios. A tooltip naming a different resource from the sentence is a
// far smaller wrong than the sentence being wrong.
func TestHealthWorstNamesWhicheverResourceRaisedTheTier(t *testing.T) {
	r := stallRing(120, 10*time.Second, 0.16, 0.75, 0)
	v := healthVerdictFrom(r, defaultLimits())
	if v.Tier != healthTierVeryBusy {
		t.Errorf("tier: got %q, want %q — io at 75%% is past its 70%% line", v.Tier, healthTierVeryBusy)
	}
	if v.Worst != "io" {
		t.Errorf("worst: got %q, want \"io\" — io is the resource that crossed its very-busy line", v.Worst)
	}
	pts := r.series(10*time.Minute, defaultLimits())
	if last := pts[len(pts)-1]; last.Resource != "cpu" || !closeTo(last.OfLimit, 1.6) {
		t.Errorf("the sparkline's last point: got %+v, want cpu at 1.6x its amber line", last)
	}
}

// A window shorter than healthColourMinWindow reports every figure and
// withholds the colour. The thresholds ARE ten-minute rates, so measuring a
// ninety-second rate against them is a different measurement wearing the same
// number, and it would cross a line at a rate nobody calibrated. The bar is
// four minutes rather than the full ten; the constant carries the measurements
// behind that choice.
func TestHealthWithholdsTheColourBelowTheMinimumWindow(t *testing.T) {
	// Ninety seconds of history, well over the CPU line for all of it.
	v := healthVerdictFrom(stallRing(10, 10*time.Second, 0.20, 0, 0), defaultLimits())
	if !v.PartialWindow {
		t.Error("a 90-second reading was not marked as one")
	}
	if v.WindowSeconds != 90 {
		t.Errorf("window: got %ds, want 90s", v.WindowSeconds)
	}
	// The widest window available IS used, and every figure comes from it.
	if !closeTo(v.CPUPct, 20) {
		t.Errorf("the widest window available was not used: cpu=%v, want 20", v.CPUPct)
	}
	// But the state waits. `unknown` is this model's word for "has not
	// reported" and every rule skips it rather than counting it as health or
	// as fault, which is exactly the claim a ninety-second rate can support.
	if v.State != healthUnknown {
		t.Errorf("state over a partial window: got %q, want %q — 20%% CPU over 90s is not the measurement the 10%% line was calibrated against", v.State, healthUnknown)
	}
	if v.Tier != healthTierFine {
		t.Errorf("tier over a partial window: got %q, want %q — no sentence may be printed from a window this short", v.Tier, healthTierFine)
	}
}

// The counterpart: once the full window exists, the same pressure does produce
// a colour. Without this, clamping the partial window could silently clamp
// everything and no test would notice.
func TestHealthColoursOnceTheFullWindowExists(t *testing.T) {
	// CPU's lines are 10 and 20, and both comparisons are strictly greater, so
	// 20.0 itself is busy and not very-busy. Pinning both sides of that here
	// means a later change from > to >= cannot pass unnoticed.
	for _, c := range []struct {
		name  string
		stall float64
		tier  string
	}{
		{"over the amber line", 0.15, healthTierBusy},
		{"exactly on the very-busy line", 0.20, healthTierBusy},
		{"past the very-busy line", 0.25, healthTierVeryBusy},
	} {
		t.Run(c.name, func(t *testing.T) {
			v := healthVerdictFrom(stallRing(61, 10*time.Second, c.stall, 0, 0), defaultLimits())
			if v.PartialWindow {
				t.Fatalf("ten minutes of history was still marked partial: window=%ds", v.WindowSeconds)
			}
			if v.State != healthDegraded || v.Tier != c.tier {
				t.Errorf("state/tier: got %q/%q, want %q/%q", v.State, v.Tier, healthDegraded, c.tier)
			}
		})
	}
}

// The bar for a colour is healthColourMinWindow and not healthWindow, which is
// the whole of what moving it from ten minutes to four bought: a window between
// the two is PARTIAL and still coloured. The two tests above pin 90 seconds and
// ten minutes, so without this one the four-minute bar could drift anywhere
// inside that gap — back to ten included — and both of them would still pass.
func TestHealthColoursOnceTheColourWindowExists(t *testing.T) {
	// 0.15 is over CPU's amber line of 10 and under its very-busy line of 20,
	// so a reading that produces any colour at all produces this one.
	const overAmber = 0.15
	// The comparison is `elapsed < healthColourMinWindow`, so the bar itself
	// counts as wide enough. n samples a step apart span (n-1) steps.
	step := 10 * time.Second
	atBar := int(healthColourMinWindow/step) + 1

	for _, c := range []struct {
		name    string
		samples int
		state   string
	}{
		{"one sample short of the bar", atBar - 1, healthUnknown},
		{"exactly on the bar", atBar, healthDegraded},
		{"past the bar and still short of the full window", atBar + 6, healthDegraded},
	} {
		t.Run(c.name, func(t *testing.T) {
			v := healthVerdictFrom(stallRing(c.samples, step, overAmber, 0, 0), defaultLimits())
			// Every case here is inside the ten minutes the thresholds were
			// calibrated over, which is the band this test is about.
			if !v.PartialWindow {
				t.Fatalf("a %ds window was not marked partial", v.WindowSeconds)
			}
			if v.State != c.state {
				t.Errorf("state over a %ds window: got %q, want %q", v.WindowSeconds, v.State, c.state)
			}
		})
	}
}

func TestHealthUnknownBeforeAnythingHasBeenMeasured(t *testing.T) {
	cases := []struct {
		name string
		ring *healthRing
	}{
		{"a nil ring, before the sampler exists", nil},
		{"an empty ring, before the first tick", newHealthRing()},
		{"one sample, with no window behind it", stallRing(1, 10*time.Second, 0, 0, 0)},
		// "Working, measured over no time at all" is a claim this code should
		// not make. Production samples ten seconds apart and clears the floor
		// on its second reading.
		{"samples too close together to be a rate", stallRing(4, 20*time.Millisecond, 0.9, 0, 0)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v := healthVerdictFrom(c.ring, defaultLimits())
			if v.State != healthUnknown {
				t.Errorf("state: got %q, want %q", v.State, healthUnknown)
			}
			if !v.PartialWindow {
				t.Error("an unknown reading claimed a full window")
			}
			if v.Tier != healthTierFine {
				t.Errorf("tier: got %q, want %q — unknown makes no claim about how busy the box is", v.Tier, healthTierFine)
			}
		})
	}
}

func TestHealthFallsBackToLoadWhenPSIIsMissing(t *testing.T) {
	cases := []struct {
		name      string
		load1     float64
		nproc     int
		wantState string
		wantTier  string
	}{
		{"half a core busy per core", 16, 32, healthWorking, healthTierFine},
		{"exactly one per core", 32, 32, healthWorking, healthTierFine},
		{"over one per core", 33, 32, healthDegraded, healthTierBusy},
		{"over two per core", 70, 32, healthDegraded, healthTierVeryBusy},
		{"a four-core laptop reads on the same scale", 5, 4, healthDegraded, healthTierBusy},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newHealthRing()
			r.add(healthSample{
				At: healthEpoch, PSI: false, Load1: c.load1, NProc: c.nproc,
				MemTotalKB: 32857648, MemAvailableKB: 13143240,
			})
			v := healthVerdictFrom(r, defaultLimits())
			if v.State != c.wantState || v.Tier != c.wantTier {
				t.Errorf("got state=%q tier=%q, want %q %q", v.State, v.Tier, c.wantState, c.wantTier)
			}
			if v.Source != healthSourceLoad {
				t.Errorf("source: got %q, want %q — the row has to say it is not reading PSI", v.Source, healthSourceLoad)
			}
			if v.Worst != "load" {
				t.Errorf("worst: got %q, want \"load\"", v.Worst)
			}
			// No pressure was read, so claiming a 0% stall rate would be a
			// measurement this path never made.
			if v.CPUPct != 0 || v.IOPct != 0 || v.MemPct != 0 {
				t.Errorf("the fallback path reported stall rates: %+v", v)
			}
		})
	}
}

// --- thresholds from the environment -----------------------------------------

func TestHealthThresholdsFromEnv(t *testing.T) {
	// What an unset environment has to produce, named once so the cases below
	// read as "this input changes nothing".
	shipped := healthThresholds{CPUPct: 10, IOPct: 50, MemPct: 10, CPUVeryPct: 20, IOVeryPct: 70, MemVeryPct: 20}
	if shipped != defaultLimits() {
		t.Fatalf("the shipped defaults moved: %+v against %+v", defaultLimits(), shipped)
	}
	cases := []struct {
		name string
		env  map[string]string
		want healthThresholds
	}{
		{"nothing set", nil, shipped},
		{"all six set", map[string]string{
			"TL_HEALTH_CPU_PCT": "5", "TL_HEALTH_IO_PCT": "80", "TL_HEALTH_MEM_PCT": "2.5",
			"TL_HEALTH_CPU_VERY_PCT": "15", "TL_HEALTH_IO_VERY_PCT": "90", "TL_HEALTH_MEM_VERY_PCT": "5",
		}, healthThresholds{CPUPct: 5, IOPct: 80, MemPct: 2.5, CPUVeryPct: 15, IOVeryPct: 90, MemVeryPct: 5}},
		{"whitespace around a good value", map[string]string{
			"TL_HEALTH_CPU_PCT": " 25 ", "TL_HEALTH_CPU_VERY_PCT": " 40 ",
		}, healthThresholds{CPUPct: 25, IOPct: 50, MemPct: 10, CPUVeryPct: 40, IOVeryPct: 70, MemVeryPct: 20}},
		{"garbage", map[string]string{"TL_HEALTH_CPU_PCT": "soon"}, shipped},
		{"garbage in a very line", map[string]string{"TL_HEALTH_IO_VERY_PCT": "later"}, shipped},
		{"empty", map[string]string{"TL_HEALTH_IO_PCT": ""}, shipped},
		// Zero would paint the dot amber forever, which is the same as painting
		// it never.
		{"zero", map[string]string{"TL_HEALTH_MEM_PCT": "0"}, shipped},
		{"negative", map[string]string{"TL_HEALTH_CPU_PCT": "-3"}, shipped},
		{"above a hundred percent", map[string]string{"TL_HEALTH_IO_PCT": "150"}, shipped},
		{"not a number in any base", map[string]string{"TL_HEALTH_MEM_PCT": "0x10"}, shipped},
		{"one bad value does not take the good ones with it", map[string]string{
			"TL_HEALTH_CPU_PCT": "nope", "TL_HEALTH_IO_PCT": "65",
		}, healthThresholds{CPUPct: 10, IOPct: 65, MemPct: 10, CPUVeryPct: 20, IOVeryPct: 70, MemVeryPct: 20}},

		// A very-busy line has to sit above its own amber line, or the row would
		// report very busy at a rate where it has not yet reported busy. A
		// refused pair becomes 100, which the tier check can never exceed: the
		// resource keeps saying busy and stops short of very busy.
		{"a very line under its amber line", map[string]string{"TL_HEALTH_CPU_VERY_PCT": "5"},
			healthThresholds{CPUPct: 10, IOPct: 50, MemPct: 10, CPUVeryPct: 100, IOVeryPct: 70, MemVeryPct: 20}},
		{"a very line equal to its amber line", map[string]string{"TL_HEALTH_IO_VERY_PCT": "50"},
			healthThresholds{CPUPct: 10, IOPct: 50, MemPct: 10, CPUVeryPct: 20, IOVeryPct: 100, MemVeryPct: 20}},
		// The same repair when the operator moves the AMBER line up past a very
		// line they never touched.
		{"an amber line raised past an untouched very line", map[string]string{"TL_HEALTH_MEM_PCT": "30"},
			healthThresholds{CPUPct: 10, IOPct: 50, MemPct: 30, CPUVeryPct: 20, IOVeryPct: 70, MemVeryPct: 100}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := parseHealthThresholds(func(k string) string { return c.env[k] })
			if got != c.want {
				t.Errorf("got %+v, want %+v", got, c.want)
			}
		})
	}
}

// --- the sparkline series -----------------------------------------------------

func TestHealthSeriesDrawsTheDecidingPressure(t *testing.T) {
	r := stallRing(120, 10*time.Second, 0.20, 0.10, 0)
	pts := r.series(10*time.Minute, defaultLimits())
	// The first 60 samples have less than ten minutes behind them, so they are
	// omitted rather than drawn as zero — a zero reads as "the box was fine",
	// which is a different claim from "we do not know yet".
	if len(pts) != 60 {
		t.Fatalf("points: got %d, want 60", len(pts))
	}
	for i, p := range pts {
		if p.Resource != "cpu" || !closeTo(p.Pct, 20) || !closeTo(p.OfLimit, 2) {
			t.Fatalf("point %d: got %+v, want cpu at 20%% and twice its line", i, p)
		}
	}
	if pts[len(pts)-1].At != r.all()[119].At.Unix() {
		t.Error("the last point is not the newest sample")
	}
	// The line and the dot are read off the same arithmetic, so the right-hand
	// end of the line is the number that decided the colour. Nothing here has
	// crossed a very-busy line, so the verdict names the amber leader too; the
	// test above covers the case where the two deliberately differ.
	v := healthVerdictFrom(r, defaultLimits())
	if !closeTo(pts[len(pts)-1].Pct, v.CPUPct) || pts[len(pts)-1].Resource != v.Worst {
		t.Errorf("the line disagrees with the verdict: %+v against %q at %v",
			pts[len(pts)-1], v.Worst, v.CPUPct)
	}
}

func TestHealthSeriesIsEmptyUntilThereIsHistoryBehindIt(t *testing.T) {
	if pts := stallRing(30, 10*time.Second, 0.5, 0, 0).series(10*time.Minute, defaultLimits()); len(pts) != 0 {
		t.Errorf("got %d points from five minutes of history, want none", len(pts))
	}
	if pts := newHealthRing().series(10*time.Minute, defaultLimits()); len(pts) != 0 {
		t.Errorf("an empty ring drew %d points", len(pts))
	}
	// A ring with no PSI in it has no pressure to draw, and the panel says so
	// in words instead.
	r := newHealthRing()
	for i := 0; i < 120; i++ {
		r.add(healthSample{At: healthEpoch.Add(time.Duration(i) * 10 * time.Second), Load1: 1, NProc: 4})
	}
	if pts := r.series(10*time.Minute, defaultLimits()); len(pts) != 0 {
		t.Errorf("a ring with no PSI drew %d points", len(pts))
	}
}

// --- the invariant ------------------------------------------------------------

// The box being busy is never "down". Red means "you are disconnected", and the
// person reading this row is plainly connected — they are looking at it. This
// test feeds the verdict deliberately hostile rings: counters that run
// backwards, clocks that do, zero cores, totals near the width of a uint64.
func TestHealthVerdictIsNeverDown(t *testing.T) {
	rng := rand.New(rand.NewSource(20260912))
	states := map[string]bool{healthWorking: true, healthDegraded: true, healthUnknown: true}
	tiers := map[string]bool{healthTierFine: true, healthTierBusy: true, healthTierVeryBusy: true}

	for i := 0; i < 20000; i++ {
		r := newHealthRing()
		n := rng.Intn(8)
		at := healthEpoch
		for j := 0; j < n; j++ {
			// Steps that sometimes run backwards or stand still, so a verdict
			// can never assume time only moves one way.
			at = at.Add(time.Duration(rng.Intn(40)-10) * time.Second)
			r.add(healthSample{
				At:             at,
				PSI:            rng.Intn(2) == 0,
				CPUSomeTotal:   rng.Uint64(),
				IOFullTotal:    rng.Uint64(),
				MemFullTotal:   rng.Uint64(),
				Load1:          rng.Float64() * 5000,
				NProc:          rng.Intn(4) - 1, // includes 0 and -1
				MemTotalKB:     rng.Uint64() % 64_000_000,
				MemAvailableKB: rng.Uint64() % 64_000_000,
			})
		}
		limits := healthThresholds{
			CPUPct: rng.Float64() * 100,
			IOPct:  rng.Float64() * 100,
			MemPct: rng.Float64() * 100,
		}
		// Very-busy lines anywhere above their own amber line, which is the
		// only pairing parseHealthThresholds will hand out.
		limits.CPUVeryPct = limits.CPUPct + rng.Float64()*100
		limits.IOVeryPct = limits.IOPct + rng.Float64()*100
		limits.MemVeryPct = limits.MemPct + rng.Float64()*100
		v := healthVerdictFrom(r, limits)
		if !states[v.State] {
			t.Fatalf("state %q from ring #%d", v.State, i)
		}
		if !tiers[v.Tier] {
			t.Fatalf("tier %q from ring #%d", v.Tier, i)
		}
		for name, f := range map[string]float64{"cpu": v.CPUPct, "io": v.IOPct, "mem": v.MemPct, "load1": v.Load1} {
			if math.IsNaN(f) || math.IsInf(f, 0) {
				t.Fatalf("%s came back %v from ring #%d", name, f, i)
			}
		}
		if v.State == healthWorking && v.Tier != healthTierFine {
			t.Fatalf("working with tier %q from ring #%d", v.Tier, i)
		}
		// A colour on the PSI path always has a window behind it.
		if v.Source == healthSourcePSI && v.State != healthUnknown && v.WindowSeconds < 1 {
			t.Fatalf("state %q over a %ds window from ring #%d", v.State, v.WindowSeconds, i)
		}
		// The X-TL-Machine header carries these bytes, so every verdict this
		// code can produce has to marshal and has to be legal in a header. A
		// NaN would fail the first; a byte outside printable ASCII would fail
		// the second, and no ring should be able to produce either.
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("the verdict from ring #%d does not marshal: %v", i, err)
		}
		for _, c := range b {
			if c < 0x20 || c > 0x7e {
				t.Fatalf("the verdict from ring #%d rendered a byte no header may carry: %q", i, b)
			}
		}
	}
}

// The header is json.Marshal of healthVerdict, which is legal in a header only
// because every field is an enum from health.go or a number — no free text, no
// non-ASCII, no newline. A string field carrying a hostname, a path or an error
// message would break that quietly on the day someone adds it, so this fails
// then, while the header contract can still change with it.
func TestHealthVerdictCarriesNoFreeText(t *testing.T) {
	known := map[string]bool{"State": true, "Tier": true, "Worst": true, "Source": true}
	typ := reflect.TypeOf(healthVerdict{})
	for i := 0; i < typ.NumField(); i++ {
		f := typ.Field(i)
		if f.Type.Kind() == reflect.String && !known[f.Name] {
			t.Errorf("healthVerdict.%s is a string the header contract has not accounted for: "+
				"either it is an enum and belongs in this list, or it is free text and X-TL-Machine "+
				"can no longer carry the struct", f.Name)
		}
	}
}

// --- concurrency --------------------------------------------------------------

// The sampler writes on its own goroutine while every HTTP handler reads. The
// race detector runs in CI (`go test -race`), which is what makes this test
// worth its half second.
func TestHealthRingIsSafeUnderConcurrentUse(t *testing.T) {
	r := newHealthRing()
	var wg sync.WaitGroup
	stop := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		at := healthEpoch
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			at = at.Add(10 * time.Second)
			r.add(healthSample{
				At: at, PSI: true,
				CPUSomeTotal: uint64(i) * 1_000_000,
				IOFullTotal:  uint64(i) * 2_000_000,
				MemFullTotal: uint64(i) * 500_000,
				Load1:        1, NProc: 32, MemTotalKB: 32857648, MemAvailableKB: 13143240,
			})
		}
	}()

	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 500; j++ {
				_ = healthVerdictFrom(r, defaultLimits())
				_ = r.series(time.Minute, defaultLimits())
				_ = r.all()
				_ = r.len()
			}
		}()
	}
	time.Sleep(20 * time.Millisecond)
	close(stop)
	wg.Wait()
}

// --- the sampler --------------------------------------------------------------

// The goroutine main.go will start, reading this host's real /proc. It ticks
// fast enough here to build more than a second of history, which is what makes
// the verdict at the end a real one — the kernel's own counters, subtracted
// across a window that actually elapsed — rather than a check that the code
// runs. The values are the host's, so the assertions are about shape.
func TestHealthSamplerFillsTheRing(t *testing.T) {
	restore := healthSampleInterval
	healthSampleInterval = 300 * time.Millisecond
	defer func() { healthSampleInterval = restore }()

	stop := make(chan struct{})
	done := make(chan struct{})
	go func() { runHealthSampler(stop); close(done) }()

	// Five samples 300ms apart span 1.2s, over the one-second floor a verdict
	// needs.
	deadline := time.Now().Add(10 * time.Second)
	for machineHealth.len() < 5 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	close(stop)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("the sampler did not stop when its channel closed")
	}

	if machineHealth.len() < 5 {
		t.Fatalf("samples after ticking: %d", machineHealth.len())
	}
	latest, ok := machineHealth.latest()
	if !ok || latest.At.IsZero() || latest.NProc < 1 {
		t.Errorf("the sampler wrote an empty sample: %+v", latest)
	}

	v := currentMachineHealth()
	switch v.Source {
	case healthSourcePSI:
		// This box has PSI, and so does any kernel since 4.20 built with
		// CONFIG_PSI. A real window, a real verdict.
		// The state is withheld until the full ten minutes exists, and this
		// test starts a fresh sampler, so `unknown` with a partial window is
		// the CORRECT answer here rather than a failure. What must hold is
		// that the figures were really measured off this box.
		if v.WindowSeconds < 1 {
			t.Errorf("a PSI reading came back with no window: %+v", v)
		}
		if v.PartialWindow && v.State != healthUnknown {
			t.Errorf("a partial window produced a colour: %+v", v)
		}
		if !v.PartialWindow && v.State == healthUnknown {
			t.Errorf("a full window produced no verdict: %+v", v)
		}
		if latest.CPUSomeTotal == 0 && latest.IOFullTotal == 0 && latest.MemFullTotal == 0 {
			t.Error("every pressure counter read zero, which no box that has been up a while reports")
		}
	case healthSourceLoad:
		// A kernel without /proc/pressure still answers, and says which
		// reading it is on.
		if v.State == healthUnknown {
			t.Errorf("the fallback path reported nothing: %+v", v)
		}
	default:
		t.Errorf("source from the live box: %q", v.Source)
	}
	if v.State == "down" {
		t.Error("the machine channel reported down")
	}
	t.Logf("live reading on this host: %+v", v)
	t.Logf("live sample on this host: %+v", latest)
}
