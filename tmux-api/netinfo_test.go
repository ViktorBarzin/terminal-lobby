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

These tests pin the three things that decide whether a person's cellular figure
is trustworthy: which header the client address is read from, that a private
address is called WiFi without asking anyone, and that a public one is resolved
to its owning network exactly once per TTL.
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

// a1 is a real Cymru answer pair: the origin lookup returns TWO records because
// the address sits inside both a /18 and a /20 announcement.
func a1() *stubResolver {
	return &stubResolver{txt: map[string][]string{
		"76.22.12.176.origin.asn.cymru.com": {
			"8717 | 176.12.0.0/18 | BG | ripencc | 2011-05-18",
			"29580 | 176.12.16.0/20 | BG | ripencc | 2011-05-18",
		},
		"AS29580.asn.cymru.com": {"29580 | BG | ripencc | 2003-10-15 | A1BG_RSG - A1 Bulgaria EAD, BG"},
		"AS8717.asn.cymru.com":  {"8717 | BG | ripencc | 1997-09-19 | A1-BG-AS, BG"},
	}}
}

func freshCache() *netCache { return newNetCache(time.Hour, 64) }

// --- which address the request came from -------------------------------------

func TestClientIPPrefersCloudflareOverForwardedFor(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/netinfo", nil)
	r.RemoteAddr = "10.0.20.5:41234"
	// A client may send its own X-Forwarded-For; Cloudflare overwrites
	// CF-Connecting-IP, so that one is the only entry nobody downstream typed.
	r.Header.Set("X-Forwarded-For", "203.0.113.9, 176.12.22.76")
	r.Header.Set("CF-Connecting-IP", "176.12.22.76")
	got, via := clientAddr(r)
	if got != "176.12.22.76" || via != "CF-Connecting-IP" {
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
		{"x-real-ip", map[string]string{"X-Real-Ip": "176.12.22.76"}, "10.0.20.5:1", "176.12.22.76", "X-Real-Ip"},
		{"leftmost xff", map[string]string{"X-Forwarded-For": "176.12.22.76, 172.64.0.1"}, "10.0.20.5:1", "176.12.22.76", "X-Forwarded-For"},
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

func TestPrivateAddressIsWiFiWithoutADNSLookup(t *testing.T) {
	// Split-horizon DNS points terminal.viktorbarzin.me at the internal ingress,
	// so a phone on home WiFi arrives from the LAN and never leaves the house.
	// That is the one case that classifies with certainty.
	for _, ip := range []string{"192.168.1.44", "10.0.20.9", "172.16.4.4", "127.0.0.1", "100.64.0.3", "::1", "fd00::5"} {
		res := &stubResolver{}
		got := classifyIP(context.Background(), ip, res, freshCache())
		if got.Kind != kindWiFi || got.Net != "lan" {
			t.Fatalf("%s: got %+v, want the lan/wifi verdict", ip, got)
		}
		if res.n != 0 {
			t.Fatalf("%s: resolved %d names; a private address must not be looked up", ip, res.n)
		}
	}
}

// --- a public address is resolved to its network -----------------------------

func TestPublicAddressResolvesToTheLongestMatchingPrefix(t *testing.T) {
	res := a1()
	got := classifyIP(context.Background(), "176.12.22.76", res, freshCache())
	// 176.12.16.0/20 is more specific than 176.12.0.0/18, so AS29580 is the
	// network the address actually sits in. Picking the first record instead
	// would name the wrong operator.
	if got.Net != "as29580" {
		t.Fatalf("Net = %q, want as29580 (the /20, not the /18)", got.Net)
	}
	if got.Label != "A1 Bulgaria EAD" {
		t.Fatalf("Label = %q, want the operator name without the Cymru handle or country suffix", got.Label)
	}
	if got.CC != "BG" {
		t.Fatalf("CC = %q, want BG", got.CC)
	}
	if got.Source != sourceASN {
		t.Fatalf("Source = %q, want %q", got.Source, sourceASN)
	}
}

func TestASNResultIsCachedPerAddress(t *testing.T) {
	res, cache := a1(), freshCache()
	first := classifyIP(context.Background(), "176.12.22.76", res, cache)
	after := res.n
	second := classifyIP(context.Background(), "176.12.22.76", res, cache)
	if res.n != after {
		t.Fatalf("second call resolved %d more names; want the cached answer", res.n-after)
	}
	if first != second {
		t.Fatalf("cached answer %+v differs from %+v", second, first)
	}
}

func TestExpiredCacheEntryIsResolvedAgain(t *testing.T) {
	res, cache := a1(), newNetCache(time.Hour, 64)
	classifyIP(context.Background(), "176.12.22.76", res, cache)
	after := res.n
	// Age every entry past the TTL rather than sleeping.
	cache.mu.Lock()
	for k, e := range cache.entries {
		e.at = e.at.Add(-2 * time.Hour)
		cache.entries[k] = e
	}
	cache.mu.Unlock()
	classifyIP(context.Background(), "176.12.22.76", res, cache)
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
	a := classifyIP(context.Background(), "176.12.22.76", res, freshCache())
	b := classifyIP(context.Background(), "203.0.113.9", res, freshCache())
	if a.Kind != kindUnknown || a.Source != sourceNone {
		t.Fatalf("got %+v, want an unknown verdict", a)
	}
	if a.Net == "" || a.Net == b.Net {
		t.Fatalf("nets %q and %q must be present and distinct", a.Net, b.Net)
	}
	if strings.Contains(a.Net, "176.12.22.76") {
		t.Fatalf("Net %q leaks the address it was derived from", a.Net)
	}
}

// --- the guess, which one tap overrides --------------------------------------

func TestKindGuessOnlyFiresOnAnUnambiguousMobileTell(t *testing.T) {
	cell := []string{
		"EE-MOBILE - EE Mobile, GB",
		"VIVACOM-MOBILE, BG",
		"A1BG-GSM - A1 Bulgaria mobile network, BG",
		"CELLULAR-ONE, US",
		"SOMEISP LTE Access, DE",
	}
	for _, name := range cell {
		if got := guessKind(name); got != kindCell {
			t.Fatalf("guessKind(%q) = %q, want %q", name, got, kindCell)
		}
	}
	// Brand names are deliberately NOT tells: every one of these operators sells
	// fixed broadband under the same name, and a confidently wrong label is
	// worse than an unknown one — both cost the same single tap to correct.
	fixed := []string{
		"A1BG_RSG - A1 Bulgaria EAD, BG",
		"VODAFONE_UK - Vodafone Limited, GB",
		"BT-UK-AS BTnet UK Regional network, GB",
		"",
	}
	for _, name := range fixed {
		if got := guessKind(name); got != kindUnknown {
			t.Fatalf("guessKind(%q) = %q, want %q", name, got, kindUnknown)
		}
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
	r.Header.Set("CF-Connecting-IP", "176.12.22.76")
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
	if got.Net != "as29580" || got.Label != "A1 Bulgaria EAD" || got.CC != "BG" {
		t.Fatalf("body = %+v, want the A1 Bulgaria network", got)
	}
	// The address itself is not part of the answer: the client needs a stable
	// name for the network, and nothing it does with one needs the address.
	if strings.Contains(rec.Body.String(), "176.12.22.76") {
		t.Fatalf("response leaks the client address: %s", rec.Body.String())
	}
}
