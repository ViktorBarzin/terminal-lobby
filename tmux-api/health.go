package main

/*
Whether THE BOX is the reason a terminal feels slow.

ADR-0016 gave a person five answers to "why is this slow" — the terminal socket,
the transcript stream, the session list poll, notifications, and a stale build —
and every one of them is about the client. This file supplies the sixth: the
machine itself is stalling and all five channels are healthy. Design and the
measurements behind every number here:
docs/adr/0027-stall-time-says-the-box-is-busy.md.

WHY PRESSURE AND NOT LOAD. Linux PSI measures the question directly — wall-clock
time lost waiting for a resource — so "the box feels slow" and "tasks are
stalled" are the same sentence. A load average blends runnable and blocked tasks
into one figure and cannot say which it counted; on this devvm it would have read
calm through most of 40 hours of IO stall. Load stays in the reading because it
is the number people recognise and because it is what survives when PSI is
missing. It does not pick the colour.

WHY THE TOTALS AND NOT THE avg FIELDS. Each /proc/pressure row carries avg10,
avg60, avg300 and a cumulative total. The three thresholds were calibrated in
Prometheus against 10-MINUTE rates over 696 hours of this box's history, and a
rate computed from two totals ten minutes apart reproduces that exactly, where
avg60 is noisier and fires more often than anything anyone measured.

WHAT IT NEVER SAYS. "down". Red means "you are disconnected" everywhere else in
the UI, and a busy box is the opposite of disconnected — the person is reading
the row. This reaches "degraded" and stops, and how bad it is within degraded is
carried by the tier, which the frontend turns into a sentence.
*/

/*
THE WIRE CONTRACT. Two surfaces carry this verdict, and both are described here
because this file is where the shape is decided. main.go, sessions.go and
machine.go implement them; a change to either shape starts here, so that the
Go and TypeScript sides cannot drift apart one field at a time.

THE HEADER carries the verdict and never the series, following X-TL-Net's own
argument at netinfo.go: keep the header small enough to ride a poll the client
was already making, and let the client fetch the rest once, from a real
endpoint, when it actually needs it.

	X-TL-Machine: {"state":"degraded","tier":"busy","worst":"io","source":"psi",…}

It is json.Marshal of the healthVerdict below — the same bytes the endpoint
returns under its "verdict" key, so there is ONE encoder and one shape to
validate, whichever surface delivered it. A second, hand-rolled encoding is
somewhere the two can disagree, and three fields on this feature disagreed
across the two languages on the day it was built: the source enum, whether
`worst` could be null, and the name of the `res` field.

	LEGAL IN A HEADER BY CONSTRUCTION. Every field of healthVerdict is an enum
	from this file or a number, so no free text, no non-ASCII byte and no
	newline can reach the value. That is the property that makes this safe, and
	it is the property that breaks the moment someone adds a string field
	carrying a hostname, a path or an error message. Add one and the header has
	to change with it.

	PARSING IT. JSON.parse, then validate the same shape the endpoint's
	"verdict" is validated against. A field added later is ignored by a client
	that does not know it, so an older client cannot break. A header that is
	missing or that does not parse leaves the channel UNKNOWN — never healthy.
	Unknown and healthy are different claims, which is the whole reason the
	unknown state exists.

THE ROUTE is GET /machine, and it answers with a wrapper rather than a flattened
object:

	{"verdict": {…every healthVerdict field…}, "series": [{"at":…,"res":…,"pct":…,"ofLimit":…}, …]}

The wrapper is deliberate. The frontend's MachineReport is a flat interface of
exactly the verdict's fields, so `verdict` maps onto it with no reshaping, and
`series` stays visibly a different kind of thing. Flattened, the client's type
would be the union of two concerns and the next field added would have to guess
which half it had joined. The series is series(healthWindow, healthLimits()) —
the same window the verdict used, so the last point is the number that decided
the colour.
*/

