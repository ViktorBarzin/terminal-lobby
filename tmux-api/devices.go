package main

// Paired T3 apps (ADR-0045, docs/plans/2026-10-21-t3-everywhere-design.md).
//
// T3's web, desktop and phone apps connect to tl-t3-view, and each one proves
// who it is with a device token: a bearer that resolves to one person through
// authuser, the way a browser's identity header does. This file is where those
// tokens come from and where they go.
//
// Pairing takes two requests from two places:
//
//  1. POST /devices/pair, from the person's signed-in browser. tmux-api mints a
//     short code bound to their account and the lobby shows it as a link and a
//     QR code. Five minutes, single use, held in memory only.
//  2. POST /devices/exchange, from tl-t3-view on loopback, carrying the code the
//     app was handed. tmux-api spends the code, writes a registry entry holding
//     the token's digest, and returns the token once. The app keeps it.
//
// GET /devices and DELETE /devices/{id} are the list and the revoke button in
// Settings.
//
// Only a signed-in browser may pair, list or revoke. A paired app must never be
// able to mint another (a stolen token would otherwise renew itself past a
// revoke), and a tokens-file credential has no person behind it. Act-as is
// refused for the same reason links refuse it: the lens watches someone's
// lobby, and handing out a credential to their account is not watching.
//
// The registry (authuser.DefaultDevicesPath) has one writer, this service, and
// every write goes through updateDevices: an flock on a sibling lock file, a
// fresh read, the change, and an atomic rename. The last-use file is written
// the same way, throttled to once per deviceSeenInterval per device. The other
// services only read, through authuser.

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"terminal-lobby/authuser"
)

const (
	// pairCodeAlphabet is T3's own: no 0/O or 1/I, so a code read off a screen
	// survives being typed. 32 characters, so one random byte masked to five
	// bits picks a character with no bias.
	pairCodeAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
	// pairCodeLen is 60 bits of code. A code lives five minutes and is spent
	// on its first exchange, so that is far past guessing.
	pairCodeLen = 12
	pairCodeTTL = 5 * time.Minute
	// maxPairCodesPerUser bounds the codes one person can have outstanding,
	// so a button pressed in a loop cannot grow the book without limit.
	maxPairCodesPerUser = 5

	// deviceSeenInterval is how often a device's last use is written. The
	// sidecar re-checks each device every 60 s; the idle limit is 90 days, so
	// a ten-minute resolution costs nothing and saves 9 writes in 10.
	deviceSeenInterval = 10 * time.Minute

	maxDeviceLabelRunes = 64
	maxDeviceFieldRunes = 32
	defaultDeviceLabel  = "T3 app"
)

// deviceNow is the clock for codes, creation stamps and last use. A var so the
// tests can move it.
var deviceNow = time.Now

// --- pairing codes -----------------------------------------------------------

type pairCode struct {
	code    string
	user    string
	expires time.Time
}

// pairBook holds the outstanding codes. In memory on purpose: a code is good
// for five minutes, and a restart that forgets them costs a person one more
// press of the button.
type pairBook struct {
	mu      sync.Mutex
	codes   []pairCode
	perUser int
}

func newPairBook() *pairBook { return &pairBook{perUser: maxPairCodesPerUser} }

var pairCodes = newPairBook()

var errTooManyCodes = errors.New("too many outstanding pairing codes")

// newPairCode draws pairCodeLen characters from the alphabet. Rejection
// sampling keeps the draw unbiased for any alphabet length; with 32 it never
// rejects.
func newPairCode() (string, error) {
	n := len(pairCodeAlphabet)
	limit := 256 - 256%n
	out := make([]byte, 0, pairCodeLen)
	buf := make([]byte, pairCodeLen)
	for len(out) < pairCodeLen {
		if _, err := io.ReadFull(rand.Reader, buf); err != nil {
			return "", err
		}
		for _, b := range buf {
			if int(b) >= limit || len(out) == pairCodeLen {
				continue
			}
			out = append(out, pairCodeAlphabet[int(b)%n])
		}
	}
	return string(out), nil
}

// pruneLocked drops expired codes.
func (b *pairBook) pruneLocked(now time.Time) {
	kept := b.codes[:0]
	for _, c := range b.codes {
		if now.Before(c.expires) {
			kept = append(kept, c)
		}
	}
	b.codes = kept
}

func (b *pairBook) mint(user string, now time.Time) (pairCode, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pruneLocked(now)
	n := 0
	for _, c := range b.codes {
		if c.user == user {
			n++
		}
	}
	if n >= b.perUser {
		return pairCode{}, errTooManyCodes
	}
	code, err := newPairCode()
	if err != nil {
		return pairCode{}, err
	}
	pc := pairCode{code: code, user: user, expires: now.Add(pairCodeTTL)}
	b.codes = append(b.codes, pc)
	return pc, nil
}

