package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// GET /netinfo names the network a request arrived over, so the browser's
// "Data used" panel can say how much of a month went over cellular rather than
// WiFi — the question that matters while roaming.
//
// WHY THE SERVER ANSWERS THIS. The browser cannot. Safari has never shipped the
// Network Information API (200 of 200 iPhone diagnostic records carry no
// tl.net.* at all), and where it does exist it is unreliable for this question:
// a wired desktop in this house reports effectiveType "4g". The address a
// request came from is the only signal available on every device, and it lives
// here.
//
// THREE ANSWERS, CHEAPEST FIRST.
//   - A private address means the client reached the internal ingress, which
//     split-horizon DNS points terminal.viktorbarzin.me at. Being on the LAN is
//     WiFi with certainty, and costs no lookup at all.
//   - A public address is resolved to its owning network through Team Cymru's
//     DNS service — free, no account, no API key, and cached here so a phone
//     polling every couple of minutes resolves nothing.
//   - A lookup that fails still names the network, from a keyed digest of the
//     address, so a roaming month does not collapse into one mystery total.
//
// WHAT IT DELIBERATELY DOES NOT DECIDE. Whether a named network is cellular is
// only GUESSED here, and only on an unambiguous tell in the operator's name.
// Most operators sell fixed and mobile access under one brand — the AS name on
// a subscriber line and on the same operator's mobile network is frequently the
// same string — so a brand-name match would be wrong about half the time. Unknown is the honest
// default; the client remembers the person's own correction per network, in
// their roamed prefs, and one tap settles a network for good.

const (
	kindWiFi    = "wifi"
	kindCell    = "cell"
	kindUnknown = "unknown"

	sourceLAN  = "lan"  // a private address; certain
	sourceASN  = "asn"  // resolved to an operator
	sourceNone = "none" // no answer; the client may still separate networks

	// A network changes when a person moves, not on a timer, so an address may
	// be held for a long time. Six hours bounds the staleness of an operator
	// rename without making the phone's poll cost a lookup.
	netCacheTTL = 6 * time.Hour
	// Enough for every network a person passes through in a TTL, with room for
	// the other users of the box. The cost of overflowing is a repeat lookup.
	netCacheMax = 512
	// Cymru answers in milliseconds. A lookup that takes longer than this is a
	// broken resolver, and the panel is better served by "unknown" than by a
	// request that hangs.
	netLookupTimeout = 2 * time.Second
)

// netInfo is what the browser gets: a stable name for the network, the verdict,
// and enough to show a person which network they are on. The client's own
// address is deliberately absent — nothing the client does with this needs it.
type netInfo struct {
	// Net is the client's key for this network — "lan", "as64501", or
	// "ip-<digest>". Stable across reconnects, which is what lets a person's
	// correction stick to a network rather than to a session.
	Net string `json:"net"`
	// Kind is the guess: wifi, cell, or unknown. The client overrides it.
	Kind string `json:"kind"`
	// Label is the operator, for the "you are on X" line. May be empty.
	Label string `json:"label,omitempty"`
	// CC is the two-letter country the network is registered in, which is how
	// a person spots that they are abroad.
	CC string `json:"cc,omitempty"`
	// Source says which of the three answers this is, so the client can show a
	// lookup failure as unknown rather than as a verdict.
	Source string `json:"source"`
}

// txtResolver is the DNS seam. net.Resolver satisfies it; tests supply a table.
type txtResolver interface {
	LookupTXT(ctx context.Context, name string) ([]string, error)
}

// netinfoResolver and netinfoCache are vars only as test seams; production
// never reassigns them.
var (
	netinfoResolver txtResolver = net.DefaultResolver
	netinfoCache                = newNetCache(netCacheTTL, netCacheMax)
)

// netDigestSalt keys the digest that names an unresolved network. Per-process
// and random-by-birth (the address of a fresh allocation is not predictable
// enough to rely on, so the clock is mixed in): the digest only has to be
// stable for the life of a process and unlinkable to the address it came from.
var netDigestSalt = strconv.FormatInt(time.Now().UnixNano(), 36)

type netCacheEntry struct {
	info netInfo
	at   time.Time
}

type netCache struct {
	mu      sync.Mutex
	entries map[string]netCacheEntry
	ttl     time.Duration
	max     int
}

func newNetCache(ttl time.Duration, max int) *netCache {
	return &netCache{entries: map[string]netCacheEntry{}, ttl: ttl, max: max}
}

