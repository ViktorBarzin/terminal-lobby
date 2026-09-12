# Stall time says the box is busy, load average only describes it

Viktor, 2026-09-12: *"the goal is to allow users to know the load of the machine
and the overall health. If the machine is overloaded, then users should expect
worse behaviour and slowness."*

ADR-0016 built a status model for the five things a **client** keeps alive, and
it answers "why is this slow" five ways, all of them about the browser's end.
The sixth answer — the box itself is stalling and every channel is fine — had no
surface. It was visible only in Prometheus and Grafana, which is not somewhere
the person holding the slow terminal can go.

The obvious build is a load average in the corner. This ADR records why it is
not that, and what the choice costs.

```stats
6 | channels, up from five
3 | resources read, one threshold each
2.44 % | of 30 days the dot would have been amber
17 h | of 696, measured against Prometheus
0 | new requests in the common case
0 | behaviour the app changes under load
```

## What we decided

**Linux PSI decides the colour. Load average stays on screen and decides
nothing.**

Design and the full measurements:
[Tell people when the box is the reason](../plans/2026-09-12-machine-health-indicator-design.md).

| Question | Decision |
|---|---|
| What picks the colour | Worst of CPU, IO and memory stall from `/proc/pressure` |
| What is displayed | Those three, plus the load average |
| How far it goes | Amber at worst. Never red, no process list, no per-user slice |
| Where it lives | A sixth channel in ADR-0016's model, one dot, one panel row |
| Where the numbers come from | `tmux-api` samples every 10 s; the reading rides the session poll |
| What it changes | Nothing. It reports and the app behaves identically |

### Load average would have been calm through most of the pain

Measured on this devvm over 56.2 days of uptime, with the same counters
confirmed in Prometheus:

| resource | stalled (some) | stalled (full) | % of uptime |
|---|---|---|---|
| IO | 40.50 h | 37.71 h | 3.00% |
| CPU | 8.92 h | 0.00 h | 0.66% |
| memory | 2.85 h | 2.58 h | 0.21% |

IO stall is 4.5 times more common than CPU stall here, and for IO `full` is
almost equal to `some`: when this box stalls on disk, every non-idle task stalls
together. That is the experience the feature exists to name, and it is not what
people picture when they picture an overloaded machine.

Load1 normalised per core over the same window sits at p50 0.056, p90 0.176,
p99 1.089. A load average blends runnable and blocked tasks into one figure and
cannot say which it counted, so a load-only indicator would have read green
through a large share of those 40 hours.

PSI measures the question directly: wall-clock time lost to waiting for a
resource. "The box feels slow" and "tasks are stalled" are the same sentence.

### The trade we are making

PSI is less familiar than a load average. A number most engineers have read for
thirty years is being demoted, in the UI, beneath one many have never seen. That
is a real cost in legibility and it is why load stays on the panel: it gives a
reader something recognisable to anchor against, and it is the fallback when PSI
is unavailable.

PSI also needs a kernel that has it. Where `/proc/pressure` is absent — older
kernels, some container runtimes, the Docker dev environment — the row falls
back to load and memory headroom and says in words that it has. ADR-0016's
reasoning carries: a row that vanishes reads as a bug and cannot be asked about.

### Three resources, three thresholds

The distributions differ enough on this hardware that one shared number could
not serve all three. At p90, IO `full` is 12.87% while CPU `some` is 0.86%. A
single line at 10% would have painted amber about 5% of the month on IO alone
while CPU never spoke, and an indicator that is amber one hour in twenty is one
people are likely to stop reading.

| resource | amber above | hours in 30 d |
|---|---|---|
| CPU, `some` | 10% | 7.17 |
| IO, `full` | 50% | 7.33 |
| memory, `full` | 10% | 4.83 |
| any of the three | | 17.00 (2.44% of 696 h) |

Each line lands near 1% on its own so that all three mean the same thing to a
reader. The target for the union was 1-3%: about half an hour a day, rare enough
to carry meaning and common enough that people meet it before the day it
matters.