import (
	"bufio"
	"io"
	"log"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The states this channel can report. They are ADR-0016's, minus "down", which
// this channel has no way to be in.
const (
	healthWorking  = "working"
	healthDegraded = "degraded"
	healthUnknown  = "unknown"
)

// How far into degraded the box is. The frontend owns the words; keeping the
// copy out of here means the sentence can be rewritten without a redeploy of
// the service, and translated without touching the arithmetic.
const (
	healthTierFine     = "fine"
	healthTierBusy     = "busy"
	healthTierVeryBusy = "very-busy"
)

// Which reading the verdict came from. A row that quietly switched to a weaker
// signal reads as a wrong number; a row that says it switched is answering the
// question.
const (
	healthSourcePSI     = "psi"     // /proc/pressure, the calibrated path
	healthSourceLoad    = "load"    // load average, where the kernel has no PSI
	healthSourceUnknown = "unknown" // nothing sampled yet

	// machineHeader rides responses the client already asks for, so the verdict
	// costs no request of its own. It carries json.Marshal of a healthVerdict;
	// the wire contract at the top of this file is the whole of the rule.
	//
	// Declared HERE, beside the contract, and referenced from machine.go rather
	// than redeclared there — two declarations of one header name is how the
	// two sides of a seam start disagreeing about what it carries.
	machineHeader = "X-TL-Machine"
)

const (
	// healthRingSize covers an hour at one sample every 10 seconds, which is
	// the window the panel's sparkline draws. A few kilobytes, emptied on
	// restart.
	healthRingSize = 360

	// healthWindow is what the thresholds mean. Ten minutes is long enough that
	// a single slow command cannot paint the dot amber and short enough that a
	// stall which has ended stops being reported within a few minutes.
	healthWindow = 10 * time.Minute

	// healthMinWindow is the narrowest window worth a verdict. Sampling every
	// ten seconds clears it on the second sample, so it never delays anything
	// in production; it is here because a rate divided by a few milliseconds is
	// jitter wearing a percentage sign, and a reading of "working, measured
	// over 0 seconds" is worse than saying nothing yet.
	healthMinWindow = time.Second

	// The amber lines, from 696 hours of this devvm measured in Prometheus: each
	// one lands near 1% of the month on its own, 2.44% for the union. They are
	// overridable because the package installs on machines other than this one
	// and the distribution they came from is this machine's.
	defaultHealthCPUPct = 10.0 // cpu, "some"
	defaultHealthIOPct  = 50.0 // io, "full"
	defaultHealthMemPct = 10.0 // memory, "full"

	// The very-busy lines, measured the same way over the same 30 days at the
	// same 10-minute rate: 2.50 hours above the CPU line, 1.17 above IO's, 1.33
	// above memory's. Each resource gets its own line rather than a multiple of
	// its amber one, for the reason the amber lines are not a single shared
	// number either — the three distributions are not the same shape. The
	// measured maxima on this box are 60.39% CPU, 87.59% IO and 56.59% memory,
	// so every line here is one the hardware has actually crossed.
	defaultHealthCPUVeryPct = 20.0 // cpu, "some"
	defaultHealthIOVeryPct  = 70.0 // io, "full"
	defaultHealthMemVeryPct = 20.0 // memory, "full"

	// healthFallbackLoadPerCore is the line on the no-PSI path. One runnable
	// task per core is the figure everyone already reads a load average
	// against, and on this box it is true 0.84-1.1% of the time, which puts it
	// in the same band of rarity as the three PSI thresholds.
	healthFallbackLoadPerCore = 1.0
)

// healthSampleInterval is a var only as a test seam; production never
// reassigns it. Ten seconds is what makes 360 entries an hour.
var healthSampleInterval = 10 * time.Second

// machineHealth is the one ring: the sampler goroutine writes it, HTTP handlers
// read it. It exists before main runs so a handler that arrives first reads an
// empty ring rather than a nil one.
var machineHealth = newHealthRing()

// healthThresholds is two lines for each resource, as percentages of wall time
// spent stalled over healthWindow: the amber one that makes the row say "busy"
// and the higher one that makes it say "very busy".
//
// Six numbers rather than one-and-a-multiplier because the distributions
// differ: at p90 this box sits at 0.86% CPU and 12.87% IO, so no single line
// and no single multiple of one could mean the same thing to a reader on both.
// The very-busy lines are 2x amber on CPU and memory and 1.4x on IO, which is
// what falls out of calibrating each against the hours it costs rather than
// against the other lines.
type healthThresholds struct {
	CPUPct float64
	IOPct  float64
	MemPct float64

	CPUVeryPct float64
	IOVeryPct  float64
	MemVeryPct float64
}

var (
	healthLimitsOnce  sync.Once
	healthLimitsValue healthThresholds
)

// healthLimits is the process's thresholds, read from the environment once.
// Once because they ship as systemd unit environment: they cannot change under
// a running process, and re-reading them per request would only invite the
// three numbers to disagree between two responses.
func healthLimits() healthThresholds {
	healthLimitsOnce.Do(func() { healthLimitsValue = parseHealthThresholds(os.Getenv) })
	return healthLimitsValue
}

// parseHealthThresholds reads TL_HEALTH_{CPU,IO,MEM}_PCT and their _VERY_
// counterparts through getenv, which is the seam the tests use. A value that is
// not a percentage is refused and logged rather than fatal: the operator gets a
// line naming what they typed, and the indicator keeps working on the
// calibrated defaults instead of the service refusing to start over a cosmetic
// setting.
//
// The amber lines are read first because each very-busy line is checked against
// its own amber line, which the operator may also have moved.
func parseHealthThresholds(getenv func(string) string) healthThresholds {
	t := healthThresholds{
		CPUPct: healthPctEnv(getenv, "TL_HEALTH_CPU_PCT", defaultHealthCPUPct),
		IOPct:  healthPctEnv(getenv, "TL_HEALTH_IO_PCT", defaultHealthIOPct),
		MemPct: healthPctEnv(getenv, "TL_HEALTH_MEM_PCT", defaultHealthMemPct),
	}
	t.CPUVeryPct = healthVeryPctEnv(getenv, "TL_HEALTH_CPU_VERY_PCT", defaultHealthCPUVeryPct, t.CPUPct)
	t.IOVeryPct = healthVeryPctEnv(getenv, "TL_HEALTH_IO_VERY_PCT", defaultHealthIOVeryPct, t.IOPct)
	t.MemVeryPct = healthVeryPctEnv(getenv, "TL_HEALTH_MEM_VERY_PCT", defaultHealthMemVeryPct, t.MemPct)
	return t
}

// healthVeryPctEnv reads one very-busy line and refuses a value that is not
// above the resource's own amber line — including the case where the operator
// raised the amber line past a very-busy line they left alone.
//
// A refused pair becomes 100, and the tier asks for strictly MORE than the
// line, so that resource keeps saying "busy" and never says "very busy". The
// alternative is a row that reports very busy at a rate where it has not yet
// reported busy, which is not a thing a reader can act on.
func healthVeryPctEnv(getenv func(string) string, name string, def, amber float64) float64 {
	v := healthPctEnv(getenv, name, def)
	if v > amber {
		return v
	}
	log.Printf("health: the very-busy line %s=%g is not above this resource's amber line of %g, so it will report busy and never very-busy", name, v, amber)
	return 100
}

func healthPctEnv(getenv func(string) string, name string, def float64) float64 {
	raw := strings.TrimSpace(getenv(name))
	if raw == "" {
		return def
	}
	v, err := strconv.ParseFloat(raw, 64)
	// Zero and below would paint the dot amber forever, which is the same as
	// never painting it; above 100 is a rate no counter can reach, so the
	// resource would go silent. Both are almost certainly a typo.
	if err != nil || math.IsNaN(v) || v <= 0 || v > 100 {
		log.Printf("health: %s=%q is not a percentage above 0 and up to 100, using %g", name, raw, def)
		return def
	}
	return v
}

// pressureLine is one "some" or "full" row of a /proc/pressure file.
type pressureLine struct {
	Avg10, Avg60, Avg300 float64
	// Total is cumulative MICROSECONDS of stall since boot. This is the field
	// the verdict uses; see the file comment for why not the averages.
	Total uint64
}

// pressureFile is a parsed /proc/pressure/<resource>. Full is zero when the row
// is absent, which is how kernels before 5.13 report CPU.
type pressureFile struct {
	Some, Full pressureLine
}

/*
parsePressure reads a /proc/pressure file, which looks like:

	some avg10=0.00 avg60=0.31 avg300=0.57 total=32098861209
	full avg10=0.00 avg60=0.00 avg300=0.00 total=0

It returns false when there is no usable "some" row — an empty file, a file that
is not a pressure file, or a row with no total= on it. That is the parser's only
verdict: whether /proc/pressure EXISTS is a question for the caller, and a
missing file is a documented state rather than an error.
*/
func parsePressure(r io.Reader) (pressureFile, bool) {
	var f pressureFile
	var haveSome bool
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		line, ok := parsePressureLine(fields[1:])
		if !ok {
			continue
		}
		switch fields[0] {
		case "some":
			f.Some, haveSome = line, true
		case "full":
			f.Full = line
		}
	}
	return f, haveSome
}

