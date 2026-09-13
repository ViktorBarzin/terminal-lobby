package main

/*
How the box's own verdict reaches a browser. health.go decides it and settles
both wire shapes; this file is the two doors they come out of.

WHY A HEADER, AND WHY NOT A FIELD IN THE BODY. The lobby already polls
/sessions every five seconds, so a verdict stamped on that response costs no
request of its own — the argument netinfo.go:51 made for X-TL-Net, and the
reason the common case here is zero new requests. It cannot be a field in the
list, though: the /sessions BODY is memoised per OS user for five seconds
(main.go, sessionsTTL) and shared across that user's devices, so a verdict
inside it would be up to a poll stale. A header is written per response, before
the cache is consulted, which is exactly where setNetworkHeader already stamps.

WHY AN ENDPOINT AS WELL. The header carries the verdict and nothing else. The
panel draws an hour of history behind it, and it is open only while somebody is
watching the number move — which is the one moment a dedicated request is worth
making. Run check probes the same endpoint, because a row that sits still while
five others refresh reads as broken.

WHAT NEITHER DOOR DOES. Read /proc. The sampler goroutine owns that, once every
ten seconds; both of these read a ring in memory under a read lock, so a
five-second poll from every open tab costs arithmetic and no syscalls.
*/

import (
	"encoding/json"
	"log"
	"net/http"
)

// setMachineHeader stamps the current verdict on a response as X-TL-Machine.
//
// The value is json.Marshal of the verdict, which is health.go's contract and
// not this file's to vary: the endpoint returns those same bytes under its
// "verdict" key, so one encoder feeds both surfaces and a client validates one
// shape whichever door it came through.
//
// No *http.Request, unlike setNetworkHeader: the network answer is about the
// caller and differs per device, while there is one box and every caller gets
// the same reading of it.
//
// A marshal that fails sets NO header, and a client that sees none reads the
// channel as unknown — which is the honest answer and is what it already does
// for a response from a build that predates this. Every field is an enum or a
// number today, so there is nothing here that can fail; the branch is what
// keeps a future field from turning a /sessions poll into a broken response.
func setMachineHeader(w http.ResponseWriter) {
	raw, err := json.Marshal(currentMachineHealth())
	if err != nil {
		log.Printf("machine: header encode: %v", err)
		return
	}
	w.Header().Set(machineHeader, string(raw))
}

// machineReading is GET /machine. A wrapper rather than one flat object, which
// is health.go's contract: the frontend's MachineReport is exactly the
// verdict's fields, so "verdict" maps onto it with no reshaping and "series"
// stays visibly a different kind of thing.
type machineReading struct {
	Verdict healthVerdict `json:"verdict"`
	// Series is the hour behind the dot, one point per sample, each a rate over
	// the same ten minutes the verdict used. The last point is therefore the
	// number that picked the colour, which is what keeps the line and the dot
	// from ever disagreeing on screen. Empty for the first ten minutes after a
	// restart, and on a kernel with no PSI — both honest shapes, and the panel
	// says so in words rather than drawing a flat line along zero.
	Series []healthPoint `json:"series"`
}

// GET /machine → the full reading. What the Right now panel polls while it is
// open, and what Run check probes.
func handleMachine(w http.ResponseWriter, r *http.Request) {
	// Authenticated like every other surface here. The REAL caller, not an
	// act-as target: ?as= chooses whose sessions you are looking at, and there
	// is only one machine to report on either way.
	if resolveRealOSUser(w, r) == "" {
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	// Two reads of the ring rather than one. A sample landing between them
	// would leave the line one point newer than the verdict — ten seconds on a
	// ten-minute window, resolved by the next poll a few seconds later — and
	// the alternative is a combined accessor that exists for no other caller.
	reading := machineReading{
		Verdict: currentMachineHealth(),
		Series:  machineHealth.series(healthWindow, healthLimits()),
	}
	// The number moves while somebody watches it, which is the one thing a
	// cached response cannot show.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(reading); err != nil {
		log.Printf("machine: encode: %v", err)
	}
}