They ship as environment on the systemd unit. The package installs on machines
other than this one, and the distribution above is this machine's.

### Amber, and never red

`degraded` means wait and `down` means act — ADR-0016's distinction, and the one
a frozen terminal actually needs. There is no action to take about a busy
machine, and the box is not down: the person is talking to it. If load ever gets
bad enough to break the poll, the Session list channel goes red on its own row,
which is the accurate statement.

So red keeps one meaning, "you are disconnected". Depth within amber is carried
by the sentence instead — "may feel slow" against "is slow right now" — which is
what someone who opens the panel reads anyway.

### It reports, and changes nothing

Backing off the hover-preload or stretching attach timeouts when the box is busy
is tempting and was declined. An app that quietly does less under load is an app
whose slowness has two causes that cannot be separated from the outside, and
this channel exists to remove ambiguity about why things feel slow, not to add
some.

## What we did not do

**Show what is eating the box.** No process list and no per-user breakdown. The
stated goal is expectation-setting; a top-N of other people's commands on a
shared box is a different feature carrying a privacy question.

**Report your own slice.** Each user has a 24 GB cap and each pane a 6 GB scope
cap, so "you are at your cap" is a sharper fact than "the box is busy". It is
also a second number to explain on a surface that has none yet. Deferred, not
rejected, and the collection half is already built: `tl-session-watch` attributes
per-pane cgroup memory by {user, session} every 30 seconds and publishes
`tl_pane_memory_bytes` (`tl-session-watch/collect.go:447-465`, `emit.go:83-118`).

**CPU steal.** Measured, raised, and deliberately left out. Steal on this VM sat
above 10% for 8.67 hours of the last 30 days and peaked at 43.8% — the
hypervisor handing vCPUs to other guests, with nothing inside the box looking
responsible. The first cut stays with the three resources a person can reason
about. The consequence, recorded so it is not a surprise later: this indicator
can read green through a slow hour whose cause is outside the VM.

**Disk, swap, and service checks.** Swap is the closest call, with 8 GB of 23 GB
in use as this was written, and swapping is felt directly.

**A Prometheus-backed graph.** Prometheus holds these exact counters for the
devvm, but at a 2-minute scrape interval and about 13 weeks of coverage (61,343
samples, 85.2 days), not the 26 weeks the k8s nodes get. Over a 60-minute window
that is 30 points against the ring buffer's 360, so the query would give a
coarser graph and would tie Terminal Lobby to one homelab's monitoring stack,
handing every other install a blank panel. A 360-entry ring buffer in the Go
service covers the hour the panel shows, in a few kilobytes, anywhere.

**New telemetry.** Prometheus already has all of it, so a second copy sent from
the browser would spend the ADR-0008 budget on data we hold.

**Alerting.** No toast and no push. Host alerting exists; a second channel
repeating it teaches people to ignore both.

## Open questions

- 2.44% is a judgement about attention, not a measurement. The first month of
  real use is what tests it.
- The IO threshold rests on a strong claim: that this box fully stalls for
  everyone 7.33 hours a month. No user report has yet been matched to those
  hours. If the two disagree, the mismatch is worth understanding before the
  number moves.
- The sparkline empties on service restart, so it is shortest right after a
  deploy — which is one of the moments someone is most likely to look.
- The machine-wide memory threshold may be watching the wrong level. Over the
  last 30 days `earlyoom` killed nothing and the host never approached OOM
  (minimum available memory 1.06 GiB across 13 weeks), while 73 processes were
  killed by the per-pane 6 GB cgroup cap — 51 vitest, 12 ffmpeg, 4 claude, all
  `CONSTRAINT_MEMCG` against a `tmux-spawn-*.scope`. Memory pain on this box is
  mostly per-pane, which a machine-wide reading will stay green through. That is
  an argument for the deferred per-user slice above, and worth weighing before
  the memory input is treated as carrying its share.