// parsePressureLine reads the key=value fields of one row. A row without a
// total= is not usable, because the totals are the whole reading.
func parsePressureLine(kvs []string) (pressureLine, bool) {
	var line pressureLine
	var haveTotal bool
	for _, kv := range kvs {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		switch k {
		case "avg10":
			line.Avg10, _ = strconv.ParseFloat(v, 64)
		case "avg60":
			line.Avg60, _ = strconv.ParseFloat(v, 64)
		case "avg300":
			line.Avg300, _ = strconv.ParseFloat(v, 64)
		case "total":
			n, err := strconv.ParseUint(v, 10, 64)
			if err != nil {
				return pressureLine{}, false
			}
			line.Total, haveTotal = n, true
		}
	}
	return line, haveTotal
}

// parseLoadavg reads the 1-minute figure from "1.04 0.94 1.40 2/3664 3791539".
func parseLoadavg(s string) (float64, bool) {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return 0, false
	}
	v, err := strconv.ParseFloat(fields[0], 64)
	// ParseFloat accepts "NaN" and "Inf", which /proc never writes and which
	// would travel all the way to the panel as a number nobody can read.
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
		return 0, false
	}
	return v, true
}

// parseMeminfo reads MemTotal and MemAvailable, in kB. Both or nothing:
// MemAvailable arrived in 3.14, and on a kernel without it there is no headroom
// figure to show, which is worth saying rather than approximating out of
// MemFree.
func parseMeminfo(r io.Reader) (totalKB, availableKB uint64, ok bool) {
	var haveTotal, haveAvail bool
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		key, rest, found := strings.Cut(sc.Text(), ":")
		if !found {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		n, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		switch key {
		case "MemTotal":
			totalKB, haveTotal = n, true
		case "MemAvailable":
			availableKB, haveAvail = n, true
		}
	}
	return totalKB, availableKB, haveTotal && haveAvail
}

