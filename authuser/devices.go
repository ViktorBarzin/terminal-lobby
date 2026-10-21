package authuser

// Device tokens: the bearer a T3 app holds after it is paired from the lobby
// (ADR-0045).
//
// A paired app is a person's own client, not a machine caller, and it differs
// from a bearer.go credential in every way that decides where it is kept. It is
// issued by a signed-in person pressing a button rather than by an operator, so
// the service has to be able to write it. There is one per phone or desktop
// app, and a person adds and removes them from Settings. And it never refreshes:
// T3's clients hold the token they were given for as long as they are paired.
// So device tokens live in their own registry, written by tmux-api, and are
// told apart from file credentials by a prefix on the token itself.
//
// The token as presented is DeviceTokenPrefix followed by 43 characters of
// base64url, 32 random bytes. The registry holds only BearerDigest of it, for
// the reason the tokens file does: every lobby service reads the file, and a
// reader should find nothing it can present.
//
// Format, JSON, one object per paired app:
//
//	{"devices":[{"id":"a1b2c3d4e5f60718","user":"wizard","label":"Pixel 8",
//	  "deviceType":"mobile","os":"android","digest":"sha256:…","created":1900000000}]}
//
// Who may write it. tmux-api is its only writer, and tmux-api runs as the
// service account, so the file belongs to that account: the owner must be the
// uid this process runs as, and the mode 0600 or tighter. That is a weaker
// owner rule than the tokens file's root, and it costs nothing that was not
// already spent. A process running as the service account can read
// TL_PROXY_SECRET out of any service's /proc/<pid>/environ and then send any
// identity header it likes, so the account is already able to act as every
// lobby user; a registry it can write adds no reach it lacked. The boundary
// file modes do enforce is against the box's other OS users, and 0600 under a
// 0700 state directory keeps the registry from them.
//
// Last use lives in a second file, devices-seen.json, {"<id>": <unix seconds>},
// also written by tmux-api and held to the same owner and mode. It is separate
// so the registry is written only when a person pairs or revokes, and a busy
// device refreshing its last use can never race a revoke into bringing a
// deleted device back. A device whose last use (its seen entry, else the day
// it was paired) is older than DeviceIdleLimit is refused.
//
// What the tests pin:
//
//   - Only a token carrying the prefix reads either file. A browser request
//     has no Authorization header and a file credential has no prefix, so
//     neither gains a read.
//   - A prefixed token is answered by the registry alone. A miss is 401, never
//     a second attempt at the tokens file or the header path, and that holds
//     with an empty or absent registry too: the prefix is this repo's own, so
//     unlike a bare bearer it cannot belong to a proxy upstream.
//   - The identity's Header is the person's own identity name, never the
//     device's label. session-events shows that name to other people.

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
)

// DeviceTokenPrefix marks a device token. The digit is a format version, so a
// later token shape can be told from this one without guessing.
const DeviceTokenPrefix = "tld1_"

// DefaultDevicesPath and DefaultDevicesSeenPath are where tmux-api keeps the
// registry when TL_DEVICES and TL_DEVICES_SEEN say nothing. The directory is
// tmux-api's StateDirectory=, 0700 and owned by the service account.
const (
	DefaultDevicesPath     = "/var/lib/terminal-lobby/devices.json"
	DefaultDevicesSeenPath = "/var/lib/terminal-lobby/devices-seen.json"
)

// DeviceIdleLimit is how long a paired app may go unused before its token
// stops working. T3's clients never refresh, so this is the only expiry a
// device has.
const DeviceIdleLimit = 90 * 24 * time.Hour

// The three ways a request can authenticate, as Identity.Method reports them.
const (
	// MethodBrowser is the identity header behind the proxy: a signed-in
	// person in a browser.
	MethodBrowser = "browser"
	// MethodToken is a credential from the root-owned tokens file
	// (bearer.go): a machine caller an operator issued.
	MethodToken = "token"
	// MethodDevice is a device token: a T3 app a person paired.
	MethodDevice = "device"
)

