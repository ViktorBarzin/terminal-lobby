package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

/*
The network a client is on, which is what turns "Data used" into "Data used on
cellular". The browser cannot answer this — Safari has never shipped the Network
Information API, and where the API does exist it reports "4g" on a wired desktop
— so the answer is derived here, from the address the request arrived from.

These tests pin what decides whether a person's per-network figures are
trustworthy: which header the client address is read from, that ONLY a forwarded
private address is the house, that a public one is resolved to its owning
operator exactly once per TTL, and that the header a poll carries never blocks
and never leaks between callers.
*/

// stubResolver answers TXT lookups from a table and counts them, so a test can
// assert both the parse and that the cache stopped the second lookup.
type stubResolver struct {
	txt  map[string][]string
	n    int
	fail bool
}

func (s *stubResolver) LookupTXT(_ context.Context, name string) ([]string, error) {
	s.n++
	if s.fail {
		return nil, errors.New("dns unavailable")
	}
	v, ok := s.txt[name]
	if !ok {
		return nil, errors.New("NXDOMAIN")
	}
	return v, nil
}

// blockingResolver never answers, standing in for DNS that is slow or gone.
type blockingResolver struct{}

func (blockingResolver) LookupTXT(ctx context.Context, _ string) ([]string, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

// a1 is a Cymru answer pair in the shape a real one comes back in: the origin lookup returns TWO records because
// the address sits inside both a /18 and a /20 announcement.
func a1() *stubResolver {
	return &stubResolver{txt: map[string][]string{
		"76.113.0.203.origin.asn.cymru.com": {
			"64500 | 203.0.64.0/18 | GB | ripencc | 2011-05-18",
			"64501 | 203.0.112.0/20 | GB | ripencc | 2011-05-18",
		},
		"AS64501.asn.cymru.com": {"64501 | GB | ripencc | 2003-10-15 | EXAMPLE_RSG - Example Telecom Ltd, GB"},
		"AS64500.asn.cymru.com": {"64500 | GB | ripencc | 1997-09-19 | EXAMPLE-WIDE-AS, GB"},
	}}
}

func freshCache() *netCache { return newNetCache(time.Hour, 64) }

// --- which address the request came from -------------------------------------

func TestClientIPPrefersCloudflareOverForwardedFor(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/netinfo", nil)
	r.RemoteAddr = "192.0.2.5:41234"
	// A client may send its own X-Forwarded-For; Cloudflare overwrites
	// CF-Connecting-IP, so that one is the only entry nobody downstream typed.
	r.Header.Set("X-Forwarded-For", "203.0.113.9, 203.0.113.76")
	r.Header.Set("CF-Connecting-IP", "203.0.113.76")
	got, via := clientAddr(r)
	if got != "203.0.113.76" || via != "CF-Connecting-IP" {
		t.Fatalf("clientAddr = %q via %q, want the CF-Connecting-IP value", got, via)
	}
}

func TestClientIPFallsBackThroughRealIPThenForwardedThenPeer(t *testing.T) {
	cases := []struct {
		name    string
		headers map[string]string
		peer    string
		want    string
		via     string
	}{
		{"x-real-ip", map[string]string{"X-Real-Ip": "203.0.113.76"}, "192.0.2.5:1", "203.0.113.76", "X-Real-Ip"},
		{"leftmost xff", map[string]string{"X-Forwarded-For": "203.0.113.76, 172.64.0.1"}, "192.0.2.5:1", "203.0.113.76", "X-Forwarded-For"},
		{"peer only", nil, "192.168.1.44:52001", "192.168.1.44", "peer"},
		{"peer without port", nil, "192.168.1.44", "192.168.1.44", "peer"},
		{"blank header ignored", map[string]string{"X-Real-Ip": "  "}, "192.168.1.44:1", "192.168.1.44", "peer"},
		{"garbage header ignored", map[string]string{"X-Real-Ip": "not-an-ip"}, "192.168.1.44:1", "192.168.1.44", "peer"},
		{"nothing at all", nil, "", "", "none"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/netinfo", nil)
			r.RemoteAddr = c.peer
			for k, v := range c.headers {
				r.Header.Set(k, v)
			}
			got, via := clientAddr(r)
			if got != c.want || via != c.via {
				t.Fatalf("clientAddr = %q via %q, want %q via %q", got, via, c.want, c.via)
			}
		})
	}
}

// --- a private address needs no lookup ---------------------------------------

func TestForwardedPrivateAddressIsTheHouseWithoutADNSLookup(t *testing.T) {
	// Split-horizon DNS points the lobby's host at the internal ingress, so a
	// phone on home WiFi arrives from the LAN and never leaves the house. That
	// is the one case that classifies with certainty.
	for _, ip := range []string{"192.168.1.44", "10.0.20.9", "172.16.4.4", "127.0.0.1", "100.64.0.3", "::1", "fd00::5"} {
		res := &stubResolver{}
		got := classifyIP(context.Background(), ip, true, res, freshCache())
		if got.Net != netLAN || got.Source != sourceLAN {
			t.Fatalf("%s: got %+v, want the house verdict", ip, got)
		}
		if res.n != 0 {
			t.Fatalf("%s: resolved %d names; a private address must not be looked up", ip, res.n)
		}
	}
}