// healthSources is one sample's worth of raw /proc text. Empty pressure strings
// mean the kernel has no PSI, which is a state and not a failure.
type healthSources struct {
	CPUPressure string
	IOPressure  string
	MemPressure string
	Loadavg     string
	Meminfo     string
	NProc       int
}

// healthSample is one moment's reading. It holds the CUMULATIVE totals rather
// than a rate, so any window can be derived from the ring afterwards — the
// panel's hour and the verdict's ten minutes come out of the same entries.
type healthSample struct {
	At time.Time
	// PSI says /proc/pressure answered. False puts the verdict on the load
	// fallback and makes the row say so.
	PSI bool
	// The three counters the thresholds are written against: CPU "some", IO
	// "full", memory "full". Microseconds since boot.
	CPUSomeTotal uint64
	IOFullTotal  uint64
	MemFullTotal uint64

	Load1 float64
	NProc int

	MemTotalKB     uint64
	MemAvailableKB uint64
}

// healthSampleFrom builds a sample out of already-read text, which is the seam
// that keeps the tests off the host's real /proc.
//
// All three pressure files are required before a sample counts as PSI. CONFIG_PSI
// creates all three together, so one missing is not "two thirds of a reading",
// it is a /proc that is not shaped the way this code believes.
func healthSampleFrom(at time.Time, src healthSources) healthSample {
	s := healthSample{At: at, NProc: src.NProc}
	if s.NProc < 1 {
		s.NProc = 1
	}
	cpu, cpuOK := parsePressure(strings.NewReader(src.CPUPressure))
	ioPressure, ioOK := parsePressure(strings.NewReader(src.IOPressure))
	mem, memOK := parsePressure(strings.NewReader(src.MemPressure))
	if cpuOK && ioOK && memOK {
		s.PSI = true
		s.CPUSomeTotal = cpu.Some.Total
		s.IOFullTotal = ioPressure.Full.Total
		s.MemFullTotal = mem.Full.Total
	}
	if load1, ok := parseLoadavg(src.Loadavg); ok {
		s.Load1 = load1
	}
	if total, avail, ok := parseMeminfo(strings.NewReader(src.Meminfo)); ok {
		s.MemTotalKB, s.MemAvailableKB = total, avail
	}
	return s
}