// redeem spends a code and reports whose it was. Every outstanding code is
// compared whichever one matches, so how long this takes says nothing about
// which codes exist.
func (b *pairBook) redeem(code string, now time.Time) (string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pruneLocked(now)
	match := -1
	for i, c := range b.codes {
		if subtle.ConstantTimeCompare([]byte(c.code), []byte(code)) == 1 {
			match = i
		}
	}
	if match < 0 {
		return "", false
	}
	user := b.codes[match].user
	b.codes = append(b.codes[:match], b.codes[match+1:]...)
	return user, true
}

// normalizePairCode forgives what a person typing a code does to it: lower
// case, and the spaces or dashes a display groups it with. Anything else
// outside the alphabet makes it no code at all.
func normalizePairCode(s string) (string, bool) {
	var b strings.Builder
	for _, r := range strings.ToUpper(s) {
		switch {
		case r == ' ' || r == '-':
			continue
		case r < unicode.MaxASCII && strings.ContainsRune(pairCodeAlphabet, r):
			b.WriteRune(r)
		default:
			return "", false
		}
	}
	out := b.String()
	return out, len(out) == pairCodeLen
}

// --- the registry and its single writer ------------------------------------

// loadDeviceRegistry reads the registry as written. An absent file is an empty
// registry. No owner or mode check: this is the writer reading its own file,
// and authuser applies those checks on the path that authenticates.
func loadDeviceRegistry(path string) (authuser.DeviceRegistry, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return authuser.DeviceRegistry{Devices: []authuser.Device{}}, nil
	}
	if err != nil {
		return authuser.DeviceRegistry{}, err
	}
	var reg authuser.DeviceRegistry
	if err := json.Unmarshal(raw, &reg); err != nil {
		return authuser.DeviceRegistry{}, fmt.Errorf("corrupt device registry: %w", err)
	}
	if reg.Devices == nil {
		reg.Devices = []authuser.Device{}
	}
	return reg, nil
}

// loadDeviceSeen reads the last-use file. Absent is empty.
func loadDeviceSeen(path string) (map[string]int64, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]int64{}, nil
	}
	if err != nil {
		return nil, err
	}
	seen := map[string]int64{}
	if err := json.Unmarshal(raw, &seen); err != nil {
		return nil, fmt.Errorf("corrupt device seen file: %w", err)
	}
	return seen, nil
}