func TestAnUnforwardedAddressIsNeverTheHouse(t *testing.T) {
	// Every real request arrives through Traefik, which forwards. One that did
	// not is an in-cluster probe or something on the box, and its peer address
	// is always private — so trusting it would mean an edge that stopped
	// forwarding labelled every device's traffic as home, silently.
	for _, ip := range []string{"192.168.1.44", "10.0.20.9", "203.0.113.76"} {
		res := &stubResolver{}
		got := classifyIP(context.Background(), ip, false, res, freshCache())
		if got.Net != netUnknown || got.Source != sourceNone {
			t.Fatalf("%s: got %+v, want unknown", ip, got)
		}
		if res.n != 0 {
			t.Fatalf("%s: resolved %d names; an unforwarded address is not looked up", ip, res.n)
		}
	}
}

// --- a public address is resolved to its network -----------------------------

func TestPublicAddressResolvesToTheLongestMatchingPrefix(t *testing.T) {
	res := a1()
	got := classifyIP(context.Background(), "203.0.113.76", true, res, freshCache())
	// 203.0.112.0/20 is more specific than 203.0.64.0/18, so AS64501 is the
	// network the address actually sits in. Picking the first record instead
	// would name the wrong operator.
	if got.Net != "as64501" {
		t.Fatalf("Net = %q, want as64501 (the /20, not the /18)", got.Net)
	}
	if got.Label != "Example Telecom Ltd" {
		t.Fatalf("Label = %q, want the operator name without the Cymru handle or country suffix", got.Label)
	}
	if got.CC != "GB" {
		t.Fatalf("CC = %q, want GB", got.CC)
	}
	if got.Source != sourceASN {
		t.Fatalf("Source = %q, want %q", got.Source, sourceASN)
	}
}

func TestAnOperatorIsNeverCategorised(t *testing.T) {
	// The category was removed on purpose: an operator's name says nothing
	// reliable about whether the link is fixed or mobile, so the panel names
	// networks and leaves the categorising to the reader.
	body, _ := json.Marshal(classifyIP(context.Background(), "203.0.113.76", true, a1(), freshCache()))
	for _, word := range []string{"kind", "wifi", "cell"} {
		if strings.Contains(string(body), word) {
			t.Fatalf("answer %s still carries %q", body, word)
		}
	}
}

func TestASNResultIsCachedPerAddress(t *testing.T) {
	res, cache := a1(), freshCache()
	first := classifyIP(context.Background(), "203.0.113.76", true, res, cache)
	after := res.n
	second := classifyIP(context.Background(), "203.0.113.76", true, res, cache)
	if res.n != after {
		t.Fatalf("second call resolved %d more names; want the cached answer", res.n-after)
	}
	if first != second {
		t.Fatalf("cached answer %+v differs from %+v", second, first)
	}
}

func TestExpiredCacheEntryIsResolvedAgain(t *testing.T) {
	res, cache := a1(), newNetCache(time.Hour, 64)
	classifyIP(context.Background(), "203.0.113.76", true, res, cache)
	after := res.n
	// Age every entry past the TTL rather than sleeping.
	cache.mu.Lock()
	for k, e := range cache.entries {
		e.at = e.at.Add(-2 * time.Hour)
		cache.entries[k] = e
	}
	cache.mu.Unlock()
	classifyIP(context.Background(), "203.0.113.76", true, res, cache)
	if res.n <= after {
		t.Fatal("an expired entry was served from cache")
	}
}

func TestCacheEvictsWhenFull(t *testing.T) {
	cache := newNetCache(time.Hour, 2)
	cache.put("a", netInfo{Net: "as1"})
	cache.put("b", netInfo{Net: "as2"})
	cache.put("c", netInfo{Net: "as3"})
	cache.mu.Lock()
	n := len(cache.entries)
	cache.mu.Unlock()
	if n > 2 {
		t.Fatalf("cache holds %d entries, want at most 2", n)
	}
}

func TestFailedLookupStillNamesAStableNetwork(t *testing.T) {
	// A lookup that fails must not merge every unknown network into one bucket,
	// or a month spent roaming reads as a single mystery total.
	res := &stubResolver{fail: true}
	a := classifyIP(context.Background(), "203.0.113.76", true, res, freshCache())
	b := classifyIP(context.Background(), "203.0.113.9", true, res, freshCache())
	if a.Source != sourceNone {
		t.Fatalf("got %+v, want an unresolved verdict", a)
	}
	if a.Net == "" || a.Net == b.Net {
		t.Fatalf("nets %q and %q must be present and distinct", a.Net, b.Net)
	}
	if strings.Contains(a.Net, "203.0.113.76") {
		t.Fatalf("Net %q leaks the address it was derived from", a.Net)
	}
}

// --- the endpoint ------------------------------------------------------------