// readHealthSampleFrom reads the five files under procDir. Everything here is
// world-readable, so no privilege and no helper process is involved; a file
// that cannot be read becomes empty text and the sample says what it could not
// see.
func readHealthSampleFrom(at time.Time, procDir string) healthSample {
	read := func(parts ...string) string {
		raw, err := os.ReadFile(filepath.Join(append([]string{procDir}, parts...)...))
		if err != nil {
			return ""
		}
		return string(raw)
	}
	return healthSampleFrom(at, healthSources{
		CPUPressure: read("pressure", "cpu"),
		IOPressure:  read("pressure", "io"),
		MemPressure: read("pressure", "memory"),
		Loadavg:     read("loadavg"),
		Meminfo:     read("meminfo"),
		NProc:       runtime.NumCPU(),
	})
}

// readHealthSample reads the real /proc.
func readHealthSample(at time.Time) healthSample { return readHealthSampleFrom(at, "/proc") }

// healthRing is the last hour of samples, oldest overwritten. The sampler
// goroutine writes and every HTTP handler reads, so every method takes the
// lock; `go test -race` in CI is what keeps that honest.
type healthRing struct {
	mu   sync.RWMutex
	buf  [healthRingSize]healthSample
	next int // where the next add writes
	n    int // how many slots hold a sample, capped at healthRingSize
}

func newHealthRing() *healthRing { return &healthRing{} }

func (r *healthRing) add(s healthSample) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf[r.next] = s
	r.next = (r.next + 1) % healthRingSize
	if r.n < healthRingSize {
		r.n++
	}
}

func (r *healthRing) len() int {
	if r == nil {
		return 0
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.n
}

// at returns the i-th oldest sample. The caller holds the lock.
func (r *healthRing) at(i int) healthSample {
	if r.n < healthRingSize {
		return r.buf[i]
	}
	return r.buf[(r.next+i)%healthRingSize]
}

// all is a copy of the ring, oldest first, for a handler that wants the raw
// figures. The derived line the panel draws is series() — nothing outside this
// file should be subtracting microseconds.
func (r *healthRing) all() []healthSample {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]healthSample, r.n)
	for i := 0; i < r.n; i++ {
		out[i] = r.at(i)
	}
	return out
}