// withDevicesLock runs fn holding an exclusive flock on devices.json.lock, next
// to the registry. flock rather than a mutex because the lock has to hold
// between processes: a restart overlapping the old process, or two tmux-api
// binaries during a test run. Each call opens its own descriptor, so two
// goroutines in this process exclude each other too.
//
// The state directory is created 0700 if it is missing. In production systemd
// creates it from the unit's StateDirectory=; this covers a scratch build and
// the tests.
func withDevicesLock(fn func() error) error {
	dir := filepath.Dir(actAsGate.DevicesPath())
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	lock, err := os.OpenFile(actAsGate.DevicesPath()+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	return fn()
}

// updateDevices is the only way the registry changes: lock, re-read, apply fn,
// write atomically. Re-reading under the lock is what keeps a revoke from being
// undone by a writer holding an older copy. fn returning an error writes
// nothing.
func updateDevices(fn func(*authuser.DeviceRegistry) error) error {
	path := actAsGate.DevicesPath()
	return withDevicesLock(func() error {
		reg, err := loadDeviceRegistry(path)
		if err != nil {
			return err
		}
		if err := fn(&reg); err != nil {
			return err
		}
		return writeAtomicJSON(filepath.Dir(path), "devices.*.tmp", path, reg)
	})
}

// editDeviceSeen rewrites the last-use file under the registry's lock. Entries
// for devices the registry no longer holds are dropped first, which keeps the
// file the registry's size; then fn may add one, given the set of live ids, and
// reports whether it did. Nothing changed means nothing written.
func editDeviceSeen(fn func(seen map[string]int64, live map[string]bool) bool) error {
	return withDevicesLock(func() error {
		reg, err := loadDeviceRegistry(actAsGate.DevicesPath())
		if err != nil {
			return err
		}
		live := map[string]bool{}
		for _, d := range reg.Devices {
			live[d.ID] = true
		}
		seenPath := actAsGate.DevicesSeenPath()
		seen, err := loadDeviceSeen(seenPath)
		if err != nil {
			// A corrupt file is replaced rather than kept: it holds nothing
			// but timestamps, and an absent entry only makes a device look
			// older than it is.
			log.Printf("devices: replacing unreadable %s: %v", seenPath, err)
			seen = map[string]int64{}
		}
		changed := false
		for k := range seen {
			if !live[k] {
				delete(seen, k)
				changed = true
			}
		}
		if fn(seen, live) {
			changed = true
		}
		if !changed {
			return nil
		}
		return writeAtomicJSON(filepath.Dir(seenPath), "devices-seen.*.tmp", seenPath, seen)
	})
}

// recordDeviceSeen writes one device's last use, and only for a device the
// registry still holds, so a use racing a revoke cannot leave an entry behind
// for a device that is gone.
func recordDeviceSeen(id string, at int64) error {
	return editDeviceSeen(func(seen map[string]int64, live map[string]bool) bool {
		if !live[id] {
			return false
		}
		seen[id] = at
		return true
	})
}

// seenRecorder throttles recordDeviceSeen to once per deviceSeenInterval per
// device. In memory: a restart writes each device once more, which is the
// throttle's only cost.
type seenRecorder struct {
	mu   sync.Mutex
	last map[string]time.Time
}

func newSeenRecorder() *seenRecorder { return &seenRecorder{last: map[string]time.Time{}} }

var deviceSeen = newSeenRecorder()

func (s *seenRecorder) note(id string) {
	now := deviceNow()
	s.mu.Lock()
	if t, ok := s.last[id]; ok && now.Sub(t) < deviceSeenInterval {
		s.mu.Unlock()
		return
	}
	s.last[id] = now
	s.mu.Unlock()
	if err := recordDeviceSeen(id, now.Unix()); err != nil {
		log.Printf("devices: recording last use of %s: %v", id, err)
		s.mu.Lock()
		delete(s.last, id)
		s.mu.Unlock()
	}
}

// wireDeviceGate connects the gate's device hook to the recorder. main calls it
// on the production gate; the tests call it on theirs. It reads deviceSeen at
// call time, so a test that swaps the recorder is the one that records.
func wireDeviceGate(g *authuser.Gate) {
	g.OnDeviceUsed = func(id string) { deviceSeen.note(id) }
}

// cleanDeviceField keeps a client-supplied string printable and short. It is
// shown only to the device's owner, but it is stored and rendered, so control
// and formatting characters (a right-to-left override among them) are dropped.
func cleanDeviceField(s string, max int) string {
	var b strings.Builder
	n := 0
	for _, r := range strings.TrimSpace(s) {
		if n >= max {
			break
		}
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || r == utf8.RuneError {
			continue
		}
		b.WriteRune(r)
		n++
	}
	return strings.TrimSpace(b.String())
}

// --- handlers ----------------------------------------------------------------

func writeDeviceJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func deviceError(w http.ResponseWriter, status int, msg string) {
	writeDeviceJSON(w, status, map[string]string{"error": msg})
}

// deviceOwner resolves the signed-in person for pair, list and revoke, or
// writes the refusal and returns "".
func deviceOwner(w http.ResponseWriter, r *http.Request) string {
	id, ok := actAsGate.Authorize(w, r)
	if !ok {
		return ""
	}
	if id.Method != authuser.MethodBrowser {
		deviceError(w, http.StatusForbidden, "devices are paired and revoked from a signed-in browser")
		return ""
	}
	if id.OSUser != id.RealOSUser {
		deviceError(w, http.StatusForbidden, "devices cannot be managed while acting as another user")
		return ""
	}
	return id.RealOSUser
}

// handleDevicePair is POST /devices/pair: a fresh code for the caller.
func handleDevicePair(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	osUser := deviceOwner(w, r)
	if osUser == "" {
		return
	}
	pc, err := pairCodes.mint(osUser, deviceNow())
	if errors.Is(err, errTooManyCodes) {
		deviceError(w, http.StatusTooManyRequests, "too many pairing codes outstanding; wait for one to expire")
		return
	}
	if err != nil {
		logAndFail(w, "devices: minting a pairing code for %s: %v", osUser, err)
		return
	}
	log.Printf("devices: pairing code issued for %s", osUser)
	writeDeviceJSON(w, http.StatusOK, map[string]any{"code": pc.code, "expiresAt": pc.expires.Unix()})
}

// forwardedHeaders are the ones a reverse proxy adds. The container's nginx
// reaches this service over loopback, so on that install a request from the
// internet would pass IsLoopback; it also carries X-Real-IP, and tl-t3-view,
// calling directly, carries none of these.
var forwardedHeaders = []string{"X-Forwarded-For", "X-Real-IP", "Forwarded"}

// handleDeviceExchange is POST /devices/exchange, tl-t3-view's half: a code for
// a token. Loopback only, and no identity: the code is the credential.
func handleDeviceExchange(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	if !authuser.IsLoopback(r) {
		deviceError(w, http.StatusForbidden, "forbidden")
		return
	}
	for _, h := range forwardedHeaders {
		if r.Header.Get(h) != "" {
			deviceError(w, http.StatusForbidden, "forbidden")
			return
		}
	}
	var body struct {
		Code       string `json:"code"`
		Label      string `json:"label"`
		DeviceType string `json:"deviceType"`
		OS         string `json:"os"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil {
		deviceError(w, http.StatusBadRequest, "bad request body")
		return
	}
	const badCode = "invalid or expired pairing code"
	code, ok := normalizePairCode(body.Code)
	if !ok {
		deviceError(w, http.StatusUnauthorized, badCode)
		return
	}
	now := deviceNow()
	osUser, ok := pairCodes.redeem(code, now)
	if !ok {
		log.Printf("devices: exchange refused: no such pairing code")
		deviceError(w, http.StatusUnauthorized, badCode)
		return
	}
	token, err := authuser.NewDeviceToken()
	if err != nil {
		logAndFail(w, "devices: minting a token: %v", err)
		return
	}
	label := cleanDeviceField(body.Label, maxDeviceLabelRunes)
	if label == "" {
		label = defaultDeviceLabel
	}
	d := authuser.Device{
		ID:         newLinkID(), // the same 8 random bytes in hex a link id is
		User:       osUser,
		Label:      label,
		DeviceType: cleanDeviceField(body.DeviceType, maxDeviceFieldRunes),
		OS:         cleanDeviceField(body.OS, maxDeviceFieldRunes),
		Digest:     authuser.BearerDigest(token),
		Created:    now.Unix(),
	}
	if err := updateDevices(func(reg *authuser.DeviceRegistry) error {
		reg.Devices = append(reg.Devices, d)
		return nil
	}); err != nil {
		logAndFail(w, "devices: saving a device for %s: %v", osUser, err)
		return
	}
	// The id and the account, never the token or the code.
	log.Printf("devices: paired %s for %s", d.ID, osUser)
	// expiresIn 0: the token does not expire on a schedule, only after
	// authuser.DeviceIdleLimit unused or when revoked.
	writeDeviceJSON(w, http.StatusOK, map[string]any{
		"token": token, "id": d.ID, "user": osUser, "expiresIn": 0,
	})
}

// DeviceView is a device as its owner sees it. No digest.
type DeviceView struct {
	ID         string `json:"id"`
	Label      string `json:"label"`
	DeviceType string `json:"deviceType"`
	OS         string `json:"os"`
	Created    int64  `json:"created"`
	// LastSeen is a unix second, 0 for a device not used since it paired.
	LastSeen int64 `json:"lastSeen"`
}

// handleDevices is GET /devices: the caller's own paired apps, newest first.
func handleDevices(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	osUser := deviceOwner(w, r)
	if osUser == "" {
		return
	}
	reg, err := loadDeviceRegistry(actAsGate.DevicesPath())
	if err != nil {
		logAndFail(w, "devices: reading the registry: %v", err)
		return
	}
	seen, err := loadDeviceSeen(actAsGate.DevicesSeenPath())
	if err != nil {
		log.Printf("devices: reading last use: %v", err)
		seen = map[string]int64{}
	}
	out := []DeviceView{}
	for _, d := range reg.Devices {
		if d.User != osUser {
			continue
		}
		out = append(out, DeviceView{
			ID: d.ID, Label: d.Label, DeviceType: d.DeviceType, OS: d.OS,
			Created: d.Created, LastSeen: seen[d.ID],
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created > out[j].Created })
	writeDeviceJSON(w, http.StatusOK, out)
}

var errNoSuchDevice = errors.New("no such device")

// handleDeviceByID is DELETE /devices/{id}: revoke one of the caller's own.
// Another person's device answers 404, the same as one that does not exist.
func handleDeviceByID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "DELETE only", http.StatusMethodNotAllowed)
		return
	}
	osUser := deviceOwner(w, r)
	if osUser == "" {
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/devices/")
	if !authuser.ValidDeviceID(id) {
		deviceError(w, http.StatusNotFound, "no such device")
		return
	}
	err := updateDevices(func(reg *authuser.DeviceRegistry) error {
		kept := reg.Devices[:0]
		found := false
		for _, d := range reg.Devices {
			if d.ID == id && d.User == osUser {
				found = true
				continue
			}
			kept = append(kept, d)
		}
		if !found {
			return errNoSuchDevice
		}
		reg.Devices = kept
		return nil
	})
	if errors.Is(err, errNoSuchDevice) {
		deviceError(w, http.StatusNotFound, "no such device")
		return
	}
	if err != nil {
		logAndFail(w, "devices: revoking %s for %s: %v", id, osUser, err)
		return
	}
	// The last-use entry goes too: editDeviceSeen drops entries for devices
	// the registry no longer holds, and this call adds nothing.
	if err := editDeviceSeen(func(map[string]int64, map[string]bool) bool { return false }); err != nil {
		log.Printf("devices: pruning last use after revoking %s: %v", id, err)
	}
	log.Printf("devices: revoked %s for %s", id, osUser)
	w.WriteHeader(http.StatusNoContent)
}