// Device is one paired app, as the registry stores it.
type Device struct {
	// ID names the device to its owner (list, revoke) and keys the seen file.
	// 16 hex characters; not a secret.
	ID   string `json:"id"`
	User string `json:"user"`
	// Label, DeviceType and OS are what the client said about itself when it
	// paired. They are shown to the device's owner and to nobody else.
	Label      string `json:"label"`
	DeviceType string `json:"deviceType"`
	OS         string `json:"os"`
	// Digest is BearerDigest of the token.
	Digest  string `json:"digest"`
	Created int64  `json:"created"`
}

// DeviceRegistry is the whole registry document.
type DeviceRegistry struct {
	Devices []Device `json:"devices"`
}

// deviceIDRe is the shape tmux-api mints: 8 random bytes in lower-case hex.
var deviceIDRe = regexp.MustCompile(`^[0-9a-f]{16}$`)

// ValidDeviceID reports whether id has the shape of a device id. tmux-api
// checks a DELETE path against it before looking anything up.
func ValidDeviceID(id string) bool { return deviceIDRe.MatchString(id) }

// NewDeviceToken mints a device token. The format is defined here rather than
// in tmux-api so the issuer and the gate cannot drift.
func NewDeviceToken() (string, error) {
	b := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return "", err
	}
	return DeviceTokenPrefix + base64.RawURLEncoding.EncodeToString(b), nil
}

// DevicesPath is the configured registry path, or the compiled default.
// Exported so tmux-api writes the file the gate reads.
func (g *Gate) DevicesPath() string {
	if p := g.Config.DevicesPath; p != "" {
		return p
	}
	return DefaultDevicesPath
}

// DevicesSeenPath is the configured seen file, or the compiled default.
func (g *Gate) DevicesSeenPath() string {
	if p := g.Config.DevicesSeenPath; p != "" {
		return p
	}
	return DefaultDevicesSeenPath
}

// devicesOwner is the uid both files must belong to: this process's own.
func (g *Gate) devicesOwner() int {
	if g.devicesOwnerUID != nil {
		return g.devicesOwnerUID()
	}
	return os.Getuid()
}

func (g *Gate) clock() time.Time {
	if g.now != nil {
		return g.now()
	}
	return time.Now()
}

// readOwnFile reads one of the two device files, holding it to the owner and
// mode rule above. Every failure is nil, which each caller reads as "nothing
// here": no devices, or no last-use entries.
func (g *Gate) readOwnFile(path string) []byte {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	// From the open file, for bearerCreds' reason: what is checked is what is
	// read.
	info, err := f.Stat()
	if err != nil {
		return nil
	}
	want := g.devicesOwner()
	if owner, ok := fileOwnerUID(info); !ok || owner != want {
		log.Printf("authuser: ignoring %s: owned by uid %d, want %d, the account tmux-api runs as",
			path, owner, want)
		return nil
	}
	if perm := info.Mode().Perm(); perm&^0o600 != 0 {
		log.Printf("authuser: ignoring %s: mode %04o, want 0600 or tighter", path, perm)
		return nil
	}
	// The registry grows by one entry per paired app. A megabyte is thousands
	// of them, so anything larger is not a registry this service wrote.
	raw, err := io.ReadAll(io.LimitReader(f, 1<<20))
	if err != nil {
		return nil
	}
	return raw
}

// pairedDevice is one usable registry entry, digest parsed.
type pairedDevice struct {
	Device
	digest [sha256.Size]byte
}

// devices parses the registry. A record that does not validate is skipped and
// logged by position, never by content, so one bad entry costs that entry.
func (g *Gate) devices() []pairedDevice {
	if g.countDeviceReads != nil {
		g.countDeviceReads()
	}
	path := g.DevicesPath()
	raw := g.readOwnFile(path)
	if raw == nil {
		return nil
	}
	var reg DeviceRegistry
	if err := json.Unmarshal(raw, &reg); err != nil {
		log.Printf("authuser: ignoring %s: not a device registry", path)
		return nil
	}
	out := make([]pairedDevice, 0, len(reg.Devices))
	for i, d := range reg.Devices {
		digest, ok := parseDigest(d.Digest)
		if !ok || !deviceIDRe.MatchString(d.ID) || !userRe.MatchString(d.User) {
			log.Printf("authuser: %s entry %d skipped: want a 16-hex id, a plain account name and sha256:<64 hex digits>", path, i)
			continue
		}
		out = append(out, pairedDevice{Device: d, digest: digest})
	}
	return out
}