func (r *healthRing) latest() (healthSample, bool) {
	if r == nil {
		return healthSample{}, false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.n == 0 {
		return healthSample{}, false
	}
	return r.at(r.n - 1), true
}

// window returns the newest sample and the newest one at least d older than it
// — under regular spacing, the entry 60 back for a ten-minute window. When no
// sample is that old yet the widest available is returned instead, and the
// caller marks that reading as short rather than waiting ten minutes to say
// anything. Below healthMinWindow the caller says nothing at all.
//
// Searching by TIME rather than by index is deliberate: a box stalled badly
// enough to make the sampler miss ticks is exactly the box this feature is
// about, and the rate still divides by the elapsed time that actually passed.
func (r *healthRing) window(d time.Duration) (from, to healthSample, ok bool) {
	if r == nil {
		return healthSample{}, healthSample{}, false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.n < 2 {
		return healthSample{}, healthSample{}, false
	}
	to = r.at(r.n - 1)
	for i := r.n - 2; i >= 0; i-- {
		if s := r.at(i); to.At.Sub(s.At) >= d {
			return s, to, true
		}
	}
	return r.at(0), to, true
}

// healthPoint is one sample of the sparkline: the resource furthest into its
// own threshold at that moment, its stall rate, and how far into the line that
// is. OfLimit is what the line is drawn against, because 1.0 is amber for every
// resource while the raw percentages are not comparable across three different
// thresholds.
type healthPoint struct {
	At       int64   `json:"at"` // unix seconds
	Resource string  `json:"res"`
	Pct      float64 `json:"pct"`
	OfLimit  float64 `json:"ofLimit"`
}

// series is the line the panel draws, one point per sample, oldest first, each
// a rate over the `rate` window behind it. Pass healthWindow and the last point
// is the number that decided the colour, which is what keeps the line and the
// dot from ever disagreeing.
//
// A point with too little history behind it is OMITTED rather than drawn as
// zero: zero reads as "the box was fine", and "we have not measured that far
// back yet" is a different claim. After a restart the line is therefore short,
// which is the honest shape.
//
// THE SEAM WITH THE PANEL. OfLimit is normalised so 1.0 is the amber line for
// every resource, which is what lets one line carry three resources whose raw
// percentages are not comparable. The panel passes those OfLimit values to the
// Sparkline component as its series, with its threshold set to 1.0. Note that
// the normalisation is against the AMBER line only — the very-busy tier has its
// own per-resource lines, at 2x amber on CPU and memory and 1.4x on IO, so a
// point at 1.4 is not one fixed distance into red on every resource.
func (r *healthRing) series(rate time.Duration, limits healthThresholds) []healthPoint {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	pts := make([]healthPoint, 0, r.n)
	for i := 1; i < r.n; i++ {
		to := r.at(i)
		if !to.PSI {
			continue
		}
		for j := i - 1; j >= 0; j-- {
			from := r.at(j)
			if !from.PSI || to.At.Sub(from.At) < rate {
				continue
			}
			s := stallReadingBetween(from, to, limits)
			pts = append(pts, healthPoint{
				At: to.At.Unix(), Resource: s.Worst, Pct: s.WorstPct, OfLimit: s.OfLimit,
			})
			break
		}
	}
	return pts
}

// stallReading is the three rates between two samples and which resource is in
// the worst trouble.
type stallReading struct {
	CPUPct, IOPct, MemPct float64
	// Worst is the resource furthest into its own AMBER line, measured against
	// that line and not as a raw percentage: 15% CPU is 1.5x its threshold
	// while 55% IO is only 1.1x, and the reader wants to know which one is
	// hurting. Worst, WorstPct and OfLimit are all the SAME resource's, which
	// is what lets the sparkline draw a point out of the three together.
	Worst    string
	WorstPct float64
	OfLimit  float64 // WorstPct over its own amber line; 1.0 is exactly amber
	// VeryWorst and OfVery are the same pair for the VERY-BUSY lines. They are
	// tracked apart because the two orderings can disagree: the very-busy lines
	// are not a fixed multiple of the amber ones, so the resource furthest into
	// amber is not always the one that crossed red.
	VeryWorst string
	OfVery    float64
}

// blame names the resource to report beside the tier: whichever is furthest
// past the HIGHEST line it has crossed. Past a very-busy line, that is the
// very-busy leader, because the sentence a person reads to decide whether to
// stop typing has to accuse the resource that actually raised it. Short of one,
// it is the amber leader, and at "fine" it is the resource nearest its line,
// which is still the honest answer to "which one should I watch".
//
// The sparkline keeps drawing the amber leader — it draws a line, not a name,
// and its points have to stay internally consistent — so a tooltip's `res` can
// name a different resource from the sentence. That disagreement is visible
// only next to a per-point figure, which is a far smaller wrong than a sentence
// blaming the wrong resource.
func (s stallReading) blame() string {
	if s.OfVery > 1 {
		return s.VeryWorst
	}
	return s.Worst
}

func stallReadingBetween(from, to healthSample, limits healthThresholds) stallReading {
	elapsed := to.At.Sub(from.At)
	s := stallReading{
		CPUPct: round2(stallRatePct(from.CPUSomeTotal, to.CPUSomeTotal, elapsed)),
		IOPct:  round2(stallRatePct(from.IOFullTotal, to.IOFullTotal, elapsed)),
		MemPct: round2(stallRatePct(from.MemFullTotal, to.MemFullTotal, elapsed)),
	}
	// Fixed order, so a tie between two resources always names the same one.
	for _, c := range []struct {
		name  string
		pct   float64
		limit float64
		very  float64
	}{
		{"cpu", s.CPUPct, limits.CPUPct, limits.CPUVeryPct},
		{"io", s.IOPct, limits.IOPct, limits.IOVeryPct},
		{"memory", s.MemPct, limits.MemPct, limits.MemVeryPct},
	} {
		if of := overLimit(c.pct, c.limit); s.Worst == "" || of > s.OfLimit {
			s.Worst, s.WorstPct, s.OfLimit = c.name, c.pct, of
		}
		// The leader of its own race, not the amber leader's figure against a
		// second line: one resource past its own very-busy line is enough, and
		// it is the one to name when that happens.
		if of := overLimit(c.pct, c.very); s.VeryWorst == "" || of > s.OfVery {
			s.VeryWorst, s.OfVery = c.name, of
		}
	}
	return s
}

// stallRatePct turns two cumulative counters into the percentage of wall time
// the resource was stalled between them.
//
// Both guards are real. A counter that went BACKWARDS is a reset, not negative
// stall, and reporting it as a huge positive rate would paint the dot amber on
// the one event that means nothing. And no resource can stall for longer than
// the clock ran, so anything above 100% is skew rather than a measurement.
func stallRatePct(from, to uint64, elapsed time.Duration) float64 {
	micros := float64(elapsed.Microseconds())
	if micros <= 0 || to <= from {
		return 0
	}
	return math.Min(100, float64(to-from)/micros*100)
}

func overLimit(pct, limit float64) float64 {
	if limit <= 0 {
		return 0
	}
	return pct / limit
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

// finite keeps a value that arrived from outside from travelling to the panel
// as something no reader can make sense of.
func finite(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return v
}

// healthVerdict is the answer to "is the box the reason this feels slow". It is
// what the sixth channel renders, and the JSON shape the panel and the
// X-TL-Machine header are built from.
type healthVerdict struct {
	// State is ADR-0016's, minus "down": "working", "degraded" or "unknown".
	State string `json:"state"`
	// Tier is how far into degraded it is — "fine", "busy", "very-busy" — which
	// the frontend turns into the sentence a reader gets.
	Tier string `json:"tier"`
	// Worst names the resource furthest past the HIGHEST line it has crossed,
	// so that the resource the row blames is the one that set the tier beside
	// it. Under every line it is the one nearest its own, which is the honest
	// answer to "which should I watch". "load" on the fallback path, and empty
	// before anything has been measured.
	Worst string `json:"worst"`

	// The three rates over WindowSeconds, as percentages. Zero on the fallback
	// path, where no pressure was read at all.
	CPUPct float64 `json:"cpuPct"`
	IOPct  float64 `json:"ioPct"`
	MemPct float64 `json:"memPct"`

	// Displayed, and on the PSI path they decide nothing.
	Load1 float64 `json:"load1"`
	NProc int     `json:"nproc"`

	MemAvailableMB int `json:"memAvailableMb"`
	MemTotalMB     int `json:"memTotalMb"`

	// Source says which reading this is: "psi", "load" or "unknown".
	Source string `json:"source"`
	// WindowSeconds is the span the rates were computed over, and
	// PartialWindow says it was shorter than the ten minutes the thresholds
	// were calibrated against — true right after a restart, and whenever there
	// is nothing to report yet.
	WindowSeconds int  `json:"windowSeconds"`
	PartialWindow bool `json:"partialWindow"`
}

/*
healthVerdictFrom is the whole decision: a pure function of the ring and the
thresholds, with no clock of its own — the newest sample IS "now", which is what
makes it testable and what keeps a stalled sampler from reading as a healthy box.

A nil or empty ring answers "unknown", never a zero-valued verdict. Unknown is
not a severity, and a channel that has not reported has to be distinguishable
from one reporting good news — that invariant holds from the first millisecond
of process life, before the sampler has started.
*/
func healthVerdictFrom(r *healthRing, limits healthThresholds) healthVerdict {
	v := healthVerdict{
		State:         healthUnknown,
		Tier:          healthTierFine, // unknown makes no claim about how busy the box is
		Source:        healthSourceUnknown,
		PartialWindow: true,
	}
	latest, ok := r.latest()
	if !ok {
		return v
	}
	v.Load1 = finite(latest.Load1)
	v.NProc = latest.NProc
	if v.NProc < 1 {
		v.NProc = 1
	}
	v.MemTotalMB = int(latest.MemTotalKB / 1024)
	v.MemAvailableMB = int(latest.MemAvailableKB / 1024)

	if !latest.PSI {
		return healthFromLoad(v)
	}
	v.Source = healthSourcePSI

	from, to, ok := r.window(healthWindow)
	// Both ends have to be PSI readings for the subtraction to mean anything.
	// In practice a kernel does not grow or lose /proc/pressure while a process
	// runs, so this is the first ten minutes after a restart and little else.
	if !ok || !from.PSI || !to.PSI {
		return v
	}
	elapsed := to.At.Sub(from.At)
	if elapsed < healthMinWindow {
		return v
	}
	v.WindowSeconds = int(elapsed / time.Second)
	v.PartialWindow = elapsed < healthWindow

	s := stallReadingBetween(from, to, limits)
	v.CPUPct, v.IOPct, v.MemPct = s.CPUPct, s.IOPct, s.MemPct
	// The resource furthest past the highest line it has crossed, so the name
	// the row prints matches the severity printed beside it. See blame().
	v.Worst = s.blame()
	// Each resource's OWN very-busy line is the "very busy" sentence, and one
	// resource past its line is enough. Doubling the amber line was the earlier
	// design and it repeated the mistake the three amber lines exist to avoid:
	// one uniform rule over three distributions that are not uniform. It also
	// put IO's very-busy line at 100%, the ceiling of a rate, so a box stalling
	// on disk for ten straight minutes could only ever read "busy".
	//
	// The ten-minute window is what makes either tier a sustained reading
	// rather than a spike, which is why there is no consecutive-samples rule on
	// top of it: a rate averaged over ten minutes cannot be a momentary blip,
	// and asking for the same thing twice would only delay the sentence.
	//
	// A SHORT WINDOW REPORTS FIGURES BUT NO COLOUR. The thresholds ARE
	// ten-minute rates, so measuring a ten-SECOND rate against them is a
	// different measurement wearing the same number: sixty times narrower, so
	// far more variable, and it would cross a line at a rate nobody calibrated.
	// The first ten minutes after a restart is also the worst possible moment
	// to cry wolf, because it is exactly when someone has just deployed and is
	// watching. So while PartialWindow is set the state stays `unknown`, which
	// this model already defines as "has not reported" and which every rule
	// skips rather than counting as health or as fault. The percentages, the
	// load, the memory and the window itself are all still filled in above, so
	// the panel shows live figures throughout and only the dot waits.
	if v.PartialWindow {
		v.State, v.Tier = healthUnknown, healthTierFine
		return v
	}
	switch {
	case s.OfVery > 1:
		v.State, v.Tier = healthDegraded, healthTierVeryBusy
	case s.OfLimit > 1:
		v.State, v.Tier = healthDegraded, healthTierBusy
	default:
		v.State, v.Tier = healthWorking, healthTierFine
	}
	return v
}

// healthFromLoad is the verdict where the kernel has no /proc/pressure — older
// kernels, some container runtimes, the Docker dev environment. The row keeps
// reporting and says in words that it is on a weaker signal: a row that
// disappears reads as a bug and cannot be asked about, and a degraded signal is
// worth more than a blank one as long as it does not pretend to be the good one.
//
// The line is one runnable task per core, which is the figure a load average is
// already read against and which this box crosses 0.84-1.1% of the time — the
// same band of rarity as the three PSI thresholds. MemAvailable is reported
// beside it but decides nothing: no headroom threshold has been measured, and
// an invented one would fire at a rate nobody has checked.
func healthFromLoad(v healthVerdict) healthVerdict {
	v.Source = healthSourceLoad
	v.Worst = "load"
	// A load average is its own one-minute window, so there is nothing partial
	// about this reading and no rate behind it.
	v.PartialWindow = false
	perCore := v.Load1 / float64(v.NProc)
	switch {
	case perCore > 2*healthFallbackLoadPerCore:
		v.State, v.Tier = healthDegraded, healthTierVeryBusy
	case perCore > healthFallbackLoadPerCore:
		v.State, v.Tier = healthDegraded, healthTierBusy
	default:
		v.State, v.Tier = healthWorking, healthTierFine
	}
	return v
}

// currentMachineHealth is what a handler asks for — the sessions poll's
// X-TL-Machine header and the panel's own endpoint both come from here. Safe
// before the sampler has started: an unwritten ring answers "unknown".
func currentMachineHealth() healthVerdict {
	return healthVerdictFrom(machineHealth, healthLimits())
}

// runHealthSampler fills the ring until stop is closed, following
// runPrewarmReaper's shape. Five world-readable files every ten seconds, so it
// is cheap enough to run for the life of the process on any box, whether or not
// anyone ever opens the panel.
//
// It takes one reading immediately: the first tick is ten seconds away, and a
// row that says "unknown" for the first ten seconds of a process's life is a row
// people would meet mostly after a deploy.
func runHealthSampler(stop <-chan struct{}) {
	machineHealth.add(readHealthSample(time.Now()))
	t := time.NewTicker(healthSampleInterval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case now := <-t.C:
			machineHealth.add(readHealthSample(now))
		}
	}
}
