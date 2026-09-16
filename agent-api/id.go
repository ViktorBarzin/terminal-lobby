package main

// Identifiers.
//
// Trace ids, task ids and generated conversation names are all ULIDs: 48 bits
// of millisecond timestamp then 80 bits of randomness, Crockford base32, 26
// characters. Sortable by creation time as plain text, which is what makes
// `sort` over a day of trace.jsonl useful and what lets a conversation list
// read chronologically without a clock field.
//
// The design doc's own example ids are ULIDs ("01JB…"), so this matches what
// the document told the caller to expect.

import (
	"crypto/rand"
	"sync"
	"time"
)

// crockford is base32 without I, L, O or U, so a hand-copied id cannot be
// misread between 1/I, 0/O and V/U.
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// idGen mints ULIDs. The mutex guards the monotonic carry: two ids minted in
// the same millisecond must still sort in the order they were created, or two
// tasks submitted back to back read as simultaneous.
type idGen struct {
	mu   sync.Mutex
	last uint64   // last millisecond used
	seed [10]byte // that millisecond's entropy, incremented per id
	now  func() time.Time
}

func newIDGen(now func() time.Time) *idGen {
	if now == nil {
		now = time.Now
	}
	return &idGen{now: now}
}

// New mints one id.
//
// Within a millisecond the entropy is INCREMENTED rather than redrawn, which
// is the ULID spec's monotonic mode. Redrawing gives two ids in the same
// millisecond a coin-flip order, and folding a counter into the low bytes does
// not help either, because the untouched high bytes dominate the sort.
func (g *idGen) New() string {
	g.mu.Lock()
	ms := uint64(g.now().UnixMilli())
	if ms == g.last {
		incrementEntropy(&g.seed)
	} else {
		if _, err := rand.Read(g.seed[:]); err != nil {
			g.mu.Unlock()
			// crypto/rand does not fail on any platform this runs on, and an
			// id that repeats is worse than a panic in a service whose whole
			// audit trail is keyed on ids being distinct.
			panic("agent-api: crypto/rand: " + err.Error())
		}
		// Leave headroom so a long burst inside one millisecond cannot carry
		// past the top and wrap back below an id already handed out.
		g.seed[0] &= 0x7f
		g.last = ms
	}
	entropy := g.seed
	g.mu.Unlock()

	var b [16]byte
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	copy(b[6:], entropy[:])
	return encodeULID(b)
}

// incrementEntropy adds one to an 80-bit big-endian counter, carrying upward.
func incrementEntropy(e *[10]byte) {
	for i := len(e) - 1; i >= 0; i-- {
		e[i]++
		if e[i] != 0 {
			return
		}
	}
}

// encodeULID renders 16 bytes as 26 Crockford base32 characters, which is 130
// bits of alphabet over 128 bits of value — the first character therefore only
// ever reaches 7.
func encodeULID(b [16]byte) string {
	out := make([]byte, 26)
	// Timestamp: 48 bits over the first 10 characters.
	ts := uint64(b[0])<<40 | uint64(b[1])<<32 | uint64(b[2])<<24 |
		uint64(b[3])<<16 | uint64(b[4])<<8 | uint64(b[5])
	for i := 9; i >= 0; i-- {
		out[i] = crockford[ts&0x1f]
		ts >>= 5
	}
	// Entropy: 80 bits over the remaining 16 characters, high bits first.
	hi := uint64(b[6])<<32 | uint64(b[7])<<24 | uint64(b[8])<<16 | uint64(b[9])<<8 | uint64(b[10])
	lo := uint64(b[11])<<32 | uint64(b[12])<<24 | uint64(b[13])<<16 | uint64(b[14])<<8 | uint64(b[15])
	for i := 7; i >= 0; i-- {
		out[10+i] = crockford[hi&0x1f]
		hi >>= 5
	}
	for i := 7; i >= 0; i-- {
		out[18+i] = crockford[lo&0x1f]
		lo >>= 5
	}
	return string(out)
}