// lastSeen reads one device's entry in the seen file.
func (g *Gate) lastSeen(id string) (int64, bool) {
	raw := g.readOwnFile(g.DevicesSeenPath())
	if raw == nil {
		return 0, false
	}
	var seen map[string]int64
	if err := json.Unmarshal(raw, &seen); err != nil {
		return 0, false
	}
	t, ok := seen[id]
	return t, ok
}

// matchDevice is matchBearer for the registry: every device is compared,
// whichever one matches.
func (g *Gate) matchDevice(devices []pairedDevice, presented string) (pairedDevice, bool) {
	if !tokenRe.MatchString(presented) {
		return pairedDevice{}, false
	}
	want := sha256.Sum256([]byte(presented))
	var found pairedDevice
	ok := false
	for _, d := range devices {
		if g.countTokenCompares != nil {
			g.countTokenCompares()
		}
		if subtle.ConstantTimeCompare(d.digest[:], want[:]) == 1 {
			found, ok = d, true
		}
	}
	return found, ok
}

// resolveDevice answers a request that presented a device token. Like
// resolveBearer it never falls back: a miss, an idle device and an unreadable
// registry are all 401.
func (g *Gate) resolveDevice(r *http.Request, token string) (Identity, error) {
	d, ok := g.matchDevice(g.devices(), token)
	if !ok {
		return Identity{}, ErrBadBearer
	}
	last := d.Created
	if seen, ok := g.lastSeen(d.ID); ok {
		last = seen
	}
	if g.clock().Sub(time.Unix(last, 0)) > DeviceIdleLimit {
		log.Printf("authuser: device %s refused: unused for more than %s", d.ID, DeviceIdleLimit)
		return Identity{}, ErrBadBearer
	}
	// The registry is written by the service on a signed-in person's behalf,
	// so the user it names was that person's own account when it was paired.
	// Whether it is still a terminal account is today's question.
	if !g.IsTarget(d.User) {
		return Identity{}, ErrNoAccount
	}
	if !g.SkipAccountCheck {
		if err := g.lookupUser(d.User); err != nil {
			return Identity{}, ErrNoSuchAccount
		}
	}
	// A paired app acts as its own person, for resolveBearer's reason.
	if as := strings.TrimSpace(r.URL.Query().Get("as")); as != "" && as != d.User {
		if g.OnActAsRefused != nil {
			g.OnActAsRefused(d.User, as, ErrNotAdmin.Error())
		}
		return Identity{}, ErrNotAdmin
	}
	if g.OnDeviceUsed != nil {
		g.OnDeviceUsed(d.ID)
	}
	return Identity{
		// The person's own name, as their browser would have sent it. Not the
		// label: session-events shows Header to other people, and a label is
		// whatever the client called itself.
		Header:     g.identityNameFor(d.User),
		OSUser:     d.User,
		RealOSUser: d.User,
		MultiUser:  g.MultiUser(),
		// Admin is false for resolveBearer's reason: a device cannot act as
		// anyone, so advertising the picker would offer a control that only
		// fails.
		Admin:    false,
		Method:   MethodDevice,
		DeviceID: d.ID,
	}, nil
}

// identityNameFor is the user map read backwards: the identity a person signs
// in as, for an OS account. Several identities may name one account; the one
// equal to the account's own name wins, then the first in sort order, so the
// answer does not depend on the file's order. With no map (single-user) or no
// entry, the OS user is the name.
func (g *Gate) identityNameFor(osUser string) string {
	if !g.MultiUser() {
		return osUser
	}
	var keys []string
	for k, v := range g.userMap() {
		if v != osUser {
			continue
		}
		if k == osUser {
			return k
		}
		keys = append(keys, k)
	}
	if len(keys) == 0 {
		return osUser
	}
	sort.Strings(keys)
	return keys[0]
}