func (c *netCache) get(key string) (netInfo, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || time.Since(e.at) > c.ttl {
		return netInfo{}, false
	}
	return e.info, true
}

// put stores an answer, dropping the oldest entries when full. Eviction is by
// age rather than by use: an address nobody has asked about for hours is the
// one whose answer matters least.
func (c *netCache) put(key string, info netInfo) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) >= c.max {
		oldest, at := "", time.Time{}
		for k, e := range c.entries {
			if at.IsZero() || e.at.Before(at) {
				oldest, at = k, e.at
			}
		}
		delete(c.entries, oldest)
	}
	c.entries[key] = netCacheEntry{info: info, at: time.Now()}
}

// clientAddr is the address the request came from, and which header it was
// read from. Trust order: Cloudflare overwrites CF-Connecting-IP with the
// address it accepted the connection from, so it is the one header no
// intermediary or client can have typed; Traefik's X-Real-Ip is the same claim
// one hop later. A leftmost X-Forwarded-For is spoofable, which costs nothing
// worse here than a wrongly-labelled figure in the spoofer's own browser, so it
// stays as the third choice ahead of a peer address that is always the edge.
//
// The header name is returned because it is the difference between a verdict
// and a coincidence: every request reaches this service through Traefik, so if
// the edge ever stopped forwarding, `peer` would be a private address and every
// byte on every device would be labelled WiFi with nothing on screen to say so.
func clientAddr(r *http.Request) (addr, via string) {
	for _, h := range []string{"CF-Connecting-IP", "X-Real-Ip"} {
		if ip := net.ParseIP(strings.TrimSpace(r.Header.Get(h))); ip != nil {
			return ip.String(), h
		}
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		first, _, _ := strings.Cut(xff, ",")
		if ip := net.ParseIP(strings.TrimSpace(first)); ip != nil {
			return ip.String(), "X-Forwarded-For"
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(strings.TrimSpace(host)); ip != nil {
		return ip.String(), "peer"
	}
	return "", "none"
}


// isLocalAddr covers every address that cannot have crossed the public
// internet to get here: loopback, link-local, the RFC1918 ranges, unique-local
// v6, and the carrier-grade NAT range — which reaching this server means a
// mesh peer rather than a phone, since a carrier's own NAT presents a public
// address to the outside.
func isLocalAddr(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
		return true
	}
	_, cgnat, _ := net.ParseCIDR("100.64.0.0/10")
	return cgnat.Contains(ip)
}

// reverseIPv4 turns 203.0.113.76 into the 76.113.0.203 that Cymru's origin
// zone is keyed by.
func reverseIPv4(ip net.IP) (string, bool) {
	v4 := ip.To4()
	if v4 == nil {
		return "", false
	}
	return strconv.Itoa(int(v4[3])) + "." + strconv.Itoa(int(v4[2])) + "." +
		strconv.Itoa(int(v4[1])) + "." + strconv.Itoa(int(v4[0])), true
}

// parseOrigin reads Cymru's origin answer — "<asn> | <prefix> | <cc> | <registry>
// | <date>". An address inside overlapping announcements gets one record per
// announcement, so the MOST SPECIFIC prefix wins: it is the one the address is
// actually routed by, and the shorter one frequently belongs to a different
// operator in
// practice.
func parseOrigin(txts []string) (asn, cc string, ok bool) {
	best := -1
	for _, txt := range txts {
		f := splitCymru(txt)
		if len(f) < 3 {
			continue
		}
		_, prefix, err := net.ParseCIDR(f[1])
		if err != nil {
			continue
		}
		ones, _ := prefix.Mask.Size()
		if ones > best {
			best, asn, cc, ok = ones, f[0], f[2], true
		}
	}
	return asn, cc, ok
}

// parseASName reads Cymru's AS answer — "<asn> | <cc> | <registry> | <date> |
// <name>" — and returns the operator as a person would recognise it. The name
// field carries a routing handle, the operator, and a country suffix
// ("EXAMPLE_RSG - Example Telecom Ltd, GB"); only the middle part belongs on
// screen.
func parseASName(txts []string) string {
	for _, txt := range txts {
		f := splitCymru(txt)
		if len(f) < 5 {
			continue
		}
		name := f[4]
		if _, rest, found := strings.Cut(name, " - "); found {
			name = rest
		}
		if i := strings.LastIndex(name, ","); i > 0 {
			// Only a trailing two-letter country code, never a comma that is
			// part of the operator's own name.
			if tail := strings.TrimSpace(name[i+1:]); len(tail) == 2 {
				name = name[:i]
			}
		}
		if name = strings.TrimSpace(name); name != "" {
			return name
		}
	}
	return ""
}

func splitCymru(txt string) []string {
	f := strings.Split(strings.Trim(txt, `"`), "|")
	for i := range f {
		f[i] = strings.TrimSpace(f[i])
	}
	return f
}

// mobileTell matches only names that are about mobile access whatever operator
// carries them. Brand names are excluded on purpose — see the file comment.
var mobileTell = regexp.MustCompile(`(?i)(^|[^a-z])(mobile|mobil|cellular|gsm|umts|lte|nr|[2345]g)([^a-z]|$)`)

// guessKind is the starting position, not the answer: cell on an unambiguous
// tell, unknown otherwise. A person's own correction always wins over this.
func guessKind(asName string) string {
	if mobileTell.MatchString(asName) {
		return kindCell
	}
	return kindUnknown
}

// classifyIP is the whole decision, cache included.
func classifyIP(ctx context.Context, addr string, res txtResolver, cache *netCache) netInfo {
	ip := net.ParseIP(addr)
	if ip == nil {
		return netInfo{Net: "unknown", Kind: kindUnknown, Source: sourceNone}
	}
	if isLocalAddr(ip) {
		// Not cached: it costs nothing to decide, and caching it would hold a
		// LAN address in memory for no gain.
		return netInfo{Net: "lan", Kind: kindWiFi, Label: "Home network", Source: sourceLAN}
	}
	if hit, ok := cache.get(ip.String()); ok {
		return hit
	}
	info := resolveNetwork(ctx, ip, res)
	cache.put(ip.String(), info)
	return info
}

// resolveNetwork asks Cymru which network announces this address, then what
// that network is called. Either lookup failing leaves a usable answer.
func resolveNetwork(ctx context.Context, ip net.IP, res txtResolver) netInfo {
	unresolved := netInfo{Net: digestNet(ip), Kind: kindUnknown, Source: sourceNone}

	rev, ok := reverseIPv4(ip)
	if !ok {
		// Cymru's v6 zone is keyed by nibble-reversed address. Not built out
		// here: this network is v4 end to end, and an honest unknown beats a
		// path nothing exercises.
		return unresolved
	}
	ctx, cancel := context.WithTimeout(ctx, netLookupTimeout)
	defer cancel()

	origin, err := res.LookupTXT(ctx, rev+".origin.asn.cymru.com")
	if err != nil {
		return unresolved
	}
	asn, cc, ok := parseOrigin(origin)
	if !ok {
		return unresolved
	}
	info := netInfo{Net: "as" + asn, Kind: kindUnknown, CC: cc, Source: sourceASN}

	// The name is a nicety: without it the network is still named and still
	// correctable, it just reads as "AS64501" on screen.
	if names, err := res.LookupTXT(ctx, "AS"+asn+".asn.cymru.com"); err == nil {
		info.Label = parseASName(names)
		info.Kind = guessKind(info.Label)
	}
	return info
}

// digestNet names a network that could not be resolved, without carrying the
// address into the client or the store. Distinct addresses stay distinct, so a
// month of roaming still separates into networks.
func digestNet(ip net.IP) string {
	sum := sha256.Sum256([]byte(netDigestSalt + "|" + ip.String()))
	return "ip-" + hex.EncodeToString(sum[:4])
}

func handleNetinfo(w http.ResponseWriter, r *http.Request) {
	// Authenticated like every other surface here, though the answer is about
	// the caller's own connection: an unauthenticated caller has no business
	// learning anything about this box's view of the internet.
	if resolveRealOSUser(w, r) == "" {
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	addr, via := clientAddr(r)
	_, cached := netinfoCache.get(addr)
	info := classifyIP(r.Context(), addr, netinfoResolver, netinfoCache)
	// One line the first time a network is seen, and never the address itself
	// — Traefik's access log already holds those, and this only has to answer
	// "which header did the verdict come from, and what did it decide".
	if !cached {
		log.Printf("netinfo: via %s -> %s (%s)", via, info.Net, info.Kind)
	}
	// The verdict changes the moment the person moves between networks, which
	// is exactly when a cached response would be wrong.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(info); err != nil {
		log.Printf("netinfo: encode: %v", err)
	}
}