func TestNetinfoRefusesAnonymousAndNonGET(t *testing.T) {
	rec := httptest.NewRecorder()
	handleNetinfo(rec, httptest.NewRequest(http.MethodGet, "/netinfo", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous GET: status %d, want 401", rec.Code)
	}

	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	rec = httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/netinfo", nil)
	r.Header.Set(authHeader, "wiz")
	handleNetinfo(rec, r)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST: status %d, want 405", rec.Code)
	}
}

func TestNetinfoAnswersTheCallersNetworkAndIsNotCachedByTheBrowser(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	prev := netinfoResolver
	netinfoResolver = a1()
	defer func() { netinfoResolver = prev }()
	netinfoCache = newNetCache(time.Hour, 64)

	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/netinfo", nil)
	r.Header.Set(authHeader, "wiz")
	r.Header.Set("CF-Connecting-IP", "203.0.113.76")
	handleNetinfo(rec, r)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	// The whole point is that the answer changes when the network does, so it
	// must never come back from the HTTP cache.
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", cc)
	}
	var got netInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	if got.Net != "as64501" || got.Label != "Example Telecom Ltd" || got.CC != "GB" {
		t.Fatalf("body = %+v, want the Example Telecom network", got)
	}
	// The address itself is not part of the answer: the client needs a stable
	// name for the network, and nothing it does with one needs the address.
	if strings.Contains(rec.Body.String(), "203.0.113.76") {
		t.Fatalf("response leaks the client address: %s", rec.Body.String())
	}
}

// --- the header a poll carries -----------------------------------------------

func netHeaderFor(t *testing.T, headers map[string]string, peer string) string {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/sessions", nil)
	r.RemoteAddr = peer
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	setNetworkHeader(rec, r)
	return rec.Header().Get(netHeader)
}

func TestNetworkHeaderNamesTheHouseAndTheUnforwarded(t *testing.T) {
	cases := []struct {
		name    string
		headers map[string]string
		peer    string
		want    string
	}{
		{"forwarded private", map[string]string{"X-Forwarded-For": "192.168.1.44"}, "10.0.20.5:1", netLAN},
		// A definite answer, not a missing one: the client must drop whatever
		// it was holding rather than keep attributing to it.
		{"peer only", nil, "10.0.20.104:1", netUnknown},
		{"no address at all", nil, "", netUnknown},
		{"garbage header falls through to the peer", map[string]string{"X-Real-Ip": "nope"}, "10.0.20.104:1", netUnknown},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := netHeaderFor(t, c.headers, c.peer); got != c.want {
				t.Fatalf("%s = %q, want %q", netHeader, got, c.want)
			}
		})
	}
}

func TestNetworkHeaderAnswersFromCacheAndNeverBlocks(t *testing.T) {
	prev := netinfoResolver
	// A resolver that would hang far past any poll interval. If the header path
	// ever waited on DNS, the five-second poll would stall behind it.
	netinfoResolver = blockingResolver{}
	defer func() { netinfoResolver = prev }()
	netinfoCache = newNetCache(time.Hour, 64)

	done := make(chan string, 1)
	go func() {
		done <- netHeaderFor(t, map[string]string{"CF-Connecting-IP": "203.0.113.76"}, "10.0.20.5:1")
	}()
	select {
	case got := <-done:
		// A miss sets NO header: the client keeps the answer it has, under its
		// own staleness rule, rather than being told "unknown" every poll while
		// a lookup is still in flight.
		if got != "" {
			t.Fatalf("%s = %q on a cache miss, want no header", netHeader, got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("setNetworkHeader blocked on the resolver")
	}

	// Once the answer is cached, the same request answers from it.
	netinfoCache.put("203.0.113.76", netInfo{Net: "as64501", Source: sourceASN})
	if got := netHeaderFor(t, map[string]string{"CF-Connecting-IP": "203.0.113.76"}, "10.0.20.5:1"); got != "as64501" {
		t.Fatalf("%s = %q, want the cached network", netHeader, got)
	}
}

func TestSessionsStampsTheCallersOwnNetworkPastTheBodyCache(t *testing.T) {
	// The /sessions BODY is cached per OS user and shared by that user's
	// devices. The header must not be: a phone on cellular and a desktop at
	// home poll the same cached body and have to receive different answers.
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	netinfoCache = newNetCache(time.Hour, 64)
	netinfoCache.put("203.0.113.76", netInfo{Net: "as64501", Source: sourceASN})

	get := func(clientIP string) (string, string) {
		r := httptest.NewRequest(http.MethodGet, "/sessions", nil)
		r.Header.Set(authHeader, "wiz")
		r.Header.Set("CF-Connecting-IP", clientIP)
		rec := httptest.NewRecorder()
		handleSessions(rec, r)
		return rec.Header().Get(netHeader), rec.Body.String()
	}

	first, bodyA := get("203.0.113.76") // warms the per-user body cache
	second, bodyB := get("192.168.1.44")

	if first != "as64501" {
		t.Fatalf("first caller got %q, want as64501", first)
	}
	if second != netLAN {
		t.Fatalf("second caller got %q, want %q — the header rode the cached body", second, netLAN)
	}
	if bodyA != bodyB {
		t.Fatalf("bodies differ (%q vs %q); the cache was supposed to serve both", bodyA, bodyB)
	}
}
