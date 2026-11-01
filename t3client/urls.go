package t3client

import (
	"fmt"
	"regexp"
	"strings"
)

// DefaultDomain is the parent domain of the per-user T3 hosts when
// TL_T3_DOMAIN is unset.
const DefaultDomain = "viktorbarzin.me"

var (
	userRe = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	hostRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`)
)

// validUser is the OS user rule t3-mint applies, so a name that reaches a
// file path or a sudo argument here is one t3-mint would accept.
func validUser(u string) error {
	if !userRe.MatchString(u) {
		return fmt.Errorf("t3client: invalid user name %q", u)
	}
	return nil
}

// Hosts names each user's public T3 host.
type Hosts struct {
	// Domain is the parent of the default host, t3-<user>.<Domain>.
	Domain string
	// Override maps a user to a host that does not follow the default.
	Override map[string]string
}

// ParseHosts reads a TL_T3_HOSTS value, "user=host" pairs separated by
// commas or whitespace, for example "wizard=t3.viktorbarzin.me".
func ParseHosts(spec, domain string) (Hosts, error) {
	domain = strings.ToLower(strings.TrimSpace(domain))
	if !hostRe.MatchString(domain) {
		return Hosts{}, fmt.Errorf("t3client: invalid T3 domain %q", domain)
	}
	h := Hosts{Domain: domain, Override: map[string]string{}}
	for _, pair := range strings.FieldsFunc(spec, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' || r == '\n' }) {
		user, host, ok := strings.Cut(pair, "=")
		host = strings.ToLower(host)
		if !ok || validUser(user) != nil || !hostRe.MatchString(host) {
			return Hosts{}, fmt.Errorf("t3client: TL_T3_HOSTS entry %q is not user=host", pair)
		}
		if _, dup := h.Override[user]; dup {
			return Hosts{}, fmt.Errorf("t3client: TL_T3_HOSTS names %q twice", user)
		}
		h.Override[user] = host
	}
	return h, nil
}

// HostsFromEnv reads TL_T3_HOSTS and TL_T3_DOMAIN (default DefaultDomain).
func HostsFromEnv(getenv func(string) string) (Hosts, error) {
	domain := strings.TrimSpace(getenv("TL_T3_DOMAIN"))
	if domain == "" {
		domain = DefaultDomain
	}
	return ParseHosts(getenv("TL_T3_HOSTS"), domain)
}

// Host is the user's public T3 host.
func (h Hosts) Host(user string) string {
	if v, ok := h.Override[user]; ok {
		return v
	}
	if h.Domain == "" {
		return ""
	}
	return "t3-" + user + "." + h.Domain
}

// WebURL opens a thread in T3's web client on the user's host. The thread id
// is escaped the way T3's own links escape it (JavaScript's
// encodeURIComponent), so "mcp:x" becomes "mcp%3Ax".
func (l Location) WebURL(threadID string) string {
	return "https://" + l.Host + "/" + l.EnvironmentID + "/" + EncodeURIComponent(threadID)
}

// AppURL opens a thread in the T3 app, which routes on
// t3code://threads/<environmentId>/<threadId>.
func (l Location) AppURL(threadID string) string {
	return "t3code://threads/" + l.EnvironmentID + "/" + threadID
}

// EncodeURIComponent matches JavaScript's encodeURIComponent: everything
// except A-Z a-z 0-9 - _ . ! ~ * ' ( ) is percent-encoded as UTF-8.
// url.PathEscape differs, for one, it leaves ':' alone.
func EncodeURIComponent(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&15])
	}
	return b.String()
}
